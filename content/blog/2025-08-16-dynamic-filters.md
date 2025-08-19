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

This blog posts introduces a powerful query engine optimization technique called dynamic filters or sideways information passing. We implemented this optimization in DataFusion as a community effort with care to support custom operators and distributed usage. These optimizations (and related work) have resulted in order of magnitude imoprovemnts for some query patterns.

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

Where `dynamic_filter()` is a structure that initially has the value `true` but will be updated by the TopK operator as the query progresses. Altough I'm showing this example as SQL for illustrative purposes these optimizations are actually done at the physical plan layer - much after SQL is parsed.

## Results Summary

We've seen upwards of a 10x performance improvement for some queries and no performance regressions.
The actual numbers depend on a lot of factors which we need to dig into.
Let's look at some preliminary numbers, using [ClickBench Q23](https://github.com/apache/datafusion/blob/main/benchmarks/queries/clickbench/queries/q23.sql) which is very similar to our earlier examples:

![exeuction-times](../images/dyanmic-filters/execution-time.svg)

Figure 1: Execution times for ClickBench Q23 with and without dynamic filters (DF) and late materialization (LM) for different partitions / core usage. Dynamic filters along show a large improvement but when combined with late materialization we can see up to a 22x improvement in execution time. See appendix for the queries used to generate these results.

Let's go over some of the flags used in the benchmark:

### Dynamic Filters

This is the optimization we spoke about above.
The TopK operator will generate a filter that is applied to the scan operators, which will first be used to skip rows and then as we open new files (if there are more to open) it will be used to skip entire files that do not match the filter.

### Late Materialization

This optimization has been talked about in the past (see for example [this blog post](./2025-03-21-parquet-pushdown.md)).
It's particularly effective when combined with dynamic filters because without them there is no tieme based filter to apply during the scan.
And without late materialization the filter can only be used to prune entire files, which is ineffective for large files or if the order in which files are read is not optimal.

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
