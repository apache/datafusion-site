---
layout: post
title: Dynamic Filters: Passing Information Between Operators During Execution for 10x Faster Queries
date: 2025-09-10
author: Adrian Garcia Badaracco (Pydantic), Andrew Lamb (InfluxData)
categories: [features]
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

<!-- 
diagrams source: https://docs.google.com/presentation/d/1FFYy27ydZdeFZWWuMjZGnYKUx9QNJfzuVLAH8AE5wlc/edit?slide=id.g364a74cba3d_0_92#slide=id.g364a74cba3d_0_92
Intended Audience: Query engine / data systems developers who want to learn about topk optimization
Goal: Introduce TopK and dynamic filters as in general optimization techniques for query engines, and how they were used to improve performance in DataFusion.
-->

This blog post introduces the query engine optimization techniques called TopK
and dynamic filters. We describe the motivating use case, how these
optimizations work, and how we implemented them with the [Apache DataFusion]
community to improve performance by an magnitude improvement for some query
patterns.

[Apache DataFusion]: https://datafusion.apache.org/

## Motivation and Results

The main commercial product at [Pydantic], [Logfire], is an observability
platform built on DataFusion. One of the most common workflows / queries is
"show me the last K traces" which translates to a query similar to:

[Pydantic]: https://pydantic.dev
[Logfire]: https://pydantic.dev/logfire

```sql
SELECT * FROM records ORDER BY start_timestamp DESC LIMIT 1000;
```

We noticed this was *pretty slow*, even thought DataFusion has long had the
classic `TopK` optimization (described below). After implementing the
dynamic filter techniques described in this blog, we saw *10x and higher
performance improvement* for this query pattern, and are applying the
optimization to other queries and operators as well.

Let's look at some preliminary numbers, using [ClickBench] [Q23] which is very similar to our earlier examples:

```sql
SELECT * FROM hits WHERE "URL" LIKE '%google%' ORDER BY "EventTime" LIMIT 10;
```

<div class="text-center">
<img 
  src="/blog/images/dynamic-filters/execution-time.svg" 
  width="80%" 
  class="img-responsive" 
  alt="Q23 Performance Improvement with Dynamic Filters and Late Materialization"
/>
</div>

