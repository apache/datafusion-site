---
layout: post
title: Sort Pushdown in DataFusion: Skip Sorts, Skip I/O
date: 2026-05-25
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

Many [Apache Parquet] datasets are already sorted on disk. Time-series
files are usually written in ingestion-time order. Event logs are sharded
and sorted by event id. Partitioned tables come with a natural ordering
implied by the partition key. The information about that ordering is
sitting right there in the file metadata.

[Apache Parquet]: https://parquet.apache.org/

Until recently, [Apache DataFusion] would still re-sort those files on
every `ORDER BY` query. Every `SELECT ... ORDER BY ts LIMIT 100` did a
full external sort across the entire scan, even though the data was
already in that order. CPU wasted. Memory wasted. Streaming defeated.

[Apache DataFusion]: https://datafusion.apache.org/

This post walks through the **sort pushdown** work that closed
that gap. It covers two complementary capabilities — **sort
elimination via statistics** (the `Exact` path, which deletes the
`SortExec`) and **runtime reorder** (the `Inexact` path, which
keeps the `SortExec` but reads the most-promising data first for
`TopK` and `DESC` queries) — and lands real benchmark speedups of
**2.1×–49× on common queries**. The page-level reverse primitive
we are adding upstream in [arrow-rs] will push the `DESC` gains
further still.

[arrow-rs]: https://github.com/apache/arrow-rs

## TL;DR

* DataFusion can now **skip `SortExec` entirely** when input files are
  already in the requested order, and **read the most-promising data
  first** when they aren't — so `TopK` converges fast and the rest
  gets pruned by statistics.
* What's supported today:
  * **The `PushdownSort` rule** — a physical optimizer rule that
    asks each `ExecutionPlan` "can you produce output in *this*
    ordering?" and uses the `Exact` / `Inexact` / `Unsupported`
    answer to decide whether to delete the surrounding `SortExec`,
    leave it in place with a hint, or give up.
  * **Sort elimination via statistics** — `PushdownSort` sorts
    files within each partition by Parquet `min/max` statistics
    and, when the resulting ranges are provably non-overlapping,
    upgrades the source's ordering claim from `Unsupported` to
    `Exact` and **removes the `SortExec`** that `EnforceSorting`
    inserted earlier.
  * **Runtime reorder for `TopK` and `DESC` queries** — when the
    leading sort key is a plain column (or the reversed source
    ordering satisfies the request), the scan reorders files and
    row groups by `min/max` stats so the most-promising data is
    read first; for `DESC` requests it additionally flips
    iteration. `SortExec` stays `Inexact`, but `TopK`'s dynamic
    filter tightens fast and the rest is pruned. Full `SortExec`
    removal on `DESC` requires a page-level reverse primitive
    that's in flight in arrow-rs.
* Real-world benchmarks on the `sort_pushdown` suite (`Exact` path):
  `ORDER BY ... LIMIT` queries get **27× and 49× faster**; full
  `ORDER BY` scans get **~2×** faster.

## Why Sort Pushdown Matters

`SortExec` is one of the most expensive operators in a query plan.
It is blocking by construction — no row can leave until every input
row has been seen and compared — so it tends to dominate both latency
and peak memory. The cost gets paid even when:

* the file is already ordered by the sort key (very common for
  timestamp columns);
* the query only needs the top *N* rows (`ORDER BY ts LIMIT 100`), in
  which case full sort + truncate is wildly wasteful;
* the next operator (`SortPreservingMergeExec`, `SortMergeJoinExec`,
  a window function) was going to consume ordered input anyway.

The data DataFusion needs to avoid this work is **already in the file
metadata**. Parquet writers can record per-column statistics (`min`,
`max`) at the row-group level. Files written by Spark, DuckDB,
arrow-rs, and others routinely include them. And explicit `WITH ORDER`
clauses in DataFusion's SQL `CREATE EXTERNAL TABLE` give the optimizer
a direct ordering hint. The job of sort pushdown is to **use that
information**.

## How DataFusion Tracks Ordering

<img src="/blog/images/sort-pushdown/plan-diff.svg" alt="EXPLAIN before / after: SortExec eliminated once ordering is Exact" width="100%" class="img-fluid"/>

