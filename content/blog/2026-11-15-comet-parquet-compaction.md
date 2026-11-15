---
layout: post
title: Round Robin Without the Hash: Faster Parquet Compaction in Apache DataFusion Comet
date: 2026-11-15
author: pmc
categories: [performance, subprojects]
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

Compaction is one of the most common maintenance jobs on a data lake. It rewrites the many small files of a table partition as a few large ones. For plain Parquet tables it is often a single line of Spark, and at its center is the round robin shuffle behind `repartition(n)`.

On a production table with more than 200 columns, nested up to seven levels deep, Apache DataFusion Comet compacted a 200 GB daily partition in 70 minutes, against 80 minutes for Spark. The bottleneck was the shuffle write, where Comet's round robin hashed every value of every row. With positional round robin, which places rows by their position and copies them in contiguous groups, Comet compacts the same partition in 28 minutes. That is 2.9x faster than Spark, with 6.4x less memory.

<img
src="/blog/images/comet-parquet-compaction/results.svg"
width="100%"
class="img-fluid"
alt="Compaction of a 200 GB partition. Execution time: Spark 4.0 80 minutes, Comet with hash round robin 70 minutes, Comet with positional round robin 28 minutes. Peak memory: 770 GB, 130 GB and 120 GB."
/>

This post explains how compaction runs, why hashing was slow on nested data, and the three approaches we tried: a faster hash, a vectorized round robin that was fast but not safe when tasks are retried, and the positional round robin that Comet has offered since 1.1.0.

## What compaction does

Small files are a side effect of how data lands in a data lake. Streaming jobs commit every few minutes, many writers each add files to the same partition, and late data arrives in small batches. Every file costs a reader a file open, a footer read and at least one request to object storage, and small files hold small row groups that encode and compress less well. A day of data is slower to read from a thousand small files than from a few dozen large ones.

Compaction runs in the background and rewrites a partition's small files as a few large ones. Table formats such as Apache Iceberg and Delta Lake have their own procedures for it. For a plain directory of Parquet files, a common way is a short Spark job:

```scala
spark.read.parquet(inputPath)
  .repartition(50)
  .write.parquet(outputPath)
```

`repartition(50)` with no columns asks Spark for round robin partitioning. Rows are dealt evenly to 50 partitions regardless of their content, and each partition is written as one file, so the output files come out about the same size. `coalesce(50)` would skip the shuffle, but it also limits the scan to 50 tasks, and because it merges whole input splits, the output sizes follow the input.

### How the job runs

The job runs as two stages with a shuffle between them:

1. **Map stage.** Each task scans one split of the input, assigns every row to one of the 50 output partitions (round robin partitioning) and writes the rows to a local shuffle file, grouped by partition (shuffle write).
2. **Reduce stage.** Each of the 50 tasks fetches its partition from every map task (shuffle read) and writes the rows as one Parquet file (Parquet write).

<img
src="/blog/images/comet-parquet-compaction/pipeline.svg"
width="100%"
class="img-fluid"
alt="The compaction job in two stages. Map stage: Parquet scan, round robin partitioning that sends each row to one of 50 partitions, and shuffle write grouped by partition. Reduce stage with 50 tasks: shuffle read from every map task and Parquet write of one file per task. Input is 1,200 files and 200 GB, output is 50 files."
/>

Comet runs the map stage natively. Its Parquet scan produces Arrow record batches, and its native shuffle writer partitions them, buffers them per partition, spills when memory runs short and writes each partition as compressed Arrow IPC blocks. All of it runs in Rust, without converting the batches to rows.

### Wide and deep data

The input is one daily partition of a production event table, 1,200 Parquet files and 200 GB in total. The output is 50 files.

The table is wide and deep. It has more than 200 columns, nested up to seven levels deep. Parquet stores each leaf field as its own column. Arrow gives each level of nesting its own array with its own validity bitmap, and each list adds an offsets buffer. Even a small nested column is several arrays:

```
a: STRUCT<b: ARRAY<STRUCT<c: INT, d: STRING>>>

a          struct   validity
a.b        list     validity, offsets
a.b[]      struct   validity
a.b[].c    int32    validity, values
a.b[].d    utf8     validity, offsets, values
```

