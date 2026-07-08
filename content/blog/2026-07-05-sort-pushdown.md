---
layout: post
title: Sort Pushdown in DataFusion: Skip Sorts, Skip Decode, Skip I/O
date: 2026-07-05
author: Qi Zhu
categories: [performance]
---

<!--
{% comment %}
Licensed to the Apache Software Foundation (ASF) under one or more
contributor license agreements.  See the NOTICE file distributed with
this work for additional information regarding copyright ownership.
The ASF licenses this file to you under the Apache License, Version 2.0
(the "License"); you may not use this file except in compliance with
the License.  You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
{% endcomment %}
-->

[TOC]

*Qi Zhu, [Massive](https://www.massive.com/)*

**[Apache DataFusion]  automatically takes advantage of sortedness in the
data — even when the data is only *partially* sorted, and even when
DataFusion has not been told about the ordering ahead of time.** This post
explains why that matters and walks through how DataFusion achieves it,
through a combination of plan-time sort pushdown, runtime scan reordering,
and mid-scan row-group pruning driven by [dynamic filters][dyn-filters-blog].

[Apache DataFusion]: https://datafusion.apache.org/
[dyn-filters-blog]: https://datafusion.apache.org/blog/2025/09/10/dynamic-filters/

## Why sort pushdown matters

Many real datasets are at least partly sorted when stored:

- Time-series files are written in ingestion-time order.
- Event logs are sharded and sorted by event id.
- Partitioned tables have a natural ordering by partition key.
- Modern data lakes based on [Apache Iceberg] and similar formats
  often have to work with data **as it was written** — resorting the
  whole table isn't an option.

But that "pre-existing sortedness" is only useful if the query engine can
**notice** it and **use** it. Two common failure modes:

1. The engine doesn't know about the ordering — the writer didn't set
   Parquet `sorting_columns`, and the table definition doesn't include a
   [`WITH ORDER`](https://datafusion.apache.org/user-guide/sql/ddl.html#create-external-table) clause.
2. The engine knows the *per-file* ordering, but the file *listing* on
   disk is in a different order, so global sortedness can't be proven at
   plan time.

In both cases, an `ORDER BY` or `ORDER BY ... LIMIT N` query pays the
cost of a full external `SortExec` — a pipeline-blocking operator that
must see every input row before emitting anything, dominating both
latency and peak memory on large scans.

Min/max statistics used for *predicate* pushdown are well-known and
widely implemented across databases. Using them to *reason about sort
order* — deleting redundant sorts, biasing scan order toward the
most-promising data — is less common. This post is about how DataFusion
does the latter.

[Apache Iceberg]: https://iceberg.apache.org/

## What DataFusion could already do — and what was missing

DataFusion has always been able to skip the sort in the **exact** case,
using the machinery covered in [@akurmustafa's earlier post on
ordering analysis][ordering-analysis]: when the table definition
declares an ordering (via `WITH ORDER` or Parquet `sorting_columns`)
**and** the on-disk file listing already matches that order, the
existing `EnsureRequirements` rule sees that the scan's
`output_ordering` satisfies the request and **removes the redundant
`SortExec`** entirely.

This post is about **everything else** — the messier real-world cases
where sortedness exists but isn't provable up front:

- Files listed in the "wrong" order on disk (each file internally
  sorted, but the listing doesn't match).
- Declared ordering with **overlapping** ranges across files.
- **No** declared ordering at all.
- `ORDER BY ... DESC` on ASC-sorted data.

Three complementary techniques close each gap:

1. **Statistics-based sort elimination** (`Exact` path). Extend the
   optimizer to prove ordering from min/max statistics after
   reordering the file list, then delete the `SortExec` entirely.
2. **Runtime scan reorder** (`Inexact` path). Keep the `SortExec`, but
   bias scan order so the *most-promising* data is read first —
   `TopK`'s [dynamic filter][dyn-filters-blog] tightens quickly and
   downstream data is pruned by statistics before it's read.
3. **Runtime row-group dynamic pruning** ([#22450]). Inside the
   parquet decoder loop, re-check the live `TopK` threshold at every
   row-group boundary and physically remove pruned row groups before
   any bytes are fetched.

Together these compose into a **three-layer pruning stack**
(file-level, row-group-level, row-level), all driven by the same
`TopK` dynamic filter. Headline results:

- **Sort elimination**: 2×–49× faster on ASC-LIMIT queries where the
  file list was in the wrong disk order.
- **Runtime row-group pruning ([#22450])**: 5 of 11 `topk_tpch`
  queries run 3–4× faster with zero regressions; total runtime drops
  −44%.

The rest of this post walks through each technique in turn.

[#22450]: https://github.com/apache/datafusion/pull/22450
[#20839]: https://github.com/apache/datafusion/pull/20839
[Apache Parquet]: https://parquet.apache.org/
[ordering-analysis]: https://datafusion.apache.org/blog/2025/03/11/ordering-analysis/

## How DataFusion Tracks Ordering

<img src="/blog/images/sort-pushdown/plan-diff.svg" alt="EXPLAIN before / after: SortExec eliminated once ordering is Exact" width="100%" class="img-fluid"/>

DataFusion's [`FileScanConfig`](https://docs.rs/datafusion-datasource/latest/datafusion_datasource/file_scan_config/struct.FileScanConfig.html) carries an ordering claim for
each scan's output, which is one of:

- **`Exact`** — the optimizer is *certain* the output is in this order,
  and removes redundant [`SortExec`](https://docs.rs/datafusion-physical-plan/latest/datafusion_physical_plan/sorts/sort/struct.SortExec.html) operators entirely.
  `LIMIT N` becomes a static fetch on the source (the reader stops the
  moment N rows are emitted).
- **`Inexact`** — the optimizer believes the output is probably ordered
  but cannot prove it. Downstream operators like
  [`SortPreservingMergeExec`](https://docs.rs/datafusion-physical-plan/latest/datafusion_physical_plan/sorts/sort_preserving_merge/struct.SortPreservingMergeExec.html) can still benefit, but the
  explicit `SortExec` stays for correctness. In this case `TopK`'s
  [dynamic filter][dyn-filters-blog] tightens as the heap fills, and
  data whose min/max cannot beat the threshold is pruned before it is
  fully read.

For example, given a query that returns the 10 most recent trades:

```sql
SELECT ts, symbol, amount FROM trades ORDER BY ts DESC LIMIT 10;
```

- With no ordering knowledge, DataFusion scans everything and uses a
  `TopK` heap to keep the running best 10.
- With **`Exact`** ordering, DataFusion drops the sort entirely and
  stops reading after emitting 10 rows.
- With **`Inexact`** ordering, the `SortExec` stays but scans start
  from the most-promising data, so the `TopK` threshold tightens fast
  and the rest is pruned by statistics.

The optimizer rule that upgrades a scan from `Unsupported` to
`Exact`/`Inexact` — and that removes the resulting redundant
`SortExec` — is [`PushdownSort`](https://github.com/apache/datafusion/blob/main/datafusion/physical-optimizer/src/pushdown_sort.rs). `PushdownSort`
runs late, after `EnsureRequirements` has finalised the plan shape.
It walks each `SortExec`, asks the child leaf via `try_pushdown_sort`
which flavour the source can produce, and rewrites accordingly.

## The `Exact` Path · Sort Elimination via Statistics

<img src="/blog/images/sort-pushdown/phase1-file-reorder.svg" alt="File reorder: rearranging files within a partition by min/max statistics so the file list is in range order" width="100%" class="img-fluid" /><br/>
*Figure: file reorder by per-file `min/max` puts the file list in range
order without touching file contents.*

DataFusion could already recognize the *exact* sortedness case (declared
ordering + matching on-disk file list). The new capability is recognizing
sortedness when the **file list is in the wrong order** on disk, using
the min/max statistics that the Parquet writer already stored per row
group. Implemented across two PRs on `PushdownSort`:
[apache/datafusion#19064][#19064] (rule scaffolding), and
[apache/datafusion#21182][#21182] (stats-based file reorder).

[#19064]: https://github.com/apache/datafusion/pull/19064
[#21182]: https://github.com/apache/datafusion/pull/21182

For example, consider three files `a.parquet`, `b.parquet`,
`c.parquet`. Each is internally sorted by `ts` and declares
`WITH ORDER (ts ASC)`, but they were written by different jobs and end
up listed alphabetically on disk (which does *not* match sort order).
The old machinery has no way to prove global sortedness, so an
`ORDER BY ts` query pays for a full external sort even though the
underlying data is already sorted.

`PushdownSort` fixes this in three steps at the file-scan node:

1. **Sort the file list by per-file `min`** on the sort column.
2. **Check adjacency**: does `file[i].max ≤ file[i+1].min` hold for
   every adjacent pair? If yes, the sorted file list produces a globally
   sorted stream.
3. **Upgrade the source's ordering claim to `Exact`** and remove the
   surrounding `SortExec`.

<img src="/blog/images/sort-pushdown/phase2-stats-overlap.svg" alt="Detecting non-overlapping ranges via min/max statistics" width="100%" class="img-fluid" /><br/>
*Figure: after reorder, the left case has non-overlapping ranges (safe
to upgrade to `Exact`); the right case has overlaps (upgrade skipped,
falls through to the `Inexact` path).*

Two conservative bail-outs: (a) sort keys must be plain columns
(`ORDER BY date_trunc('hour', ts)` doesn't qualify — no per-file min/max
for the function output), and (b) sort columns must be null-free, so
`NULLS FIRST`/`NULLS LAST` semantics are preserved across file
boundaries. The overlap case falls through to the `Inexact` path
covered later.

### `BufferExec` · a subtle multi-partition side effect

<img src="/blog/images/sort-pushdown/buffer-exec-stall.svg" alt="SPM stalls when SortExec is removed in multi-partition plans" width="100%" class="img-fluid" /><br/>
*Figure: removing the per-partition `SortExec` leaves the top-of-plan
merge (`SortPreservingMergeExec`) directly consuming raw I/O; a stall
on any partition stalls the whole plan.*

Removing the `SortExec` looked like a pure win, but the first
multi-partition benchmarks showed something counter-intuitive: **some
queries got slower**. The root cause is that the removed `SortExec`
was doing two jobs — sorting *and* implicitly buffering. Each
per-partition `SortExec` runs as its own task, greedily draining its
source in the background; the top-of-plan `SortPreservingMergeExec`
picks from those large in-memory buffers and never blocks on I/O in
any single partition.

Once the `SortExec` is deleted, the merge sits directly on the raw
parquet streams. It's a lazy consumer — a k-way merge must see the
head row from every input before deciding which to emit. A stall in
*any one* partition now stalls the entire merge.

<img src="/blog/images/sort-pushdown/buffer-exec.svg" alt="BufferExec replaces the deleted SortExec with a bounded streaming buffer per partition" width="100%" class="img-fluid" /><br/>
*Figure: `BufferExec` is inserted where the `SortExec` used to live —
same greedy per-partition prefill, but no blocking sort.*

The fix is [`BufferExec`](https://github.com/apache/datafusion/blob/main/datafusion/physical-plan/src/buffer.rs): a bounded per-partition
prefill buffer that plays the same "greedy parallel I/O driver" role
the `SortExec` implicitly did. No sort, no blocking, and strictly
less memory than the `SortExec` it replaces. The capacity is bounded
(default 1 GB, configurable via
[`sort_pushdown_buffer_capacity`](https://github.com/apache/datafusion/pull/21426)) and grows via the
global memory pool, so it back-pressures the source instead of
OOMing.

### Benchmark: `sort_pushdown` suite

<img src="/blog/images/sort-pushdown/benchmark.svg" alt="Sort pushdown benchmark: 2x-49x speedup across four queries" width="100%" class="img-fluid" /><br/>
*Figure: `sort_pushdown` results (`--partitions 1`, release build). ASC
queries with the file list reversed against sort-key ranges.*

Numbers below are the [`sort_pushdown`](https://github.com/apache/datafusion/tree/main/benchmarks/queries/sort_pushdown) suite,
`--partitions 1`, versus `main`:

| Query                                       | Before  | After   | Speedup  |
| ------------------------------------------- | -------:| -------:| -------: |
| Q1 — `ORDER BY key` (full scan)             | 259 ms  | 122 ms  | **2.1×** |
| Q2 — `ORDER BY key LIMIT 100`               |  80 ms  |   3 ms  | **27×**  |
| Q3 — `SELECT * ORDER BY key`                | 700 ms  | 313 ms  | **2.2×** |
| Q4 — `SELECT * ORDER BY key LIMIT 100`      | 342 ms  |   7 ms  | **49×**  |

- **Full-scan queries (Q1, Q3)** save the cost of the sort itself
  (~½ end-to-end latency for in-memory sorts).
- **`LIMIT` queries (Q2, Q4)** benefit dramatically because deleting
  the `SortExec` turns `LIMIT N` into a **static fetch** on the source —
  the reader stops after N rows. A 342 ms full-file scan collapses
  into a 7 ms K-row read.

## The `Inexact` Path · Runtime Reorder for `TopK` and `DESC`

Stats-based sort elimination handles the `Exact` upgrade — strong
correctness, sort elimination — but only when the table has a
declared `output_ordering` *and* the files are provably
non-overlapping after sorting by min. Three classes of queries
fall outside that window:

* **Unsorted data** — no `WITH ORDER`, no parquet `sorting_columns`.
  The `Exact` upgrade cannot fire because there is no ordering
  claim to upgrade.
* **Overlapping ranges** — files written by different ingestion
  jobs share time windows. The `Exact` upgrade keeps the `SortExec`
  because the global ordering can't be proven, even though the
  files often do contain large stretches of in-order data.
* **`ORDER BY ... DESC` on ASC-sorted data** — flipping iteration
  at the row-group level emits "RGs descending × rows ascending",
  close to the requested order but not strictly DESC, so the
  `SortExec` has to stay for correctness.

For all three, a full external `SortExec` is overkill. The parquet
metadata is right there, and reading the *most-promising* data
first lets `TopK`'s dynamic filter threshold tighten quickly so the
rest gets pruned. Runtime reorder wires that up by generalising
the `Inexact` path the rule introduced.

### When Inexact fires

<img src="/blog/images/sort-pushdown/pr21956-decision.svg" alt="try_pushdown_sort decision tree: Exact, Inexact, or Unsupported" width="100%" class="img-fluid" /><br/>
*Figure: for each `SortExec`, the leaf source returns `Exact` (drop
the sort), `Inexact` (bias the scan and keep the sort), or
`Unsupported`.*

The Inexact verdict fires when either of two independent signals is
true:

- **Stats-based reorder available**: the leading sort key is a plain
  column in the file schema, so the scan can sort files and row
  groups by `min(col)` from Parquet statistics.
- **Reverse satisfies the request**: the source's declared ordering,
  when reversed, satisfies what the query asks for. This uses
  DataFusion's [equivalence-properties][ordering-analysis] reasoning
  and covers function monotonicity (`ts DESC` declared, `date_trunc('day', ts) ASC`
  requested), constants inferred from filters, and multi-column
  composite orderings.

### How the scan reorders data

<img src="/blog/images/sort-pushdown/pr21956-runtime-pipeline.svg" alt="Runtime reorder pipeline: file reorder, RG reorder, then optional reverse" width="100%" class="img-fluid" /><br/>
*Figure: the parquet opener applies file-level reorder → row-group-level
reorder → optional iteration reverse.*

The parquet opener applies up to three composable steps at query start:

1. **File-level reorder** — across a shared work-stealing queue, the
   file list is sorted by `min(col)`, so the most-promising file is
   picked first across all partitions.
2. **Row-group-level reorder** — once a file is opened, its row groups
   are sorted by `min(col)`.
3. **Iteration reverse** — flip row-group iteration order for `DESC`
   requests (and for the reverse-satisfies-the-request cases above).

### File-level early stop already works

<img src="/blog/images/sort-pushdown/desc_walk_file.png" alt="Tier 1 file-level reorder with early stop via file_pruner" width="100%" class="img-fluid" /><br/>
*Figure: after file reorder, low-value files at the tail of the queue
are cut by the file-level pruner before they are ever opened — no
metadata I/O.*

Once files are ordered "most-promising first", `TopK`'s heap fills
quickly and its dynamic filter threshold tightens. Low-value files at
the tail of the queue are then checked against the live threshold
by the [`FilePruner`](https://github.com/apache/datafusion/blob/main/datafusion/pruning/src/file_pruner.rs) before they are ever opened —
never loading their footer, page index, or any data.

### Row-group-level: the gap [#22450] fills

<img src="/blog/images/sort-pushdown/desc_walk_rg.png" alt="Tier 2 RG-level reorder — filter column still read for every RG pre-#22450" width="100%" class="img-fluid" /><br/>
*Figure: inside a file, the first row group tightens the threshold —
subsequent row groups have their projection columns short-circuited,
but the filter column still has to be read to discover that no rows
qualify.*

Inside a file, the story is almost identical — but with one gap.
After the first row group fills the heap, subsequent row groups
whose values can't beat the threshold evaluate to an empty
`RowSelection`, and arrow-rs's reader short-circuits: no projection
columns fetched, no decompress, no decode.

However, **the filter column still gets read for every row group**,
because the dynamic filter has to be evaluated row-by-row to
*discover* that no rows survive. On a large file with many row
groups, that's a meaningful tax — most of which is redundant, since
metadata alone could have proven the row group unwinnable. Closing
that gap is what [#22450] does.

## #22450 · Runtime Row-Group Dynamic Pruning

The merge that just landed — [apache/datafusion#22450][#22450] —
re-checks the dynamic filter **at every row-group boundary** inside
an open file, converts the live threshold into a fresh
`PruningPredicate`, and physically removes any row group whose
min/max can't possibly beat the threshold. The pruned row groups are
**never decoded, not even on the filter column**.

### Architecture · who drives the IO + decode loop

<img src="/blog/images/sort-pushdown/arch_one_glance.png" alt="Three eras of who drives the parquet IO + decode loop" width="100%" class="img-fluid"/>

The interesting backstory is that **DataFusion didn't actually own
this loop until recently**. Three eras:

* **Pre-[#20839]**: arrow-rs owned the I/O + decode loop as a black
  box; DataFusion only called `.next()` and served byte ranges. The
  row-group list was frozen at construction, so once the loop started,
  no mid-stream decisions were possible.
* **[#20839]**: the push-based parquet decoder moved the loop into
  DataFusion. The capability to insert a decision mid-loop now
  existed — but the loop went from `drain` straight to `drive`, with
  no decision point.
* **[#22450]**: adds the missing decision point. At every row-group
  boundary, the loop pauses to ask the runtime pruner whether the
  remaining row groups are still worth reading.

### The loop, and the decision point [#22450] adds

<img src="/blog/images/sort-pushdown/transition_anatomy.png" alt="transition() loop: drain, decide, drive — Step 2 is the #22450 addition" width="100%" class="img-fluid" /><br/>
*Figure: the decoder loop has three steps. Step 2 (DECIDE) is what
[#22450] adds — it only fires at row-group boundaries.*

The loop body reads: **drain** the current row group's batches until
it's exhausted; **decide** at the boundary whether any of the
remaining row groups can be dropped based on the live threshold; then
**drive** the decoder into the next row group and repeat. Inside a
row group, only drain and drive run — no decision point.

<img src="/blog/images/sort-pushdown/pruner_loop.png" alt="RowGroupPruner: watch (cheap), rebuild (expensive, only if changed), prune (cheap)" width="100%" class="img-fluid" /><br/>
*Figure: the pruner has a cheap "check if the filter changed" step, a
moderately expensive "rebuild the predicate if so" step, and a cheap
"apply the predicate to remaining row groups" step.*

The pruner is designed so the expensive work only fires when it can
possibly help: a cheap epoch check tells it whether the dynamic filter
has actually changed since last time, and only then does it rebuild
the pruning predicate. The predicate is then applied to remaining
row groups' min/max statistics — pure metadata comparison, no I/O.
Errors always fall back to "keep the row group" — a flaky pruner
never drops live data.

### Cascading prune · how the heap eats row groups

<img src="/blog/images/sort-pushdown/rg_cascade.png" alt="Cascading prune: one row group fills the heap, threshold snaps, all subsequent row groups are pruned in a single pass" width="100%" class="img-fluid" /><br/>
*Figure: for `ORDER BY x DESC LIMIT 10`, opening the first row group
(values [90..100)) is enough to fill the heap; at the next boundary,
every remaining row group with `max < 90` is pruned in one pass.*

The savings compound because the threshold moves in **steps**, not
smoothly. For `ORDER BY x DESC LIMIT 10` on a 10-row-group file
where reorder puts high-value row groups first:

1. RG 9 (values `[90..100)`) opens. One row group is enough to fill
   the heap of size 10 — the threshold jumps into RG 9's range (≥ 90).
2. At the next row-group boundary, the pruner sees that all of RG 8
   through RG 0 have `max < 90` and drops them in one pass.
3. Bytes for those nine row groups were **never fetched** — not
   projection columns, not the filter column. Full I/O + decompress +
   decode all skipped.

This is the unconditional value of [#22450]: when reorder lines up
disjoint per-RG ranges (the common case for time-series or
partition-key sorts), a single row group can cascade-eliminate every
remaining row group at the next boundary.

## Three-Layer Pruning · file + RG + row, stacked

<img src="/blog/images/sort-pushdown/pruning_stack.png" alt="Three-layer pruning: file-level, RG-level, row-level, all driven by the same TopK dynamic filter" width="100%" class="img-fluid"/>

A common question at this point: "if [#22450] prunes whole row
groups, does that replace the `RowFilter` row-level prune that the
`Inexact` path was already using?" **No** — the three layers stack,
and they're driven by the **same** `TopK` dynamic filter. (The
"Tier 1 / Tier 2" framing earlier maps to "Layer 0 / Layer A"
below — same partition, different lens. Layer B is what runs on
each row group after Layer A keeps it.)

* **Layer 0 · file-level** (`file_pruner` + `EarlyStoppingStream`).
  Cuts dead files before they're opened. The only layer that skips
  parquet metadata I/O entirely. Already shipped before [#22450] —
  this is Tier 1.
* **Layer A · row-group-level** ([#22450]). Cuts dead row groups
  inside open files at every row-group boundary. Bytes never
  fetched, filter column never decoded. **This is the layer that
  fills the Tier 2 gap** ("× no early stop yet" pre-[#22450]).
* **Layer B · row-level** (`RowFilter`). For row groups that
  survive Layer A, the filter is still evaluated row-by-row to
  build a `RowSelection`. Rows that fail the predicate get their
  *projection* columns short-circuited via arrow-rs's
  `selects_any()`, but the *filter* column is necessarily read.
  This layer has the highest residual cost (the filter column),
  but also the finest granularity.

The same dynamic filter drives all three. A single insertion into
the `TopK` heap becomes a new threshold that Layer B applies
per-row immediately (in the currently-open row group), and Layer A
re-applies to remaining row groups at the next boundary. No layer
subsumes another — Layer A prunes on metadata alone (never touching
the filter column), while Layer B is finer-grained but has to read
the filter column to decide.

### Benchmark · `topk_tpch` (TPC-H SF1, `LIMIT 100`)

<img src="/blog/images/sort-pushdown/topk_tpch_bench.png" alt="topk_tpch benchmark results: 5 of 11 queries 3-4× faster, 0 regressions, total -44%" width="100%" class="img-fluid"/>

The [`topk_tpch`](https://github.com/apache/datafusion/blob/main/benchmarks/src/sort_tpch.rs) benchmark runs 11 TPC-H SF1 queries, all of the
shape `ORDER BY ... LIMIT 100`, comparing `main` against the same
branch with [#22450] enabled. Headline numbers:

| Metric                              | Value                              |
| ----------------------------------- | ---------------------------------- |
| Total wall-clock (sum of 11 queries) | 248.8 ms → 139.1 ms (**−44%**)    |
| Queries with ≥2× speedup vs main    | **5 of 11** (Q2, Q4, Q8, Q9, Q10) |
| Queries with regression vs main     | **0**                              |
| Best single-query speedup           | **~4×**                            |

The five queries with significant speedups all use `l_orderkey`
as the **leading** sort key — lineitem's physical sort key, a
`BIGINT` with ~1.5M distinct values per SF1, so per-RG `min/max`
ranges are cleanly disjoint and `Layer A` can cascade-prune
aggressively. The non-winners (Q1, Q3, Q5, Q6, Q7, Q11) lead with
`l_linenumber` (cardinality 7), `l_comment`, or `l_shipmode` —
columns whose per-RG ranges overlap heavily because they're not the
physical sort order. (Q5–Q7 still *include* `l_orderkey`, but only
as a third-key tie-breaker — the leading key is what controls RG-level
disjointness.) A tighter threshold doesn't translate into clean
RG-level boundaries to prune at, so `Layer B` (row-level) still does
its share of the work.

The takeaway isn't "5 out of 11", it's "**zero regressions and
no-op when the data doesn't help, 3–4× when it does**". The sweet
spot — sort key aligned with the physical layout — is the common
case for time-series, partitioned tables, and ingestion-ordered
event logs.

## Future Directions

Two complementary directions are open. The first needs an upstream
arrow-rs primitive; the second is pure DataFusion plumbing on top
of [#22450]:

### A · Page-level `Exact` reverse · arrow-rs [#9937]

<img src="/blog/images/sort-pushdown/reverse-scan.svg" alt="Row-group reverse (128 MB peak) vs page-level reverse (1 MB peak)" width="100%" class="img-fluid"/>

[#9937]: https://github.com/apache/arrow-rs/pull/9937

Today's `DESC` query support lives in the `Inexact` path: the
row-group reverse emits "RGs descending × rows ascending", which is
close to DESC but not strictly so. `SortExec` stays.

A page-level reverse primitive in arrow-rs would let the reader
walk the parquet offset index in reverse — decoding each page
forward, reversing its `RecordBatch`, and emitting before moving to
the previous page. Peak buffer drops from ~128 MB (one
row group) to ~1 MB (one page); per-page decode stays forward (RLE,
dictionary, delta, and bit-packed encodings are all forward-only
by construction — page *traversal* is what gets reversed). Once
each batch already comes out in DESC order, `PushdownSort` can
finally return `Exact` for `DESC`, the `SortExec` is removed
outright, and `LIMIT N` becomes a static fetch.

In flight upstream as [arrow-rs#9937]. The killer use case is
**filtered reverse `TopK`** — e.g. `WHERE user_id = 42 ORDER BY ts
DESC LIMIT 10`. You can't pre-compute a `RowSelection::with_limit`
because matching rows are sparse; the only correct strategy is to
stream pages backward, filter, and stop when 10 matches accumulate.
Row-group reverse stops at ~128 MB granularity; page reverse stops
at ~1 MB.

[arrow-rs#9937]: https://github.com/apache/arrow-rs/pull/9937

### B · Page-level dynamic prune at the row-group boundary

<img src="/blog/images/sort-pushdown/future_page_level.png" alt="Page-level dynamic prune: extends #22450 to skip individual pages, not just whole row groups" width="100%" class="img-fluid"/>

[#22450] prunes whole row groups at row-group boundaries. The
finer-grained extension prunes whole **pages** within a surviving
row group. The signal is the same dynamic filter, just re-applied
at page granularity — for any page whose `max(col)` is already
below the threshold, the filter column's bytes for that page can be
skipped along with the projection columns.

Today's page-level pruning runs once at file open using the static
query predicate. Future B extends [#22450]'s "refresh at RG
boundary" pattern to also rebuild the page-level filter with the
live threshold, so upcoming row groups get tighter page selections
mid-scan. Same arrow-rs API [#22450] already uses — no new
primitive needed. Tracked in [apache/datafusion#23216].

[apache/datafusion#23216]: https://github.com/apache/datafusion/issues/23216

Conceptually this is the same idea as [#22450] stepped down one
level: every level of the parquet hierarchy gets to chip off its
share of the residue from the level above.

## Acknowledgements

Thank you to [@adriangb], [@alamb], [@xudong963], [@2010YOUY01], and
[@Dandandan] for reviewing the design and the patches across many
iterations. The DataFusion community's willingness to engage deeply
with optimizer changes — including the ones that touch foundational
invariants like who-drives-the-decode-loop — is what made this work
possible.

[@alamb]: https://github.com/alamb
[@adriangb]: https://github.com/adriangb
[@xudong963]: https://github.com/xudong963
[@2010YOUY01]: https://github.com/2010YOUY01
[@Dandandan]: https://github.com/Dandandan

## References

Umbrella issue tracking the entire effort:

* **[EPIC] Sort Pushdown · skip sorts and skip IO for ORDER BY / TopK queries: [apache/datafusion#23036](https://github.com/apache/datafusion/issues/23036)** — phase-by-phase status of all the PRs and follow-ups.

Prior post this work builds on:

* [Dynamic Filters: Passing Information Between Operators During Execution for 25x Faster Queries][dyn-filters-blog] — the dynamic filter primitive `TopK` uses.

Landed PRs that make up the merged work:

* `MinMaxStatistics` foundation: [apache/datafusion#9593](https://github.com/apache/datafusion/pull/9593)
* `PushdownSort` rule + row-group reverse: [apache/datafusion#19064](https://github.com/apache/datafusion/pull/19064)
* Reverse-output redesign: [apache/datafusion#19446](https://github.com/apache/datafusion/pull/19446), [apache/datafusion#19557](https://github.com/apache/datafusion/pull/19557)
* Sort elimination via statistics: [apache/datafusion#21182](https://github.com/apache/datafusion/pull/21182)
* `BufferExec` capacity for sort elimination: [apache/datafusion#21426](https://github.com/apache/datafusion/pull/21426)
* Push-based parquet decoder (DataFusion owns the loop): [apache/datafusion#20839](https://github.com/apache/datafusion/pull/20839)
* Morsel-style work scheduling: [apache/datafusion#21351](https://github.com/apache/datafusion/pull/21351)
* Runtime reorder for `TopK` convergence: [apache/datafusion#21956](https://github.com/apache/datafusion/pull/21956)
* **Runtime row-group dynamic pruning ([#22450])** — the centerpiece of this post.

In flight / open:

* Page-level reverse (arrow-rs): [apache/arrow-rs#9937](https://github.com/apache/arrow-rs/pull/9937), discussion in [apache/arrow-rs#9934](https://github.com/apache/arrow-rs/issues/9934)
* `peek_next_row_group` API for per-RG `fully_matched` RowFilter skip (arrow-rs): [apache/arrow-rs#10158](https://github.com/apache/arrow-rs/pull/10158)
* Page-level dynamic prune at RG boundary (Future B): [apache/datafusion#23216](https://github.com/apache/datafusion/issues/23216)
* Per-RG `fully_matched` RowFilter skip on top of [#22450] (blocked on arrow-rs#10158): [apache/datafusion#23067](https://github.com/apache/datafusion/issues/23067)
* Multi-column / function-wrapped stats reorder follow-ups: [apache/datafusion#22198](https://github.com/apache/datafusion/issues/22198)

Concretely useful issues for new contributors:

* [Add more `ExecutionPlan` impls to support sort pushdown][more-impls-issue].

[more-impls-issue]: https://github.com/apache/datafusion/issues/19394

Benchmark suites: [sort_pushdown](https://github.com/apache/datafusion/tree/main/benchmarks/queries/sort_pushdown), [topk_tpch](https://github.com/apache/datafusion/blob/main/benchmarks/src/sort_tpch.rs).