Each `FileScanConfig` carries an `output_ordering` — the ordering
that the optimizer is willing to claim for the scan's output. There
are two flavours:

* **`Exact`** — the optimizer is *certain* the output is in this order.
  Sort-handling rules treat an `Exact` ordering as a proof and **remove
  the surrounding `SortExec`**. ([`EnforceSorting`] does this when the
  scan declares `Exact` from the start; the sort pushdown rule covered
  in this post does the same upgrade later in the pipeline.)
* **`Inexact`** — the optimizer *believes* the output is probably
  ordered, but cannot prove it. Downstream operators like
  `SortPreservingMergeExec` can still benefit from this hint, but the
  explicit `SortExec` stays for safety.

[`EnforceSorting`]: https://docs.rs/datafusion-physical-optimizer/latest/datafusion_physical_optimizer/enforce_sorting/struct.EnforceSorting.html

A helper called `validated_output_ordering()` is the gatekeeper. It
walks the list of files inside a partition, checks whether the
declared per-file ordering is consistent with the file order on disk,
and either confirms the ordering or **strips it entirely** if it
sees something ambiguous (e.g. file `b` comes before file `a` in the
file list but file `a`'s range comes first).

### `Exact` and `Inexact` at runtime

`Exact` and `Inexact` lead to different runtime behaviour, and
distinguishing them up front makes the rest of this post easier to
follow:

* With **`Exact`**, the `SortExec` is removed and the LIMIT becomes
  a **static fetch** on the source. The reader stops the moment the
  requested number of rows has been emitted — early termination
  at batch granularity, no dynamic state needed.
* With **`Inexact`**, the `SortExec` stays in place. The LIMIT
  materialises inside the sort as a `TopK` heap of size K. `TopK`
  exposes a [**dynamic filter**][dyn-filters-blog] — a runtime
  expression of the form *"only rows that could still beat the
  current K-th-best value are worth considering"* — and pushes it
  back to the parquet scanner. As more data is processed and the
  heap tightens, the filter's threshold tightens with it, and entire
  row groups can be skipped by checking the live threshold against
  the row group's min/max statistics. (See the earlier
  [dynamic filters][dyn-filters-blog] post for the full background
  on this mechanism.)

Both paths use the same underlying min/max statistics, but for
different purposes: `Exact` uses them at plan time to prove
non-overlap and justify removing the sort; `Inexact` uses them at
runtime to skip row groups that can no longer improve the heap.

[dyn-filters-blog]: https://datafusion.apache.org/blog/2025/09/10/dynamic-filters/

The diagram above shows the result we want: the plan after sort
pushdown loses the `SortExec` node. Everything downstream — the
`SortPreservingMergeExec`, the `RepartitionExec`, the
`DataSourceExec` — was already in the plan. We just need the
optimizer to convince itself that the bottom of the plan is
producing the order requested.

## The `PushdownSort` Rule

The **`PushdownSort`** physical optimizer rule asks each
`ExecutionPlan` two questions:

1. "Can you produce output in *this* ordering?"
2. "If yes, please rearrange yourself so that it actually does."

The answer is one of `Exact`, `Inexact`, `Unsupported`. `Exact`
means the surrounding `SortExec` can be deleted entirely; `Inexact`
means the source will read the data in a near-sorted order so
`TopK` and other consumers benefit, but `SortExec` stays for
strict correctness. The rest of this post is what each merged
capability does on top of this protocol — first the `Exact` path,
then the `Inexact` path.

## Sort Elimination via Statistics

<img src="/blog/images/sort-pushdown/phase1-file-reorder.svg" alt="Sort elimination: rearranging files within a partition by min/max statistics so the file list is in range order" width="100%" class="img-fluid"/>

The initial `Inexact`-only path left a sharp edge that motivated
stats-based sort elimination. Consider this realistic scenario:

* Three files: `a.parquet`, `b.parquet`, `c.parquet`.
* Each declares `WITH ORDER (ts ASC)`.
* Internally each file *is* sorted by `ts`.
* But they were written by different ingestion jobs and end up listed
  in the **wrong order** on disk (e.g. alphabetical by name, not by
  time).

