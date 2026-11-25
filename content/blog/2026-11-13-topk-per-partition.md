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

"The five best-selling products in each category" is a common analytics
query: rank the rows within each group, keep only the top few per group, and
discard the rest. In SQL this is usually written with a ranking window
function and an outer filter:

```sql
SELECT * FROM (
    SELECT ROW_NUMBER() OVER (PARTITION BY category ORDER BY revenue DESC) AS rn, *
    FROM sales
) WHERE rn <= 5;
```

The window expression means: divide the rows of `sales` into groups called
partitions — one per distinct `category` — order the rows within each group
by `revenue` descending, and number them 1, 2, 3, .... The outer
`WHERE rn <= 5` discards every row whose number is greater than 5, leaving
the five highest-revenue rows of each category. Here is one group
(`category = 'books'`) with the rows the filter removes marked:

```text
category | revenue | rn | kept
---------|--------:|---:|-----
books    |     300 |  1 | yes
books    |     250 |  2 | yes
books    |     200 |  3 | yes
books    |     150 |  4 | yes
books    |     100 |  5 | yes
books    |      50 |  6 | no
books    |      20 |  7 | no
```

Throughout this post: **N** is the number of input rows, **P** is the number
of distinct groups (partitions), and **K** is the number of rows kept per
group — 5 in the query above.

Until recently, DataFusion evaluated this query by sorting all N rows and
then throwing almost all of them away. DataFusion now has a specialized
operator for this pattern: with
[datafusion.optimizer.enable_window_topn] enabled, `PartitionedTopKExec`
keeps only the top K rows per group, and the same query runs up to **6.8x
faster** in the benchmarks below. This post shows what changes in the plan,
where the new operator helps, and where it does not.

## The Default Plan Sorts Everything

A ranking window function needs each group's rows to be contiguous and in
`ORDER BY` order, so the default plan sorts the whole input and evaluates
the window over the sorted stream:

```text
ProjectionExec
  FilterExec: rn <= 5
    BoundedWindowAggExec: ROW_NUMBER() PARTITION BY [category] ORDER BY [revenue DESC]
      SortExec: expr=[category ASC, revenue DESC]
        DataSourceExec
```

Each stage does work on rows the filter later throws away:

- `SortExec` sorts the entire dataset by `(category, revenue)`.
- `BoundedWindowAggExec` numbers every row, including the ones about to be
  discarded.
- `FilterExec` keeps only the rows with `rn <= 5`.

With 10 million rows, 1,000 groups, and `K = 3`, the plan sorts all 10
million rows to keep 3,000.

## How It Works

`PartitionedTopKExec` is a specialized operator that holds just the top K
rows for each distinct partition key in a hash map of bounded heaps. It
reads the unsorted input once: each row goes into its group's heap, which
keeps the best K rows according to the `ORDER BY` keys and evicts the rest.
It emits the surviving rows grouped by partition and ordered within each
partition — exactly the shape the window operator needs to assign row
numbers. The full input is still read; only the sort is replaced
([source][partitioned-topk-source]).

With the flag enabled, the plan for the query above becomes (abridged):

```text
ProjectionExec
  BoundedWindowAggExec: ROW_NUMBER() PARTITION BY [category] ORDER BY [revenue DESC]
    RepartitionExec: partitioning=Hash([category], ...)
      PartitionedTopKExec: fn=row_number, fetch=5, partition=[category], order=[revenue DESC]
        DataSourceExec
```

The `SortExec` and the `FilterExec` are gone: the operator feeds the window
operator only the surviving rows, already grouped and ordered.

<!-- TODO(alamb): diagram of the two plans (the sort-based plan above and
     this PartitionedTopKExec plan). Site convention is SVG images under
     /blog/images/<slug>/, as in the sort-pushdown post. -->

With `K = 3` and the input:

```text
category | revenue
---------|--------
books    |  100
toys     |   50
books    |  200
toys     |  150
books    |  300
books    |  400
```

the operator keeps two heaps: `books` retains `{400, 300, 200}` and evicts
`100`; `toys` retains `{150, 50}`.

Computational complexity changes from **O(N log N)** time and **O(N)**
memory (the sort) to **O(N log K)** time and **O(K × P × row_size)** memory
(K retained rows for each of the P distinct groups).

