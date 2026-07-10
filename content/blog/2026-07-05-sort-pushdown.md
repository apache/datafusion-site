---
layout: post
title: Optimizing for Almost Sorted Data: Sort Pushdown in Apache DataFusion
date: 2026-07-05
author: Qi Zhu and Andrew Lamb
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

*[Qi Zhu](https://github.com/zhuqi-lucas) ([Massive](https://www.massive.com/)); [Andrew Lamb](https://github.com/alamb) ([InfluxData](https://www.influxdata.com/))*

**[Apache DataFusion] uses sortedness automatically — even when data is only
partially sorted or when no ordering was declared.** This post explains how
plan-time sort pushdown, runtime scan reordering, and row-group pruning driven
by [dynamic filters][dyn-filters-blog] make that possible.

[Apache DataFusion]: https://datafusion.apache.org/
[dyn-filters-blog]: https://datafusion.apache.org/blog/2025/09/10/dynamic-filters/

## Are Real Datasets Sorted?

Resorting data is prohibitively expensive for many workloads so fully sorting is often
not practical.

However, many real datasets are at least partly sorted when stored: time-series files by
ingestion time, event logs by event id, partitioned tables by partition key, and
data lakes based on [Apache Iceberg] and similar formats in write order.

Sortedness only helps if the query engine can detect and use it. Two common
cases make that hard:

1. The ordering is undeclared in the file. For example, the writer did not set Parquet
   [`sorting_columns`](https://github.com/apache/parquet-format/blob/8a5e04bdecf100e8e981daacfa117e8b5aadacb9/src/main/thrift/parquet.thrift#L1044),
   or the table was not created with DataFusion's
   [`WITH ORDER`](https://datafusion.apache.org/user-guide/sql/ddl.html#create-external-table) clause.
2. Files are individually sorted, but the engine is canning multiple files
   and does not know a global ordering at plan time.

In both cases, `ORDER BY` or `ORDER BY ... LIMIT N` pays for a blocking full
sort, which buffers every row and dominates latency and peak memory on large
scans.

Min/max statistics used for *predicate* pushdown are well-known and
widely implemented across databases, as covered in [@XiangpengHao]'s
earlier post on [Parquet pruning][parquet-pruning-blog]
and the [Pruning in Snowflake: Working Smarter, Not Harder] paper.
Using them to
*reason about sort order* — deleting redundant sorts and biasing scan
order toward the most-promising data — is less common and what this blog is about.

[Apache Iceberg]: https://iceberg.apache.org/
[@XiangpengHao]: https://github.com/XiangpengHao
[parquet-pruning-blog]: https://datafusion.apache.org/blog/2025/03/20/parquet-pruning
[Pruning in Snowflake: Working Smarter, Not Harder]: https://dl.acm.org/doi/10.1145/3722212.3724447

## Exact vs. Inexact Ordering

DataFusion has long skipped sorts when it knows the data is **exactly** sorted, as covered in
[@akurmustafa's earlier post on ordering analysis][ordering-analysis]:
if the table declares an ordering (via `WITH ORDER` or Parquet
`sorting_columns`) and the file listing matches it, the redundant sort is removed. 

This post is about **everything else** — the messier real-world cases
where sortedness exists but is **inexact** or not provable up front:

- Files listed in the "wrong" order on disk (each file is internally
  sorted, but the files are not globally ordered).
- Ordering is known, but the sort key ranges **overlap** across files.
- **No** declared ordering at all.
- `ORDER BY ... DESC` on ASC-sorted data.

This post covers three novel techniques:

1. **Statistics-based sort elimination** (`Exact`): Avoids sorts entirely by reorder files by min/max
   statistics to prove a global ordering.
2. **Runtime scan reorder** (`Inexact`): reorders the scan to read the most promising data
   first so TopK dynamic pruning converges earlier.  
3. **Runtime row-group dynamic pruning**: re-checks dynamic predicates at
   row-group boundaries and skips pruned groups before fetching bytes.

These techniques are implemented in DataFusion and together result in:

- **Sort elimination**: 2×–49× faster on ASC-LIMIT queries where the
  file list was in the wrong disk order.
- **Runtime row-group pruning**: 5 of 11 benchmark queries run 3–4×
  faster with zero regressions; total runtime drops −44%.

The rest of this post walks through each technique in detail.

[#22450]: https://github.com/apache/datafusion/pull/22450
[#20839]: https://github.com/apache/datafusion/pull/20839
[Apache Parquet]: https://parquet.apache.org/
[ordering-analysis]: https://datafusion.apache.org/blog/2025/03/11/ordering-analysis/

## How DataFusion Tracks Ordering

<img src="/blog/images/sort-pushdown/plan-diff.svg" alt="EXPLAIN before / after: SortExec eliminated once ordering is Exact" width="100%" class="img-fluid"/>

The [`PushdownSort`](https://github.com/apache/datafusion/blob/main/datafusion/physical-optimizer/src/pushdown_sort.rs)
optimizer rule classifies each scan below a sort as either `Unsupported`,
`Exact`, or `Inexact`, and records this information on DataFusion's
[`FileScanConfig`](https://docs.rs/datafusion-datasource/latest/datafusion_datasource/file_scan_config/struct.FileScanConfig.html):

- **`Unsupported`** — the optimizer cannot determine the ordering, so no sort is removed.
- **`Exact`** — the optimizer is *certain* the output is in this order,
  and removes redundant [`SortExec`](https://docs.rs/datafusion-physical-plan/latest/datafusion_physical_plan/sorts/sort/struct.SortExec.html) operators entirely.
- **`Inexact`** — the optimizer believes the output is probably ordered
  but cannot prove it. Downstream operators like
  [`SortPreservingMergeExec`](https://docs.rs/datafusion-physical-plan/latest/datafusion_physical_plan/sorts/sort_preserving_merge/struct.SortPreservingMergeExec.html) can still benefit, but the
  explicit sort must remain. In this case `TopK`'s
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
  from the most-promising data, so the `TopK` threshold is more likely to
  tighten quickly and prune the rest with statistics.


<img src="/blog/images/sort-pushdown/pruning_stack.svg" alt="Three-layer pruning: file-level, row-group-level, row-level, all driven by the same TopK dynamic filter" width="100%" class="img-fluid" /><br/>
*Figure three pruning layers, all driven by the same `TopK` dynamic filter.*

* **Layer 1 · file-level** (`file_pruner` + `EarlyStoppingStream`).
  Skips files completely before they're opened -- no Parquet data or  metadata I/O is performed.
* **Layer 2 · row-group-level** ([#22450]). Skips dead row groups
  inside open files at every row-group boundary. Bytes never
  fetched, filter column never decoded.
* **Layer 3 · row-level** (`RowFilter`). For row groups that
  survive Layer 2, the filter is evaluated row-by-row on
  the predicate columns. If the all rows are filtered
  remaining columns are never read or decoded. 

## The Exact Path: Sort Elimination via Statistics

<img src="/blog/images/sort-pushdown/phase1-file-reorder.svg" alt="File reorder: rearranging files within a partition by min/max statistics so the file list is in range order" width="100%" class="img-fluid" /><br/>
*Figure: file reorder by per-file `min/max` puts the file list in range
order without touching file contents.*

DataFusion already handled declared ordering with matching file order. It now
also uses Parquet min/max statistics to reorder files and prove global ordering
(relevant PRs: [apache/datafusion#19064][#19064] (rule scaffolding), and
[apache/datafusion#21182][#21182] (stats-based file reorder)).

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

The overlap case falls through to the `Inexact` path covered later.

### BufferExec: Buffering Without Sorting

<img src="/blog/images/sort-pushdown/buffer-exec-stall.svg" alt="SPM stalls when SortExec is removed in multi-partition plans" width="100%" class="img-fluid" /><br/>
*Figure: removing the per-partition `SortExec` leaves the top-of-plan
merge (`SortPreservingMergeExec`) directly consuming raw I/O; a stall
on any partition stalls the whole plan.*

Removing `SortExec` was not always faster in multi-partition plans: the deleted
sort had also acted as an implicit buffer. The fix was explicit buffering in
some plans; see
[apache/datafusion#21426](https://github.com/apache/datafusion/pull/21426)
for details, as shown in the following figure.

<img src="/blog/images/sort-pushdown/buffer-exec.svg" alt="BufferExec replaces the deleted SortExec with a bounded streaming buffer per partition" width="100%" class="img-fluid" /><br/>
*Figure: `BufferExec` is inserted where the `SortExec` used to live —
same greedy per-partition prefill, but no blocking sort.*

The fix is [`BufferExec`](https://github.com/apache/datafusion/blob/main/datafusion/physical-plan/src/buffer.rs):
a bounded per-partition prefill buffer that restores the greedy parallel I/O
driver role without sorting.

### Benchmark: sort_pushdown

We measured statistics-based sort elimination with DataFusion's
[`sort_pushdown`](https://github.com/apache/datafusion/tree/main/benchmarks/queries/sort_pushdown)
benchmark suite.

<img src="/blog/images/sort-pushdown/benchmark.svg" alt="Sort pushdown benchmark: 2x-49x speedup across four queries" width="100%" class="img-fluid" /><br/>
*Figure: `sort_pushdown` results (`--partitions 1`, release build). ASC
queries with the file list reversed against sort-key ranges.*

Numbers below are the `sort_pushdown` suite,
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

## The Inexact Path: Runtime Reorder for TopK and DESC

Stats-based sort elimination applies only when ordering is declared and file
ranges are non-overlapping after the min-based file reorder. Otherwise,
DataFusion keeps the sort but uses Parquet metadata to read the most-promising
data first, helping the `TopK` dynamic filter prune the rest earlier.

<img src="/blog/images/sort-pushdown/pr21956-decision.svg" alt="try_pushdown_sort decision tree: Exact, Inexact, or Unsupported" width="100%" class="img-fluid" /><br/>
*Figure: for each `SortExec` that `PushdownSort` tries to push down
into the scan, the data source returns `Exact` (drop the sort),
`Inexact` (bias the scan and keep the sort), or `Unsupported`.*

The `Inexact` verdict fires when stats-based reorder is available (the leading
sort key is a plain file column) or when the reverse of the source's declared
ordering satisfies the request. The latter uses DataFusion's
[equivalence-properties][ordering-analysis] reasoning, including monotonic
functions<sup id="fn1">[1](#footnote1)</sup>, constants inferred from filters,
and multi-column orderings.

### Scan Reordering

If `PushdownSort` determines `Inexact` applies and the source supports it, the
Parquet opener applies runtime reordering as follows:

<img src="/blog/images/sort-pushdown/pr21956-runtime-pipeline.svg" alt="Runtime reorder pipeline: file reorder, RG reorder, then optional reverse" width="100%" class="img-fluid" /><br/>
*Figure: the Parquet opener applies file-level reorder → row-group-level
reorder → optional iteration reverse.*

The Parquet opener applies up to three composable steps at query start:

1. **File-level reorder** — the file list is sorted by `min(col)`,
   so the most-promising file is picked first across all partitions.
2. **Row-group-level reorder** — once a file is opened, its row groups
   are sorted by `min(col)`.
3. **Iteration reverse** — flip row-group iteration order for `DESC`
   requests.

### File-Level Early Stop

<img src="/blog/images/sort-pushdown/desc_walk_file.png" alt="File-level reorder with early stop via file_pruner" width="100%" class="img-fluid" /><br/>
*Figure: after file reorder, low-value files (`file_d` and `file_c`,
where "low-value" means the sort key values are smaller for ASC queries)
at the tail of the queue are cut by the file-level pruner before they
are ever opened — no metadata I/O.*

Once files are ordered "most-promising first", `TopK`'s heap fills quickly and
its dynamic filter threshold tightens. The [`FilePruner`](https://github.com/apache/datafusion/blob/main/datafusion/pruning/src/file_pruner.rs)
then cuts low-value files before opening them — no footer, page index, or data
I/O.

### Row-Group Filter Early Stop

<img src="/blog/images/sort-pushdown/desc_walk_rg.png" alt="Row-group-level reorder — filter column still read for every row group before row-group filter early stop" width="100%" class="img-fluid" /><br/>
*Figure: inside a file, the first row group tightens the threshold —
subsequent row groups have their projection columns short-circuited,
but the filter column still has to be read to discover that no rows
qualify.*

Reordering row groups so the ones most likely to contain the minimum
value are read first makes the existing `TopK` dynamic filters +
[filter pushdown](https://datafusion.apache.org/blog/2025/03/21/parquet-pushdown/)
optimization more effective, and they can often rule out entire row
groups after evaluating just the filter columns, avoiding fetching any
projection columns. This optimization was added in
[apache/datafusion#22450][#22450].

## Runtime Row-Group Dynamic Pruning

DataFusion now also re-checks the dynamic filter **at every row-group
boundary** inside an open file (only when the dynamic filter has been
updated since the initial check), converts the live threshold into a
fresh `PruningPredicate`, and physically removes any row group whose
min/max can't possibly beat the threshold. The pruned row groups are
**never decoded, not even on the filter column**.

### Decoder Loop and Decision Point

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

The pruner does expensive work only when it can help: a cheap epoch check
detects dynamic-filter changes, and only then rebuilds the pruning predicate.
The predicate is then applied to remaining row groups' min/max statistics using
metadata only.

### TopK Row-Group Pruning Example

This section walks through an example of how the techniques described in
this blog work together to prune row groups.

<img src="/blog/images/sort-pushdown/rg_cascade.png" alt="Cascading prune: one row group fills the heap, threshold snaps, all subsequent row groups are pruned in a single pass" width="100%" class="img-fluid" /><br/>
*Figure: for `ORDER BY x DESC LIMIT 10`, opening the first row group
(values [90..100)) is enough to fill the heap; at the next boundary,
every remaining row group with `max < 90` is pruned in one pass.*

For `ORDER BY x DESC LIMIT 10` on a 10-row-group file
where reorder puts high-value row groups first:

1. RG 9 (values `[90..100)`) opens. One row group is enough to fill
   the heap of size 10 — the threshold jumps into RG 9's range (≥ 90).
2. At the next row-group boundary, the pruner sees that all of RG 8
   through RG 0 have `max < 90` and drops them in one pass.
3. Bytes for those nine row groups were **never fetched** — not
   projection columns, not the filter column. Full I/O, decompression,
   and decoding are all skipped.

This is what runtime row-group dynamic pruning fundamentally provides:
when reordering lines up disjoint per-RG ranges (the common case for
time-series or partition-key sorts), a single row group can
cascade-eliminate every remaining row group at the next boundary.

## Benchmark: topk_tpch

The [`topk_tpch`](https://github.com/apache/datafusion/blob/main/benchmarks/src/sort_tpch.rs)
benchmark runs 11 TPC-H SF1 queries, all of the shape
`ORDER BY ... LIMIT 100`. The data is stored in Parquet, sorted by
`l_orderkey` (lineitem's physical sort key — a `BIGINT` with ~1.5M
distinct values per SF1), so per-RG `min/max` ranges are cleanly disjoint.
We compare DataFusion 54 with the sort optimizations described in this blog
disabled versus enabled.

<img src="/blog/images/sort-pushdown/topk_tpch_bench.png" alt="topk_tpch benchmark results: 5 of 11 queries 3-4× faster, 0 regressions, total -44%" width="100%" class="img-fluid"/>

Headline numbers:

| Metric                              | Value                              |
| ----------------------------------- | ---------------------------------- |
| Total wall-clock (sum of 11 queries) | 248.8 ms → 139.1 ms (**−44%**)    |
| Queries with ≥2× speedup            | **5 of 11** (Q2, Q4, Q8, Q9, Q10) |
| Queries with regression             | **0**                              |
| Best single-query speedup           | **~4×**                            |

The five fast queries all use `l_orderkey` as the **leading** sort key, so
`Layer 2` can cascade-prune aggressively. The other queries lead with
low-cardinality or unsorted columns (`l_linenumber`, `l_comment`,
`l_shipmode`), whose per-RG ranges overlap heavily. Even when `l_orderkey`
appears later as a tie-breaker, the leading key controls RG-level disjointness,
so `Layer 3` (row-level) is still partially effective.

Several common time-series workloads are accelerated 3–4× with zero
regressions, and the optimization becomes a no-op when the data doesn't
help. The sweet spot —
sort key aligned with the physical layout — is the common case for
time-series, partitioned tables, and ingestion-ordered event logs.

## Future Directions

Two follow-ups are open. Page-level `Exact` reverse support needs an upstream
arrow-rs primitive ([arrow-rs#9937](https://github.com/apache/arrow-rs/pull/9937))
and would let `DESC` queries drop the sort. Page-level dynamic pruning at
row-group boundaries ([apache/datafusion#23216](https://github.com/apache/datafusion/issues/23216))
extends the same refresh-at-boundary pattern one level deeper in Parquet.

## Acknowledgements

Thank you to [@adriangb], [@alamb], [@xudong963], [@2010YOUY01], and
[@Dandandan] for reviewing the design and the patches across many
iterations. The DataFusion community's willingness to engage deeply
with optimizer changes — including the ones that touch foundational
invariants like who-drives-the-decode-loop — is what made this work
possible.

Thanks also to [Massive](https://www.massive.com/) for sponsoring this
work.

<a id="footnote1"></a><sup>[1](#fn1)</sup> For example, if the source declares
`ts DESC`, reversing that ordering gives `ts ASC`, which can satisfy
`date_trunc('day', ts) ASC`.

[@alamb]: https://github.com/alamb
[@adriangb]: https://github.com/adriangb
[@xudong963]: https://github.com/xudong963
[@2010YOUY01]: https://github.com/2010YOUY01
[@Dandandan]: https://github.com/Dandandan

## References

Umbrella issue tracking the entire effort:

* **[EPIC] Sort Pushdown · skip sorts and skip IO for ORDER BY / TopK queries: [apache/datafusion#23036](https://github.com/apache/datafusion/issues/23036)** — phase-by-phase status of all the PRs and follow-ups.

Major PRs:

* `MinMaxStatistics` foundation: [apache/datafusion#9593](https://github.com/apache/datafusion/pull/9593)
* `PushdownSort` rule + row-group reverse: [apache/datafusion#19064](https://github.com/apache/datafusion/pull/19064)
* Reverse-output redesign: [apache/datafusion#19446](https://github.com/apache/datafusion/pull/19446), [apache/datafusion#19557](https://github.com/apache/datafusion/pull/19557)
* Sort elimination via statistics: [apache/datafusion#21182](https://github.com/apache/datafusion/pull/21182)
* `BufferExec` capacity for sort elimination: [apache/datafusion#21426](https://github.com/apache/datafusion/pull/21426)
* Push-based Parquet decoder (DataFusion owns the loop): [apache/datafusion#20839](https://github.com/apache/datafusion/pull/20839)
* Morsel-style work scheduling: [apache/datafusion#21351](https://github.com/apache/datafusion/pull/21351)
* Runtime reorder for `TopK` convergence: [apache/datafusion#21956](https://github.com/apache/datafusion/pull/21956)
* **Runtime row-group dynamic pruning ([#22450])** — the centerpiece of this post.

In flight / open:

* Page-level reverse (arrow-rs): [apache/arrow-rs#9937](https://github.com/apache/arrow-rs/pull/9937), discussion in [apache/arrow-rs#9934](https://github.com/apache/arrow-rs/issues/9934)
* `peek_next_row_group` API for per-RG `fully_matched` RowFilter skip (arrow-rs): [apache/arrow-rs#10158](https://github.com/apache/arrow-rs/pull/10158)
* Page-level dynamic prune at RG boundary: [apache/datafusion#23216](https://github.com/apache/datafusion/issues/23216)
* Per-RG `fully_matched` RowFilter skip on top of [#22450] (blocked on arrow-rs#10158): [apache/datafusion#23067](https://github.com/apache/datafusion/issues/23067)
* Multi-column / function-wrapped stats reorder follow-ups: [apache/datafusion#22198](https://github.com/apache/datafusion/issues/22198)

Benchmark suites: [sort_pushdown](https://github.com/apache/datafusion/tree/main/benchmarks/queries/sort_pushdown), [topk_tpch](https://github.com/apache/datafusion/blob/main/benchmarks/src/sort_tpch.rs).

## Get Involved

- **Try it out**: Run your `ORDER BY` / `ORDER BY ... LIMIT N` queries on your own data and share what you see.
- **Work on a [good first issue](https://github.com/apache/datafusion/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)**, or pick up one of the [follow-ups](https://github.com/apache/datafusion/issues/23036) listed in the umbrella issue.
- **File issues or join the conversation**: [GitHub](https://github.com/apache/datafusion/) for bugs and feature requests, [Slack or Discord](https://datafusion.apache.org/contributor-guide/communication.html) for discussion.
- Learn more by visiting the [DataFusion](https://datafusion.apache.org/index.html) project page.