`validated_output_ordering()` looks at this, sees that the
file-internal ordering disagrees with the file-list order, and
**strips the ordering entirely**. From the optimizer's point of view
the scan now has no declared ordering, so `EnforceSorting` (which runs
earlier in the pipeline) inserts a `SortExec`. The data is sorted on
disk; the optimizer just can't tell.

Stats-based sort elimination fixes this in `PushdownSort`, which
runs late — after `EnforceDistribution` and `EnforceSorting` have
already shaped the plan. When `PushdownSort` finds a `SortExec`
above a file scan whose ordering was stripped (a `FileSource`
`Unsupported` result), it does three things inside
`FileScanConfig::try_pushdown_sort`:

1. **Sort the file list by per-file statistics on the sort
   column(s)** within each file group (the diagram above). The
   pre-existing [`MinMaxStatistics`] helper reads each file's
   `column_statistics[c].min_value` / `.max_value` for each sort
   column `c`, then sorts the file list by the min row.
   `sort_files_within_groups_by_statistics` does the per-group
   orchestration and decides whether any group is non-overlapping
   after the sort.
2. **Check adjacency within each group**: walk each sorted file group
   independently and ask whether `file[i].max ≤ file[i+1].min` for
   every adjacent pair (touching at the boundary is fine — value `v`
   showing up as the last row of one file and the first row of the
   next still produces a sorted stream). The check is **per file
   group**, not across groups; cross-group ordering is the job of
   `SortPreservingMergeExec` at runtime (more on this below).
3. **Upgrade `Unsupported` to `Exact`** when adjacency holds, the
   table has a declared `output_ordering` (from `WITH ORDER` or
   parquet `sorting_columns`), and the sort columns are null-free —
   the last condition preserves `NULLS LAST`/`NULLS FIRST` semantics
   across file boundaries. `PushdownSort` then removes the `SortExec`
   itself and the plan becomes streamable.

[`MinMaxStatistics`]: https://github.com/apache/datafusion/blob/main/datafusion/datasource/src/statistics.rs

One caveat that comes straight from `MinMaxStatistics`: the stats
sort only fires when every `ORDER BY` expression is a plain column.
`ORDER BY date_trunc('hour', ts)` silently skips the upgrade — there
is no per-file min/max for the function output to compare against.
Extending sort pushdown across monotonic function wrappers is one of
the open follow-ups.

(Runtime reorder covered later does handle some function-wrapped
sorts via monotonicity inference — but stats-based sort elimination
still needs a plain column.)

<img src="/blog/images/sort-pushdown/phase2-stats-overlap.svg" alt="Detecting non-overlapping ranges via min/max statistics" width="100%" class="img-fluid"/>

The diagram above contrasts the two cases. On the left, ranges are
non-overlapping after sort, so we can guarantee that emitting the
files in min-order produces a globally sorted stream. On the right,
the ranges overlap, so even after sorting the files by `min(ts)` we
cannot guarantee global ordering — the upgrade is skipped and
`SortExec` stays in place.

The implementation handles a few edge cases worth calling out:

* **Buffering the eliminated `SortExec`.** When the `SortExec` was
  sitting under a `SortPreservingMergeExec` with
  `preserve_partitioning=true`, it wasn't just sorting — it was also
  acting as an *implicit in-memory buffer* for the SPM above it. The
  SPM picks rows from each partition stream one at a time; without
  the upstream `SortExec` holding batches in memory, the SPM would
  read directly from I/O-bound sources and stall on every pick. The
  rule compensates by inserting a [`BufferExec`] in the `SortExec`'s
  place — bounded streaming buffer, same throughput shape, no
  blocking sort. Capacity is configurable via
  [`sort_pushdown_buffer_capacity`].
* **`fetch` preservation** through `EnforceDistribution`. The
  distribution rule sometimes strips a `SortExec`'s `fetch` field and
  re-adds the node later. The PR plumbs `fetch` through so a
  surviving `LIMIT` is not lost.