The rewrite applies to the three SQL ranking functions — `ROW_NUMBER`,
`RANK`, and `DENSE_RANK` — each with slightly different bookkeeping:
`ROW_NUMBER` needs exactly K rows per group, `RANK` must also retain rows
tied with the row at the boundary (so a query can legitimately return more
than K rows per group), and `DENSE_RANK` tracks distinct order-by values
rather than rows. As of DataFusion 56 the operator also emits the rank
column itself ([#26133]), so the window operator can leave the plan
entirely.

## Using It

In DataFusion 55 and 56 the optimization is off by default; enable it with:

```sql
SET datafusion.optimizer.enable_window_topn = true;
```

The rewrite fires when the ranking function is `ROW_NUMBER`, `RANK`, or
`DENSE_RANK`, the window has a `PARTITION BY` clause, and the filter
compares the rank column to an integer literal (`rn <= K` retains K rows
per group, `rn < K` retains K−1). Any other window query uses the default
sort-based plan. The optimizer rule that implements this is
[window_topn.rs][window-topn-source] for anyone curious.

## Performance

Here is how much faster the new operator is. I re-ran the [h2o group-by]
benchmark's Q8 query (top-2 rows per group) on released DataFusion
**55.2.0**: 10M rows, in-memory data, min of 4 runs on a single desktop
machine.

| Partitions | Rows/partition | Enabled | Disabled | Enabled/Disabled |
| ---------: | -------------: | -------: | --------: | ---------------- |
| 100        | 100,000        |   79 ms |   342 ms | 0.23x (4.3x faster) |
| 1,000      | 10,000         |   92 ms |   610 ms | 0.15x (6.6x faster) |
| 5,000      | 2,000          |  124 ms |   848 ms | 0.15x (6.8x faster) |
| 10,000     | 1,000          |  159 ms |   885 ms | 0.18x (5.6x faster) |
| 20,000     | 500            |  205 ms |   791 ms | 0.26x (3.9x faster) |
| 50,000     | 200            |  416 ms |   500 ms | 0.83x (≈ parity)    |
| 60,000     | ~167           |  454 ms |   289 ms | 1.57x (regression)  |
| 100,000    | 100            |  699 ms |   530 ms | 1.32x (regression)  |
| 150,000    | ~67            |  944 ms |   566 ms | 1.67x (regression)  |

Up to about 10,000 partitions the new plan is 4–7x faster. Above 50,000
partitions performance gets worse: every distinct partition key adds a heap
and a hash-map entry, so very high-cardinality keys cost more than the sort
they replace — which is why the optimization is opt-in and the
[configuration documentation][datafusion.optimizer.enable_window_topn]
recommends it for low-cardinality partition keys.

<!-- TODO(alamb): question — you asked whether this was fixed in DataFusion
     56. The 56.0.0 changelog lists PartitionedTopK perf work ([#25730],
     [#25968]) but nothing identified as fixing the high-partition-count
     regression, so the post reports the measured 55.2.0 crossover and does
     not claim a 56 fix. Please confirm. -->

## Status

As of DataFusion 56.0.0 (released November 2026):

- `ROW_NUMBER`, `RANK`, and `DENSE_RANK` are all supported ([#23869]
  extended the rewrite to `DENSE_RANK` in 56), opt-in via
  `datafusion.optimizer.enable_window_topn`.
- The optimization is still **off by default** in 56.
- It will be **enabled by default in DataFusion 57**: [#27197] flipped the
  default (merged after the 56.0.0 branch cut), and the
  [enable-by-default EPIC][#24608] is closed.

## Remaining Work

- [Further "per partition" top-k optimizations][#24060] — the umbrella issue
  for the remaining improvements, with links to the individual tickets.

## Acknowledgements

This feature was implemented by [@SubhamSinghal] across a long series of
patches, with reviews from [@2010YOUY01] and [@kosiew]. [@jayzhan211] drove
the memory optimizations, and further contributions came from
[@saadtajwar], [@stuhood], [@viirya], and [@zhuqi-lucas]. The original
feature request was filed in 2023 ([#6899]), and the draft this post is based
on was written by [@alamb] for the DataFusion 55 announcement.

## Get Involved

- **Try it out**: run your "top N per group" queries with
  `datafusion.optimizer.enable_window_topn = true` on DataFusion 56 and
  compare `EXPLAIN ANALYZE` output. If you hit the high-partition-count
  regression, please report it.
- **Work on a [good first issue](https://github.com/apache/datafusion/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)**,
  or pick up one of the [remaining work](#remaining-work) items.
- Learn more by visiting the [DataFusion](https://datafusion.apache.org/index.html) project page, and join the
  conversation on [GitHub](https://github.com/apache/datafusion/) or
  [Slack or Discord](https://datafusion.apache.org/contributor-guide/communication.html).

## References

- Original feature request (2023): [#6899]
- Introducing `PartitionedTopKExec` and the `WindowTopN` rule (`ROW_NUMBER`): [#21479]
- `RANK` support: [#22885]
- `DENSE_RANK` support: [#23869]
- Shared encoder and memory reservation across partitions: [#23096]
- `RANK` memory from O(input) to O(K + ties): [#24591]
- Emit the rank column from the operator: [#26133]
- Enabled by default in 57: [#27197] / EPIC [#24608]
- This post's ticket: [#27233]

[datafusion.optimizer.enable_window_topn]: https://datafusion.apache.org/user-guide/configs.html
[partitioned-topk-source]: https://github.com/apache/datafusion/blob/main/datafusion/physical-plan/src/sorts/partitioned_topk.rs
[window-topn-source]: https://github.com/apache/datafusion/blob/main/datafusion/physical-optimizer/src/window_topn.rs
[h2o group-by]: https://github.com/h2oai/db-benchmark
[#6899]: https://github.com/apache/datafusion/issues/6899
[#21479]: https://github.com/apache/datafusion/pull/21479
[#22885]: https://github.com/apache/datafusion/pull/22885
[#23096]: https://github.com/apache/datafusion/pull/23096
[#23869]: https://github.com/apache/datafusion/pull/23869
[#24591]: https://github.com/apache/datafusion/pull/24591
[#25730]: https://github.com/apache/datafusion/pull/25730
[#25968]: https://github.com/apache/datafusion/pull/25968
[#26133]: https://github.com/apache/datafusion/pull/26133
[#27197]: https://github.com/apache/datafusion/pull/27197
[#24608]: https://github.com/apache/datafusion/issues/24608
[#24060]: https://github.com/apache/datafusion/issues/24060
[#27233]: https://github.com/apache/datafusion/issues/27233
[@alamb]: https://github.com/alamb
[@SubhamSinghal]: https://github.com/SubhamSinghal
[@2010YOUY01]: https://github.com/2010YOUY01
[@kosiew]: https://github.com/kosiew
[@jayzhan211]: https://github.com/jayzhan211
[@saadtajwar]: https://github.com/saadtajwar
[@stuhood]: https://github.com/stuhood
[@viirya]: https://github.com/viirya
[@zhuqi-lucas]: https://github.com/zhuqi-lucas