**Figure 1**: Execution times for ClickBench Q23 with and without dynamic
filters (DF)<sup id="fn1">[1](#footnote1)</sup>, and late materialization
(LM)<sup id="fn2">[2](#footnote2)</sup> for different partitions / core usage.
Both dynamic filters alone (yellow) and late materialization alone (red) show a
large improvement over the baseline (blue). Combined (green) they show an even
larger improvement, up to a 22x improvement in execution time. See the appendix
for reproduction instructions.


## Background: TopK and Dynamic Filters

To explain how dynamic filters improve query performance we first need to
explain the so called "TopK" optimization. To do so we will use a simplified
version of ClickBench Q23:

```sql
SELECT * 
FROM hits 
ORDER BY "EventTime"
LIMIT 10
```

[Q23]: https://github.com/apache/datafusion/blob/main/benchmarks/queries/clickbench/queries/q23.sql
[ClickBench]: https://benchmark.clickhouse.com/

A straightforward, though slow, plan to answer this query is shown in Figure 2.

<div class="text-center">
<img 
  src="/blog/images/dynamic-filters/query-plan-naive.png" 
  width="80%" 
  class="img-responsive" 
  alt="Naive Query Plan"
/>
</div>

**Figure 2**: Simple Query Plan for ClickBench Q23. Data flows in plans from the
scan at the bottom to limit at the top. This plan reads all 100M rows of the
`hits` table, sorts them by `EventTime`, and then return only the top 10 rows.

This naive plan requires substantial effort: all columns from all rows are
decoded and sorted, but then only 10 are returned. 

High performance query engines typically avoid the expensive full sort with a
specialized operator that tracks the current top rows using a [heap], rather
than sorting the entire data. For example, this operator
is called [TopK in DataFusion], [SortWithLimit in Snowflake], and [topn in
DuckDB]. The plan for Q23 using this specialized operator is shown in Figure 3.

[heap]: https://en.wikipedia.org/wiki/Heap_(data_structure)
[TopK in DataFusion]: https://docs.rs/datafusion/latest/datafusion/physical_plan/struct.TopK.html
[SortWithLimit in Snowflake]: https://docs.snowflake.com/en/user-guide/ui-snowsight-activity
[topn in DuckDB]: https://duckdb.org/2024/10/25/topn.html#introduction-to-top-n

<div class="text-center">
<img 
  src="/blog/images/dynamic-filters/query-plan-topk.png" 
  width="80%" 
  class="img-responsive" 
  alt="TopK Query Plan"
/>
</div>

**Figure 3**: Query plan for Q23 in DataFusion using the TopK Operator. This
plan still reads all 100M rows of the `hits` table, but instead of first sorting
them all by `EventTime`, the TopK operator keeps track of the current top 10
rows using a Min/Max heap. Credit to [Visualgo](https://visualgo.net/en) for the
heap icon

However, this plan still reads and decodes all 100M rows of the `hits` table,
which is often unnecessary once we have found the top 10 rows. For example,
while running the query, if the current top 10 rows all have `EventTime` in
2025, then any subsequent rows with `EventTime` in 2024 or earlier can be
skipped entirely without reading or decoding them. This technique is especially
effective at skipping entire files or row groups if the top 10 values are in the
first few files read, which is very common with timestamp predicates when the
data insert order is approximately the same as the timestamp order.

Leveraging this insight is the key idea behind dynamic filters, which introduce
a runtime mechanism for the TopK operator to provide the current top values to
the scan operator, allowing it to skip unnecessary rows, entire files, or portions
of files. The plan for Q23 with dynamic filters is shown in Figure 4.

<div class="text-center">
<img 
  src="/blog/images/dynamic-filters/query-plan-topk-dynamic-filters.png" 
  width="100%" 
  class="img-responsive" 
  alt="TopK Query Plan with Dynamic Filters"
/>
</div>

**Figure 4**: Query plan for Q23 in DataFusion with specialized TopK Operator
and dynamic filters. The TopK operator provides the minimum `EventTime` of the
current top 10 rows to the scan operator, allowing it to skip rows with
`EventTime` earlier than that value. The scan operator uses this dynamic filter
to skip unnecessary files, and rows, reducing the amount of data that needs to
be read and


## Worked Example

To make dynamic filters more concrete let's look at a simplified example. Imagine we
have a table `records` with a column `start_timestamp` and we are running the
query from the introduction:

```sql
SELECT * 
FROM records 
ORDER BY start_timestamp 
DESC LIMIT 3;
```

For example, let's imagine that at some point during execution, the heap in the
`TopK` operator has the actual 3 most recent values:

| start_timestamp          |
|--------------------------|
| 2025-08-16T20:35:15.00Z  |
| 2025-08-16T20:35:14.00Z  |
| 2025-08-16T20:35:13.00Z  |

Since `2025-08-16T20:35:13.00Z` is the smallest of these values, we know that
any subsequent rows with `start_timestamp` less than or equal to this value
cannot possibly be in the top 3, and can be skipped entirely.

We can express this condition as a filter of the form `start_timestamp >
'2025-08-16T20:35:13.00Z'`. If we knew the correct timestamp value before
starting the plan, we could simply write:

```sql
SELECT *
FROM records
WHERE start_timestamp > '2025-08-16T20:35:13.00Z'  -- Filter to skip rows
ORDER BY start_timestamp DESC
LIMIT 3;
```

And DataFusion's sophisticated [multi-level filter pushdown] and pruning would
ensure that we skip reading unnecessary files and row groups, and only decode
the necessary rows.

[multi-level filter pushdown]: https://datafusion.apache.org/blog/2025/08/15/external-parquet-indexes/

However, obviously when we start running the query we don't have the value
`'2025-08-16T20:35:13.00Z'`, so what DataFusion does is put in a placeholder in
the plan, which you can think of as:

```sql
SELECT *
FROM records
WHERE dynamic_filter()
ORDER BY start_timestamp DESC
LIMIT 3;
```

In this case, `dynamic_filter()` is a structure that initially has the value
`true` but will be progressively updated by the TopK operator as the query
progresses. Note that while we are using SQL for illustrative purposes, these
optimizations are actually done at the physical plan ([ExecutionPlan]) -
and they apply to both SQL and DataFrame APIs.

[ExecutionPlan]: https://docs.rs/datafusion/latest/datafusion/physical_plan/trait.ExecutionPlan.html

## TopK + Dynamic Filters

As mentioned above, DataFusion has a specialized sort operator named [TopK]
that only keeps ~ `K` rows in memory. For a `DESC` sort order, each new input
batch is compared against the current `K` largest values, and then the current
`K` rows possibly get replaced with any new rows that were larger. The [code is here].

[TopK]: https://docs.rs/datafusion/latest/datafusion/physical_plan/struct.TopK.html
[code is here]: https://github.com/apache/datafusion/blob/b4a8b5ae54d939353b7cbd5ab8aee7d3bedecb66/datafusion/physical-plan/src/topk/mod.rs

Prior to dynamic filters, DataFusion had no early termination: it would read the
*entire* `records` table even if it already had the top `K` rows because it
still had to check that there were no rows that had larger `start_timestamp`.

You can see how this is a problem if you have 2 years' worth of timeseries data:
the largest `1000` values of `start_timestamp` are likely within the first few
files read, but even if the `TopK` operator has seen 1000 timestamps on August
16th, 2025, DataFusion would still read files that have only data in 2024 just to
make sure.

InfluxData [optimized a similar query pattern in InfluxDB IOx] using another
operator called [`ProgressiveEvalExec`] but that operator requires that the data
is already sorted and a careful analysis of ordering to prove that it can be
used. That is not the case for Logfire data (and many other datasets out there):
data can tend to be *roughly* sorted (e.g. if you append to files as you receive
it) but that does not guarantee that it is fully sorted, including between
files. 

We [discussed possible solutions] with the community, which ultimately resulted
in the implementation of "dynamic filters", and our design is general enough that it
applies to joins as well. We believe our implementation is very similar to
recently announced optimizations in closed source, commercial systems such as
[Accelerating TopK Queries in Snowflake], or [self-sharpening runtime filters in
Alibaba Cloud's PolarDB], and we are excited we can offer similar performance
improvements in an open source query engine like DataFusion. We hope this will
help all users with similar workloads.

[discussed possible solutions]: https://github.com/apache/datafusion/issues/15037
[Accelerating TopK Queries in Snowflake]: https://program.berlinbuzzwords.de/bbuzz24/talk/3DTQJB/
[self-sharpening runtime filters in Alibaba Cloud's PolarDB]: https://www.alibabacloud.com/blog/about-database-kernel-%7C-learn-about-polardb-imci-optimization-techniques_600274

At the query plan level, Q23 looks like this before it is executed:

```text
┌───────────────────────────┐
│       SortExec(TopK)      │
│    --------------------   │
│ EventTime@4 ASC NULLS LAST│
│                           │
│         limit: 10         │
└─────────────┬─────────────┘
┌─────────────┴─────────────┐
│       DataSourceExec      │
│    --------------------   │
│         files: 100        │
│      format: parquet      │
│                           │
│         predicate:        │
│ CAST(URL AS Utf8View) LIKE│
│      %google% AND true    │
└───────────────────────────┘
```

**Figure 5**: Physical plan for ClickBench Q23 prior to execution. The dynamic
filter shown as `true` in the `predicate` field of the `DataSourceExec`
operator.

The dynamic filter is updated by the `SortExec(TopK)` operator during execution
as it processes rows, as shown in Figure 6.

```text
┌───────────────────────────┐
│       SortExec(TopK)      │
│    --------------------   │
│ EventTime@4 ASC NULLS LAST│
│                           │
│         limit: 10         │
└─────────────┬─────────────┘
┌─────────────┴─────────────┐
│       DataSourceExec      │
│    --------------------   │
│         files: 100        │
│      format: parquet      │
│                           │
│         predicate:        │
│ CAST(URL AS Utf8View) LIKE│
│      %google% AND         │
│ EventTime < 1372713773.0  │
└───────────────────────────┘
```
**Figure 6**: Physical plan for ClickBench Q23 after to execution. The dynamic filter has been
updated to `EventTime < 1372713773.0` which allows the `DataSourceExec` operator to skip
files and rows that do not match the filter.

## Hash Join + Dynamic Filters

We spent significant effort to make dynamic filters a general purpose
optimization (see the Extensibility section below for more details). Instead of
a one-off optimization for TopK queries, we created a general mechanism for
passing information between operators during execution that can be used in many
different contexts. We have already used the dynamic filter infrastructure to
improve hash joins by implementing a technique called [sideways information
passing], which is similar to [Bloom filter joins] in Apache Spark. See 
[issue #7955] for more details.

[sideways information passing]: https://15721.courses.cs.cmu.edu/spring2020/papers/13-execution/shrinivas-icde2013.pdf
[Bloom filter joins]: https://issues.apache.org/jira/browse/SPARK-32268
[issue #7955]: https://github.com/apache/datafusion/issues/7955

In a Hash Join, the query engine picks one input of the join to be the "build"
input and the other input to be the "probe" side. A hash join first *builds* a
hash table by reading the build input into memory, and then it reads the probe
input, using the hash table to find match rows from the probe side.
Many hash joins are very selective (only a small number of rows are matched) and
act as a filter, so it is natural to use the same dynamic filter technique to
create filters on the probe side scan based on the values that were seen on the
build side.

DataFusion 50.0.0 adds a dynamic filters to the proble input using min/max join
key values from the build side. This simple approach is fast to evaluate and the
filter improves performance significantly when used with statistics pruning,
late materialization, and other optimizations as shown in Figure 7.

<div class="text-center">
<img 
  src="/blog/images/dynamic-filters/join-performance.png" 
  width="80%" 
  class="img-responsive" 
  alt="Join Performance Improvements with Dynamic Filters"
/>
</div>

**Figure 7**: Join performance with and without dynamic filters. In DataFusion
49.0.2 the join takes 2.5s, even with late materialization enabled. In
DataFusion 50.0.0 with dynamic filters enabled the join takes only 0.7s, a 5x
improvement, and with both dynamic filters and late materialization it takes
only 0.1s, a 25x improvement. See this [discussion] for more details.

[discussion]: https://github.com/apache/datafusion-site/pull/103#issuecomment-3262612288

You can see dynamic join filters in action by running the following example. 

```sql
-- create two tables: small_table with 1K rows and large_table with 100K rows
copy (select i as k, i as v from generate_series(1, 1000) t(i)) to 'small_table.parquet';
create external table small_table stored as parquet location 'small_table.parquet';
copy (select i as k from generate_series(1, 100000) t(i)) to 'large_table.parquet';
create external table large_table stored as parquet location 'large_table.parquet';

-- Join the two tables, with a filter on small_table
EXPLAIN 
SELECT * 
FROM small_table JOIN large_table ON small_table.k = large_table.k 
WHERE small_table.v >= 50;
```

A dynamic filter is created on the `large_table` scan which is updated as the
`small_table` is read and the hash table is built. Before execution, the plan
looks like this:

```text
+---------------+------------------------------------------------------------+
| plan_type     | plan                                                       |
+---------------+------------------------------------------------------------+
| physical_plan | ┌───────────────────────────┐                              |
|               | │    CoalesceBatchesExec    │                              |
|               | │    --------------------   │                              |
|               | │     target_batch_size:    │                              |
|               | │            8192           │                              |
|               | └─────────────┬─────────────┘                              |
|               | ┌─────────────┴─────────────┐                              |
|               | │        HashJoinExec       │                              |
|               | │    --------------------   ├──────────────┐               |
|               | │        on: (k = k)        │              │               |
|               | └─────────────┬─────────────┘              │               |
|               | ┌─────────────┴─────────────┐┌─────────────┴─────────────┐ |
|               | │   CoalescePartitionsExec  ││      RepartitionExec      │ |
|               | │                           ││    --------------------   │ |
|               | │                           ││ partition_count(in->out): │ |
|               | │                           ││          1 -> 16          │ |
|               | │                           ││                           │ |
|               | │                           ││    partitioning_scheme:   │ |
|               | │                           ││    RoundRobinBatch(16)    │ |
|               | └─────────────┬─────────────┘└─────────────┬─────────────┘ |
|               | ┌─────────────┴─────────────┐┌─────────────┴─────────────┐ |
|               | │    CoalesceBatchesExec    ││       DataSourceExec      │ |
|               | │    --------------------   ││    --------------------   │ |
|               | │     target_batch_size:    ││          files: 1         │ |
|               | │            8192           ││      format: parquet      │ |
|               | │                           ││      predicate: true      │ |
|               | └─────────────┬─────────────┘└───────────────────────────┘ |
|               | ┌─────────────┴─────────────┐                              |
|               | │         FilterExec        │                              |
|               | │    --------------------   │                              |
|               | │     predicate: v >= 50    │                              |
|               | └─────────────┬─────────────┘                              |
|               | ┌─────────────┴─────────────┐                              |
|               | │      RepartitionExec      │                              |
|               | │    --------------------   │                              |
|               | │ partition_count(in->out): │                              |
|               | │          1 -> 16          │                              |
|               | │                           │                              |
|               | │    partitioning_scheme:   │                              |
|               | │    RoundRobinBatch(16)    │                              |
|               | └─────────────┬─────────────┘                              |
|               | ┌─────────────┴─────────────┐                              |
|               | │       DataSourceExec      │                              |
|               | │    --------------------   │                              |
|               | │          files: 1         │                              |
|               | │      format: parquet      │                              |
|               | │     predicate: v >= 50    │                              |
|               | └───────────────────────────┘                              |
|               |                                                            |
+---------------+------------------------------------------------------------+
```

**Figure 8**: Physical plan for the join query before execution. The left input
to the join is the build side, which scans small_table and applies the filter 
`v >= 50`. The right input to the join is the probe side, which scans `large_table`
and has the dynamic filter placeholder `true`

## Dynamic Filter Extensibility: Custom `ExecutionPlan` Operators

We went to great efforts to ensure that dynamic filters are not a hardcoded
black box that only works for internal operators. This is important not only for
software maintainability, but also because DataFusion is used in many different
contexts, some with very advanced custom operators specialized for specific use
cases.

Dynamic filters creation and pushdown are implemented as methods on the
[ExecutionPlan trait]. Thus, it is possible for user defined, custom
`ExecutionPlan`s to use dynamic filters with little to no modification. We also
provide an extensive library of helper structs and functions, so it often
takes only 1-2 lines to implement filter pushdown support or a source of dynamic
filters for custom operators.

[ExecutionPlan trait]: https://docs.rs/datafusion/latest/datafusion/physical_plan/trait.ExecutionPlan.html

This approach has already paid off, and we know of community members who have
implemented support for dynamic filter pushdown using preview releases of
DataFusion 50.0.0.

<!-- AAL Who else has done this? -->

###  Design of Scan Operator Integration

A core design decision is that dynamic filters are represented as `Arc<dyn
PhysicalExpr>` which is the same interface as all other expressions in
DataFusion. This means that `DataSourceExec` and other scan operators do not
handle dynamic filters specially and existing filter pushdown logic works as
expected. We did, add some new functionality to `PhysicalExpr` to make working
with dynamic filters more performant for specific use cases:

* `PhysicalExpr::generation() -> u64`: to track if a tree of filters has
  changed (e.g. because it has a dynamic filter that has been updated). For
  example, if we go from `c1 = 'a' AND DynamicFilter [ c2 > 1]` to `c1 = 'a' AND
  DynamicFilter [ c2 > 2]` the generation value will change so operators know if they
  should re-evaluate the filter against static data like file or row group level
  statistics. This is used to do early termination of reading a file if the
  filter is updated mid scan and we can now skip the file, without
  needlessly re-evaluating file level statistics all the time.

* `PhysicalExpr::snapshot() -> Arc<dyn PhysicalExpr>`: used to create a snapshot
  of the filter at a given point in time. Dynamic filters use this to return the
  current value of their inner static filter. This can be used to serialize the
  filter across the network for distributed engines or pass to systems that
  support specific static filter patterns (e.g. stats pruning rewrites).

This is all encapsulated in the `DynamicFilterPhysicalExpr` struct.

Another important design decisions was how to handle concurrency and information
flow. In early designs, the scan polled the source operators on every row /
batch, which had significant overhead. The final design is a "push" model where
the scan requires has minimal locking and the write path (e.g. the TopK
operator) is responsible for updating the filter. You can think of
`DynamicFilterPhysicalExpr` as an `Arc<RwLock<Arc<dyn PhysicalExpr>>>` which
allows the TopK operator to update the filter without blocking the scan
operator.

## Future Work

Although we've made great progress and DataFusion now has one of the most
advanced open source dynamic filter / sideways information passing
implementations that we know of, there are many of areas of future improvement
such as:

* [Support for more types of joins]: This optimization is only implemented for
  `INNER` hash joins so far, but it could be implemented for other join algorithms
   (nested loop joins, etc.) and join type (e.g. `LEFT OUTER JOIN`, etc).

* [Push down entire hash tables to the scan operator]: We could improve the representation
  of the dynamic filter from min/max values to improve performance for joins with many
  distinct matching keys that are not naturally ordered or have a lot of skew.

* [Use file level statistics to order files] to match the `ORDER BY` clause as
  much as possible. This can help TopK dynamic filters be more effective at
  pruning by skipping more work earlier in the scan.

[Support for more types of joins]: https://github.com/apache/datafusion/issues/16973
[Push down entire hash tables to the scan operator]: https://github.com/apache/datafusion/issues/17171
[Use file level statistics to order files]: https://github.com/apache/datafusion/issues/17348


## Acknowledgements

Thank you to [Pydantic] and [InfluxData] for supporting our work on DataFusion
and open source in general. Thank you to [zhuqi-lucas], [xudong963],
[Dandandan],  and [LiaCastaneda], for helping with the dynamic join filter
implementation and testing. Thank you to [nuno-faria] for providing performance
results with joins.

[Pydantic]: https://pydantic.dev
[InfluxData]: https://www.influxdata.com/
[zhuqi-lucas]: https://github.com/zhuqi-lucas
[xudong963]: https://github.com/xudong963
[Dandandan]: https://github.com/Dandandan
[LiaCastaneda]: https://github.com/LiaCastaneda
[nuno-faria]: https://github.com/nuno-faria


## About the Authors

[Adrian Garcia Badaracco](https://www.linkedin.com/in/adrian-garcia-badaracco/) is a Founding Engineer at
[Pydantic](https://pydantic.dev/), and an [Apache
DataFusion](https://datafusion.apache.org/) committer. 

[Andrew Lamb](https://www.linkedin.com/in/andrewalamb/) is a Staff Engineer at
[InfluxData](https://www.influxdata.com/), and a member of the [Apache
DataFusion](https://datafusion.apache.org/) and [Apache Arrow](https://arrow.apache.org/) PMCs. He has been working on
databases and related systems for more than 20 years.

## About DataFusion

[Apache DataFusion] is an extensible query engine toolkit, written
in Rust, that uses [Apache Arrow] as its in-memory format. DataFusion and
similar technology are part of the next generation “Deconstructed Database”
architectures, where new systems are built on a foundation of fast, modular
components, rather than as a single tightly integrated system.

The [DataFusion community] is always looking for new contributors to help
improve the project. If you are interested in learning more about how query
execution works, help document or improve the DataFusion codebase, or just try
it out, we would love for you to join us.

[Apache Arrow]: https://arrow.apache.org/
[Apache DataFusion]: https://datafusion.apache.org/
[DataFusion community]: https://datafusion.apache.org/contributor-guide/communication.html

## Footnotes

<a id="footnote1"></a><sup>[1](#fn1)</sup> *Dynamic Filters (DF)* refers to the
optimization described in this blog post. The TopK operator will generate a
filter that is applied to the scan operators, which will first be used to skip
rows and then as we open new files (if there are more to open) it will be used
to skip entire files that do not match the filter.

<a id="footnote2"></a><sup>[2](#fn2)</sup> *Late Materialization (LM)* refers to
the optimization described in [this blog post]. Late Materialization is
particularly effective when combined with dynamic filters as it can apply
filters during a scan. Without late materialization, dynamic filters can only be
used to prune row groups or entire files, which will be less effective if the 
files themselves are large or the top values are not in the first few files read.

[this blog post]: https://datafusion.apache.org/blog/2025/03/21/parquet-pushdown/


## Appendix

### Queries and Data

#### Figure 1: ClickBench Q23

```sql
-- Data was downloaded using apache/datafusion -> benchmarks/bench.sh -> ./benchmarks/bench.sh data clickbench_partitioned
create external table hits stored as parquet location 'benchmarks/data/hits_partitioned';

-- Must set for ClickBench hits_partitioned dataset. See https://github.com/apache/datafusion/issues/16591
set datafusion.execution.parquet.binary_as_string = true;
-- Only matters if pushdown_filters is enabled but they don't get enabled together sadly
set datafusion.execution.parquet.reorder_filters = true;

set datafusion.execution.target_partitions = 1;  -- or set to 12 to use multiple cores
set datafusion.optimizer.enable_dynamic_filter_pushdown = false;
set datafusion.execution.parquet.pushdown_filters = false;

explain analyze
SELECT *
FROM hits
WHERE "URL" LIKE '%google%'
ORDER BY "EventTime"
LIMIT 10;
```

| dynamic filters   | late materialization   |   cores |   time (s) |
|:------------------|:-----------------------|--------:|-----------:|
| False             | False                  |       1 |     32.039 |
| False             | True                   |       1 |     16.903 |
| True              | False                  |       1 |     18.195 |
| True              | True                   |       1 |      1.42  |
| False             | False                  |      12 |      5.04  |
| False             | True                   |      12 |      2.37  |
| True              | False                  |      12 |      5.055 |
| True              | True                   |      12 |      0.602 |