* **Per-group, not global, non-overlap.** The adjacency check is
  scoped to each file group. Two file groups can have *overlapping*
  ranges and the upgrade still fires, as long as each group is
  internally non-overlapping. That works because each group already
  produces an independently ordered stream at runtime, and
  `SortPreservingMergeExec` then picks rows across streams in value
  order to produce the final globally sorted output. The rule only
  has to prove the per-stream property.
* **Single-partition vs multi-partition execution.** The default
  multi-partition setup byte-range-splits files into single-file
  groups, after which `validated_output_ordering()` works on its
  own. Stats-based reorder only fires when files aren't split —
  typically `--partitions 1` or files small enough that the
  splitter leaves them alone.

[`BufferExec`]: https://github.com/apache/datafusion/blob/main/datafusion/physical-plan/src/buffer.rs
[`sort_pushdown_buffer_capacity`]: https://github.com/apache/datafusion/pull/21426

## Benchmarks

<img src="/blog/images/sort-pushdown/benchmark.svg" alt="Sort pushdown benchmark: 2x-49x speedup across four queries" width="100%" class="img-fluid"/>

The [`sort_pushdown`] benchmark suite reproduces the
"wrong-order file list" scenario by generating Parquet files whose
names are intentionally reversed against their sort-key ranges. Numbers
below are `--partitions 1`, release build, with stats-based sort
elimination enabled, versus `main`:

[`sort_pushdown`]: https://github.com/apache/datafusion/tree/main/benchmarks/queries/sort_pushdown

| Query                                       | Before  | After   | Speedup |
| ------------------------------------------- | -------:| -------:| -------:|
| Q1 — `ORDER BY key` (full scan)             | 259 ms  | 122 ms  | **2.1×** |
| Q2 — `ORDER BY key LIMIT 100`               |  80 ms  |   3 ms  | **27×**  |
| Q3 — `SELECT * ORDER BY key`                | 700 ms  | 313 ms  | **2.2×** |
| Q4 — `SELECT * ORDER BY key LIMIT 100`      | 342 ms  |   7 ms  | **49×**  |

The shape of the speedup is what you would expect once `SortExec` is
removed:

* **Full-scan queries (Q1, Q3)** still have to push every row through
  the pipeline, so the gain is "just" the cost of the sort itself —
  roughly half the original time. This matches the rule of thumb that
  a blocking sort doubles end-to-end latency on data that fits in
  memory.
* **`LIMIT` queries (Q2, Q4)** benefit much more because removing
  `SortExec` converts the LIMIT into a static `fetch` on the data
  source — the reader stops the moment K rows have been emitted,
  instead of reading the full file, sorting, and truncating.
  This is the "early termination at batch granularity" case from
  the runtime-difference section above. A 342 ms full-file scan
  collapses into a 7 ms K-row read.

The default multi-partition execution path is unaffected: those
plans already produce correct orderings via byte-range splitting,
so stats-based sort elimination simply does not fire there. No
regression and no behavior change for typical multi-threaded
queries.

## Runtime Reorder for `TopK` and `DESC` Queries

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

### Two independent triggers for `Inexact`

<img src="/blog/images/sort-pushdown/pr21956-decision.svg" alt="try_pushdown_sort decision tree: Exact, Inexact, or Unsupported" width="100%" class="img-fluid"/>

`try_pushdown_sort` first checks whether the natural ordering
already satisfies the request (→ `Exact`) or whether a non-empty
*proper prefix* of the request is already satisfied (→
`Unsupported`, so the outer `SortExec`'s `sort_prefix`
optimisation can fire instead). Otherwise it looks at two
**independent** Inexact signals — either one is enough, and they
compose when both apply:

**Stats-based RG reorder** — fires when the leading sort key is a
plain `Column` in the file schema. The opener sorts row groups by
`min(col)` via parquet statistics. Restrictive (plain physical
column only), but lets the scan globally reorder data so the
most-promising row group is decoded first.

**Iteration reverse** — fires when the source's declared ordering,
**reversed**, satisfies the request. This goes through the full
`EquivalenceProperties` reasoning machinery and is **strictly more
powerful** than the column-in-schema check above. It fires for:

