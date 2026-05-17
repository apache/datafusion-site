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

This post walks through the **sort pushdown** work that closed that gap.
It is structured in two phases — file rearrangement first, then a
statistics-based proof of non-overlap — and lands real benchmark
speedups of **2.1×–49× on common queries**. The same machinery extends
to `ORDER BY ... DESC`, and the page-level reverse primitive we are
adding upstream in [arrow-rs] will push the gains further still.

[arrow-rs]: https://github.com/apache/arrow-rs

## TL;DR

* DataFusion can now **skip `SortExec` entirely** when input files are
  already in the requested order, and **read the most-promising data
  first** when they aren't — so `TopK` converges fast and the rest
  gets pruned by statistics.
* Three phases:
  * **Phase 1** — establish the `PushdownSort` rule and the
    `Exact` / `Inexact` / `Unsupported` protocol; ship the reverse
    row-group case for `ORDER BY ... DESC` (reports `Inexact`).
  * **Phase 2** — sort files within each partition by Parquet
    `min/max` statistics and *prove* non-overlap, upgrading
    `Unsupported` to `Exact` so `PushdownSort` removes the `SortExec`
    that `EnforceSorting` inserted earlier.
  * **Phase 3** ([#21956]) — generalise `Inexact`: whenever the
    leading sort key is a plain column in the file schema (or the
    source's reversed declared ordering satisfies the request),
    `try_pushdown_sort` stamps two flags on the source and the
    opener runs a three-step runtime pipeline — file-level reorder
    in the shared morsel queue, row-group reorder by min/max stats,
    then optional iteration reverse for `DESC` requests.
* Real-world benchmarks on the `sort_pushdown` suite (Phase 2's
  `Exact` upgrade): `ORDER BY ... LIMIT` queries get **27× and 49×
  faster**; full `ORDER BY` scans get **~2×** faster.
* Reverse scans (`ORDER BY ... DESC`) ride the same machinery: a
  merged row-group-level reverse returns `Inexact` (Sort stays, but
  `TopK` terminates early); the page-level reverse primitive needed
  for `Exact` reverse — and so for full `SortExec` removal on `DESC`
  queries — is in flight in arrow-rs.

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
  [dynamic filters][dyn-filters-blog] and [limit pruning][limit-pruning-blog]
  posts for the full background on this mechanism.)

Both paths use the same underlying min/max statistics, but for
different purposes: `Exact` uses them at plan time to prove
non-overlap and justify removing the sort; `Inexact` uses them at
runtime to skip row groups that can no longer improve the heap.

[dyn-filters-blog]: https://datafusion.apache.org/blog/2025/09/10/dynamic-filters/
[limit-pruning-blog]: https://datafusion.apache.org/blog/2026/03/20/limit-pruning/

The diagram above shows the result we want: the plan after sort
pushdown loses the `SortExec` node. Everything downstream — the
`SortPreservingMergeExec`, the `RepartitionExec`, the
`DataSourceExec` — was already in the plan. We just need the
optimizer to convince itself that the bottom of the plan is
producing the order requested.

## Phase 1: The Pushdown API and Reverse Scans

Phase 1 ([#19064]) introduced the **`PushdownSort`** physical
optimizer rule and a uniform API for asking each `ExecutionPlan` two
questions:

[#19064]: https://github.com/apache/datafusion/pull/19064

1. "Can you produce output in *this* ordering?"
2. "If yes, please rearrange yourself so that it actually does."

The protocol uses three results — `Exact`, `Inexact`, `Unsupported` —
that downstream operators can interpret uniformly. The Parquet
`FileSource` answers by comparing the requested ordering against the
per-file declared ordering: if natural ordering satisfies the request,
it returns `Exact`; if the *reverse* of the declared ordering does,
it returns `Inexact` and flips on `reverse_row_groups=true` so the
scan reads row groups from last to first (the row-group-level reverse
covered later in this post); otherwise it returns `Unsupported`.

Phase 1's scope was deliberately narrow. It set up the API and
delivered the reverse-scan case end-to-end, but it did **not** add
any statistics-based file rearrangement — that came later in Phase 2.
A finer-grained extension that broadens this `Inexact` path with a
three-step runtime reorder pipeline landed in [#21956] — covered in
[Phase 3](#phase-3-runtime-reorder-for-inexact-pushdown) below.

Phase 1 also produced a useful side improvement:

* **Reverse-output redesign** ([#19446], [#19557]) extended the same
  rule to `DESC` queries — picked up again in the reverse-scan
  section below.

[#19446]: https://github.com/apache/datafusion/pull/19446
[#19557]: https://github.com/apache/datafusion/pull/19557

## Phase 2: Use Statistics to Prove Non-Overlap

<img src="/blog/images/sort-pushdown/phase1-file-reorder.svg" alt="Phase 2: rearranging files within a partition by min/max statistics so the file list is in range order" width="100%" class="img-fluid"/>

Phase 1 left a sharp edge that motivated Phase 2 ([#21182]). Consider
this realistic scenario:

[#21182]: https://github.com/apache/datafusion/pull/21182

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

Phase 2 fixes this in `PushdownSort`, which runs late — after
`EnforceDistribution` and `EnforceSorting` have already shaped the
plan. When `PushdownSort` finds a `SortExec` above a file scan whose
ordering was stripped (a `FileSource` `Unsupported` result), it does
three things inside `FileScanConfig::try_pushdown_sort`:

1. **Sort the file list by per-file statistics on the sort
   column(s)** within each file group (the diagram above). The
   pre-existing [`MinMaxStatistics`] helper (introduced in [#9593])
   reads each file's `column_statistics[c].min_value` /
   `.max_value` for each sort column `c`, then sorts the file list by
   the min row. Phase 2 wires this helper into the optimizer's
   `Unsupported` branch — `sort_files_within_groups_by_statistics`
   does the per-group orchestration and decides whether any group is
   non-overlapping after the sort.
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
[#9593]: https://github.com/apache/datafusion/pull/9593

One caveat that comes straight from `MinMaxStatistics`: the stats
sort only fires when every `ORDER BY` expression is a plain column.
`ORDER BY date_trunc('hour', ts)` silently skips the upgrade — there
is no per-file min/max for the function output to compare against.
Extending sort pushdown across monotonic function wrappers is one of
the open follow-ups.

*(Within #21956's `Inexact` path, `EquivalenceProperties`'s
monotonicity inference does let function-wrapped sorts benefit from
row-group iteration reverse when the source declares a compatible
natural ordering — but stats-based reorder still needs a plain
column.)*

<img src="/blog/images/sort-pushdown/phase2-stats-overlap.svg" alt="Phase 2: detecting non-overlapping ranges via min/max statistics" width="100%" class="img-fluid"/>

The diagram above contrasts the two cases. On the left, ranges are
non-overlapping after sort, so we can guarantee that emitting the
files in min-order produces a globally sorted stream. On the right,
the ranges overlap, so even after sorting the files by `min(ts)` we
cannot guarantee global ordering — Phase 2 correctly bails out and
keeps `SortExec` in place.

The implementation handles a few edge cases worth calling out:

* **Buffering the eliminated `SortExec`.** When the `SortExec` was
  sitting under a `SortPreservingMergeExec` with
  `preserve_partitioning=true`, it wasn't just sorting — it was also
  acting as an *implicit in-memory buffer* for the SPM above it. The
  SPM picks rows from each partition stream one at a time; without
  the upstream `SortExec` holding batches in memory, the SPM would
  read directly from I/O-bound sources and stall on every pick. Phase
  2 compensates by inserting a [`BufferExec`] in the `SortExec`'s
  place — bounded streaming buffer, same throughput shape, no
  blocking sort. Capacity is configurable via
  [`sort_pushdown_buffer_capacity`] ([#21426]).
* **`fetch` preservation** through `EnforceDistribution`. The
  distribution rule sometimes strips a `SortExec`'s `fetch` field and
  re-adds the node later. Phase 2 plumbs `fetch` through so a
  surviving `LIMIT` is not lost.
* **Per-group, not global, non-overlap.** Phase 2's adjacency check is
  scoped to each file group. Two file groups can have *overlapping*
  ranges and the upgrade still fires, as long as each group is
  internally non-overlapping. That works because each group already
  produces an independently ordered stream at runtime, and
  `SortPreservingMergeExec` then picks rows across streams in value
  order to produce the final globally sorted output. Phase 2 only has
  to prove the per-stream property.
* **Single-partition vs multi-partition execution**. With the default
  multi-partition setup, `EnforceDistribution` byte-range-splits files
  into single-file groups, after which `validated_output_ordering()`
  works correctly on its own. Phase 2 only triggers when files have
  not been split — typically `--partitions 1` runs, or files small
  enough that the splitter leaves them alone. In the typical `--partitions
  1` case the "per-group" distinction collapses (one group equals the
  whole table), which is why the example earlier in this section is
  drawn that way.

[`BufferExec`]: https://github.com/apache/datafusion/blob/main/datafusion/physical-plan/src/buffer.rs
[`sort_pushdown_buffer_capacity`]: https://github.com/apache/datafusion/pull/21426
[#21426]: https://github.com/apache/datafusion/pull/21426

## Benchmarks

<img src="/blog/images/sort-pushdown/benchmark.svg" alt="Sort pushdown phase 2 benchmark: 2x-49x speedup across four queries" width="100%" class="img-fluid"/>

The [`sort_pushdown`] benchmark suite reproduces the
"wrong-order file list" scenario by generating Parquet files whose
names are intentionally reversed against their sort-key ranges. Numbers
below are `--partitions 1`, release build, on the merged Phase 2
branch versus `main`:

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

It is worth saying explicitly what this change does **not** affect.
The default multi-partition execution path is unchanged: those plans
already produced correct orderings via byte-range splitting, so
Phase 2 simply does not trigger. There is no regression and no behavior
change for the typical multi-threaded query.

## Phase 3: Runtime Reorder for Inexact Pushdown

Phase 2 handles the `Exact` upgrade — strong correctness, sort
elimination — but only when the table has a declared
`output_ordering` *and* the files are provably non-overlapping after
sorting by min. Two large classes of queries fall outside that
window:

* **Unsorted data** — no `WITH ORDER`, no parquet `sorting_columns`.
  Phase 2 cannot fire because there is no ordering claim to upgrade.
* **Overlapping ranges** — files written by different ingestion
  jobs share time windows. Phase 2 keeps the `SortExec` because the
  global ordering can't be proven, even though the files often do
  contain large stretches of in-order data.

For both, a full external `SortExec` is overkill. The parquet
metadata is right there, and reading the *most-promising* data
first lets `TopK`'s dynamic filter threshold tighten quickly so the
rest gets pruned. Phase 3 ([#21956]) wires that up by generalising
the `Inexact` path Phase 1 introduced.

### `try_pushdown_sort` — one decision, three outcomes

<img src="/blog/images/sort-pushdown/pr21956-decision.svg" alt="try_pushdown_sort decision tree: Exact, Inexact, or Unsupported" width="100%" class="img-fluid"/>

The `Exact` / `Inexact` / `Unsupported` protocol from Phase 1 stays.
Phase 3 broadens the **conditions** that route a query into
`Inexact`:

| Condition | Outcome |
| --- | --- |
| `eq_properties.ordering_satisfy(request)` | `Exact` — Phase 1 / 2 sort elimination |
| Leading sort key is a plain `Column` in the file schema, **or** the source's reversed declared ordering satisfies the request | `Inexact` — Phase 3 runtime pipeline |
| Neither | `Unsupported` — `SortExec` stays, no source-side optimisation |

The "reversed satisfies" branch is what handles function-wrapped
sorts (`date_trunc('day', ts) DESC`, `ceil(value) DESC`,
`CAST(x AS Date) DESC`) — `EquivalenceProperties`'s monotonicity
reasoning recognises that `f(col) DESC` is satisfied by `col ASC`
reversed, even though parquet has no stats keyed by `f(col)`
itself.

### Two flags on `ParquetSource`, three runtime steps

<img src="/blog/images/sort-pushdown/pr21956-runtime-pipeline.svg" alt="Phase 3 runtime pipeline: file reorder, RG reorder, then optional reverse" width="100%" class="img-fluid"/>

When `try_pushdown_sort` returns `Inexact`, it stamps two fields on
the `ParquetSource`:

```rust
struct ParquetSource {
    sort_order_for_reorder: Option<LexOrdering>,  // what to reorder by
    reverse_row_groups:     bool,                 // whether to flip iteration
    // ...
}
```

The opener reads them at scan time to drive three composable steps:

1. **File-level reorder.** `FileSource::reorder_files` sits in the
   shared morsel queue (the [#21351] work-stealing primitive) and
   sorts the partitioned-file list by `min(col)`. The first file
   picked across all partitions is globally the most-promising one.
2. **Row-group-level reorder.** Once a file is opened,
   `PreparedAccessPlan::reorder_by_statistics` sorts that file's
   `row_group_indexes` by `min(col)` ASC. The row group most likely
   to contribute to `TopK` is decoded first.
3. **Reverse.** For `DESC` requests,
   `PreparedAccessPlan::reverse` flips the iteration after the
   stats reorder normalises everything to ASC-by-min. Same
   primitive Phase 1 introduced for declared reverse scans — Phase
   3 just routes more queries through it.

The two layers **nest by construction**: file `i`'s `min(col)` is
a lower bound on every row group inside it, so the file queue's
order is a natural prefix of the within-file row-group order.
Choosing the same key (`min`) in both layers keeps the strategies
consistent.

`reverse_row_groups`'s meaning depends on which way `Inexact` was
reached. When the column-in-schema condition fires, the stats
reorder produces ASC-by-min, so `reverse_row_groups` simply mirrors
the request direction. When only the reversed-equivalence
condition fires (function-wrapped case with a declared source
ordering), `reverse_row_groups` is `true` unconditionally — there
is no stats reorder to compose with, just a flip of the file's
natural order.

Both flags surface on the `DataSourceExec` line in `EXPLAIN` so
plan inspection and snapshot tests can confirm the pushdown fired:

```text
DataSourceExec: file_groups=..., file_type=parquet,
  sort_order_for_reorder=[a@0 ASC], reverse_row_groups=true
```

Absence of either flag means the corresponding runtime step is a
no-op.

### When Phase 3 does *not* fire

* **Aggregations on top of the sort key.** `SELECT URL, COUNT(*) AS c
  FROM hits GROUP BY URL ORDER BY c DESC LIMIT 10` (the ClickBench
  TopK shape) — the leading sort key (`c`) is an aggregation result
  and has no per-RG stats in the parquet file, so the
  column-in-schema check fails. Pushing sort metadata through
  `AggregateExec` is a separate problem: the aggregated value
  doesn't exist before aggregation, so even if the metadata reached
  the scan there'd be nothing actionable to do with it.
* **Multi-column sort secondary keys.** The reorder currently only
  uses the leading sort expression — secondary keys are ignored.
  Tracked as a follow-up in [#22198].
* **Function-wrapped sort without a source-declared ordering.**
  Without a declared ordering to invert, the reversed-equivalence
  branch has nothing to satisfy. Tracked in the same follow-up.
* **Source declares a forward prefix of the request.** When the
  source's declared `output_ordering` is a non-empty proper prefix
  of the request (e.g. source `[a DESC, b ASC]`, request
  `[a DESC, b ASC, c DESC]`), `try_pushdown_sort` returns
  `Unsupported` so the surrounding `SortExec` can keep its
  `sort_prefix` annotation — prefix-aware early termination in
  `TopK` is strictly better than the Phase 3 reorder on data that
  is already in prefix order on disk.

## Reverse Scans for `ORDER BY ... DESC`

<img src="/blog/images/sort-pushdown/reverse-scan.svg" alt="Row-group reverse vs page reverse: 128MB and 8 pages vs 1MB and 1 page" width="100%" class="img-fluid"/>

`ORDER BY ts DESC` is the same problem in reverse. If a file is sorted
ascending and the query wants descending, we should be able to skip
the sort — we just need to read the data in the opposite order.

The first iteration of this lives in [#18817] and operates at the
**row group** level: it reverses the *iteration order of row groups*
so the last RG is opened first, but rows within each RG are still
decoded forward. The resulting stream is "RGs descending × rows
ascending" — close to the requested order, but not strictly DESC. The
optimizer therefore reports this as `Inexact` and leaves the
`SortExec` in place; the win is that `TopK`'s dynamic filter tightens
much faster, because the very first row groups read already contain
values near the final answer. A tight threshold means subsequent row
groups can be skipped via min/max statistics. This ships today and
is what powers fast `ORDER BY ts DESC LIMIT N` on ASC-sorted files.

[#18817]: https://github.com/apache/datafusion/pull/18817

To turn this into `Exact` reverse — so the `SortExec` can be removed
outright — each emitted batch itself has to be in DESC order. The
straightforward row-group-level approach (decode an entire RG forward,
materialize all rows, reverse the buffer, then emit) is correct and
was actually proposed first, in an earlier iteration of this work
([#18817], later closed and split into smaller pieces). Review
feedback there — primarily from [@2010YOUY01] — flagged the memory
profile as too aggressive: caching an entire row group's worth of
decoded rows before any batch can be emitted is roughly:

* **Peak buffer of one whole row group** (~128 MB by default), versus
  the few-MB-per-batch streaming profile readers normally have.
* **First-batch latency = full last-row-group decode**. For
  `ORDER BY ts DESC LIMIT 10` that means decoding ~1 million rows to
  return 10 — defeating the point of the `LIMIT`.

The agreed direction coming out of that discussion was to ship the
narrower `Inexact` row-group-reverse first (which became Phase 1 in
[#19064]), and to build `Exact` reverse on a finer-grained primitive
once `arrow-rs` exposed one.

### Empirical note — runtime cost of `Inexact` + `TopK`

We run an internal row-group-level `Exact` reverse implementation in
production and tested swapping in upstream's `Inexact` row-group
reverse + `TopK` on `ORDER BY ts DESC LIMIT N` queries. End-to-end
latency went **up**, not down. A few cost components stack up on the
`Inexact` + `TopK` side:

* **`LIMIT N` does not propagate as a static stop signal to the
  source.** In the `Inexact` path the `SortExec` stays on top and
  `TopK`'s fetch belongs to `SortExec`, not to the parquet scan. The
  only mechanism that can cut work below the `SortExec` is the
  dynamic-filter pushdown: as the heap fills, the filter (`ts >
  threshold`) is pushed to the source and its threshold tightens
  with every batch. That filter is enough to **stats-prune
  subsequent, not-yet-opened row groups** entirely — if a row
  group's `max(ts) < threshold` it is skipped without decode. But
  inside the row group the source is currently reading, the
  filter pushdown does not unwind to "stop": the sort column has
  to be **fully decoded** so the filter can be evaluated row by
  row, the surviving rows feed the heap to tighten the threshold,
  and only then can the resulting `RowSelection` skip the *other*
  columns for rows that didn't pass. For
  `ORDER BY ts DESC LIMIT 10` on a 1M-row row group that is still
  ~1M sort-column decodes regardless of `N`; the LIMIT only saves
  work on non-sort columns inside the same row group and on whole
  *subsequent* row groups that the tightened threshold can prune.
  The internal RG-level `Exact` reverse path, by contrast, deletes
  the `SortExec` so the LIMIT becomes a static fetch on the source.
  The source still has to decode the target row group in full —
  parquet does not allow partial row-group reads, so this part is
  the same as `Inexact` — but it then reverses the buffer in
  memory, takes the first K rows, and **stops**. No subsequent row
  group is opened, no stats check, no filter machinery, no per-row
  heap maintenance, no `SortExec` final ordering pass. The wins
  come from removing those per-row and per-RG overheads on top, not
  from decoding less sort-column data on the target row group.
* **`SortExec` itself adds ordering work on top of `Inexact`.** The
  reversed-RG stream is not strictly DESC (rows within each RG are
  still forward), so `Inexact` keeps the surrounding `SortExec`.
  Even when the heap is settled and the dynamic filter has
  pruned the tail, the outer operator does its own final ordering
  pass — overhead that `Exact` (which deletes the `SortExec`)
  does not pay.

Why didn't we just upstream the internal `Exact` reverse, then?
**Memory.** Parquet does not allow reading only part of a row
group, so any RG-level `Exact` implementation — ours included —
has to decode the entire row group, reverse the buffer in
memory, and only then emit. That is the same memory profile that
`#18817` was rejected for: a peak of one whole row group
(~128 MB) of decoded data, vs. the few-MB-per-batch streaming
profile readers normally have. Our runtime advantage over
`Inexact` + `TopK` does *not* come from decoding less — both
paths decode the relevant row group's sort column in full — it
comes from skipping the per-row heap maintenance, the dynamic
filter evaluation, and the `SortExec` final ordering pass that
`Inexact` keeps on top. So we end up running our `Exact` reverse
in-house but cannot land it as the upstream default for the same
memory reason that closed `#18817`.

**The fix that keeps both the runtime win and a streaming memory
profile is page-level `Exact` reverse via arrow-rs [#9937]**,
described next.

That primitive is the **page-level** reverse traversal. Parquet's
`OffsetIndex` already gives us byte-precise locations for every data
page in a column chunk, so we can `seek` directly to the last page,
decode it forward, reverse the resulting batch, and emit. Peak buffer
drops to one page (~1 MB) and first-batch latency drops to the cost
of one page decode — the row-group-level memory cliff disappears.

We are landing this primitive upstream in arrow-rs as
[#9937], with the discussion in [#9934]. Early numbers on a 100k-row,
98-page column chunk show **~50× faster time-to-first-N** for `n ≤ 1
page` and **~9× faster** for `n` spanning 10 pages, compared with the
row-group-level Exact reverse described above. The DataFusion-side
integration that turns this primitive into an `Exact` result is a
follow-up to #9937 and is gated on its merge.

[@2010YOUY01]: https://github.com/2010YOUY01

[#9937]: https://github.com/apache/arrow-rs/pull/9937
[#9934]: https://github.com/apache/arrow-rs/issues/9934

One natural question: why not reverse the rows *within* a page
directly? Because we can't. Parquet's page encodings (RLE, dictionary,
delta, bit-packing) are all forward streams — you cannot decode the
last value without decoding every value that came before it. The
design therefore is: **reverse the page traversal, forward-decode
each page, reverse the resulting RecordBatch**. This is the algorithm
shape that DataFusion's Phase-2 `RecordBatchReader` integration will
use once arrow-rs ships the primitive.

The killer use case is **filtered reverse TopK**:

```sql
SELECT * FROM events
WHERE user_id = 42
ORDER BY ts DESC
LIMIT 10
```

Here `RowSelection::with_limit` cannot help — you don't know in
advance which rows match `user_id = 42`, so you can't pre-compute a
selection of the "last 10 matching rows". The only correct strategy
is to stream pages backward, evaluate the filter on each, and stop
when 10 matches are collected. Row-group reverse stops at a
~128 MB granularity. Page reverse stops at ~1 MB granularity. For a
selective filter, the saving compounds.

## What's Next

Sort pushdown is a long-running line of work and there is more to do.
Beyond the `Exact` path described above, there is a complementary
**dynamic / TopK-driven path** that helps when `Exact` cannot apply —
e.g. when file ranges genuinely overlap, or when the sort is on a
function output rather than a plain column. The two directions are
not alternatives; they compose:

* **`Exact` reverse for `ORDER BY ... DESC`.** Today's row-group
  reverse returns `Inexact` and the `SortExec` stays on top; the
  arrow-rs page-level reverse primitive ([#9937]) is what unlocks
  `Exact` reverse on `DESC` queries (and therefore full `SortExec`
  elimination on `DESC`). Memory + first-batch latency rule out doing
  the same thing at the row-group level. Gated on #9937.
* **Dynamic / TopK-driven path.** When `Exact` cannot fire, `TopK`'s
  [dynamic filter][dyn-filters-blog] still benefits enormously from
  reading the *best* data first. This thread also builds on the
  [limit pruning][limit-pruning-blog] work that turned `LIMIT` into
  an I/O optimization across the pruning pipeline. The
  recently-merged morsel-style work scheduling in `FileStream`
  ([#21351]) gives sibling partitions a *shared work queue* with
  file-level work-stealing — no CPU sits idle when one partition
  runs out of files. The proposed [#21733] sorts files in
  that shared queue by per-file statistics *before* any partition
  picks, so the first file read is globally optimal and tightens the
  dynamic filter immediately. Combined with **TopK threshold init from
  parquet statistics** ([#21712]) and **`try_pushdown_sort` driving
  runtime row-group / file reorder + reverse** ([#21956], landed),
  the threshold can be set before reading a single byte. The reorder
  mechanism applies to any `ORDER BY <plain_col> [LIMIT N]` on
  parquet, not just TopK queries with a dynamic filter. The combined statistics-driven `TopK` pipeline is in flight
  as [#21580].

  The mechanism here is **RG-level pruning, not mid-stream early
  return**. With the threshold known up front, the parquet
  `PruningPredicate` rejects entire row groups against their min/max
  statistics before any I/O — those row groups are never decoded.
  The row group(s) the reader *does* open still have their sort
  column decoded in full to feed the dynamic filter. On the #21580
  microbenchmark (single file, 61 sorted row groups, `--partitions 1`),
  **60 of the 61 row groups are skipped** and only one is decoded:

  | Query                          | Baseline | With pipeline | Speedup |
  | ------------------------------ | -------: | ------------: | ------: |
  | `ORDER BY col DESC LIMIT 100`  | 28.5 ms  | 1.64 ms       | **17×** |
  | `ORDER BY col DESC LIMIT 1000` | 22.2 ms  | 0.37 ms       | **60×** |
  | `SELECT * ORDER BY ... LIMIT 100`  | 22.5 ms  | 0.66 ms       | **34×** |
  | `SELECT * ORDER BY ... LIMIT 1000` | 22.4 ms  | 0.61 ms       | **37×** |

  The stack reports `Inexact` — the `SortExec` stays on top to
  enforce correctness across overlapping ranges — so this path
  cannot do *true* mid-stream early return. Once the parquet reader
  opens a row group, the sort column has to be decoded all the way
  through; once a `FileStream` picks up a file from the shared work
  queue, it has to finish that file. Today's dynamic work scheduling
  ([#21351]) is **file-granular**: idle partitions stop pulling
  new files from the queue once a global limit is satisfied, but
  the partition that's currently inside a file decodes that file's
  remaining row groups regardless. Mid-file RG-level early return
  on `TopK` convergence is **not implemented yet** — the work
  queue holds `PartitionedFile`, not row-group descriptors.

  Closing the tap the moment `TopK` has K confirmed winners therefore
  needs either:

  * the **`Exact` path**, where the `SortExec` is gone entirely and
    the data source's own `fetch` becomes a static limit that the
    reader can honour at batch granularity; or
  * **finer-grained dynamic scheduling** — having the shared queue
    hold row-group descriptors instead of whole files, so a partition
    can release its current file's remaining row groups back to the
    pool once a global signal says enough TopK winners have been
    found. This is a natural extension of [#21351] and [#21733] but
    is not yet on a PR.

  The three mechanisms compose. Stats pruning saves the row groups
  that *can't* matter (skipped without I/O). The dynamic filter
  narrows what's decoded inside the row groups the reader does
  open. `Exact` or finer-grained scheduling is what eventually
  closes the tap once `TopK` is satisfied.
* **Filtered reverse TopK end-to-end.** `WHERE filter ORDER BY ts
  DESC LIMIT N` is the dominant observability query shape and the
  one where the arrow-rs page-reverse primitive matters most:
  `RowSelection::with_limit` cannot pre-compute the last `N` matching
  rows when the filter is selective, so the only correct strategy is
  to stream pages backward, evaluate the filter, and stop when `N`
  matches are collected. The DataFusion-side integration is the
  follow-up to #9937.
* **Unifying `EnforceDistribution` and `EnforceSorting`** into a
  single `EnsureRequirements` rule ([#21976]). The two existing rules
  are coupled through `SortExec.preserve_partitioning`, which makes
  their composition non-idempotent and has caused a class of
  production bugs. Other engines (Spark's `EnsureRequirements`,
  Trino's `AddExchanges`) handle both in a single rule. Merging them
  also gives future sort-related optimizations a single coherent place
  to live. In progress.
* **OFFSET pushdown to parquet** ([#21828]) so `ORDER BY ts LIMIT K
  OFFSET N` queries can skip the first `N` rows at the row-group level
  instead of decoding and discarding them. In progress.
* **Multi-column and function-wrapped reorder follow-ups** ([#22198]).
  The reorder mechanism in #21956 currently only uses the leading
  sort key and only fires on plain columns. Lexicographic multi-key
  reorder via `arrow::compute::lexsort_to_indices` is low-hanging
  fruit; extending to monotonic function wrappers via leaf-column
  extraction (e.g. `date_trunc('day', ts)` → use `min(ts)`) needs a
  bit more `EquivalenceProperties` integration but is doable.

[#21976]: https://github.com/apache/datafusion/pull/21976
[#21956]: https://github.com/apache/datafusion/pull/21956
[#22198]: https://github.com/apache/datafusion/issues/22198
[#21712]: https://github.com/apache/datafusion/pull/21712
[#21580]: https://github.com/apache/datafusion/pull/21580
[#21828]: https://github.com/apache/datafusion/pull/21828
[#21351]: https://github.com/apache/datafusion/pull/21351
[#21733]: https://github.com/apache/datafusion/issues/21733

Concretely useful issues for new contributors:

* [#17348] — the umbrella issue for sort pushdown.
* [#21317] — sort pushdown: reorder row groups by statistics within
  each file.
* [#19394] — add more `ExecutionPlan` impls to support sort pushdown.

[#17348]: https://github.com/apache/datafusion/issues/17348
[#21317]: https://github.com/apache/datafusion/issues/21317
[#19394]: https://github.com/apache/datafusion/issues/19394

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

Prior posts this work builds on:

* [Dynamic Filters: Passing Information Between Operators During Execution for 25x Faster Queries][dyn-filters-blog] — the dynamic filter primitive `TopK` uses.
* [Turning LIMIT into an I/O Optimization: Inside DataFusion's Multi-Layer Pruning Stack][limit-pruning-blog] — the pruning pipeline this work plugs into.

Issues and PRs:

* Umbrella issue: [apache/datafusion#17348][#17348]
* `MinMaxStatistics` foundation: [apache/datafusion#9593][#9593]
* Phase 1: [apache/datafusion#19064][#19064]
* Phase 2: [apache/datafusion#21182][#21182]
* `BufferExec` capacity for sort elimination: [apache/datafusion#21426][#21426]
* Dynamic / TopK-driven path: [apache/datafusion#21351][#21351] (morsel-style work scheduling),
  [apache/datafusion#21733][#21733] (global file reorder in shared queue)
* Benchmark suite: [`sort_pushdown`]
* Row-group reverse scan: [apache/datafusion#18817][#18817]
* Page-level reverse (arrow-rs): [apache/arrow-rs#9934][#9934],
  [apache/arrow-rs#9937][#9937]
* `EnsureRequirements`: [apache/datafusion#21976][#21976]
