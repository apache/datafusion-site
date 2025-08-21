---
layout: post
title: Dynamic Filters: information passing between operators for 10x faster queries
date: 2025-08-16
author: Adrian Garcia Badaracco (Pydantic)
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

<!-- diagrams source https://docs.google.com/presentation/d/1e_Z_F8nt2rcvlNvhU11khF5lzJJVqNtqtyJ-G3mp4-Q -->

This blog post introduces a powerful query engine optimization technique called dynamic filters or sideways information passing. We implemented this optimization in DataFusion as a community effort with care to support custom operators and distributed usage. These optimizations (and related work) have resulted in order of magnitude improvements for some query patterns.

## Motivation

Our main commercial product at [Pydantic](https://pydantic.dev/logfire) is an observability platform built on DataFusion. One of the most common workflows / queries is "show me the last K traces" which translates to something along the lines of:

```sql
SELECT *
FROM records
ORDER BY start_timestamp DESC
LIMIT 1000;
```

We noticed this was *pretty slow* for us, and came to the finding that DataFusion runs this query by reading the *entire* `records` table and sorting it. It uses a specialized sort operator called a `TopK` that only keeps ~ `K` rows in memory: every new batch that gets read is compared against the `K` largest (in the case of an `DESC` order; compared by the sort key, in this case `start_timestamp`) and then those `K` rows possibly get replaced with any new rows that were larger.
Importantly DataFusion had no early termination here: it would read the *entire* `records` table even if it already had `K` rows because it had to verify that there could not possibly be any other rows that are have a larger `start_timestamp`.

You can see how this is a problem if you have 2 years worth of data: the largest `1000` start timestamps are probably all within the first couple of files read, but even if we have 1000 timestamps on August 16th 2025 we'll keep reading files that have all of their timestamps in 2024 just to make sure.

Looking through the DataFusion issues we found that Influx has a similar issue that they've solved with an operator called [`SortPreservingMerge`](https://github.com/apache/datafusion/issues/15191), but that requires that the data is already sorted and requires some careful analysis of ordering to prove that it can be used. That is not the case for our data (and a lot of other datasets out there): data can tend to be *roughly* sorted (e.g. if you append to files as you receive it) but that does not guarantee that it is fully sorted, including between files. We brought this up with the community which ultimately resulted in us opening [an issue describing a possible solution](https://github.com/apache/datafusion/issues/15037) which we deemed "dynamic filters". The basic idea is to create a link between the state of the `TopK` operator and a filter that is applied when opening files and during scans. For example, let's say our `TopK` heap for an `ORDER BY start_timetsamp LIMIT 3` has the values:

| start_timestamp          |
|--------------------------|
| 2025-08-16T20:35:15.00Z  |
| 2025-08-16T20:35:14.00Z  |
| 2025-08-16T20:35:13.00Z  |

We'd generate a filter from these values of the form `start_timestamp > '2025-08-16T20:35:13.00Z'`, if that was placed into the query would look like:

```sql
SELECT *
FROM records
WHERE start_timestamp > '2025-08-16T20:35:13.00Z'
ORDER BY start_timestamp DESC
LIMIT 3;
```

But obviously when we start running the query we don't have the value `'2025-08-16T20:35:13.00Z'` so what we do is put in a placeholder value, you can think of it as:

```sql
SELECT *
FROM records
WHERE dynamic_filter()
ORDER BY start_timestamp DESC
LIMIT 3;
```

Where `dynamic_filter()` is a structure that initially has the value `true` but will be updated by the TopK operator as the query progresses. Although I'm showing this example as SQL for illustrative purposes these optimizations are actually done at the physical plan layer - much after SQL is parsed.

## Results Summary

We've seen upwards of a 10x performance improvement for some queries and no performance regressions.
The actual numbers depend on a lot of factors which we need to dig into.
Let's look at some preliminary numbers, using [ClickBench Q23](https://github.com/apache/datafusion/blob/main/benchmarks/queries/clickbench/queries/q23.sql) which is very similar to our earlier examples:

![exeuction-times](../images/dyanmic-filters/execution-time.svg)

<div class="text-center">
<img 
  src="/blog/images/dyanmic-filters/execution-time.svg" 
  width="80%" 
  class="img-responsive" 
  alt="Q23 Performance Improvement with Dynamic Filters and Late Materialization"
/>
</div>

**Figure 1**: Execution times for ClickBench Q23 with and without dynamic filters (DF) and late materialization (LM) for different partitions / core usage. Dynamic filters along show a large improvement but when combined with late materialization we can see up to a 22x improvement in execution time. See appendix for the queries used to generate these results.

Let's go over some of the flags used in the benchmark:

### Dynamic Filters

This is the optimization we spoke about above.
The TopK operator will generate a filter that is applied to the scan operators, which will first be used to skip rows and then as we open new files (if there are more to open) it will be used to skip entire files that do not match the filter.

### Late Materialization

This optimization has been talked about in the past (see for example [this blog post](./2025-03-21-parquet-pushdown.md)).
It's particularly effective when combined with dynamic filters because without them there is no tieme based filter to apply during the scan.
And without late materialization the filter can only be used to prune entire files, which is ineffective for large files or if the order in which files are read is not optimal.

## Implementation for TopK Operator

TopK operators (a specialization of a sort operator + a limit operator) implement dynamic filter pushdown by updating a filter each time the heap / topK is updated. The filter is then used to skip rows and files during the scan operator.
At the query plan level, Q23 looks like this before it is exectuted:

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

You can see the `true` placeholder filter for the dynamic filter in the `predicate` field of the `DataSourceExec` operator. This will be updated by the `SortExec` operator as it processes rows.
After running the query, the plan looks like this:

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

## Implementation for Hash Join Operator

We've also implemented dynamic filters for hash joins, also called "sideways information passing".
In a Hash Join the query engine picks one side of the join to be the "build" side and the other side to be the "probe" side. The build side is read first and then the probe side is read, using a hash table built from the build side to match rows from the probe side.
Dynamic filters are used to filter the probe side based on the values from the build side.
In particular, we take the min/max values from the build side and use them to create a filter that is applied to the probe side.
This is a very cheap filter to evaluate but when combined with statistics pruning, later materialization and other optimizations it can lead to significant performance improvements (we've observed up to 20x improvements in some queries).

A query plan for a hash join with dynamic filters looks like this after it is executed:


```sql
copy (select i as k from generate_series(1, 1000) t(i)) to 'small_table.parquet';
copy (select i as k, i as v from generate_series(1, 100000) t(i)) to 'large_table.parquet';
create external table small_table stored as parquet location 'small_table.parquet';
create external table large_table stored as parquet location 'large_table.parquet';
explain select * from small_table join large_table on small_table.k = large_table.k where large_table.v >= 50;
```

```text
┌───────────────────────────┐
│    CoalesceBatchesExec    │
│    --------------------   │
│     target_batch_size:    │
│            8192           │
└─────────────┬─────────────┘
┌─────────────┴─────────────┐
│        HashJoinExec       │
│    --------------------   ├──────────────┐
│        on: (k = k)        │              │
└─────────────┬─────────────┘              │
┌─────────────┴─────────────┐┌─────────────┴─────────────┐
│       DataSourceExec      ││    CoalesceBatchesExec    │
│    --------------------   ││    --------------------   │
│          files: 1         ││     target_batch_size:    │
│      format: parquet      ││            8192           │
└───────────────────────────┘└─────────────┬─────────────┘
                              ┌─────────────┴─────────────┐
                              │         FilterExec        │
                              │    --------------------   │
                              │     predicate: v >= 50    │
                              └─────────────┬─────────────┘
                              ┌─────────────┴─────────────┐
                              │      RepartitionExec      │
                              │    --------------------   │
                              │ partition_count(in->out): │
                              │          1 -> 12          │
                              │                           │
                              │    partitioning_scheme:   │
                              │    RoundRobinBatch(12)    │
                              └─────────────┬─────────────┘
                              ┌─────────────┴─────────────┐
                              │       DataSourceExec      │
                              │    --------------------   │
                              │          files: 1         │
                              │      format: parquet      │
                              │                           │
                              │         predicate:        │
                              │      v >= 50 AND.         │
                              │     k >= 1 AND k <= 1000  │
                              └───────────────────────────┘
```

## Implementation for Scan Operator

Scan operators do not actually know anything about dynamic filters: we were able to package up dynamic filters as an `Arc<dyn PhysicalExpr>` which is mostly handled by scan operators like any other expression.
We did however add some new functionality to `PhysicalExpr` to make working with dynamic filters easier:

* `PhysicalExpr::generation() -> u64`: used to track if a tree of filters has changed (e.g. because it has a dynamic filter that has been updated). For example, if we go from `c1 = 'a' AND DynamicFilter [ c2 > 1]` to `c1 = 'a' AND DynamicFilter [ c2 > 2]` the generation value will change so we know if we should re-evaluate the filter against static date like file or row group level statistics. This is used to do early termination of reading a file if the filter is updated mid scan and we can now skip the file, all without needlessly re-evaluating file level statistics all the time.
* `PhysicalExpr::snapshot() -> Arc<dyn PhysicalExpr>`: used to create a snapshot of the filter at a given point in time. Dynamic filters use this to return the current value of their innner static filter. This can be used to serialize the filter across the wire in the case of distributed queries or to pass to systems that only support more basic filters (e.g. stats pruning rewrites).

This is all encapsulated in the `DynamicFilterPhysicalExpr` struct.

One of the important design decisions was around directionality of information passing and locking: some early designs had the scan polling the source operators on every row / batch, but this causes a lot of overhead.
Instead we opted for a "push" based model where the read path has minimal locking and the write path (the TopK operator) is responsible for updating the filter.
Thus `DynamicFilterPhysicalExpr` is essentially an `Arc<RwLock<Arc<dyn PhysicalExpr>>>` which allows the TopK operator to update the filter while the scan operator can read it without blocking.

## Custom `ExectuionPlan` Operators

We went to great efforts to ensure that dynamic filters are not a hardcoded black box that only works for internal operators.
The DataFusion community is dynamic and the project is used in many different contexts, some with very advanced custom operators specialized for specific use cases.
To support this we made sure that dynamic filters can be used with custom `ExecutionPlan` operators by implementing a couple of methods in the `ExecutionPlan` trait.
We've made an extensive library of helper structs and functions that make it only 1-2 lines to implement filter pushdown support or a source of dynamic filters for custom operators.

This approach has already paid off: we've had multiple community members implement support for dynamic filter pushdown in just the first few months of this feature being available.

## Future Work

Although we've made great progress and DataFusion now has one of the most advanced dynamic filter / sideways information passing implementations that we know of we are not done yet!

There's a multitude of areas of future improvement that we are looking into:

* Support for more types of joins: we only implemented support for hash inner joins so far. There's the potential to expand this to other join types both in terms of the physical implementation (nested loop joins, etc.) and join type (e.g. left outer joins, cross joins, etc.).
* Push down entire hash tables to the scan operator: this could potentially help a lot with join keys that are not naturally ordered or have a lot of skew.
* Use file level statistics to order files to match the `ORDER BY` clause as best we can: this will help TopK dynamic filters be more effective by skipping more work earlier in the scan.

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