* **Function monotonicity** — file declares `ts DESC`, request is
  `date_trunc('day', ts) ASC` → reversed `ts ASC` satisfies the
  request via monotonicity even though parquet has no stats keyed
  by the function. Same for `ceil(value)`, `CAST(x AS Date)`, etc.
* **Constant columns from filters** — `WHERE region = 'us'` marks
  `region` as constant in the equivalence class, so a request
  involving `region` is trivially satisfied.
* **Equivalence relationships** — `WHERE a = b` transfers a known
  ordering on `a` to a request on `b`.
* **Multi-column composite orderings** — the source's declared
  multi-key ordering reversed satisfies the multi-key request as a
  whole.

### Three runtime steps in the opener

<img src="/blog/images/sort-pushdown/pr21956-runtime-pipeline.svg" alt="Runtime reorder pipeline: file reorder, RG reorder, then optional reverse" width="100%" class="img-fluid"/>

The two triggers above set two fields on `ParquetSource`:

```rust
struct ParquetSource {
    sort_order_for_reorder: Option<LexOrdering>,  // what to reorder by
    reverse_row_groups:     bool,                 // whether to flip iteration
    // ...
}
```

The opener consumes them in three composable steps:

1. **File-level reorder** (`FileSource::reorder_files`). The shared
   morsel queue — a work-stealing primitive that lets sibling
   partitions share a single file pool — sorts the partitioned-file
   list by `min(col)`. The first file picked across all partitions
   is globally the most-promising one. Skipped when the stats
   reorder trigger didn't fire.
2. **Row-group-level reorder**
   (`PreparedAccessPlan::reorder_by_statistics`). Once a file is
   opened, sort its row groups by `min(col)` ASC so the most-promising
   row group is decoded first. Same trigger as step 1; the two
   layers nest because a file's `min(col)` is the minimum over its
   row groups' `min(col)` values.
3. **Iteration reverse** (`PreparedAccessPlan::reverse`). Flips the
   row-group iteration order. For `DESC` requests on a plain
   column the flip composes with steps 1–2 (ASC-by-min → reverse →
   DESC-by-min). For the function-wrapped / constants-from-filters /
   multi-column cases, steps 1–2 are skipped and this is the only
   step that runs — just a flip of the file's natural order.

Both flags surface on the `DataSourceExec` line in `EXPLAIN`:

```text
DataSourceExec: file_groups=..., file_type=parquet,
  sort_order_for_reorder=[a@0 ASC], reverse_row_groups=true
```

### `ORDER BY ... DESC` in practice

A `DESC` request on an ASC-sorted plain column goes through both
triggers — the stats reorder normalises to ASC-by-min and the
iteration reverse flips to DESC-by-min. The result is *"RGs
descending × rows ascending"* — close to the requested order but
not strictly DESC, hence `Inexact`. The `SortExec` stays for
correctness, but `TopK`'s dynamic filter tightens fast because the
first row groups read already contain values near the final
answer, so subsequent row groups can be skipped via min/max
statistics. This is what powers fast `ORDER BY ts DESC LIMIT N` on
ASC-sorted files today.

Why not full `Exact` reverse that deletes the `SortExec` outright?
Decoding a whole row group forward, reversing the buffer, then
emitting works — but peaks at ~128 MB vs. the few-MB-per-batch
streaming profile readers expect. `Exact` reverse waits on a
page-level primitive that keeps the runtime win on a streaming
memory budget — covered in the roadmap below.

### When neither Inexact trigger fires

* **Aggregations on the sort key** — `SELECT URL, COUNT(*) AS c FROM
  hits GROUP BY URL ORDER BY c DESC LIMIT 10` (the ClickBench TopK
  shape). The leading sort key `c` is an aggregate result with no
  per-RG stats and no equivalence to a file column, so neither
  trigger fires. Pushing sort metadata through `AggregateExec` is a
  separate problem entirely.
* **Function-wrapped sort with no source-declared ordering** — the
  reversed-equivalence branch has nothing to invert.
