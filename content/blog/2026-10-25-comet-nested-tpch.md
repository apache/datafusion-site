---
layout: post
title: Announcing nested TPC-H, a benchmark for nested data in Apache DataFusion Comet
date: 2026-10-25
author: comphead
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

Apache DataFusion Comet now runs all 22 queries of a nested TPC-H at scale factor 1000 in 777 s, against 1,515 s for Spark. Before the changes this benchmark helped to find, it took 1,088 s.

<img
src="/blog/images/comet-nested-tpch/intro-total.svg"
width="100%"
class="img-fluid"
alt="Total execution time at SF1000: Spark 1,515.0 s, Comet nested unoptimized 1,087.5 s, Comet nested optimized 777.2 s"
/>

Nested TPC-H is a new benchmark in the Comet repository ([#7044](https://github.com/apache/datafusion-comet/pull/7044)). It keeps the TPC-H data and questions and changes only the shape of the tables. The data and queries are engine neutral, so they can be used to compare Spark, Comet and other engines. Figures are the fastest of three iterations from one run per configuration, and the optimized Comet run uses newer Spark, Iceberg and Comet builds than the Spark reference (see Results).

## The problem: TPC-H is flat, real data is not

[TPC-H](https://www.tpc.org/tpch/) is one of the most cited analytical benchmarks, and its schema is flat: eight normalized tables with primitive columns. Its 22 queries exercise well-understood choke points such as aggregation, join ordering and correlated subqueries (Boncz, Neumann and Erling, "TPC-H Analyzed", TPCTC 2013). TPC-DS has more tables and queries but is also flat (Nambiar and Poess, "The Making of TPC-DS", VLDB 2006).

Real data is often nested. Event logs, JSON, Avro and Protobuf records, and many data lake tables are full of structs and arrays, which Parquet stores with the record shredding scheme from Dremel (Melnik et al., VLDB 2010). Nested data adds work that flat benchmarks never exercise:

- **Reading.** Rebuilding list offsets and validity bitmaps from repetition and definition levels, and decoding only the fields a query uses.
- **Planning.** Nested column pruning and predicate pushdown through `explode`.
- **Operators.** `explode`, field access, and sort, join and exchange over wide variable-size values.
- **Memory and spilling.** Variable-size values make memory use and spill volume harder to predict.
- **Conversion.** Moving nested values between a JVM and a native representation.

Comet hit this in [#5397](https://github.com/apache/datafusion-comet/issues/5397), where native shuffle writes of wide nested fields were two to three times slower than Spark's. The issue notes that it was "invisible for TPC-* benchmarks because of historical flat schema".

## The solution: an adapter that nests TPC-H

The adapter keeps the TPC-H questions and answers and changes the data layout. Each table keeps its join keys and partition column at the top level (`p_brand`, `c_mktsegment`, `o_orderdate` and `l_shipdate`), and every other column moves into one `array<struct>` named `<table>_data`. Each array holds exactly one element, so exploding it never changes the row count and the queries return the same answers as TPC-H. For `lineitem`:

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

[`nest_tpch.scala`](https://github.com/apache/datafusion-comet/blob/main/benchmarks/nested/scripts/nest_tpch.scala) converts an existing flat TPC-H dataset, in Parquet or Iceberg, to the nested layout, in Parquet or Iceberg. It runs under `spark-shell` on a laptop or a cluster, casts columns to fixed types, writes zstd-compressed Parquet with 512 MiB row groups, partitions by the columns above and checks row counts:

```bash
spark-shell -i scripts/nest_tpch.scala \
  --conf spark.nesttpch.source=parquet:/data/tpch/sf10 \
  --conf spark.nesttpch.target=parquet:/data/tpch-nested/sf10
```

The [README](https://github.com/apache/datafusion-comet/tree/main/benchmarks/nested) has the Iceberg variants and all settings. TPC-H is a trademark of the TPC. The queries are derived from TPC-H under the TPC Fair Use Policy, and results from them are not TPC-H results.

## Results at SF1000

One Spark run and two Comet runs, each with three iterations per query. Figures are the fastest iteration, and totals are sums of the per-query times. All runs use Iceberg tables with zstd-compressed Parquet on Kubernetes with 16-core executors.

- **Spark**: 2026-09-22, Spark 3.4.3 and Iceberg 1.5.0, without Comet. It is the reference for both Comet runs.
- **Comet nested unoptimized**: the same day and stack, with a Comet 1.1.0 snapshot (revision `a50fe3aea863`), before the changes described below.
- **Comet nested optimized**: 2026-10-24, Spark 4.0, Iceberg 1.9.1 and a Comet 1.3.0 snapshot (revision `330b29cf`).

The optimized run uses newer Spark and Iceberg versions than the Spark reference, and the cluster size is not recorded with the runs. The comparison therefore does not separate the effect of Comet from the effect of the newer stack.

### Total execution time

Unoptimized Comet takes 1,087.5 s against 1,515.0 s for Spark (1.39x) and is slower on q20 and q21. Optimized Comet takes 777.2 s (1.95x), 29% less than unoptimized, and is faster than Spark on all 22 queries.

<img
src="/blog/images/comet-nested-tpch/intro-total.svg"
width="100%"
class="img-fluid"
alt="Total execution time at SF1000: Spark 1,515.0 s, Comet nested unoptimized 1,087.5 s, Comet nested optimized 777.2 s"
/>

### Execution time by query

q21 is the longest query: 490.6 s on unoptimized Comet, 373.5 s on Spark and 256.6 s on optimized Comet.

<img
src="/blog/images/comet-nested-tpch/results-queries.svg"
width="100%"
class="img-fluid"
alt="Execution time by query for Spark, Comet nested unoptimized and Comet nested optimized"
/>

An [interactive version](/blog/images/comet-nested-tpch/dashboard.html) shows iteration times on hover. The numbers:

| Query | Spark (s) | Comet nested unoptimized (s) | Comet nested optimized (s) |
| ----- | ---: | ---: | ---: |
| q01 | 78.1 | 14.5 | 13.7 |
| q02 | 34.9 | 34.0 | 28.1 |
| q03 | 41.0 | 19.6 | 17.9 |
| q04 | 46.7 | 20.6 | 14.8 |
| q05 | 82.5 | 45.7 | 47.4 |
| q06 | 4.9 | 2.8 | 1.9 |
| q07 | 56.7 | 33.3 | 32.4 |
| q08 | 76.8 | 42.0 | 42.8 |
| q09 | 97.9 | 49.9 | 48.1 |
| q10 | 47.7 | 31.6 | 25.8 |
| q11 | 70.4 | 40.0 | 34.5 |
| q12 | 34.4 | 16.1 | 14.4 |
| q13 | 25.3 | 8.7 | 8.1 |
| q14 | 8.2 | 6.8 | 2.8 |
| q15 | 31.8 | 18.1 | 16.5 |
| q16 | 33.7 | 13.7 | 13.1 |
| q17 | 109.4 | 41.5 | 40.6 |
| q18 | 142.5 | 71.6 | 57.9 |
| q19 | 31.2 | 14.8 | 11.0 |
| q20 | 31.5 | 32.9 | 21.8 |
| q21 | 373.5 | 490.6 | 256.6 |
| q22 | 56.1 | 38.8 | 27.1 |
| **Total** | **1,515.0** | **1,087.5** | **777.2** |

### What the nested benchmark found

The unoptimized run pointed at problems that the flat benchmarks did not show.

- **q21 spills uncompressed ([#6467](https://github.com/apache/datafusion-comet/issues/6467), fixed by [#6698](https://github.com/apache/datafusion-comet/pull/6698)).** Spark pushes the `EXISTS` and `NOT EXISTS` predicates below the `explode`, so the whole unpruned `lineitem_data` column goes through the shuffle, sort and joins. The sort spilled several hundred GiB per iteration, and DataFusion writes spill files uncompressed by default. #6698 adds `spark.comet.exec.spill.compression.codec`, which defaults to `lz4`. In that investigation (Spark 4, Iceberg, SF1000) q21 went from 380 s to 250 s, against 367 s for Spark. A contributor also measured per-row evaluation of the semi and anti join filter ([apache/datafusion#25923](https://github.com/apache/datafusion/issues/25923)) as a further cost, not yet confirmed.
- **Nested columns are read in full ([#6724](https://github.com/apache/datafusion-comet/issues/6724), fixed by [#6725](https://github.com/apache/datafusion-comet/pull/6725)).** Comet's native Iceberg scan decoded every field of a nested column even when Spark pruned it. In q20 the `partsupp` scan read 26.4 GiB for a query that needs one field. #6725 passes the pruned schema, and a microbenchmark of that read went from 624 ms to 62 ms, against 413 ms for Spark. The follow-up [#7019](https://github.com/apache/datafusion-comet/issues/7019) covers a partition column nested inside a pruned struct.
- **Nested shuffle writes ([#5397](https://github.com/apache/datafusion-comet/issues/5397)).** The motivating issue above. Related work is tracked in [#6855](https://github.com/apache/datafusion-comet/issues/6855).

Two of the three sit in code that flat workloads also use. The nested schema changed the data volume or access pattern enough to expose them.

## What's next

- **Nested TPC-DS**, with the same rule: keys and partition columns stay at the top level, the rest moves into a single-element `array<struct>`. Open questions are which columns count as keys (surrogate keys end in `_sk` and many are nullable), which columns to partition by, and how to rewrite `ROLLUP` and window queries next to `explode`.
- **Other nested shapes**: multi-element arrays, maps and deeper nesting, at the cost of changing the questions the queries answer.
- **More engines**: results for other engines on the same data.

These results are a snapshot from single runs. Issues, pull requests and results from other engines and scale factors are welcome. See the [Comet contributor guide](https://datafusion.apache.org/comet/contributor-guide/index.html).