That is five arrays and nine buffers for two leaf values. One row of the compaction table is spread over hundreds of arrays like these. Work that handles one row at a time, such as hashing a row or copying it into another batch, visits every one of them for every row. Work that handles a range of rows visits each array once per range.

Flat benchmarks such as TPC-H have no data like this, which is why we built [nested TPC-H](https://datafusion.apache.org/blog/2026/10/25/comet-nested-tpch/).

## Round robin in Spark and in Comet

### Spark deals rows by position

Spark's round robin deals rows like cards. Each map task starts at a pseudo-random partition, `new XORShiftRandom(partitionId).nextInt(numPartitions)`, and sends each row to the next partition in turn. Placement depends only on a row's position in the task's input, so it is cheap and as even as it can be.

Positions are fragile when tasks fail. If a map task is retried after some reducers have already fetched its output, the retry has to send every row to the same partition as the first attempt. Otherwise the reducers that fetched from the first attempt and the reducers that fetch from the retry see two different splits of the same rows, and the job silently loses some rows and duplicates others ([SPARK-23207](https://issues.apache.org/jira/browse/SPARK-23207)). A retry does not always see its rows in the same order. Rows that come out of another shuffle, for example, arrive in whatever order their blocks were fetched.

So by default (`spark.sql.execution.sortBeforeRepartition=true`), Spark first sorts each map partition by the binary form of its rows, `UnsafeRow`. Placement then depends only on which rows a task has, not on their order. The cost is a full sort of every map partition, which spills to disk when it does not fit in memory.

### Comet hashed every column

Comet's native shuffle works on Arrow batches, and Arrow cannot reproduce the `UnsafeRow` sort order. When round robin came to the native shuffle in [#3076](https://github.com/apache/datafusion-comet/pull/3076), it was built as hash partitioning on every column instead. A row goes to `pmod(murmur3(row), numPartitions)` with Spark's seed of 42, the same as `df.repartition(n, df.columns.map(col): _*)`. [#3077](https://github.com/apache/datafusion-comet/pull/3077) extended Comet's murmur3 to structs, arrays and maps to make that possible.

A hash depends only on a row's content, so a retried task places rows the same way in any order, with no sort. The approach gives up two things. Comet sends rows to different partitions than Spark would, and identical rows always land in the same partition, so data with many repeated rows ends up skewed. Because of the first, native round robin is off by default (`spark.comet.shuffle.native.partitioning.roundrobin.enabled`). Without it, Comet hands round robin to its JVM shuffle, which converts the batches to rows and back.

## Hashing made compaction slow

Flat benchmarks never showed a problem, because hashing a flat row is cheap. On wide nested data like this table, the map tasks that do Comet's shuffle write ran two to three times slower than Spark's ([#5397](https://github.com/apache/datafusion-comet/issues/5397)). End to end, Comet took 70 minutes against Spark's 80, only 1.1x faster.

The time went into two passes over every value of every row:

1. **Hash.** `create_murmur3_hashes` visits every leaf value of every row. For each array it dispatches on the data type, recurses into every struct field and list element, and checks validity at every level.
2. **Gather.** Hashing scatters neighboring rows across all partitions. The writer keeps one `(batch, row)` index per row and builds each partition's output with `interleave_record_batch`, a per-row gather that walks every column and nested child a second time.

A microbenchmark added later in [#6095](https://github.com/apache/datafusion-comet/pull/6095) puts numbers on both passes. It places 8 batches of 8,192 rows into 50 partitions, on a schema of 40 struct columns with 120 leaf arrays. Hashing took 19 ms and the gather another 86 ms. The benchmark leaves out encoding, compression and I/O, so it shows where the writer spends its time, not how long a whole shuffle takes.

None of that work is needed to deal rows evenly. The hash is there only so that a retried task places rows the same way, and every attempt to replace it had to keep that property.

## Attempt 1: a faster hash

The first experiment kept the hash and made it cheaper. [#5450](https://github.com/apache/datafusion-comet/pull/5450) replaced murmur3 with XXH3 from the `xxhash-rust` crate for round robin. It turned out slower than murmur3.

The review of #5450 explained why. On a wide nested schema, the time is not in the mixing function but in walking every leaf value. XXH3 is fastest on long byte strings, but called once per value on 4- and 8-byte primitives it takes its short-input path, which does more setup per call than murmur3's single round. And even a free hash would leave the per-row gather in place.

The #6095 benchmark later confirmed this from another angle. Hashing only the first column (`spark.comet.shuffle.native.partitioning.roundrobin.maxHashColumns=1`) made placement 21x cheaper on the nested schema, but placement and gather together only 1.1x faster.

A faster hash had no other use either. Hash partitioning for joins and aggregations cannot change its function. One side of a join can be shuffled by Comet and the other by Spark, and both must agree on murmur3 with seed 42, or the join silently drops rows. #5450 was closed.

## Attempt 2: vectorized round robin

If placement does not need a row's content, the cheapest key is the batch. [#5449](https://github.com/apache/datafusion-comet/pull/5449) sent each Arrow batch whole to the next partition, `(mapPartitionId + batchSequence) % numPartitions`. There was no hash, and when a partition's output was exactly one buffered batch, the writer passed it through without copying.

The numbers were good. In a microbenchmark of 8 batches of 8,192 rows into 50 partitions, the partitioning step went from 12.8 ms to 0.27 ms on a nested schema, 47 to 49 times faster, and got 11 to 22 times faster on a flat one. On the cluster, a round robin repartition of a different dataset went from 21 to 10 minutes.

### The catch: task and executor restarts

Batch placement depends on how rows are framed into batches, and no Spark contract covers framing. Spark's `DeterministicLevel.DETERMINATE` promises the same rows in the same order on a retry, and says nothing about batch boundaries. Two attempts can see the same rows in the same order and still frame them as `[a, b] [c, d]` and `[a] [b, c, d]`, for example when an operator below the shuffle spills at a different point under different memory pressure. The two framings send row `b` to different partitions, and SPARK-23207 is back.

To cover the gap, #5449 added two defenses:

- Declare the shuffle `INDETERMINATE` when its input is unordered, through Spark's `isOrderSensitive` mechanism, so that the scheduler reruns the whole stage instead of a single task.
- Fail any retry of a task that uses batch placement, putting correctness ahead of availability.

They cancel each other out. Every stage rerun is a new stage attempt, so every rerun task trips the failure check. An executor lost in the middle of the stage, a fetch failure after the stage finished or a speculative copy of a slow task would each fail the whole job. That is not a mode to turn on for a large cluster, which is where a faster shuffle matters most.

Balance depended on framing too. A map task that emits 8 batches into 200 partitions writes to only 8 of them. #5449 was closed in favor of the next approach.

## Positional round robin

[#6095](https://github.com/apache/datafusion-comet/pull/6095) keeps positional placement with three changes. It counts rows instead of batches, it uses positions only where the query plan shows that a retry replays its rows in the same order, and it copies contiguous runs of rows instead of single rows.

### Placement

Each map task numbers its rows from 0, counting across batch boundaries, and sends row `i` to partition

```
(start + i / groupRows) % numPartitions
```

Consecutive rows go to the same partition in groups of `groupRows`, and the groups go to the partitions in turn.

<img
src="/blog/images/comet-parquet-compaction/placement.svg"
width="100%"
class="img-fluid"
alt="Where the 18 rows of one map task go, for three output partitions. Hashing every column scatters neighboring rows and places them the same way on a retry. Vectorized round robin sends each batch whole to the next partition, so a retry with batches of 4, 8 and 6 rows instead of 6, 6 and 6 moves rows 4 and 5. Positional round robin sends groups of four consecutive rows to the partitions in turn and places every row the same way on the retry."
/>

The figure follows one map task with 18 rows and three output partitions. Hashing scatters neighboring rows. Vectorized round robin keeps each batch together, so a retry that frames the rows as 4, 8 and 6 instead of 6, 6 and 6 moves rows 4 and 5. Positional round robin counts rows, so the retry places every row the same way.

- **Rows, not batches.** A group that one batch leaves part-way through is finished by the next. Placement depends on row order alone, not on how the rows are framed or when the writer spills. Tests feed the same 1,000 rows through five different framings, and through forced spills, and check that every row lands in the same partition.
- **Group size.** By default `groupRows` is `clamp(batchSize / numPartitions, 64, batchSize)`, which is 163 rows for 8,192-row batches into 50 partitions. Each task then cycles through all the partitions about once per batch, and within one task no two partitions differ by more than `groupRows` rows. The 64-row floor keeps runs from getting too short when there are many partitions, at the cost that a task then needs several batches to cycle through them all. The driver resolves the group size and stores it with the shuffle dependency, so a task that reruns after `spark.comet.batchSize` changes still uses the original size.
- **Start partition.** `start` is `XORShiftRandom(mapPartitionId).nextInt(numPartitions) + 1`, the start Spark uses. A task walks consecutive partitions from its start, so the starts of different tasks must be spread out, not just distinct. With adjacent starts, ten map tasks of 5,000 rows into 200 partitions, at a group of 64, would leave 112 partitions empty. With Spark's scrambled starts, none are empty. Spark scrambles its start for the same reason ([SPARK-21782](https://issues.apache.org/jira/browse/SPARK-21782)).

With `groupRows = 1`, this is exactly Spark's round robin with `sortBeforeRepartition` turned off.

### Retry safety comes from the plan

Nothing sorts, so a retried task must see the same rows in the same order. Comet checks this in the plan instead of assuming it. Positional placement is used only when the shuffle writer reads from a native Parquet scan, through nothing but projections and filters whose expressions are all deterministic. A native scan replays its rows in order because its file splits are fixed on the driver. Every other plan keeps hash placement. That includes any aggregate, sort or join under the shuffle, since an operator that spills can emit its rows in a different order on a retry, and any nondeterministic expression, such as `rand()` or a UDF marked `asNondeterministic`.

Within that gate, a retried task reproduces its placement exactly, so Spark's usual recovery works unchanged. Task retries, lost executors, fetch failures and speculative tasks need no special handling, and nothing fails the job on a retry. As a second line of defense, `CometNativeShuffleInputRDD` reports itself `INDETERMINATE` over an unordered parent, which only matters if the gate is widened later. Positional placement is not used with the Celeborn shuffle manager yet.

Review found two holes before merge, each with a reproduction. A projection with a UDF marked `asNondeterministic` passed the allowlist, and a UDF that swapped two groups of 64 rows between attempts lost 64 values and duplicated 64 others. The group size was first derived on the executor, so changing `spark.comet.batchSize` between attempts duplicated and lost 1,024 of 16,384 values. Both were fixed before merge, and both cases are now tests.

### Copying runs instead of rows

Keeping neighboring rows together also removes most of the gather. The writer records `(batch, start, len)` runs instead of one `(batch, row)` pair per row, and builds each output batch by slicing and concatenating runs. That is one bulk copy per buffer per run, instead of a walk through every column for every row. A run that covers a whole buffered batch passes through without a copy. Arrow's IPC writer writes only the visible window of a sliced array for every type except `Utf8View` and `BinaryView`, which it writes with their shared data buffers in full, so a schema with a view type falls back to hash placement.

In the #6095 microbenchmark, positional placement is 124x cheaper than hashing on the nested schema (157 µs against 19.3 ms), and placement and gather together are 5.2x faster (20.4 ms against 105.7 ms). Much of that gain comes from the run representation rather than the placement key. Even the placement step alone is faster than vectorized round robin's, 62x against 47x to 49x over hashing on the nested schema, because the vectorized writer still appended one index per row.

Groups as large as a batch would make every run a whole batch and the gather almost free, 549x faster than hashing in the same benchmark. They are not the default, because the benchmark runs a single map task and hides what happens across tasks. A reducer receives groups from every map task, and the stage is only balanced when each task emits many more groups than there are partitions. In a simulation of 50 map tasks of a million rows each into 200 partitions, batch-sized groups gave the largest partition 1.57 times as many rows as the smallest, against 1.00 for the default. For 10 tasks of 500,000 rows, the ratio was 6.0 against 1.01. Larger groups remain available through `spark.comet.shuffle.native.partitioning.roundrobin.positional.groupRows`.

## Results

| | Execution time | Peak memory, mean over executors |
| --- | ---: | ---: |
| Spark 4.0 | 1 h 20 min | 770 GB |
| Comet, hash round robin | 1 h 10 min (1.1x) | 130 GB (5.9x less) |
| Comet, positional round robin | **28 min (2.9x)** | **120 GB (6.4x less)** |

- Positional round robin cut Comet's time from 70 to 28 minutes, 2.5x on its own. The two Comet runs differ only in `spark.comet.shuffle.native.partitioning.roundrobin.positional.enabled`.
- Both Comet runs use about a sixth of Spark's memory. We have not profiled where Spark's memory goes, but its sort before the round robin is the likely cause of most of it.

Setup:

- **Job**: `spark.read.parquet(inputPath).repartition(50).write.parquet(outputPath)`.
- **Input**: one daily partition, 1,200 Parquet files and 200 GB, with more than 200 columns nested up to seven levels deep. **Output**: 50 Parquet files.
- **Versions**: Spark 4.0, and Comet built from `main` ahead of 1.3.0. Positional round robin has been available since [Comet 1.1.0](https://datafusion.apache.org/blog/2026/10/01/datafusion-comet-1.1.0/).
- **Comet settings**: `spark.comet.shuffle.native.partitioning.roundrobin.enabled=true` in both Comet runs, plus `spark.comet.shuffle.native.partitioning.roundrobin.positional.enabled=true` in the positional run.

## Trying it

```
spark.comet.shuffle.native.partitioning.roundrobin.enabled=true
spark.comet.shuffle.native.partitioning.roundrobin.positional.enabled=true
```

Both settings are off by default. Native round robin is off because it sends rows to different partitions than Spark's, so each output file holds different rows than it would under Spark. The set of rows is the same, and sorted output is identical. Compaction only needs files of even size, so this rarely matters there.

Positional placement applies when the round robin shuffle reads from a native Parquet scan with only deterministic projections and filters on top, the shuffle manager is not Celeborn, and the schema has no view types. Every other round robin shuffle keeps hash placement. The [native shuffle guide](https://datafusion.apache.org/comet/contributor-guide/native_shuffle.html) has the full argument.

## What's next

- **Runs for hash partitioning.** Hash and range partitioning still gather row by row, even when a whole batch goes to one partition. That is common in Iceberg writes that rebalance on a partition column with one value per run, such as the date of a daily job. [#7636](https://github.com/apache/datafusion-comet/pull/7636), in review, slices contiguous rows there too ([#7474](https://github.com/apache/datafusion-comet/issues/7474)).
- **More plans.** Positional placement covers scans with projections and filters. Admitting another operator needs its own argument that the operator replays its rows in the same order.
- **Celeborn.** Push shuffle needs tests with sliced batches and with an indeterminate stage's rollback before it can use positional placement.

## Pull requests and issues

- **Round robin in the native shuffle** ([#3067](https://github.com/apache/datafusion-comet/issues/3067), fixed by [#3076](https://github.com/apache/datafusion-comet/pull/3076)). Hash partitioning on all columns, off by default. It builds on [#3077](https://github.com/apache/datafusion-comet/pull/3077), which extended murmur3 to complex types.
- **Slow round robin shuffle writes on nested schemas** ([#5397](https://github.com/apache/datafusion-comet/issues/5397)). The issue behind this work.
- **A faster hash** ([#5450](https://github.com/apache/datafusion-comet/pull/5450), closed). XXH3 instead of murmur3, slower on the cluster.
- **Vectorized round robin** ([#5449](https://github.com/apache/datafusion-comet/pull/5449), closed). Batch placement, fast but not safe under retries.
- **Positional round robin** ([#6095](https://github.com/apache/datafusion-comet/pull/6095), merged, in Comet 1.1.0). Row-ordinal placement, gated on the plan, with a run-based copy.
- **Contiguous rows in hash partitioning** ([#7474](https://github.com/apache/datafusion-comet/issues/7474), in review in [#7636](https://github.com/apache/datafusion-comet/pull/7636)).

## Get involved

Thanks to [@andygrove] for native round robin and positional round robin, to [@comphead] for the experiments in #5449 and #5450, and to [@sunchao] and [@mbutrovich] for the reviews that shaped its retry safety and defaults.

Issues, pull requests and results from other nested workloads are welcome. See the [Comet contributor guide](https://datafusion.apache.org/comet/contributor-guide/index.html).

[@andygrove]: https://github.com/andygrove
[@comphead]: https://github.com/comphead
[@mbutrovich]: https://github.com/mbutrovich
[@sunchao]: https://github.com/sunchao
