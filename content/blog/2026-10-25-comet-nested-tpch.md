---
layout: post
title: "Nested TPC-H: A Benchmark for Nested Data in Apache DataFusion Comet"
date: 2026-10-25
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

Apache DataFusion Comet tracked its performance with TPC-H and TPC-DS, and the numbers were encouraging. Real user pipelines showed smaller gains, or none at all. What those pipelines had in common was nested data, which neither benchmark contains.

To measure that gap, we built nested TPC-H. At scale factor 1000 (1 TB), Comet 1.2.0 runs all 22 of its queries in 790 s, against 1,519 s for Spark 4.1.3.

<img
src="../images/comet-nested-tpch/intro-total.svg"
width="100%"
class="img-fluid"
alt="Total execution time at SF1000: Spark 4.1.3 1,519 s, Comet 1.1.0 869 s, Comet 1.2.0 790 s"
/>

Nested TPC-H is a TPC-H derived benchmark in the Comet repository ([#7044](https://github.com/apache/datafusion-comet/pull/7044)). The TPC-H data and the questions the queries answer are unchanged. The tables are reshaped to store most columns in arrays of structs, and the queries are rewritten to unnest those arrays. The data and queries are engine neutral, so they can be used to compare Spark, Comet and other engines.

The first runs showed where the gaps were: some queries ran slower on Comet than on Spark, even though Comet accelerates the same queries on flat TPC-H.

## Why: TPC-H is flat, real data is not

[TPC-H](https://www.tpc.org/tpch/) is one of the most cited analytical benchmarks, and its schema is flat: eight normalized tables with primitive columns. Its 22 queries exercise well-understood choke points such as aggregation, join ordering and correlated subqueries (Boncz, Neumann and Erling, ["TPC-H Analyzed"](https://doi.org/10.1007/978-3-319-04936-6_5), TPCTC 2013).

Real data is often nested. Event logs, JSON, Avro and Protobuf records, and many data lake tables are full of structs and arrays, which Parquet stores with the record shredding scheme from Dremel (Melnik et al., ["Dremel"](http://www.vldb.org/pvldb/vldb2010/papers/R29.pdf), VLDB 2010). Nested data adds work that flat benchmarks never exercise:

- **Reading.** Rebuilding list offsets and validity bitmaps from repetition and definition levels, and decoding only the fields a query uses.
- **Planning.** Nested column pruning and predicate pushdown through `explode`.
- **Operators.** `explode`, field access, and sort, join and exchange over wide variable-size values.
- **Memory and spilling.** Variable-size values make memory use and spill volume harder to predict.
- **Conversion.** Moving nested values between a JVM and a native representation.

Comet hit the shuffle case in [#5397](https://github.com/apache/datafusion-comet/issues/5397), where native shuffle writes of wide nested fields were two to three times slower than Spark's. The issue notes that it was "invisible for TPC-* benchmarks because of historical flat schema".

We needed a benchmark that filled the gap between academic benchmarking and real user workloads.

## How: an adapter that nests TPC-H

We did not want to invent a new benchmark from scratch. TPC-H is well understood, widely published and easy to generate, and its business shape (customers, orders, line items, suppliers and parts) is what makes its results meaningful. The goal was to preserve that shape and those questions while making every query process nested data.

The idea turned out to be surprisingly simple: a transformation of both the data and the queries that leaves the key and partition columns at the top level and nests everything else. The partition columns are `p_brand`, `c_mktsegment`, `o_orderdate` and `l_shipdate`, and every other non-key column moves into one `array<struct>` named `<table>_data`. Each array holds exactly one element, so exploding it never changes the row count and the queries return the same answers as TPC-H. For `lineitem`:

```
-- flat                               -- nested
l_orderkey       BIGINT               l_orderkey     BIGINT
l_partkey        BIGINT               l_partkey      BIGINT
l_suppkey        BIGINT               l_suppkey      BIGINT
l_linenumber     INT                  l_shipdate     DATE        -- partition column
l_quantity       DECIMAL(12,2)        lineitem_data  ARRAY<STRUCT<
l_extendedprice  DECIMAL(12,2)            l_linenumber: INT,
l_discount       DECIMAL(12,2)            l_quantity: DECIMAL(12,2),
l_tax            DECIMAL(12,2)            l_extendedprice: DECIMAL(12,2),
l_returnflag     STRING                   l_discount: DECIMAL(12,2),
l_linestatus     STRING                   l_tax: DECIMAL(12,2),
l_shipdate       DATE                     l_returnflag: STRING,
l_commitdate     DATE                     l_linestatus: STRING,
l_receiptdate    DATE                     l_commitdate: DATE,
l_shipinstruct   STRING                   l_receiptdate: DATE,
l_shipmode       STRING                   l_shipinstruct: STRING,
l_comment        STRING                   l_shipmode: STRING,
                                          l_comment: STRING>>
```

Each of the 22 queries is rewritten to unnest only the arrays it needs. The queries are in [`benchmarks/nested/queries`](https://github.com/apache/datafusion-comet/tree/main/benchmarks/nested/queries).

```sql
from (select l_orderkey, l_partkey, l_suppkey, l_shipdate,
             explode(lineitem_data) as lineitem_data from lineitem) as lineitem
where lineitem_data.l_quantity < 24
```

[`nest_tpch.scala`](https://github.com/apache/datafusion-comet/blob/main/benchmarks/nested/scripts/nest_tpch.scala) converts an existing flat TPC-H dataset to the nested layout. The source and the target can each be Parquet or Iceberg. The script runs under `spark-shell` on a laptop or a cluster, casts columns to fixed types, writes zstd-compressed Parquet with 512 MiB row groups, partitions by the columns above and checks row counts:

```bash
spark-shell -i scripts/nest_tpch.scala \
  --conf spark.nesttpch.source=parquet:/data/tpch/sf10 \
  --conf spark.nesttpch.target=parquet:/data/tpch-nested/sf10
```

The [README](https://github.com/apache/datafusion-comet/tree/main/benchmarks/nested) has the Iceberg variants and all settings.

The script and queries in the Comet repository also serve as an example. You can customize them to test any nested complexity, such as multi-element arrays, maps or deeper nesting.

## Benchmark setup

- **Data**: nested TPC-H at scale factor 1000 (1 TB), created from flat TPC-H with `nest_tpch.scala`.
- **Tables**: Apache Iceberg tables in a Hadoop catalog on S3, with zstd-compressed Parquet data files, 512 MiB row groups and the partitioning above. Comet reads them with its native Iceberg scan, which is built on [iceberg-rust](https://github.com/apache/iceberg-rust).
- **Versions**: Spark 4.1.3 (Scala 2.13, JDK 17) and Iceberg 1.11.0. Comet 1.1.0, and Comet 1.2.0 built from `branch-1.2` at `746246049`. Both Comet builds use the native Iceberg scan and the default allocator (glibc).
- **Cluster**: Kubernetes, with 32 executors of 16 task slots each (8 CPUs per executor pod), shuffle and spill files on a block volume attached to each executor, and `spark.sql.shuffle.partitions=512`.
- **Method**: the queries in `benchmarks/nested`, run from `spark-shell`. Each query runs three times in one application with no warm-up, timed from `spark.sql()` to the end of `collect()`. Figures are the fastest iteration, and totals are sums of the per-query times. Every query returned the expected TPC-H row count.
- **Memory**: each executor gets a 106 GiB container. Spark runs with a 64 GiB heap and no off-heap memory. Comet runs with a 32 GiB heap and 64 GiB of off-heap memory, which gives each task 4 GiB of native memory.

Comet 1.2.0 includes two of the fixes described below, [#6698](https://github.com/apache/datafusion-comet/pull/6698) (spill compression) and [#6725](https://github.com/apache/datafusion-comet/pull/6725) (nested column pruning in the native Iceberg scan). The iceberg-rust fixes merged after the iceberg-rust revision that Comet 1.2.0 pins, so they are not in these results.

Both engines share these settings: G1 GC, Kryo, `spark.io.compression.codec=zstd`, `spark.memory.fraction=0.6`, `spark.memory.storageFraction=0.2`, `spark.sql.sources.ignoreDataLocality=true` and `spark.executor.memoryOverhead=10g`. Comet adds:

```
spark.executor.memory=32g
spark.memory.offHeap.enabled=true
spark.memory.offHeap.size=64g
spark.plugins=org.apache.spark.CometPlugin
spark.shuffle.manager=org.apache.spark.sql.comet.execution.shuffle.CometShuffleManager
spark.comet.exec.memoryPool.fraction=0.8
spark.comet.parquet.prefetchNextFileMetadata.enabled=true
spark.comet.scan.icebergNative.enabled=true
spark.comet.scan.icebergNative.dataFileConcurrencyLimit=4
spark.executor.defaultJavaOptions=-XX:TrimNativeHeapInterval=5000 -Xlog:trimnative
```

Two of these settings were needed to run the full suite on Comet:

- **Off-heap memory.** With a 64 GiB heap and 32 GiB of off-heap memory, each task gets 2 GiB of native memory. That is not enough for q21's sort-merge join stage on Comet 1.2.0, which allocates about 2.2 GiB per task and reserves up to 3.1 GiB, so tasks failed and were retried.
- **`-XX:TrimNativeHeapInterval`.** Without it, glibc keeps native memory that Comet has freed, and executor resident memory grows from one query to the next. Late in the suite, q21 had 11 executors OOMKilled while Comet's memory pools were well inside their limits. Trimming every 5 s kept executors at 61 to 70 GiB of resident memory and cost about 4% on the other queries. The Comet tuning guide now recommends it ([#7342](https://github.com/apache/datafusion-comet/pull/7342)).

## What nested benchmarks revealed

The nested schema uses single-element arrays of structs, with no maps for now. Even that was enough to expose issues that were invisible on flat TPC-H. In our first runs, Comet was slower than Spark on q20 and q21, and barely faster on q02. Tracing those queries surfaced a lot of technical debt in how nested data is read, shuffled and spilled, in Comet and in the iceberg-rust reader underneath it.

The issues fell into four groups:

- **Spilling.** Wide nested values made q21's sort spill several hundred GiB per iteration, and Comet wrote spill files uncompressed.
- **Reading only what a query needs.** Comet's native Iceberg scan decoded every field of a nested column, even when Spark had pruned it to one field. This is why q20 was no faster than Spark in our first runs.
- **Shuffle.** Native shuffle wrote wide nested fields two to three times slower than Spark. This is still open work.
- **Nested reads in iceberg-rust.** Nested fields read as NULL, some list types could not be read at all, and projection cost grew with the number of nested leaves.

Spills and shuffle writes happen in flat workloads too. The nested schema changed the data volume or access pattern enough to expose them.

The issues and pull requests, with their measurements and details, are listed in [Issues and pull requests](#issues-and-pull-requests) at the end of the post.

## Results

### Total execution time

Comet 1.1.0 takes 869 s against 1,519 s for Spark (1.75x) and is slower than Spark on one query, q14 (8.8 s against 8.1 s). Comet 1.2.0 takes 790 s (1.92x), 9% less than 1.1.0, and is faster than Spark on all 22 queries.

### Execution time by query

<img
src="../images/comet-nested-tpch/results-queries.svg"
width="100%"
class="img-fluid"
alt="Execution time by query for Spark 4.1.3, Comet 1.1.0 and Comet 1.2.0"
/>

| Query | Spark 4.1.3 (s) | Comet 1.1.0 (s) | Comet 1.2.0 (s) | Speedup, 1.1.0 | Speedup, 1.2.0 |
| ----- | ---: | ---: | ---: | ---: | ---: |
| q01 | 84.9 | 17.0 | 14.8 | 5.01x | 5.73x |
| q02 | 39.3 | 23.4 | 27.0 | 1.68x | 1.45x |
| q03 | 39.7 | 21.6 | 20.1 | 1.83x | 1.97x |
| q04 | 45.2 | 19.8 | 16.1 | 2.28x | 2.81x |
| q05 | 82.6 | 48.5 | 43.9 | 1.70x | 1.88x |
| q06 | 5.0 | 2.2 | 2.1 | 2.22x | 2.41x |
| q07 | 58.6 | 35.3 | 33.5 | 1.66x | 1.75x |
| q08 | 84.6 | 64.1 | 59.3 | 1.32x | 1.43x |
| q09 | 97.1 | 73.2 | 64.9 | 1.33x | 1.50x |
| q10 | 50.9 | 29.2 | 26.6 | 1.74x | 1.91x |
| q11 | 59.9 | 41.8 | 40.0 | 1.43x | 1.50x |
| q12 | 37.1 | 17.8 | 15.2 | 2.08x | 2.44x |
| q13 | 25.6 | 9.3 | 8.7 | 2.75x | 2.95x |
| q14 | 8.1 | 8.8 | 4.3 | 0.93x | 1.91x |
| q15 | 34.2 | 21.1 | 23.0 | 1.62x | 1.49x |
| q16 | 31.9 | 14.7 | 15.4 | 2.16x | 2.08x |
| q17 | 133.6 | 48.1 | 42.8 | 2.78x | 3.13x |
| q18 | 152.6 | 76.3 | 56.4 | 2.00x | 2.71x |
| q19 | 32.1 | 17.2 | 15.0 | 1.87x | 2.14x |
| q20 | 34.3 | 24.6 | 24.3 | 1.39x | 1.41x |
| q21 | 332.0 | 218.9 | 202.1 | 1.52x | 1.64x |
| q22 | 49.8 | 36.2 | 35.0 | 1.38x | 1.43x |
| **Total** | **1,519** | **869** | **790** | **1.75x** | **1.92x** |

The largest gains from 1.1.0 to 1.2.0 are q14 (2.0x), q18 (1.35x) and q04 (1.23x). Comet 1.1.0 is slightly faster than 1.2.0 on q02, q15 and q16. Each version ran once, so differences this small may be noise.

## What's next

- **Nested TPC-DS**, with the same rule: keys and partition columns stay at the top level, the rest moves into a single-element `array<struct>`. Open questions are which columns count as keys (surrogate keys end in `_sk` and many are nullable), which columns to partition by, and how to rewrite `ROLLUP` and window queries next to `explode`.
- **Other nested shapes**: multi-element arrays, maps and deeper nesting, at the cost of changing the questions the queries answer.
- **More engines**: results for other engines on the same data.

## Issues and pull requests

Each item links to the pull request that fixed it, or to the open pull request or issue that tracks it.

### In Comet

- **q21 spills uncompressed ([#6467](https://github.com/apache/datafusion-comet/issues/6467), fixed by [#6698](https://github.com/apache/datafusion-comet/pull/6698)).** Spark pushes the `EXISTS` and `NOT EXISTS` predicates below the `explode`, so the whole unpruned `lineitem_data` column goes through the shuffle, sort and joins. The sort spilled several hundred GiB per iteration, and DataFusion writes spill files uncompressed by default. #6698 adds `spark.comet.exec.spill.compression.codec`, which defaults to `lz4`. In the investigation in #6467, which used an earlier build and a different cluster configuration from the results above, compression took q21 from 380 s to 250 s, against 367 s for Spark.
- **Nested columns are read in full ([#6724](https://github.com/apache/datafusion-comet/issues/6724), fixed by [#6725](https://github.com/apache/datafusion-comet/pull/6725)).** Comet's native Iceberg scan decoded every field of a nested column even when Spark pruned it. In q20 the `partsupp` scan read 26.4 GiB for a query that needs one field, and #6724 found that scan to be the main cost of Comet's q20. This is why q20 was no faster than Spark in our first runs. #6725 passes the pruned schema, and a microbenchmark of that read went from 624 ms to 62 ms, against 413 ms for Spark. The follow-up [#7019](https://github.com/apache/datafusion-comet/issues/7019) covers a partition column nested inside a pruned struct.
- **Nested shuffle writes ([#5397](https://github.com/apache/datafusion-comet/issues/5397)).** The motivating issue above. This is still open work. Nested-type conversion and JVM shuffle performance are tracked in [#6855](https://github.com/apache/datafusion-comet/issues/6855).

### In iceberg-rust

Comet's native Iceberg scan reads data files through iceberg-rust's Arrow reader, so the work on nested reads continued there.

- **Nested fields of migrated files read as NULL ([apache/iceberg-rust#3374](https://github.com/apache/iceberg-rust/issues/3374), fixed by [#3384](https://github.com/apache/iceberg-rust/pull/3384)).** For data files without embedded field IDs, the reader applied the table's name mapping to top-level columns only. Fields inside a struct, list or map got no ID, so the projection never selected them. #3384 applies the mapping at every depth, as Iceberg Java does.
- **Projection mask cost grows with the number of leaves ([#3394](https://github.com/apache/iceberg-rust/issues/3394), fixed by [#3396](https://github.com/apache/iceberg-rust/pull/3396)).** The reader built a projection mask for every file scan task and hashed every Arrow leaf twice to do it. Nested columns add leaves, so this cost grows with the schema. For a file with 1,000 columns and 10 projected, one call went from 318 µs and 3,976 allocations to 95 µs and 178 allocations.
- **List view columns read as NULL ([#3393](https://github.com/apache/iceberg-rust/issues/3393), fix in review in [#3467](https://github.com/apache/iceberg-rust/pull/3467)).** When a file's embedded Arrow schema asks for `ListView`, the projection treats the whole list as one leaf. The column reads as NULL, and a list view of structs shifts every later column to the wrong Parquet leaf. #3467 reads list views as lists.
- **Fixed-size list columns fail to read ([#3471](https://github.com/apache/iceberg-rust/issues/3471), open).** This is the same kind of problem for `FixedSizeList`. The reader cannot convert it to Iceberg's `list` type.

## Get involved

Issues, pull requests and results from other engines and scale factors are welcome. See the [Comet contributor guide](https://datafusion.apache.org/comet/contributor-guide/index.html).

TPC-H is a trademark of the TPC. The queries are derived from TPC-H under the TPC Fair Use Policy, and results from them are not TPC-H results.