* **Source declares a forward prefix of the request** —
  `try_pushdown_sort` returns `Unsupported` so the surrounding
  `SortExec` can keep its `sort_prefix` annotation; prefix-aware
  early termination in `TopK` is strictly better than reorder on
  data that's already in prefix order on disk.

## Current Bottlenecks

Sort elimination removes the `SortExec` entirely when ranges are
non-overlapping — there's nothing more to optimize on that path.
The `Inexact` runtime-reorder path is where the merged work still
leaves performance on the table. Three concrete inefficiencies:

### Bottleneck 1: `SortExec` stays on top, so `LIMIT N` does not propagate as a static stop signal

In the `Inexact` path the `SortExec` stays in the plan and
`TopK`'s fetch belongs to `SortExec`, not to the parquet scan.
The only thing that can cut work below the `SortExec` is the
dynamic-filter pushdown: as the heap fills, the filter
(`ts > threshold`) is pushed to the source and its threshold
tightens with every batch. That filter does **stats-prune
subsequent, not-yet-opened row groups** — if a row group's
`max(ts) < threshold` it is skipped without decode. But the
`SortExec` keeps pulling batches, and the outer operator does its
own final ordering pass on the "RGs descending × rows ascending"
stream even after the heap is settled. We have measured this
in-house: swapping our internal `Exact` reverse for upstream's
`Inexact` reverse + `TopK` on `ORDER BY ts DESC LIMIT N` makes
end-to-end latency go **up**, not down — exactly because the
`SortExec` final pass and the per-row heap maintenance pile up on
top.

### Bottleneck 2: Inside the currently-open row group, the sort column is fully decoded

Even with the dynamic filter pushed all the way to parquet, the
filter has to be evaluated row-by-row inside the open row group:
the sort column has to be **fully decoded** so each value can be
compared against the threshold, the surviving rows feed the heap
to tighten the threshold, and only then can the resulting
`RowSelection` skip the *other* columns for rows that didn't
pass. For `ORDER BY ts DESC LIMIT 10` on a 1M-row row group that
is ~1M sort-column decodes regardless of `N`. Parquet doesn't
allow partial row-group reads, so even an RG-level `Exact`
reverse would pay this same cost — the only way to materially
reduce it is to drop to page granularity.

### Bottleneck 3: File-granular work scheduling can't close the tap mid-file

Once a `FileStream` picks up a file from the shared work queue,
it has to finish that file. Today's dynamic work scheduling is
**file-granular**: idle partitions stop pulling new files from
the queue once a global limit is satisfied, but the partition
that's currently inside a file decodes that file's remaining row
groups regardless. The work queue holds `PartitionedFile`, not
row-group descriptors. So even with a tight threshold and
aggressive stats pruning of un-opened row groups, the *currently
open* file gets read to completion.

## Roadmap: Removing the Bottlenecks

### Page-level `Exact` reverse — addresses bottlenecks 1 + 2

<img src="/blog/images/sort-pushdown/reverse-scan.svg" alt="Row-group reverse (128 MB peak, ~8 pages decoded) vs page reverse (1 MB peak, 1 page decoded)" width="100%" class="img-fluid"/>

Parquet's `OffsetIndex` gives us byte-precise locations for every
data page in a column chunk, so we can `seek` directly to the last
page, decode it forward, reverse the resulting batch, and emit.
Peak buffer drops from ~128 MB (one row group) to ~1 MB (one
page), and first-batch latency drops to the cost of one page
decode — the row-group-level memory cliff disappears. With each
batch already in DESC order, `PushdownSort` can finally return
`Exact` for `DESC` requests, the `SortExec` is removed, and
`LIMIT N` becomes a static fetch on the source. The
`Inexact`-final-ordering-pass overhead from Bottleneck 1 goes
away outright, and the Bottleneck-2 decode reduces to the rows
the page-level seek actually pulls in.

Why not reverse the rows *within* a page directly? Because we
can't. Parquet's page encodings (RLE, dictionary, delta,
bit-packing) are all forward streams — you cannot decode the last
value without decoding every value that came before it. The
design is: **reverse the page traversal, forward-decode each
page, reverse the resulting `RecordBatch`**.

