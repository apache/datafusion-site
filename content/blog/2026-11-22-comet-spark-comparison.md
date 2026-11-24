---
layout: post
title: Where Apache Spark loses time, and how Apache DataFusion Comet gets it back
date: 2026-11-22
author: Viacheslav Inozemtsev
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

## Introduction

[Apache DataFusion Comet](https://datafusion.apache.org/comet/) is an accelerator for [Apache Spark](https://spark.apache.org/) that can also read and write [Apache Iceberg](https://iceberg.apache.org/) tables natively. It is built on top of [Apache DataFusion](https://datafusion.apache.org/), a query engine written in Rust on [Apache Arrow](https://arrow.apache.org/). Comet plugs into Spark without changes to the jobs: it takes the physical plan that Spark has built and executes the operators it supports in native code. The promise is better performance thanks to two things: Comet processes data in columnar Arrow batches instead of one row at a time, and it runs in native code outside the JVM, without JVM objects and their overhead. The project's README states a speedup of about 1.8 times on TPC-DS at 1 TB, which translates into roughly 45% lower cost.

Numbers like these are useful, but they don't explain where the gain comes from. The usual answer – "Comet is columnar and native" – is true, but it explains less than it seems, because Spark's own Iceberg reader already decodes Parquet into Arrow vectors. If both engines start from columnar batches, where exactly does Spark lose time, and what does Comet do differently? I wanted to see this in detail, step by step, on a real job.

In this post, I will take one ordinary ETL job – read an Iceberg table, filter it, compute a value, aggregate it, and write the result into another Iceberg table – and run it with plain Spark and with Spark + Comet. We will follow a few rows through every step of the job in both engines, look at the CPU profiles, and estimate how much CPU each step costs. On 8 cores, plain Spark took 38.7 seconds and 295 CPU-seconds, and Spark with Comet took 10.5 seconds and 76 CPU-seconds, with the same output. These Comet numbers are with Comet's native Iceberg write turned on (`spark.comet.write.iceberg.enabled=true`), which is off by default in Comet 1.2; without it, Iceberg's Java writer writes the files, as in plain Spark. Then we will look at the opposite case: how one unsupported expression takes most of this gain away. I will finish with a practical guide on checking and tuning Comet for your own jobs.

Everything in this post is reproducible with two commands, `docker build` and `docker run`, from the repository [Visorgood/spark-comet-iceberg-bench](https://github.com/Visorgood/spark-comet-iceberg-bench). All numbers come from Spark 4.1.3, Iceberg 1.11.0 and Comet 1.2.0.

## The benchmark job

For the data, I use TPC-H – a standard decision-support benchmark with a synthetic dataset of customers, orders, parts and suppliers, which can be generated at any size set by a scale factor. Its largest table is `lineitem`, with one row per line of a customer order: the order key, the part, the quantity, the price, the discount, the ship date, and other attributes. At scale factor 100, `lineitem` has 600 million rows.

The job computes the revenue of each order from the lines shipped since 1995 – a typical ETL step that touches every part of the engine, from the scan to the write:

```sql
INSERT INTO lake.tpch.order_revenue
SELECT l_orderkey,
       sum(l_extendedprice * (1 - l_discount)) AS revenue,
       count(*)                                AS lines
FROM   lake.tpch.lineitem
WHERE  l_shipdate >= DATE '1995-01-01'
GROUP  BY l_orderkey
```

A few details of this setup matter for the results:

- **Source.** `lineitem` at scale factor 100 is stored in an Iceberg table with Iceberg's defaults: Parquet data files with zstd compression, 15.1 GiB in 206 files. The query needs only four of the 16 columns, and Comet's scan metrics show 3.5 GiB read from these files.
- **Target.** An unpartitioned Iceberg table with no sort order and default properties. In this case, Iceberg asks Spark for no extra shuffle or sort before the write, and the write stays eligible for Comet's native Iceberg writer.
- **Shape.** An order has about four lines, so the partial aggregate shrinks the data only about four times, and the shuffle still carries 87 million rows. A query with few groups, like TPC-H Q1, would hide the shuffle.
- **Types.** The money columns are `decimal(15,2)`. The product `l_extendedprice * (1 - l_discount)` is `decimal(32,4)`, and the sum is `decimal(38,4)`, both wider than 18 digits. As we will see later, this matters more than anything else in this job.
- **`INSERT INTO` rather than `CREATE TABLE AS SELECT`.** Comet's native write handles CTAS too, but Spark runs the CTAS write as a nested append that it plans separately, so the plan of the CTAS statement itself does not show the write operators. `INSERT INTO` keeps the whole job, from the scan to the write, in one plan.

Here are the physical plans of both runs:

| Step | Spark | Spark + Comet |
| --- | --- | --- |
| Read | `BatchScan` (Iceberg) → `ColumnarToRow` | `CometIcebergNativeScan` |
| Filter, compute | `Filter`, `Project` (whole-stage codegen) | `CometFilter`, `CometProject` |
| Partial aggregate | `HashAggregate` (partial) | `CometHashAggregate` (partial) |
| Shuffle | `Exchange hashpartitioning(l_orderkey, 200)` | `CometExchange` (native shuffle) |
| Final aggregate | `HashAggregate` (final) | `CometHashAggregate` (final) |
| Write | `AppendData`: iceberg-java writes rows | `CometIcebergWrite` under `IcebergCommit` |

The Comet plan requires `spark.comet.write.iceberg.enabled=true`. The native write is off by default in Comet 1.2, and without it the plan ends with `CometColumnarToRow` → `AppendData`. Reading a Comet plan mostly comes down to one rule: every `Comet*` node is accelerated, and a node without the prefix is plain Spark. The rule has two exceptions. `CometColumnarToRow` has the prefix, but it is a conversion that marks the place where Arrow batches become rows, not accelerated work. `IcebergWrite` and `IcebergCommit` have no prefix, but they are Comet's own operators for its split Iceberg write: `IcebergCommit` commits on the driver, and `IcebergWrite` is the executor side when iceberg-java writes the files. When the write is native, the executor side is `CometIcebergWrite`.

## How Spark executes the job

Spark on Iceberg is not row-based from the disk up. Iceberg's reader decodes Parquet into Arrow vectors on the JVM, and only at the first operator does the batch become a stream of rows. From there on, filtering, decimal math, hashing, hash map updates, partitioning and serialization all run once per row, until the Iceberg writer turns the rows back into columns.

<figure>
<a href="/blog/images/comet-spark-comparison/01-spark-plan.png">
<img
src="/blog/images/comet-spark-comparison/01-spark-plan.png"
width="100%"
class="img-fluid"
alt="Plain Spark, Iceberg to Iceberg: columnar at both ends, rows in between. From ColumnarToRow to the Iceberg writer, every highlighted step runs once per row."
/>
</a>
<figcaption><b>Figure 1</b>: Plain Spark, Iceberg to Iceberg: columnar at both ends, rows in between. From <code>ColumnarToRow</code> to the Iceberg writer, every highlighted step runs once per row.</figcaption>
</figure>

<figure>
<a href="/blog/images/comet-spark-comparison/02-spark-ui-spark.png">
<img
src="/blog/images/comet-spark-comparison/02-spark-ui-spark.png"
width="100%"
class="img-fluid"
alt="The Spark run in the Spark UI, SQL tab. Read the left column top to bottom, then the right one: 600 million rows go into ColumnarToRow, 342 million come out of the Filter, and 87 million go into the shuffle and into the output table."
/>
</a>
<figcaption><b>Figure 2</b>: The Spark run in the Spark UI, SQL tab. Read the left column top to bottom, then the right one: 600 million rows go into <code>ColumnarToRow</code>, 342 million come out of the <code>Filter</code>, and 87 million go into the shuffle and into the output table.</figcaption>
</figure>

Let's go through the steps one by one:

1. **Scan: `BatchScan` with Iceberg's vectorized reader.** Iceberg Java plans the scan on the driver, i.e., decides which data files to read. On each executor, its vectorized Parquet reader decompresses and decodes the needed column chunks into Arrow vectors on the JVM, 5,000 rows per batch (`read.parquet.vectorization.batch-size`), and hands them to Spark as a `ColumnarBatch` of `IcebergArrowColumnVector`s. The `WHERE` predicate is pushed down too, but Iceberg's reader uses it only to skip data files and Parquet row groups whose statistics rule them out. In this table, ship dates are spread over every file and row group, so nothing is skipped: the reader hands Spark every row, and all 600,037,902 rows go into `ColumnarToRow`, in 120,098 batches. The rows themselves are filtered later, by Spark's `Filter`.
2. **`ColumnarToRow` inside whole-stage codegen.** Spark generates one Java loop per stage. In the map stage, the loop walks the batch row by row, reads each value from its vector into a local variable, and runs `Filter`, `Project` and the partial aggregate in the same loop body. The filter and the projection create no row objects – this is what codegen buys – but every row still goes through the loop on its own.
3. **Filter and compute.** The filter drops the rows shipped before 1995, and 341,948,854 rows remain. For each of them, Spark's `Decimal` subtraction and multiplication go through `java.math.BigDecimal`, and the 32-digit result stays a `BigDecimal`, because Spark keeps a decimal in a `long` only up to 18 digits.
4. **Partial aggregate.** For each row, Spark builds the grouping key as an `UnsafeRow`, hashes it, probes `UnsafeFixedWidthAggregationMap` (a `BytesToBytesMap` in Tungsten memory pages), and updates the aggregation buffer in place. The buffer holds the sum, the `isEmpty` flag that Spark keeps for decimal sums, and the count. The sum is `decimal(38,4)`, too wide for an 8-byte slot, so it is stored as bytes in the variable-length part of the row and has to be decoded and encoded again on every update.
5. **Shuffle write.** For each row that the partial aggregate emits, Spark computes the partition id as `Pmod(Murmur3Hash(l_orderkey), 200)` and serializes the row with `UnsafeRowSerializer`. With 200 partitions, at the `spark.shuffle.sort.bypassMergeThreshold` of 200, Spark picks `BypassMergeSortShuffleWriter`: one lz4-compressed stream per reducer, concatenated into one data file plus an index file.
6. **Shuffle read.** The reduce task fetches the blocks, decompresses them, and hands out `UnsafeRow`s that point into the buffer.
7. **Final aggregate.** Once per row again: probe the map, merge the partial sums and counts.
8. **Write: `AppendData` with Iceberg's writer.** Iceberg's Spark writer is a `DataWriter<InternalRow>`: it takes one row at a time and hands each value to a per-column value writer, which buffers it into that column's pages. The turn from rows back to columns happens inside the writer, not as a plan node, which is why the plan shows no `RowToColumnar`. The pages are encoded and zstd-compressed, and the driver commits the written files as a new snapshot of the table.

Now let's look at the same data as it is stored at each step. Four `lineitem` rows go in, one of them fails the filter, and two orders come out.

<figure>
<a href="/blog/images/comet-spark-comparison/03-spark-data-journey.png">
<img
src="/blog/images/comet-spark-comparison/03-spark-data-journey.png"
width="100%"
class="img-fluid"
alt="Four rows through the job without Comet. The file on each end is columnar, and so is the reader&#x27;s batch; everything in the highlighted middle is processed one row at a time."
/>
</a>
<figcaption><b>Figure 3</b>: Four rows through the job without Comet. The file on each end is columnar, and so is the reader's batch; everything in the highlighted middle is processed one row at a time.</figcaption>
</figure>

## How Comet executes the job

Comet keeps Spark's stages, tasks and shuffle files. What changes is the unit of work. The data stays an Arrow batch of up to 8,192 rows (`spark.comet.batchSize`) from the Parquet decoder to the shuffle file and back, and each operator makes one pass per column in Rust. With the native Iceberg write turned on, the data stays in Arrow all the way into the output Parquet file.

1. **Scan: `CometIcebergNativeScan`.** Iceberg Java still plans the scan on the driver. Comet takes the planned `FileScanTask`s and puts them into its native plan, where iceberg-rust's `ArrowReader` decodes the Parquet column chunks into Arrow arrays in Rust. This is the integration that Matt Butrovich describes on the [Apache Iceberg blog](https://iceberg.apache.org/blog/accelerating-iceberg-rust-development-with-datafusion-comet/). Like Iceberg's Java reader, it skips row groups by their statistics, but it goes one step further and filters the rows themselves while decoding. So only the 341,948,854 matching rows leave the scan, not 600 million.
2. **Filter and compute: `CometFilter`, `CometProject`.** A predicate runs over a whole column and yields a boolean array, and a filter kernel then copies the surviving values column by column. In this job, the scan has already done this work: `CometFilter` receives 342 million rows, keeps all of them, and takes 0.3 seconds across all tasks. The decimal math works column in, column out, on `Decimal128` arrays – one 16-byte integer per value, with no objects.
3. **Partial aggregate: `CometHashAggregate`.** DataFusion hashes the key column of the whole batch, maps the hashes to group indices, and updates the accumulators for the whole batch at once. Comet's decimal sum accumulates into one `Decimal128` value per group.
4. **Shuffle write: `CometExchange`.** The shuffle writer is part of the same native plan as the scan, the filter and the aggregate, so in this stage the column data never enters the JVM. The writer computes Spark-compatible Murmur3 hashes for the whole batch, takes `pmod` to get the partition ids, and gathers each partition's rows with `interleave_record_batch`. Each block is a self-contained Arrow IPC stream compressed with lz4 and written in Spark's data-plus-index file layout, so Spark's block manager serves it as usual.
5. **Shuffle read.** Native code decompresses and decodes the IPC blocks. With `spark.comet.shuffle.directRead.enabled` (on by default), the final aggregate reads them directly in native code.
6. **Final aggregate: `CometHashAggregate`.** Merges the partial sums and counts, batch by batch.
7. **Write: `CometIcebergWrite` and `IcebergCommit`.** With the native write enabled, Comet splits the write into `IcebergWrite` on the executors and `IcebergCommit` on the driver. When the write is eligible – its input plan is fully native, and every table setting is on Comet's allowlist – the executor side becomes `CometIcebergWrite`, and iceberg-rust writes the Parquet files straight from the Arrow batches. Iceberg Java still does the commit. An ineligible write keeps iceberg-java's writer and reports the reason in extended `EXPLAIN`.

<figure>
<a href="/blog/images/comet-spark-comparison/04-comet-plan.png">
<img
src="/blog/images/comet-spark-comparison/04-comet-plan.png"
width="100%"
class="img-fluid"
alt="Spark + Comet: the same stages and the same shuffle files as in Figure 1, with Arrow batches from the source file to the target file. With the native Iceberg write turned on, no step runs once per row."
/>
</a>
<figcaption><b>Figure 4</b>: Spark + Comet: the same stages and the same shuffle files as in Figure 1, with Arrow batches from the source file to the target file. With the native Iceberg write turned on, no step runs once per row.</figcaption>
</figure>

<figure>
<a href="/blog/images/comet-spark-comparison/05-spark-ui-comet.png">
<img
src="/blog/images/comet-spark-comparison/05-spark-ui-comet.png"
width="100%"
class="img-fluid"
alt="The Comet run in the Spark UI, SQL tab: the scan already returns only the 342 million matching rows, and every node down to the write is a Comet node with its native metrics."
/>
</a>
<figcaption><b>Figure 5</b>: The Comet run in the Spark UI, SQL tab: the scan already returns only the 342 million matching rows, and every node down to the write is a Comet node with its native metrics.</figcaption>
</figure>

Here are the same four rows, step by step:

<figure>
<a href="/blog/images/comet-spark-comparison/06-comet-data-journey.png">
<img
src="/blog/images/comet-spark-comparison/06-comet-data-journey.png"
width="100%"
class="img-fluid"
alt="The same four rows with Comet: the same values at every step as in Figure 3, but every middle panel holds arrays instead of rows, including the aggregation state and the shuffle blocks."
/>
</a>
<figcaption><b>Figure 6</b>: The same four rows with Comet: the same values at every step as in Figure 3, but every middle panel holds arrays instead of rows, including the aggregation state and the shuffle blocks.</figcaption>
</figure>

When batches do cross between the JVM and Rust, they go through the Arrow C Data and C Stream interfaces. From the JVM to Rust, Comet imports the buffers without a copy, and ownership moves by reference count. From Rust to the JVM, the batch is exported into structures that the JVM has allocated. In this job, that happens only on the reduce side, between the final aggregate and the native writer. Either way, the cost of crossing is paid once per batch, not once per row.

## Where the time goes

Here are the totals for the whole job, as medians of five iterations, with the fastest and the slowest iteration in brackets:

| Run | Wall time | CPU time | GC time | Shuffle written |
| --- | --- | --- | --- | --- |
| Spark | 38.7 s (35.4-39.0) | 295 s | 7.9 s | 1,698 MiB |
| Spark + Comet | 10.5 s (9.2-11.4) | 76 s | 0.3 s | 1,197 MiB |

With Comet, the job ran 3.7 times faster and used 3.9 times less CPU; even its slowest iteration beat Spark's fastest by 3.1 times. Both engines kept most of the 8 cores busy (7.6 and 7.2 cores on average), so the gain comes from removing CPU work, not from removing waiting.

One warning if you measure this yourself: Spark's own executor CPU metric counts only task threads. Comet runs a native plan with no JVM input on its own threads while the Spark task waits, so Spark's metric shows Comet using far less CPU than it does: 24 CPU-seconds per iteration, against the 76 that the container used. For plain Spark, the two numbers are close: 277 and 295. The CPU times above come from the container's own counter, which also covers the driver.

To find out which steps the CPU time goes to, I ran the job once more under async-profiler – a sampling profiler for the JVM that also sees native code – and built a CPU flame graph of the executor for each engine. If you haven't worked with flame graphs before, here is how to read them:

- Each box is a function, and the boxes on top of it are the functions it called. The bottom box (`all`) is the whole profile, and each tower above it is a set of call stacks, from a thread's entry point at the bottom to the code that was running on the CPU at the top.
- The width of a box is proportional to the number of samples in which the function was on the stack, either running itself or calling something above it. The horizontal axis is not time: the boxes on each level are sorted by name, so the order from left to right means nothing.
- The top edge shows where the CPU spent its time. A wide box with nothing above it is a hot function.
- The colour shows the type of code: green is Java, aqua is Java inlined into its caller, yellow is C++ (the JVM itself), red is other native code, such as libc or zstd, and orange is the kernel. Rust frames show up in yellow, like C++.

<figure>
<a href="/blog/images/comet-spark-comparison/07-flamegraph-spark.png">
<img
src="/blog/images/comet-spark-comparison/07-flamegraph-spark.png"
width="100%"
class="img-fluid"
alt="CPU flame graph of Spark&#x27;s executor: the map stage on the right, the reduce stage and the Iceberg writer on the left, JVM service threads at the far left."
/>
</a>
<figcaption><b>Figure 7</b>: CPU flame graph of Spark's executor: the map stage on the right, the reduce stage and the Iceberg writer on the left, JVM service threads at the far left.</figcaption>
</figure>

In Spark's flame graph (Figure 7), almost everything grows out of `java/lang/Thread.run`, i.e., the executor's task threads. Above `Executor$TaskRunner.run`, the graph splits into two towers, one per stage:

- The wide tower on the right, about 63% of the samples, is the map stage: `ShuffleMapTask` → `BypassMergeSortShuffleWriter.write` → the generated class `GeneratedIteratorForCodegenStage1`. About 80% of the stage runs inside one generated method, `hashAgg_doAggregateWithKeys` – this is whole-stage codegen fusing the scan loop, the filter, the projection and the partial aggregate into one loop. On top of it sit the decimal frames (Spark's `Decimal`, Java's `BigDecimal` and `BigInteger`, `UnsafeRow.getDecimal`), the hash map (`BytesToBytesMap`, whose `safeLookup` has more samples of its own than any other function in the graph), and Iceberg's vectorized reader with zstd decompression.
- The tower on the left, about 31%, is the reduce stage: `ResultTask` → `WritingSparkTask`, with the shuffle read, the final aggregate – again with decimal and hash map frames on top – and Iceberg's Parquet writer with zstd compression.
- The thin towers at the far left, about 5%, are JVM threads that don't run tasks: the JIT compiler and the garbage collector.

If we convert each step's share of the samples into CPU-seconds, using the measured CPU time, the biggest cost in Spark is decimal math: about a third of the CPU, or 100 seconds, of which 79 are in the map stage and 21 in the final aggregate. This includes the subtraction and multiplication, the precision checks, and moving the `decimal(38,4)` sum in and out of the aggregation buffer as bytes (`UnsafeRow.getDecimal` and `setDecimal`). Garbage collection took only 7.9 seconds; the cost is in computing with objects. The hash maps of the two aggregates take another 55 seconds: 35 in the partial aggregate (building the key, hashing it, probing the map and updating the buffer) and 20 in the final one. The remaining 8 seconds of the final aggregate go to its per-row loop and to building the output rows. The table below has every step.

<figure>
<a href="/blog/images/comet-spark-comparison/08-flamegraph-comet.png">
<img
src="/blog/images/comet-spark-comparison/08-flamegraph-comet.png"
width="100%"
class="img-fluid"
alt="CPU flame graph of Comet&#x27;s executor: native threads running the map stage on the left, the JIT compiler and unattributed zstd decompression in the middle, JVM task threads running the reduce stage on the right."
/>
</a>
<figcaption><b>Figure 8</b>: CPU flame graph of Comet's executor: native threads running the map stage on the left, the JIT compiler and unattributed zstd decompression in the middle, JVM task threads running the reduce stage on the right.</figcaption>
</figure>

Comet's flame graph (Figure 8) looks very different, because most of the work no longer runs on Spark's task threads:

- The left part, about 47% of the samples, comes from native threads that Comet runs in a Tokio thread pool inside the executor. They execute the whole map stage as one native plan (`BatchProducer`): iceberg-rust's Parquet reader (about 11%, plus 4% in `pread` reading the files), DataFusion's hash aggregate, and Comet's shuffle writer, which partitions the batches and compresses them with lz4 (about 14%). These are not Spark task threads, which is why Spark's own CPU metric doesn't see this work.
- The middle part is the JIT compiler (8%) and zstd decompression of the source files (about 11%), which the profiler couldn't attach to a stack.
- The right part, about 33%, is the JVM task threads. In the reduce stage, `ResultTask` runs two native plans through `Native.executePlan`: one reads the shuffle and runs the final aggregate, the other runs iceberg-rust's Parquet writer, which receives the aggregate's batches through the Arrow C Stream interface.

The function with the most samples of its own in Comet's graph is DataFusion's hash table for the grouping key (`GroupValuesPrimitive<Int64Type>`, 13% of the samples). Decimal math, which took about a third of Spark's samples (100 seconds across both stages), takes about 9% here (7 seconds across both stages), and the filter almost nothing. What is left is mostly the work that any engine has to do for this query: decompress the source pages, look up the order keys in a hash table, and compress the shuffle blocks and the output files.

Now we can put both engines side by side, with the unit of work at each step and its cost in CPU-seconds per iteration. The decimal math of the map stage has its own row; in the reduce stage, it is part of the final aggregate:

| Step | Spark: unit of work | Comet: unit of work | CPU s, Spark → Comet |
| --- | --- | --- | --- |
| Scan | iceberg-java decodes into Arrow vectors on the JVM, 5,000 rows | iceberg-rust decodes into Arrow arrays, up to 8,192 rows, filtering as it goes | 28 → 20 |
| Filter and projection | one row per loop iteration (codegen) | one kernel call per column | 23 → 0.4 |
| Decimal math, map stage | `BigDecimal` objects per row; the `decimal(38,4)` sum moved in and out of the row buffer as bytes | `Decimal128` arrays, 16-byte integers | 79 → 5 |
| Partial aggregate (hash map) | per row: `UnsafeRow` key, hash, probe, update | per batch: hash column, group ids, update accumulators | 35 → 8 |
| Shuffle write | per row: `Pmod(Murmur3Hash)`, `UnsafeRow` bytes, lz4 stream | per batch: Murmur3 + pmod, Arrow IPC block, lz4 | 17 → 10 |
| Shuffle read | rows from the decompressed stream | IPC decode in Rust | 11 → 4 |
| Final aggregate (hash map and decimal math) | per row: probe, merge, decimal sums | per batch, in Rust | 49 → 9 |
| Write | iceberg-java turns rows back into column pages | iceberg-rust writes the Arrow batches | 33 → 10 |
| JIT, GC, other | | | 20 → 10 |
| **Total** | | | **295 → 76** |

Comet saves the most where Spark works row by row on decimals and hash maps, and the least where both engines do much the same work: in the scan, which decompresses the same zstd pages either way, and in the shuffle write, where both engines hash every key and lz4-compress every block.

This likely explains why the speedup here is about twice as large as the 1.8 times that Comet's README reports for TPC-DS at 1 TB against Spark 4.2. TPC-DS is a mix of 99 queries of different shapes, while this job spends most of Spark's CPU time on exactly the two things where Comet gains the most – wide decimals and hash aggregation – and it reads local files, so I/O takes little of the time. TPC-DS also only reads, while this job writes too: the write is about 11% of Spark's CPU here, and the Comet run uses the native writer, which is off by default. For Iceberg, a closer published reference is the AWS Data on EKS result cited on the [Apache Iceberg blog](https://iceberg.apache.org/blog/accelerating-iceberg-rust-development-with-datafusion-comet/): TPC-DS at 3 TB on Iceberg tables, 2,803.80 seconds with Comet against 4,665.47 seconds without it, or about 1.66 times.

The Spark UI adds one more detail. AQE coalesces the 200 shuffle partitions by size, so Comet's smaller shuffle ended in 20 reduce tasks and 20 output files, and Spark's in 29. The output was about 577 MiB either way.

## Where the speedup disappears

Comet's gain lives inside the native part of the plan, and one unsupported expression can end that part for the rest of its stage. Within a stage, Comet runs an operator natively only when its input is already native, and by default it turns rows back into Arrow only right above a scan. So everything in the stage above the first operator that Comet cannot run stays in Spark. A shuffle can start a native part again: with Comet's shuffle enabled, as it is by default, its JVM columnar shuffle (`CometColumnarExchange`) takes rows from any Spark operator and writes Arrow, so the next stage can run natively. In this job, the stage after the shuffle stays in Spark too, for a reason that we will see below.

To show this, I added an artificial but harmless condition to the `WHERE` clause: a data check with `assert_true`, a built-in Spark function that Comet 1.2 does not run natively.

```sql
WHERE  l_shipdate >= DATE '1995-01-01'
  AND  assert_true(l_discount BETWEEN 0.00 AND 0.10) IS NULL
```

`assert_true` returns `NULL` when the condition holds and fails the query otherwise, so `IS NULL` keeps every row. It is not something you would write in a filter every day, but it does not change the result and costs almost nothing by itself, so the difference between the runs shows only the effect of the fallback. In real jobs, a common trigger of the same kind is a Python UDF (see the next section).

Spark rewrites `assert_true` into an `If` with `RaiseError`, which Comet 1.2 does not run natively. Comet converts a `Filter` only if its whole condition converts, so the `Filter` stays in Spark. The operators above it stay in Spark too, each for its own reason:

- `Project` and the partial `HashAggregate` stay in Spark because their input is not native.
- The final aggregate stays in Spark because of its aggregation buffer. Comet does not run a final aggregate on top of Spark's partial one if it contains a decimal `sum`, because overflow detection does not survive such a split, or a `count`, which Comet excludes on purpose because this combination broke some of Spark's plan rewrites.
- Only then does Comet decide on the shuffle. It could use its JVM columnar shuffle here, but it reverts that shuffle to Spark's when both of its neighbours are Spark aggregates, to avoid two pointless conversions (`spark.comet.shuffle.revertRedundantColumnar.enabled`, on by default).
- The Iceberg write falls back to iceberg-java, because the native write needs native input.

The run sets `spark.comet.explain.fallback.enabled=true`, so the driver log names the reason for the final aggregate:

```text
Comet aggregate that merges intermediate buffers requires a Comet child aggregate when the intermediate buffer formats are incompatible with Spark. Incompatible aggregate function(s): count, sum
```

Comet does have a conversion from rows to Arrow, `CometSparkRowToColumnar`, but by default in 1.2 it applies only above leaf operators such as scans, not after a Spark operator in the middle of a stage. Two settings, both off by default, place it elsewhere: `spark.comet.convert.shuffleInput.enabled` under a native shuffle, and `spark.comet.convert.typedDataset.enabled` above a typed Dataset operation.

<figure>
<a href="/blog/images/comet-spark-comparison/09-fallback-plan.png">
<img
src="/blog/images/comet-spark-comparison/09-fallback-plan.png"
width="100%"
class="img-fluid"
alt="The plan of the run with the guard: only the scan stays in Comet, and the rest of the job runs in Spark. The dashed boxes show what the Comet run kept native."
/>
</a>
<figcaption><b>Figure 9</b>: The plan of the run with the guard: only the scan stays in Comet, and the rest of the job runs in Spark. The dashed boxes show what the Comet run kept native.</figcaption>
</figure>

<figure>
<a href="/blog/images/comet-spark-comparison/10-spark-ui-comet-fallback.png">
<img
src="/blog/images/comet-spark-comparison/10-spark-ui-comet-fallback.png"
width="100%"
class="img-fluid"
alt="The run with the guard in the Spark UI, SQL tab: CometColumnarToRow right after the native scan, then the same two codegen stages and Spark&#x27;s Exchange as in the plain Spark run, and IcebergWrite, where iceberg-java writes the files."
/>
</a>
<figcaption><b>Figure 10</b>: The run with the guard in the Spark UI, SQL tab: <code>CometColumnarToRow</code> right after the native scan, then the same two codegen stages and Spark's <code>Exchange</code> as in the plain Spark run, and <code>IcebergWrite</code>, where iceberg-java writes the files.</figcaption>
</figure>

The result is 34.8 seconds and 268 CPU-seconds, compared to 10.5 seconds with Comet and 38.7 seconds without it. What is left of Comet is its scan. It still decodes in Rust and drops the rows shipped before 1995 itself, so Spark converts and processes 342 million rows instead of the 600 million its own reader hands over. This is part of why this run still takes 10% less time than plain Spark. But of the 28 seconds that Comet saved per iteration, only 4 remain.

That was one way out of the native path. Here are the others I know of:

- **The sink.** With Comet's defaults, every Iceberg write ends with `CometColumnarToRow`, because Spark's `AppendData` and iceberg-java's writer take rows. The native Iceberg write removes that conversion, but only for eligible writes, as described above; most non-default `write.parquet.*` settings are not on Comet's allowlist.
- **The shuffle.** A plain `Exchange` between two Comet stages means rows on both sides of it. Comet's docs name string keys with a non-default collation as one cause.
- **Wide or nested schemas.** Where a conversion does happen, its cost grows with the number of columns and nested fields. Comet's own microbenchmark puts the default conversion at 9.4 ns per row for a `long, int, double, string` schema at 8,192 rows per batch, and decimal-heavy schemas allocate an object per value.
- **The safety valve.** `spark.comet.exec.transitionRevert.enabled` (off by default) reverts a whole stage to Spark when it would need more columnar-to-row conversions than `spark.comet.exec.transitionRevert.maxTransitions` (2 by default).

So the most useful thing to look for in a Comet plan is the place where the native part ends: everything above it in the stage runs in Spark, and so may the stages after it.

## Does the API matter?

For this query, it doesn't. Spark SQL, the DataFrame API in Python, Scala or Java, and Spark Connect all build the same logical plan, so Catalyst and Comet see the same thing, and the executors run the same JVM and native code. Python runs only on the driver and sends the plan over Py4J or Spark Connect. The repository checks this: it builds the `SELECT` part of the query with `spark.sql()` and with DataFrame calls in PySpark and compares the physical plans, which are identical.

The API starts to matter only when your own code has to run on the data:

| What you write | Plan node | What Comet does |
| --- | --- | --- |
| Scala or Java scalar UDF | `ScalaUDF` expression | runs inside the Comet pipeline (since 0.17.0) |
| Typed Dataset ops in Scala or Java: `map`, `mapPartitions`, `groupByKey` | `DeserializeToObject`, `MapElements`, `MapPartitions`, … | falls back; not on Comet's roadmap, because they run JVM functions on JVM objects |
| Pickled Python `@udf` | `BatchEvalPython` | falls back; not planned |
| Scalar `@pandas_udf`, `applyInPandas` | `ArrowEvalPython`, `FlatMapGroupsInPandas` | falls back today |
| `@arrow_udf` (Spark 4.1+) | `ArrowEvalPython` | experimental native path; needs a special build and `spark.comet.exec.nativeArrowPythonUDF.enabled` |
| `mapInArrow`, `mapInPandas` | `MapInArrow`, `MapInPandas` | experimental, off by default (`spark.comet.exec.pyarrowUDF.enabled`) |
| `df.rdd` and the RDD API | none: the job leaves Catalyst | nothing to accelerate |

The practical rule is to write the logic as SQL or DataFrame expressions with built-in functions and to keep UDFs out of the hot path. As the previous section showed, a fallback in the middle of the job costs you everything after it.

## Practical guide

A few minutes with the plan tell you whether Comet can help a job before you benchmark anything, and a handful of settings decide how much it helps.

### Check

1. **Prerequisites.** `spark.plugins=org.apache.spark.CometPlugin`; off-heap memory enabled and sized (`spark.memory.offHeap.enabled`, `spark.memory.offHeap.size`); for Comet's shuffle, `spark.shuffle.manager=org.apache.spark.sql.comet.execution.shuffle.CometShuffleManager`, set before the Spark context starts.
2. **Read the plan** with `df.explain("formatted")` or in the SQL tab after the run:
    - `Comet*` nodes are accelerated; nodes without the prefix are plain Spark. The exceptions are `CometColumnarToRow`, which is a conversion, and `IcebergWrite` and `IcebergCommit`, which are Comet's operators for the split Iceberg write.
    - Find where the native part ends. A Spark operator in the middle of a stage gets a `CometColumnarToRow` below it and no conversion back, so everything above it stays in Spark.
    - Check the exchange type: `CometExchange` (native shuffle), `CometColumnarExchange` (JVM columnar shuffle) or a plain `Exchange` (Spark's shuffle).
    - Check the write: `CometIcebergWrite` under `IcebergCommit` is native; `IcebergWrite` or `AppendData` means that iceberg-java writes the files.
    - Under AQE, an `EXPLAIN` before the run shows the initial plan without transitions; the final plan is in the SQL tab after the run.
3. **Ask why something fell back.** `spark.comet.explain.fallback.enabled=true` logs the reasons on the driver; on Spark 4.0+, the SQL UI shows the annotated plan. Ineligible Iceberg writes report their reason there too.
4. **Preview without risk.** `spark.comet.explain.planOnly.enabled=true` logs the plan Comet would run and its coverage, while Spark runs the original plan. The coverage can be optimistic.
5. **Look inside the native part.** `spark.comet.explain.native.enabled=true` writes the DataFusion plan with its metrics to the executor logs.
6. **Measure CPU outside Spark.** The Executors tab and the task metrics miss Comet's native threads, so compare CPU at the process or container level.

### Tune

- **Memory.** Comet's operators allocate on the Rust heap but charge their reservations to `spark.memory.offHeap.size`, so give that pool a real budget. Native memory that no pool tracks (decompression buffers, Parquet reader structures, allocator overhead) must fit into `spark.executor.memoryOverhead`.
- **Shuffle.** Leave `spark.comet.shuffle.mode` on `auto` and check which exchange you got. A plain `Exchange` between Comet stages is the first thing to chase.
- **Iceberg reads.** `spark.comet.scan.icebergNative.dataFileConcurrencyLimit` (2 by default) sets how many files a task reads at once; a value between 2 and 8 helps with many small files or with S3, at the cost of memory. Above 1, rows come back in no fixed order.
- **Iceberg writes.** Try `spark.comet.write.iceberg.enabled=true` after validating it on your own tables, and then check in the plan that the write is native. Writes fed by local data (`INSERT ... VALUES`) also need `spark.comet.exec.localTableScan.enabled=true`.
- **Conversion-heavy stages.** `spark.comet.exec.transitionRevert.enabled=true` lets Comet hand a stage back to Spark when it would need too many conversions.
- **Keep the plan native.** Prefer built-in functions over UDFs; Scala UDFs are fine; keep typed Dataset ops and pickled Python UDFs out of the hot path.

The rule of thumb: long native stretches, few conversions, Comet's shuffle on both sides of every exchange, and a native write at the end.

## Benchmark setup

- **Environment.** One Docker container limited to 8 CPUs and 24 GiB of memory, with Java 17, Spark 4.1.3, Iceberg 1.11.0, the published Comet 1.2.0 jar and async-profiler 4.5. One Spark standalone worker and one executor with 8 cores, 7 GiB of heap and 7 GiB of off-heap memory. Comet needs off-heap memory, so the Spark-only run gets the same pool.
- **Data.** TPC-H `lineitem` at scale factor 100 from tpchgen-cli 4.0.0, loaded once into an Iceberg table with plain Spark. The target table is recreated empty before every iteration.
- **Runs.** Spark defaults otherwise, including ANSI mode, 200 shuffle partitions and AQE. One warm-up and five measured iterations per configuration in one Spark application, with medians reported. All iterations of all three configurations produced the same row count, revenue sum and lines sum.
- **CPU.** Read from the container's cgroup counter around each query, because Spark's metric misses Comet's native threads.
- **Flame graphs.** Recorded in separate Spark applications under async-profiler, so the timed iterations are never profiled. The profiler records only part of the CPU time as samples, so the per-step figures use each step's share of the samples times the measured CPU time. The profiled applications also include a warm-up iteration, so JIT compilation takes a larger share of the samples than it does in the timed iterations.
- **Machine.** A MacBook Pro with an Apple M3 Pro chip and 36 GiB of memory. Docker Desktop runs the container in a Linux virtual machine on the same chip, so absolute times depend on it and will differ on other hardware. The comparison holds, because both engines share the same container, data and settings.
- **Limitations.** This is one query on one machine, with local files and a shuffle that never crosses the network. On a cluster that reads from object storage, I/O takes a larger share of the time, and the speedup can be smaller. The Comet run has the native Iceberg write enabled, which is off by default in Comet 1.2; I did not measure Comet with its default settings.

The repository [Visorgood/spark-comet-iceberg-bench](https://github.com/Visorgood/spark-comet-iceberg-bench) contains the Dockerfile and the scripts. After `docker build`, one `docker run` generates the data, runs all three configurations, and serves a report with the timings, plans and flame graphs next to the Spark History Server.

## Conclusion

In this post, we have followed one ETL job through plain Spark and through Spark with Comet, step by step. Spark on Iceberg is columnar at both ends – its reader decodes Parquet into Arrow vectors, and its writer produces column pages – but processes the data one row at a time in between. Comet keeps the same stages, tasks and shuffle files, but the data stays in Arrow batches from the source file to the target file. In this job, that made the difference between 38.7 and 10.5 seconds, and between 295 and 76 CPU-seconds.

The flame graphs show where this gain comes from. The biggest saving is in decimal math and in the hash aggregates, which Spark runs per row on objects and byte buffers and Comet runs per batch on plain arrays. The smallest savings are in the work that both engines have to do anyway, such as decompressing the source files and compressing the shuffle blocks. The gain is also fragile: one expression that Comet cannot run natively sent the rest of the job back to Spark, and of the 28 seconds that Comet saved per iteration, only 4 remained. So when you evaluate Comet on your own jobs, check first where the native part of the plan ends.

Comet is developing quickly, and some details above, such as the default of the native Iceberg write or the list of unsupported expressions, may change in the next releases. The repository makes it easy to repeat the measurement with a new version.

## References

- [Apache DataFusion Comet](https://github.com/apache/datafusion-comet) and its [Iceberg guide for 1.2](https://datafusion.apache.org/comet/user-guide/1.2/iceberg.html)
- Matt Butrovich, [Accelerating Iceberg Rust Development with DataFusion Comet](https://iceberg.apache.org/blog/accelerating-iceberg-rust-development-with-datafusion-comet/), Apache Iceberg blog
- Benchmark and reproduction: [Visorgood/spark-comet-iceberg-bench](https://github.com/Visorgood/spark-comet-iceberg-bench)
