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
2. Files are individually sorted, but the engine is scanning multiple files
   and does not know a global ordering at plan time.

In both cases, `ORDER BY` or `ORDER BY ... LIMIT N` pays for a potentially blocking full
sort, which buffers every row and dominates latency and peak memory on large
scans.

Min/max statistics for *predicate* pushdown are well-known and widely
implemented across databases, as covered in [@XiangpengHao]'s earlier
post on [Parquet pruning][parquet-pruning-blog]. Using the same
statistics to *reason about sort order* and to prune `ORDER BY ... LIMIT`
(top-k) queries is also increasingly common: the
[Pruning in Snowflake: Working Smarter, Not Harder] paper describes
top-k pruning that keeps the current k-th-best value and
skips micro-partitions whose min/max cannot beat it, and systems such as
ClickHouse, DuckDB, PolarDB, and InfluxDB IOx apply closely related
ideas (see [Related Work](#related-work)). This post describes 
these techniques for a general audience, including the less-common case of *discovering* a provable
global sort order from per-file statistics when no ordering was declared,
deleting redundant sorts, and biasing scan order toward the
most-promising data.

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

This post describes two primary techniques:

1. **Statistics-based sort elimination** (`Exact`): avoids sorts entirely by
   reordering files by min/max statistics to prove a global ordering. This
   extends DataFusion's existing statistics-based file-group ordering
   ([#9593]) and the classic "disjoint ranges concatenate rather than
   merge" idea (see [Related Work](#related-work)) to the case where the
   *global* order across files was not known up front.
2. **Runtime reorder and dynamic pruning** (`Inexact`): reorders the scan to read
   the most-promising data first, then re-checks the `TopK` dynamic filter at file
   and row-group boundaries, skipping pruned data before fetching bytes. This
   follows the same runtime-threshold pattern used by Snowflake, ClickHouse,
   DuckDB, and PolarDB, applied here at file, row-group, and row granularity.

These techniques are implemented in DataFusion and together result in:

- **Sort elimination**: 2×–49× faster on `ORDER BY ... LIMIT`
  queries where the file list was in the wrong disk order.
- **Runtime row-group pruning**: 5 of 11 benchmark queries run ≥2× faster
  (up to ~4×) with zero regressions; total runtime drops −44%.

The rest of this post walks through each technique in detail.

[#22450]: https://github.com/apache/datafusion/pull/22450
[#20839]: https://github.com/apache/datafusion/pull/20839
[#9593]: https://github.com/apache/datafusion/pull/9593
[Apache Parquet]: https://parquet.apache.org/
[ordering-analysis]: https://datafusion.apache.org/blog/2025/03/11/ordering-analysis/

## Tracking Ordering


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

<img src="/blog/images/sort-pushdown/pr21956-decision.svg" alt="try_pushdown_sort decision tree: Exact, Inexact, or Unsupported" width="100%" class="img-fluid" /><br/>
*Figure: the `PushdownSort` rule asks each scan whether it can satisfy the
required ordering, returning `Exact` (drop the sort), `Inexact` (bias the scan
and keep the sort), or `Unsupported` (the sort stays).*

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

## Exact: Sort Elimination via Statistics

DataFusion can also eliminate sorts when it can use Parquet min/max statistics to reorder files and prove global ordering
(relevant PRs: [apache/datafusion#19064][#19064], and
[apache/datafusion#21182][#21182]) as shown below.

<img src="/blog/images/sort-pushdown/plan-diff.svg" alt="EXPLAIN before / after: SortExec eliminated once ordering is Exact" width="100%" class="img-fluid"/>
*Figure: EXPLAIN output before and after `PushdownSort` eliminates the sort. The `SortExec` is removed and the scan's ordering claim is upgraded to `Exact`.*



[#19064]: https://github.com/apache/datafusion/pull/19064
[#21182]: https://github.com/apache/datafusion/pull/21182

For example, consider three files `a.parquet`, `b.parquet`, `c.parquet`. Each is
internally sorted by `ts` and the time ranges do not overlap, but were written
by different jobs. Unless it is careful, a query engine will be forced to use a full
external sort for a query with `ORDER BY ts`, even when it could simply read the
files one after another and produce the correct result.

The `Exact` path has one important precondition: each file must be
*individually* sorted on the key. DataFusion knows this from the declared
ordering (`WITH ORDER` or Parquet `sorting_columns`); statistics alone
cannot establish within-file order. The min/max reasoning below proves
only that concatenating the already-sorted files *in range order* yields
a globally sorted stream. When no per-file ordering is declared, the
`Inexact` path (described next) applies instead.

`PushdownSort` fixes this in three steps at the file-scan node:

1. **Sort the file list by per-file `min`** on the sort column.
2. **Check overlap**: does `file[i].max ≤ file[i+1].min` hold for
   every adjacent pair? If yes, the sorted file list produces a globally
   sorted stream. (Equal values at a boundary, `file[i].max == file[i+1].min`,
   are safe for `ORDER BY key`.)
3. **Upgrade the source's ordering claim to `Exact`** and remove the
   surrounding `Sort`. Note this requires some additional performance optimizations
   described in [appendix on buffering without sorting](#appendix-buffering-without-sorting). 

This is an instance of what Graefe calls *virtual concatenation*: "two
runs with disjoint key ranges … can together … serve as a single input"
([Graefe, ACM Computing Surveys 2006][graefe2006]). The idea is
well-established — it is stated there in a *survey* (i.e. already common
by 2006), is rooted further back in range-partitioned parallel sort
([Graefe, ACM Computing Surveys 1993][graefe1993]), and is mirrored in
LSM "trivial move" compaction (RocksDB/LevelDB). What is less common, and
the focus here, is *discovering* the disjoint ranges from per-file
min/max statistics rather than from a declared partitioning scheme.

[graefe2006]: https://dl.acm.org/doi/10.1145/1132960.1132964
[graefe1993]: https://dl.acm.org/doi/10.1145/152610.152611

<img src="/blog/images/sort-pushdown/phase1-file-reorder.svg" alt="File reorder: rearranging files within a partition by min/max statistics so the file list is in range order" width="100%" class="img-fluid" /><br/>
*Figure: file reorder by per-file `min/max` puts the file list in range
order without touching file contents.*


<img src="/blog/images/sort-pushdown/phase2-stats-overlap.svg" alt="Detecting non-overlapping ranges via min/max statistics" width="100%" class="img-fluid" /><br/>
*Figure: `PushdownSort` sorts files by `min` and checks adjacency,
upgrading to `Exact` only when the ranges don't overlap. Left: non-overlapping
ranges are safe to upgrade to `Exact` and the sort is removed; right:
overlapping ranges keep the sort and fall through to the `Inexact` path described next.*

We measured statistics-based sort elimination with DataFusion's
[`sort_pushdown`](https://github.com/apache/datafusion/tree/main/benchmarks/queries/sort_pushdown) benchmark suite
forcing execution to a single core using `--partitions 1`. The results are 
as follows: 

<img src="/blog/images/sort-pushdown/benchmark.svg" alt="Sort pushdown benchmark: 2x-49x speedup across four queries" width="100%" class="img-fluid" /><br/>

| Query                                       | Before  | After   | Speedup  |
| ------------------------------------------- | -------:| -------:| -------: |
| Q1 — `ORDER BY key` (full scan)             | 259 ms  | 122 ms  | **2.1×** |
| Q2 — `ORDER BY key LIMIT 100`               |  80 ms  |   3 ms  | **27×**  |
| Q3 — `SELECT * ORDER BY key`                | 700 ms  | 313 ms  | **2.2×** |
| Q4 — `SELECT * ORDER BY key LIMIT 100`      | 342 ms  |   7 ms  | **49×**  |

*Figure: `sort_pushdown` results. Note `ASC` queries with the file list reversed against sort-key ranges.*

While DataFusion can avoid sorting for all four queries, the benefit is most dramatic for `LIMIT` queries: 

- **Full-scan queries (Q1, Q3)** result in a ~2 speedup as the scan is now a single-pass streaming read.
- **`LIMIT` queries (Q2, Q4)** result in 27x-49x speedup because `LIMIT N` turns into a streaming read with early stopping.

## Inexact: Scan Reordering Makes Dynamic Filters More Effective

It is not possible to eliminate the sort when the files have
overlapping sort key ranges. However, it is still possible to use sorted or
partly sorted data to optimize `LIMIT` queries. By reordering the read,
data that is most likely to improve the `TopK` dynamic filter is seen first and
the filter is more effective at pruning files, row groups, and rows that cannot
possibly contribute to the final result.

This `Inexact` path is used when Parquet min/max statistics are available
and the sort expression is supported by DataFusion's
[equivalence-properties][ordering-analysis], including plain columns, monotonic
functions<sup id="fn1">[1](#footnote1)</sup>, constants inferred from filters,
and multi-column orderings. The same dynamic filter is used to drive three layers of pruning:

<img src="/blog/images/sort-pushdown/pruning_stack.svg" alt="Three-layer pruning: file-level, row-group-level, row-level, all driven by the same TopK dynamic filter" width="100%" class="img-fluid" /><br/>
*Figure: three pruning layers within the Parquet reader, all driven by the same `TopK` dynamic filter.*

* **Layer 1 · file-level** ([file_pruner] + [EarlyStoppingStream]) — skips whole files before they are opened.
* **Layer 2 · row-group-level** ([#22450]) — skips whole row groups at each boundary, before any pages are fetched.
* **Layer 3 · row-level** ([RowFilter]) — skips decoding the remaining columns in a surviving row group.

Each layer is described in detail below.

[file_pruner]: https://docs.rs/datafusion-pruning/latest/datafusion_pruning/struct.FilePruner.html
[EarlyStoppingStream]: https://github.com/apache/datafusion/blob/e104138b4d45d3acfb76223cd968385f6764477b/datafusion/datasource-parquet/src/opener/early_stop.rs
[RowFilter]: https://docs.rs/parquet/latest/parquet/arrow/arrow_reader/struct.RowFilter.html

Once `PushdownSort` determines `Inexact` applies, the Parquet opener reorders
the scan before and during execution using three steps:

<img src="/blog/images/sort-pushdown/pr21956-runtime-pipeline.svg" alt="Runtime reorder pipeline: file reorder, RG reorder, then optional reverse" width="100%" class="img-fluid" /><br/>

*Figure: the Parquet opener applies file-level reorder → row-group-level reorder → optional iteration reverse.*

1. **File-level reorder** — the file list is sorted by `min(col)`,
   so the most-promising file is picked first across all partitions.
2. **Row-group-level reorder** — once a file is opened, its row groups
   are sorted by `min(col)`.
3. **Iteration reverse** — for queries which want the data in `DESC` 
   order, the file and row group order is reversed.

**File-Level Pruning**: once files are ordered "most-promising first", the
`TopK`'s heap fills quickly and its dynamic filter threshold tightens. The
[FilePruner] then cuts low-value files before opening them, as shown in the
following example.

[FilePruner]: https://github.com/apache/datafusion/blob/e104138b4d45d3acfb76223cd968385f6764477b/datafusion/pruning/src/file_pruner.rs

<img src="/blog/images/sort-pushdown/desc_walk_file.svg" alt="File-level reorder with early stop via file_pruner" width="100%" class="img-fluid" /><br/>

*Figure: after reordering files by their sort key, the low-value files (`file_d` and `file_c`,
whose sort-key values are smallest and therefore least promising for this `DESC LIMIT` query)
end up at the tail of the queue and are pruned by the file-level pruner before they
are ever opened — no metadata I/O.*

**Row-Group-Level Pruning**: When a file is first opened, DataFusion prunes
row groups based on predicates and statistics and then determines
the order to scan the row groups. During the scan, immediately before DataFusion
reads the next row group, it checks if the `TopK` dynamic filter has changed. If so, 
after [#22450] it checks the remaining row groups against the new threshold and 
prunes any that cannot contribute to the final result. See the 
[Appendix: Decoder Loop and Decision Point](#appendix-decoder-loop-and-decision-point) for more details on how this works.


<img src="/blog/images/sort-pushdown/rg_cascade.svg" alt="Cascading prune: one row group fills the heap, threshold snaps, all subsequent row groups are pruned in a single pass" width="100%" class="img-fluid" /><br/>
*Figure: for `ORDER BY x DESC LIMIT 10`, reading just the first row group can prune all the rest in a single pass (walkthrough below).*

For example, consider a file with 10 row groups, each containing rows with values
`[0..10)`, `[10..20)`, ..., `[90..100)` and a query with `ORDER BY x DESC LIMIT 10`. 

1. The row groups are first reordered by their maximum values, so the highest-value row group is read first.
2. Row group 9 (values `[90..100)`) is opened and read, filling
   the heap with at least 10 values (the minimum heap value is `90`). The `TopK` dynamic filter threshold is updated to `90`.
3. At the next row-group boundary, the pruner sees the dynamic filter has been updated
   and re-evaluates the filter on all remaining row groups. Since row group 8
   through row group 0 have `max < 90` they are all pruned out and skipped in a single pass. 
4. The scan ends early, having read only one row group instead of all 10.

Note that for the row groups that were skipped, no data is fetched or decoded.
This example shows the core benefit provided by runtime row-group dynamic
pruning: reading a single row group can cascade-eliminate every remaining row
group.

**Row-Level Early Stopping**: Even if the row group cannot be pruned with statistics, 
dynamic filters can often rule out all rows
after evaluating just the filter columns. This optimization avoids fetching any
projection columns (added in
[apache/datafusion#22450][#22450]).

<img src="/blog/images/sort-pushdown/desc_walk_rg.svg" alt="Row-group-level reorder — filter column still read for every row group before row-group filter early stop" width="100%" class="img-fluid" /><br/>

*Figure: inside a file, the first row group tightens the threshold —
subsequent row groups have their projection columns short-circuited,
but the filter column still has to be read to discover that no rows
qualify.*


## Benchmark: topk_tpch

For this work, we defined a new  [`topk_tpch`](https://github.com/apache/datafusion/blob/main/benchmarks/src/sort_tpch.rs)
benchmark that runs 11 queries over the TPC-H SF1 data. Each query has 
`ORDER BY ... LIMIT 100`. The data is stored in Parquet files, sorted by
`l_orderkey`. For the largest table, `lineitem`, this is a `BIGINT` with ~1.5M
distinct values, so per Row Group `min/max` ranges are cleanly disjoint.
We compare DataFusion 54 with the sort optimizations enabled (the default) and disabled.

<img src="/blog/images/sort-pushdown/topk_tpch_bench.svg" alt="topk_tpch benchmark results: 5 of 11 queries 3-4× faster, 0 regressions, total -44%" width="100%" class="img-fluid"/>

| Metric                              | Value                              |
| ----------------------------------- | ---------------------------------- |
| Total wall-clock (sum of 11 queries) | 248.8 ms → 139.1 ms (**−44%**)    |
| Queries with ≥2× speedup            | **5 of 11** (Q2, Q4, Q8, Q9, Q10) |
| Queries with regression             | **0**                              |
| Best single-query speedup           | **~4×**                            |

The five queries which improved use `l_orderkey` as the **first** sort key column, so
`Layer 2` (row group pruning) can cascade-prune aggressively. The other queries have multi-column
sorts with
low-cardinality or unsorted columns (`l_linenumber`, `l_comment`,
`l_shipmode`), whose per-Row Group ranges overlap heavily. Even when `l_orderkey`
appears later as a tie-breaker, the leading key controls RG-level disjointness,
so `Layer 3` (row-level) is still partially effective.


## Conclusion and Future Work

Use cases where the query sort key (e.g. `ORDER BY time DESC LIMIT 10`) is
aligned with the physical layout (e.g. the data is ordered by `time`) are common
in time-series, partitioned tables, and ingestion-ordered event logs. In
DataFusion 54, we implemented several optimizations, speeding up the target
workloads by a factor of 3-4 without slowing down queries for which they don't
apply. We hope you enjoy using them and welcome your feedback.

Two follow-ups are open:  Page-level `Exact` reverse would let `DESC` queries drop the sort
but needs lower level support in the Parquet reader ([arrow-rs#9937](https://github.com/apache/arrow-rs/pull/9937))
for reading pages in reverse order.
We are also considering implementing Page-level dynamic pruning at
row-group boundaries ([apache/datafusion#23216](https://github.com/apache/datafusion/issues/23216))
using the same pattern one level deeper in Parquet.

## Acknowledgements

Thank you to [@adriangb], [@xudong963], [@2010YOUY01], and
[@Dandandan] for reviewing the design and the patches across many
iterations. The DataFusion community's willingness to engage deeply
with optimizer changes — including the ones that touch foundational
invariants like the Parquet inner decode loop — is what made this work
possible.

Thanks also to [Massive](https://www.massive.com/) and [InfluxData](https://www.influxdata.com/) for sponsoring this
work.

<a id="footnote1"></a><sup>[1](#fn1)</sup> For example, if the source declares
`ts DESC`, reversing that ordering gives `ts ASC`, which can satisfy
`date_trunc('day', ts) ASC`.

[@alamb]: https://github.com/alamb
[@adriangb]: https://github.com/adriangb
[@xudong963]: https://github.com/xudong963
[@2010YOUY01]: https://github.com/2010YOUY01
[@Dandandan]: https://github.com/Dandandan

## Get Involved

- **Try it out**: Run your `ORDER BY` / `ORDER BY ... LIMIT N` queries on your own data and share what you see.
- **Work on a [good first issue](https://github.com/apache/datafusion/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)**, or pick up one of the [follow-ups](https://github.com/apache/datafusion/issues/23036) listed in the umbrella issue.
- **File issues or join the conversation**: [GitHub](https://github.com/apache/datafusion/) for bugs and feature requests, [Slack or Discord](https://datafusion.apache.org/contributor-guide/communication.html) for discussion.
- Learn more by visiting the [DataFusion](https://datafusion.apache.org/index.html) project page.

## Related Work

The ideas in this blog build on a long line of research, and several other
systems implement closely related techniques.

**Exploiting and proving sort order.** Reasoning about orderings to
eliminate redundant sorts goes back to "interesting orders" in System R
([Selinger et al., SIGMOD 1979][selinger1979]) and was formalized by
[Simmen, Shekita, and Malkemus (SIGMOD 1996)][simmen1996]. Those techniques
derive orderings from *schema* — declared keys, indexes, and functional
dependencies — whereas we use  per-file min/max *statistics*. Concatenating disjoint key ranges
rather than merging is described as *virtual
concatenation* by [Graefe (ACM Computing Surveys 2006)][graefe2006], and is mirrored in
LSM "trivial move" compaction ([RocksDB][rocksdb-trivial]). For *declared* partition
bounds, the "concatenate, don't merge" optimization appears in
[TimescaleDB's OrderedAppend][timescale-append] and [PostgreSQL's ordered partition scans][pg-append].

**Top-k early termination and threshold pushdown.** Using a running
threshold to stop early is described in [Fagin's Threshold Algorithm
(PODS 2001)][fagin2001], with index choice for faster convergence
explored in [IO-Top-k (VLDB 2006)][iotopk2006]; see
[Ilyas et al. (ACM Computing Surveys 2008)][ilyas2008] for a survey.
Pushing a *live* top-k boundary value into a columnar scan to skip blocks
via min/max is described for Snowflake in
[Pruning in Snowflake: Working Smarter, Not Harder] and ships in
[ClickHouse][ch-topn] (granule-level top-N skipping), [DuckDB][duckdb-topn]
(dynamic Top-N table filters), [PolarDB-IMCI][polardb-topk] (self-sharpening
runtime filters), and InfluxDB IOx ([`ProgressiveEvalExec`][iox-progressive]).

**Reverse scans and data skipping.** Reading physically-ordered data in
reverse to satisfy `DESC ... LIMIT` is a well known technique in traditional
databases (backward/descending index scans in [PostgreSQL][pg-backward] and [Oracle][oracle-backward]).
Min/max block skipping itself originates with
[Small Materialized Aggregates (Moerkotte, VLDB 1998)][sma1998] and is
now ubiquitous across columnar storage formats and query engines.

[selinger1979]: https://dl.acm.org/doi/10.1145/582095.582099
[simmen1996]: https://dl.acm.org/doi/10.1145/233269.233320
[neumann2004]: https://www.vldb.org/conf/2004/RS24P3.PDF
[fagin2001]: https://arxiv.org/abs/cs/0204046
[iotopk2006]: https://www.vldb.org/conf/2006/p475-bast.pdf
[ilyas2008]: https://dl.acm.org/doi/10.1145/1391729.1391730
[sma1998]: https://www.vldb.org/conf/1998/p476.pdf
[rocksdb-trivial]: https://github.com/facebook/rocksdb/wiki/Compaction-Trivial-Move
[timescale-append]: https://www.tigerdata.com/blog/ordered-append-postgresql-optimization
[pg-append]: https://www.postgresql.org/message-id/2401607.SfZhPQhbS4@ronan_laptop
[pg-backward]: https://www.postgresql.org/docs/current/indexes-ordering.html
[oracle-backward]: https://docs.oracle.com/en/database/oracle/oracle-database/19/tgsql/optimizer-access-paths.html
[ch-topn]: https://clickhouse.com/blog/clickhouse-top-n-queries-granule-level-data-skipping
[duckdb-topn]: https://duckdb.org/2024/10/25/topn
[polardb-topk]: https://www.alibabacloud.com/blog/how-does-the-imci-of-polardb-for-mysql-achieve-ultimate-topk-query-performance_600006
[iox-progressive]: https://www.influxdata.com/blog/query-optimization-progressive-evaluation-influxdb/


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


## Appendix: Buffering Without Sorting

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



## Appendix: Decoder Loop and Decision Point

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