The primitive is landing upstream in arrow-rs. Early numbers on a
100k-row, 98-page column chunk show **~50× faster
time-to-first-N** for `n ≤ 1 page` and **~9× faster** for `n`
spanning 10 pages, compared with the row-group-level `Exact`
reverse. The DataFusion-side integration that turns this primitive
into an `Exact` result is a follow-up gated on the arrow-rs merge.

The killer use case is **filtered reverse `TopK`**:

```sql
SELECT * FROM events
WHERE user_id = 42
ORDER BY ts DESC
LIMIT 10
```

`RowSelection::with_limit` cannot help here — you don't know in
advance which rows match `user_id = 42`, so you can't pre-compute
a selection of the "last 10 matching rows". The only correct
strategy is to stream pages backward, evaluate the filter on
each, and stop when 10 matches are collected. Row-group reverse
stops at a ~128 MB granularity. Page reverse stops at ~1 MB
granularity. For a selective filter, the saving compounds.

### Row-group-level dynamic early termination — addresses bottleneck 3

The work queue today holds `PartitionedFile`. Switching it to
hold **row-group descriptors** lets a partition stop mid-file the
moment a global signal says `TopK` has K confirmed winners. Two
flavors depending on whether file ranges actually overlap after
stats reorder:

* **Non-overlapping ranges.** The first file globally contains
  the smallest values, the second contains the next batch, and so
  on. Once `TopK`'s threshold passes file 0's max, every
  subsequent file is pruned by stats already — the only fix
  needed is the RG-granular queue so the partition currently
  inside file 0 also stops at the right RG.
* **Overlapping ranges.** The smallest *next* value could sit in
  any of several open files. Matching the non-overlap efficiency
  requires actively comparing each open file's next-RG `min` and
  pulling from whichever is smallest — a **k-way merge across
  files** at RG granularity. The dynamic-filter pushdown already
  approximates this implicitly (an RG whose `max < threshold` is
  dropped), but explicit k-way comparison would close the tap
  earlier when the filter tightens slowly across overlapping
  files.

A natural extension of the existing morsel-style work scheduling
but not yet on a PR.

The two roadmap items above are *complementary*, not
alternatives:

* `Exact` reverse closes the tap for `DESC` queries by removing
  the `SortExec` entirely.
* Row-group-level scheduling closes the tap for `Inexact` queries
  where `Exact` still cannot fire (function-wrapped sorts,
  overlapping ranges) — the `SortExec` stays, but the scan stops
  pulling row groups once `TopK` is satisfied.

### Preview: the combined statistics-driven `TopK` pipeline

The [combined statistics-driven `TopK` pipeline] is the in-flight
work that stacks several of these mechanisms: pre-scan
[TopK threshold init from parquet statistics],
[global file reorder in the shared queue], and the runtime
row-group / file reorder + reverse already merged. On a
microbenchmark (single file, 61 sorted row groups, `--partitions 1`)
**60 of the 61 row groups are skipped**, only one is decoded:

| Query                          | Baseline | With pipeline | Speedup |
| ------------------------------ | -------: | ------------: | ------: |
| `ORDER BY col DESC LIMIT 100`  | 28.5 ms  | 1.64 ms       | **17×** |
| `ORDER BY col DESC LIMIT 1000` | 22.2 ms  | 0.37 ms       | **60×** |
| `SELECT * ORDER BY ... LIMIT 100`  | 22.5 ms  | 0.66 ms       | **34×** |
| `SELECT * ORDER BY ... LIMIT 1000` | 22.4 ms  | 0.61 ms       | **37×** |

This pipeline still reports `Inexact` — the `SortExec` stays on
top to enforce correctness across overlapping ranges — so it pays
the Bottleneck-1 and Bottleneck-3 overheads listed above. The
17×–60× is what statistics-driven RG-level pruning alone can
deliver; `Exact` reverse + row-group-level early termination is
what pushes it further.

### Extending the stats reorder step

