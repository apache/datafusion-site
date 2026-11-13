---
layout: post
title: Top N Per Group with PartitionedTopKExec in Apache DataFusion
date: 2026-11-13
author: Vadim Lazuk
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

*[Vadim Lazuk](https://github.com/Inf1mum)*

"Find the top N rows within each group" is one of the most common shapes in
analytics: the five best-selling products in each category, the three most
recent events per device, the two highest-revenue rows per store. In SQL this
is usually written with a ranking window function and an outer filter:

```sql
SELECT * FROM (
    SELECT ROW_NUMBER() OVER (PARTITION BY category ORDER BY revenue DESC) AS rn, *
    FROM sales
) WHERE rn <= 5;
```

Until recently, Apache DataFusion evaluated this query by sorting the *entire*
input to compute the window function, and then throwing almost all of the
sorted output away. DataFusion 55 recognizes this pattern and, when
[datafusion.optimizer.enable_window_topn] is enabled, replaces the full sort
with a new `PartitionedTopKExec` operator that keeps only the top N rows per
partition in a bounded heap.

This post explains the use case, shows how to enable and use the feature,
walks through the `EXPLAIN` output before and after, describes how the
operator works, and reports the measured performance — including the cases
where it is *not* a good fit.

This post grew out of a draft section [@alamb] wrote for the [DataFusion
55.0.0 release post][draft-55-post], which was dropped because a release
summary has limited room to explain how an operator actually works. The
feature itself was implemented by [@SubhamSinghal], resolving a [feature
request from 2023][#6899].

[@alamb]: https://github.com/alamb
[@SubhamSinghal]: https://github.com/SubhamSinghal
[datafusion.optimizer.enable_window_topn]: https://datafusion.apache.org/user-guide/configs.html
[draft-55-post]: https://github.com/apache/datafusion/issues/27233
[#6899]: https://github.com/apache/datafusion/issues/6899

## The "Top N Per Group" Pattern

The query above computes the top five rows per `category`. Other instances of
the same pattern:

- The latest N events per device in a telemetry table (`ORDER BY time DESC`).
- The top N products by revenue per store.
- The N highest-paid employees per department.

It is also the shape of query 8 of the [h2o group-by benchmark] ("top 2 rows
by value per group"), which DataFusion tracks as part of its effort to stay
competitive on [db-benchmark][#13586] — a well-known public benchmark for data
processing engines.

[h2o group-by benchmark]: https://github.com/h2oai/db-benchmark
[#13586]: https://github.com/apache/datafusion/issues/13586

The important characteristic is that the filter keeps a *small, fixed number
of rows per group* (`rn <= K`), while the input per group is large. When that
holds, almost all the work of a sort-based plan is discarded.

## The Default Plan Sorts Everything

A ranking window function must see each partition of the data as one
contiguous, ordered run. The straightforward way to guarantee that is to sort
the whole input by `(partition keys, order keys)` and evaluate the window over
the sorted stream. With the optimization disabled, the physical plan for the
query above is (abridged):

```text
ProjectionExec
  FilterExec: rn <= 5
    BoundedWindowAggExec: ROW_NUMBER() PARTITION BY [category] ORDER BY [revenue DESC]
      SortExec: expr=[category ASC, revenue DESC]
        DataSourceExec
```

This plan:

1. Sorts the entire dataset — O(N log N) time and O(N) memory.
2. Computes `ROW_NUMBER` for **all** rows.
3. Runs the filter, which keeps only the top K rows per partition.

With 10 million rows, 1,000 partitions, and `K = 3`, the plan sorts all 10
million rows to keep 3,000. The fraction of output that survives the filter is
roughly `K × P / N` — for a high-cardinality partition key this is vanishingly
small.

## Using It in DataFusion 55

The optimization ships in DataFusion 55.0.0 behind the
`datafusion.optimizer.enable_window_topn` configuration flag, which is
**disabled by default**. Enable it with:

```sql
SET datafusion.optimizer.enable_window_topn = true;
```

With the flag on, the same query produces (abridged):

```text
ProjectionExec
  BoundedWindowAggExec: ROW_NUMBER() PARTITION BY [category] ORDER BY [revenue DESC]
    RepartitionExec: partitioning=Hash([category], ...)
      PartitionedTopKExec: fn=row_number, fetch=5, partition=[category], order=[revenue DESC]
        DataSourceExec
```

Both the `SortExec` *and* the `FilterExec` are gone. The
`PartitionedTopKExec` sits directly below the window operator and feeds it
only the surviving rows, already grouped and ordered, so the window operator
runs in `Sorted` mode and assigns row numbers cheaply.

### Which Queries the Rewrite Applies To

The physical optimizer rule behind this is called `WindowTopN`. It fires when
all of the following hold:

- The window function is `ROW_NUMBER` or `RANK` (in DataFusion 55; see
  [Status and Roadmap](#status-and-roadmap) for `DENSE_RANK`).
- The window has a `PARTITION BY` clause. A global top-N without partitioning
  is already handled efficiently by `SortExec` with a fetch limit.
- For `RANK`: the window has a non-empty `ORDER BY` clause (with an empty
  `ORDER BY`, every row ties at rank 1 and there is nothing to prune).
- The filter compares the ranking column to an integer literal using one of
  `rn <= K`, `rn < K`, `K >= rn`, or `K > rn`.

The rule derives the number of rows to retain from the predicate: `rn <= 5`
retains 5 rows per partition, and `rn < 5` retains 4.

If any of these conditions fail, the rule simply does not fire and the
sort-based plan above is used — the flag only switches *this* rewrite off and
on, it does not affect anything else. To disable it again:

```sql
SET datafusion.optimizer.enable_window_topn = false;
```

## How It Works

`PartitionedTopKExec` reads *unsorted* input and maintains one bounded
top-K heap per distinct partition key, instead of sorting the dataset. Rows
are converted to Arrow's row format with a single shared `RowConverter` and
grouped by their partition key; each group's rows flow into that group's
heap, which keeps the best K rows according to the `ORDER BY` and evicts the
rest as new rows arrive. All heaps share a single `MemoryReservation`, so the
operator reports its memory usage to DataFusion's memory pool as one unit
[#21479], [#23096].

The overall cost changes from O(N log N) time and O(N) memory to:

- **O(N log K)** time — each row is compared against a heap of size K.
- **O(K × P × row_size)** memory — K retained rows for each of the P
  distinct partitions.

For example, with `fetch=3` and input:

```text
store | revenue
------|--------
  A   |  100
  B   |   50
  A   |  200
  B   |  150
  A   |  300
  A   |  400
```

the operator keeps two heaps: `store=A` retains `{400, 300, 200}` and evicts
`100`; `store=B` retains `{150, 50}`. It emits the retained rows in
`(partition_keys, order_keys)` order — `A/400, A/300, A/200, B/150, B/50` —
which is exactly the contiguous ordered run the window operator needs to
assign `ROW_NUMBER` values 1..3 per partition.

### What Each Ranking Function Has to Retain

The three ranking functions differ in what a correct implementation must keep
per partition:

- `ROW_NUMBER` numbers rows 1, 2, 3, ... with no ties, so exactly K rows
  per partition suffice.
- `RANK` gives tied rows the same rank and skips subsequent ranks, so
  `WHERE rk <= K` must keep K rows *plus any additional rows tied with the
  row at the boundary*. The operator therefore pairs its heap with a sibling
  ties list, and a query can legitimately return more than K rows per
  partition when ties straddle the boundary — that is what `RANK` means.
- `DENSE_RANK` gives tied rows the same rank without gaps, which requires
  tracking distinct order-by values rather than just rows.

### Emission Order and the Window Operator

Window functions do not require the *partition keys* to be globally sorted —
only each partition's rows must be contiguous and ordered among themselves.
`PartitionedTopKExec` emits rows grouped by partition and ordered by the
`ORDER BY` keys within each partition, which is the weaker guarantee the
window operator needs, and avoids paying for a global sort of the partition
keys. The `BoundedWindowAggExec` above the operator then runs in `Sorted`
mode: it only walks the retained rows and writes the rank column.

Work on the main branch since DataFusion 55 goes further: [#26133] emits the
rank column directly from `PartitionedTopKExec`, allowing the window operator
to be removed from the plan entirely.

[#21479]: https://github.com/apache/datafusion/pull/21479
[#23096]: https://github.com/apache/datafusion/pull/23096
[#26133]: https://github.com/apache/datafusion/pull/26133

## Benchmarks: Where It Helps, and Where It Does Not

When the operator was introduced, it was measured on the h2o group-by shape —
10 million rows, top-2 rows per partition — across partition counts from 100
to 100,000 [#21479]. The full input is processed either way; only the sort is
replaced by the heaps.

| Scenario                          | Enabled | Disabled | Speedup     |
| --------------------------------- | ------: | -------: | ----------- |
| 100 partitions (100K rows each)   |   43 ms |  174 ms  | **4.0x**    |
| 1K partitions (10K rows each)     |   71 ms |  146 ms  | **2.1x**    |
| 10K partitions (1K rows each)     |  619 ms |  128 ms  | **0.2x** (regression) |
| 100K partitions (100 rows each)   | 4368 ms |  135 ms  | **0.03x** (regression) |

*Timings reported in [#21479] when the operator was introduced; hardware and
absolute numbers will vary, but the shape of the curve is the point.*

The pattern is clear:

- **Moderate partition cardinality is the sweet spot.** With 100 or 1,000
  partitions, each partition holds enough rows that replacing the full sort
  with per-partition heaps of size K wins by 2–4x.
- **Very high partition cardinality is the cliff.** With 100K partitions,
  there are only ~100 rows per partition, and the per-partition bookkeeping
  (row conversion, one heap per distinct key) costs more than the sort it
  replaced. This is why the feature is behind a configuration flag rather
  than always-on: the sort-based plan is more robust when the number of
  distinct partition keys is very large.

The [DataFusion configuration documentation][configs-doc] summarizes this
trade-off: the optimization helps when the window partition key has low
cardinality, but for high-cardinality keys it may cause regressions in both
memory usage and runtime, in which case the sort-based plan is more robust.

[configs-doc]: https://datafusion.apache.org/user-guide/configs.html

Follow-up work on the main branch narrows this gap: [#23096] shares the row
encoder and memory reservation across partitions, and [#24591] reduced `RANK`
memory from O(input) to O(K + ties).

[#24591]: https://github.com/apache/datafusion/pull/24591

## Status and Roadmap

As of DataFusion 55.0.0:

- `ROW_NUMBER` and `RANK` are supported, opt-in via
  `datafusion.optimizer.enable_window_topn`.
- `DENSE_RANK` support has landed on the main branch
  ([#23869]) and is expected in an upcoming release.
- The optimization is **not yet enabled by default**. Work to flip the
  default is tracked in the [enable-by-default EPIC][#24608]
  ([#27197] is the change itself, open at the time of writing).

[#23869]: https://github.com/apache/datafusion/pull/23869
[#24608]: https://github.com/apache/datafusion/issues/24608
[#27197]: https://github.com/apache/datafusion/pull/27197

If you try this on your own "top N per group" workloads, the DataFusion team
would be interested in your results — especially if you hit the
high-cardinality cliff, since those reports drive the remaining optimization
work.

## Remaining Work

There is active work to extend and harden the optimization; good places to
jump in:

- [Further "per partition" top-k optimizations][#24060] — the umbrella for
  the next round of improvements.
- [Support filters with embedded projections][#21596] — widen the set of
  queries the rule recognizes.
- [Memory-efficient dedup on wide payloads][#23600] — the `ROW_NUMBER() = 1`
  / `DISTINCT ON` dedup pattern.
- [Utf8View buffers kept alive by retained rows][#26381] — memory footprint
  when string columns are present.

[#24060]: https://github.com/apache/datafusion/issues/24060
[#21596]: https://github.com/apache/datafusion/issues/21596
[#23600]: https://github.com/apache/datafusion/issues/23600
[#26381]: https://github.com/apache/datafusion/issues/26381

## Acknowledgements

This feature was implemented by [@SubhamSinghal] across a long series of
patches, with reviews from [@2010YOUY01] and [@kosiew]. [@jayzhan211] drove
the memory optimizations, and further contributions came from
[@saadtajwar], [@stuhood], [@viirya], and [@zhuqi-lucas]. The original
feature request was filed in 2023 ([#6899]), and the draft this post is based
on was written by [@alamb] for the DataFusion 55 announcement.

[@2010YOUY01]: https://github.com/2010YOUY01
[@kosiew]: https://github.com/kosiew
[@jayzhan211]: https://github.com/jayzhan211
[@saadtajwar]: https://github.com/saadtajwar
[@stuhood]: https://github.com/stuhood
[@viirya]: https://github.com/viirya
[@zhuqi-lucas]: https://github.com/zhuqi-lucas

## Get Involved

- **Try it out**: run your "top N per group" queries with
  `datafusion.optimizer.enable_window_topn = true` on DataFusion 55 and
  compare `EXPLAIN ANALYZE` output.
- **Work on a [good first issue](https://github.com/apache/datafusion/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)**,
  or pick up one of the [remaining work](#remaining-work) items above.
- **File issues or join the conversation**: [GitHub](https://github.com/apache/datafusion/)
  for bugs and feature requests, [Slack or Discord](https://datafusion.apache.org/contributor-guide/communication.html)
  for discussion.
- Learn more by visiting the [DataFusion](https://datafusion.apache.org/index.html) project page.

## References

- Original feature request (2023): [#6899]
- Introducing `PartitionedTopKExec` and the `WindowTopN` rule (`ROW_NUMBER`): [#21479]
- `RANK` support: [#22885](https://github.com/apache/datafusion/pull/22885)
- `DENSE_RANK` support (main): [#23869]
- Shared encoder and memory reservation across partitions: [#23096]
- `RANK` memory from O(input) to O(K + ties): [#24591]
- Emit the rank column from the operator (main): [#26133]
- Enable-by-default EPIC: [#24608] / [#27197]
- This post's ticket: [#27233](https://github.com/apache/datafusion/issues/27233)