Alongside removing the bottlenecks above, the
[stats reorder step itself has room to grow][stats-reorder-followup].
Today it only uses the leading sort key on a plain column — reverse
already handles function-wrapped and multi-column cases via
`EquivalenceProperties` reasoning, but stats-based RG ordering only
fires on a plain leading column. Lexicographic multi-key reorder via
`arrow::compute::lexsort_to_indices` is low-hanging fruit; extending
to monotonic function wrappers via leaf-column extraction (e.g.
`date_trunc('day', ts)` → use `min(ts)`) needs a bit more
`EquivalenceProperties` integration but is doable.

[morsel-style work scheduling]: https://github.com/apache/datafusion/pull/21351
[global file reorder in the shared queue]: https://github.com/apache/datafusion/issues/21733
[TopK threshold init from parquet statistics]: https://github.com/apache/datafusion/pull/21712
[combined statistics-driven `TopK` pipeline]: https://github.com/apache/datafusion/pull/21580
[stats-reorder-followup]: https://github.com/apache/datafusion/issues/22198

Concretely useful issues for new contributors:

* [Umbrella issue for sort pushdown][umbrella-issue].
* [Reorder row groups by statistics within each file][rg-reorder-issue].
* [Add more `ExecutionPlan` impls to support sort pushdown][more-impls-issue].

[umbrella-issue]: https://github.com/apache/datafusion/issues/17348
[rg-reorder-issue]: https://github.com/apache/datafusion/issues/21317
[more-impls-issue]: https://github.com/apache/datafusion/issues/19394

## Acknowledgements

Thank you to [@alamb], [@adriangb], [@xudong963], [@2010YOUY01], and
[@Dandandan] for reviewing the design and the patches across many
iterations. The DataFusion community's willingness to engage deeply
with optimizer changes — including the ones that touch foundational
invariants — is what made this work possible.

[@alamb]: https://github.com/alamb
[@adriangb]: https://github.com/adriangb
[@xudong963]: https://github.com/xudong963
[@2010YOUY01]: https://github.com/2010YOUY01
[@Dandandan]: https://github.com/Dandandan

## References

Prior post this work builds on:

* [Dynamic Filters: Passing Information Between Operators During Execution for 25x Faster Queries][dyn-filters-blog] — the dynamic filter primitive `TopK` uses.

Landed PRs that make up this work:

* `MinMaxStatistics` foundation: [apache/datafusion#9593](https://github.com/apache/datafusion/pull/9593)
* `PushdownSort` rule + row-group reverse: [apache/datafusion#19064](https://github.com/apache/datafusion/pull/19064)
* Reverse-output redesign: [apache/datafusion#19446](https://github.com/apache/datafusion/pull/19446), [apache/datafusion#19557](https://github.com/apache/datafusion/pull/19557)
* Sort elimination via statistics: [apache/datafusion#21182](https://github.com/apache/datafusion/pull/21182)
* `BufferExec` capacity for sort elimination: [apache/datafusion#21426](https://github.com/apache/datafusion/pull/21426)
* Morsel-style work scheduling: [apache/datafusion#21351](https://github.com/apache/datafusion/pull/21351)
* Runtime reorder for `TopK` convergence: [apache/datafusion#21956](https://github.com/apache/datafusion/pull/21956)
* Row-group-level `Inexact` reverse: [apache/datafusion#18817](https://github.com/apache/datafusion/pull/18817)

In flight / open:

* Page-level reverse (arrow-rs): [apache/arrow-rs#9937](https://github.com/apache/arrow-rs/pull/9937), discussion in [apache/arrow-rs#9934](https://github.com/apache/arrow-rs/issues/9934)
* TopK threshold init from parquet statistics: [apache/datafusion#21712](https://github.com/apache/datafusion/pull/21712)
* Combined statistics-driven `TopK` pipeline: [apache/datafusion#21580](https://github.com/apache/datafusion/pull/21580)
* Global file reorder in shared queue: [apache/datafusion#21733](https://github.com/apache/datafusion/issues/21733)
* Multi-column / function-wrapped reorder follow-ups: [apache/datafusion#22198](https://github.com/apache/datafusion/issues/22198)
* Umbrella issue for sort pushdown: [apache/datafusion#17348](https://github.com/apache/datafusion/issues/17348)

Benchmark suite: [`sort_pushdown`]
