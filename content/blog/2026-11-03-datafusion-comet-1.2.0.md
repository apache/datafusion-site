---
layout: post
title: Apache DataFusion Comet 1.2.0 Release
date: 2026-11-03
author: pmc
categories: [subprojects]
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

The Apache DataFusion PMC is pleased to announce version 1.2.0 of the [Comet](https://datafusion.apache.org/comet/) subproject.

Comet is an accelerator for Apache Spark that translates Spark physical plans to DataFusion physical plans for
improved performance and efficiency without requiring any code changes.

This release covers roughly five weeks of development since 1.1.0: 388 commits from 40 contributors. See the
[change log] for the full list of changes.

[change log]: https://github.com/apache/datafusion-comet/blob/branch-1.2/docs/source/changelog/1.2.0.md

Comet has always aimed to return the same results as Spark. Much of this cycle went into the edge cases that
remained, working through whole categories at a time (timezones, floating-point `-0.0` and `NaN`, collations)
and adding tests that keep them fixed.

The highlights:

- **Spark-exact timestamps, floats and collations**: native timestamp results carry the right timezone, and
  `-0.0`, `0.0` and `NaN` follow Spark in hashing, comparison, sorting, aggregation and array functions.
- **Memory, spill and shuffle at scale**: fixes for memory that Spark has already reclaimed, much smaller JVM
  shuffle memory use with many partitions, and smaller shuffle files.
- **Iceberg**: native writes are a documented, opt-in feature with support for format-version 3 tables, and the
  native scan reads fewer nested fields and more files at once.
- **More of the plan runs natively**, and Comet reaches new places: a native Delta Lake scan (experimental),
  Arrow Python UDFs (experimental), and Spark 4.2 as a supported version.

## Results That Match Spark

The differences that remain between Comet and Spark tend to cluster in edge cases that share a root cause. In
1.2.0 we went through these by category, starting with the two areas that produced the most reports.

### Timestamps and timezones

Spark labels a timestamp with the session timezone, and Comet's native code has to produce the same label, not
only the same instant. Several native expressions got this wrong. The timezone work is now complete, and covers:

- Native timestamp results carry the correct timezone label: `timestamp_seconds` results are labelled as UTC
  timestamps ([#6341]), `date_trunc` keeps its input's label ([#6345]), and `CASE` and `COALESCE` relabel
  timestamp branches instead of panicking ([#6347]).
- Session timezone IDs are normalized before they reach native code ([#6351]).
- `date_trunc` with a format that differs from row to row uses the same kernel as a literal format ([#6354]).
- The driver warns when the native and JVM timezone databases differ ([#6353]), since a mismatch is the one
  thing Comet cannot hide.
- The test harness now fails a test when a native plan mislabels a timestamp, so this class of bug can't come
  back unnoticed ([#6868], [#6930]).

Thanks to [@andygrove] for the sweep and [@LinSimon-901101] for the label checks. The new
[timezone handling page](https://datafusion.apache.org/comet/contributor-guide/timezones.html) in the
contributor guide explains the rules.

### Floating point: `-0.0`, `0.0` and `NaN`

Spark treats `-0.0` and `0.0` as equal and every `NaN` as one value in some places, and as different values in
others, depending on the operation and the Spark version. DataFusion makes different choices. The differences
are easy to miss in testing and show up as wrong joins, groups and sort orders. In 1.2.0, these now follow Spark:

- **Hashing**: `hash`, `xxhash64` and native shuffle hash `NaN` as Spark does ([#6413]).
- **Comparison and ordering**: `min`, `max`, `greatest` and `least` ([#6457], [#6760], [#6761]), sort and
  window keys nested in arrays and structs ([#6475], [#6968]), and `percentile` for negative `NaN`s ([#6829]).
- **Array functions**: `array_remove`, `sort_array`, `array_distinct` and `array_union` ([#6518], [#6563]), and
  `arrays_overlap` on the Spark versions where `-0.0` and `0.0` are one value ([#6989]).
- **Arithmetic**: `signum(-0.0)` ([#6556]) and the zero check in `Remainder` ([#6896]).
- **Maps**: Comet no longer builds a map natively when its key type holds a `FLOAT` or `DOUBLE`, because Spark 4.0+
  normalizes those keys and rejects duplicates in a way native code did not ([#6992]).

The contributor guide now has a [floating point page](https://datafusion.apache.org/comet/contributor-guide/floating_point.html)
that says which Spark rule each expression follows and how to test for it. A sweep suite crosses edge values
with every operator context, so the next DataFusion upgrade that shifts float behavior will fail a test instead
of a customer.

Thanks to [@andygrove] for the sweep, [@viirya] for the `greatest` and `least` fixes, [@rich7420] for
`percentile`, [@zhangfengcdt] for `signum`, and [@Weijun-H] for nested null ordering.

### Collations and more wrong-results fixes

Strings with a non-default collation compare differently from ordinary strings. Comet now falls back to Spark, or
runs the expression through [codegen dispatch], for collated casts, sort keys and comparisons instead of
comparing bytes ([#5302], [#6206], [#6471], [#6480]). Thanks to [@stantheman0128], [@LinSimon-901101] and
[@viirya].

Other fixes in this release changed the answer a query returned:

- **Decimal `AVG`** returned `NULL` or a wrong value for sums that overflowed an intermediate `i128`, and
  mixed up empty and overflowing partial states. 1.2.0 repairs the division and the buffers, and falls back to
  Spark for the cases it cannot yet do correctly ([#5420], thanks to [@sunchao], and [#7017]).
- **Variance, covariance and correlation** now update and merge in Spark's order, so values that are large and
  close together give Spark's result, and `regr_r2` returns `NULL` or `DIVIDE_BY_ZERO` where Spark does ([#6076], thanks to [@rich7420]).
- **Broadcasts** of sliced string, binary, array or map batches could return wrong values or fail with
  `OversizedAllocationException` ([#6900], thanks to [@comphead]).
- **Join output order**: Spark drops a sort above a hash join because the join keeps its streamed side's order.
  Comet's native hash join did not keep it for some inputs, so the query could return unsorted partitions
  ([#6835], [#6810], thanks to [@dwsmith1983]).
- **ANSI mode**: `array_append` now evaluates its item on rows whose array is `NULL`, so it raises the errors
  Spark raises ([#7025], thanks to [@kazuyukitanimura]), and `corr` raises `DIVIDE_BY_ZERO` ([#6830], thanks to [@kazuyukitanimura]).

[codegen dispatch]: https://datafusion.apache.org/blog/2026/06/20/datafusion-comet-0.17.0/

## Memory, Spill and Shuffle

1.1.0 made Comet's memory use visible. 1.2.0 fixes more of the ways it went wrong, and makes shuffle cheaper.

### Memory

- **Memory is returned sooner.** Native plans return their memory before the Spark task ends ([#6261]), and a
  native acquire or shuffle page allocation that fails after Spark has dropped the task's entry is retried
  instead of failing the task ([#6310], [#6403], [#6813]).
- **Spilling works in more places.** A final aggregate that spilled reads its spill files back past its memory
  share ([#6544]), and the memory reservation of grouped integer `SUM` state is now counted ([#6370]).
- **Container sizing.** The native memory limit follows how YARN and Kubernetes size executor containers
  ([#6375]).
- **Spill files are compressed with lz4 by default** (`spark.comet.exec.spill.compression.codec`, [#6698]). The
  PR reports TPC-H q21 going from 380 s to 250 s, against 367 s for Spark.
- **The memory usage log is in the Spark event log**, so it can be read after the application ends ([#6401],
  [#6250], [#6271]).

Thanks to [@andygrove] for most of this work, with [@dwsmith1983] and [@viirya] on the retry fixes and [@comphead] on
spill compression and the event log.

### Shuffle

- **JVM shuffle with many partitions.** The bypass-merge writer gave every partition a page of Spark's page size,
  32 to 64 MB, as soon as it buffered a row. With more partitions than a task's memory could hold pages for,
  every new page forced a spill. Pages now start small and grow ([#7059]). The PR reports `REPARTITION(64)` on
  TPC-H `orders` going from 266 s and 2.48 GB to 1.1 s and 156 MB, and on `lineitem` from 15.5 minutes to 3.3 s.
- **Smaller shuffle files.** Offsets are stored as lengths and compressed with zstd, which makes shuffle files with
  string, binary, array and map columns 9% to 40% smaller in the PR's benchmarks ([#6943]).
- **Faster spills.** A JVM shuffle spill writes every partition in one native call ([#7065]), which the PR reports
  as 21% to 28% faster for 1,000 partitions and 45% to 49% faster when spilling. Spill pointers are sorted in
  the sorter's scratch space ([#7125]), and shuffle blocks are read in 64 KiB pieces ([#6805]).
- **Broadcast.** Every task that read a Comet broadcast decoded the whole broadcast for itself. Tasks on an
  executor now share one decoded copy ([#7016]). In the PR's benchmark, a 1M-row build side read by 128 tasks on
  `local[8]` went from 1,321 ms to 684 ms.

Thanks to [@andygrove] for this work, [@viirya] for the spill pointer sort and [@comphead] for the block reads.

## Iceberg

### Native writes

Native Iceberg writes are **off by default** in 1.2.0, as they were in 1.1.0 when they were experimental. We
considered turning them on during this cycle and decided against it for this release: it is their first
release as a documented, user-facing feature, and we would rather have users opt in and report what they find
before the default changes. The default is revisited after the 1.2.0 branch is cut.

To use them, set `spark.comet.write.iceberg.enabled=true`. This replaces the pair of settings used in 1.1.0, so see
[Upgrading to 1.2.0](#upgrading-to-120) if you enabled the feature then. What changed in the writer:

- **Format-version 3 tables** can be written natively ([#6672]).
- **Per-location credentials** apply to native reads and writes ([#6478]).
- **Files match iceberg-java more closely**: dictionary encoding is chosen the way iceberg-java does ([#6241]),
  partitions past year 262142 match ([#6239]), and float and double identity partitions are written natively
  ([#6851]).
- **Memory**: write buffers are charged to the task's memory pool ([#6247]), and when the pool refuses a new
  buffer the writer closes fanout partitions early instead of failing ([#6773]).
- **Speed**: the writer's dictionary pre-pass is 1.8x to 3.9x faster ([#6937]).
- **Fallbacks**: more unsupported writes are detected up front and run through iceberg-java, such as writes with
  unsupported S3 settings, a void partition field and a scan that reports an output ordering ([#6441], [#6502],
  [#6677], [#7043]).

The [Iceberg guide](https://datafusion.apache.org/comet/user-guide/latest/iceberg.html#writes) lists the
supported operations, every fallback, and every known difference from iceberg-java.

### Reads and row-level operations

- The native scan reads only the nested fields Spark keeps ([#6725]) and opens **two data files at once** by
  default ([#7132]), which hides the latency of opening files on tables with many small files or on S3.
- `MERGE INTO` can run natively in `MergeRowsExec` on Spark 3.5+ (`spark.comet.exec.mergeRows.enabled`, off by
  default, [#5318]), with `MergeSummary` support on Spark 4.1+ ([#6640]) and Spark 4.2 write transactions
  ([#6587]).

Thanks to [@andygrove] for the writer work, [@snmvaughan] for per-location credentials, [@unikdahal] for the
row-level operations, [@comphead] for nested-field pruning, [@sam-1112], [@0lai0] and [@parthchandra] for
fallback gates.

## More of the Plan Runs Natively

- **On by default**: existence joins ([#4587], thanks to [@coderfender]), conversion of `OneRowRelation` ([#6666]),
  aggregates with no grouping keys ([#6899]), `min` and `max` over strings and binary ([#6927]), and broadcast
  joins whose build side holds an unsupported scan ([#6786], thanks to [@parthchandra]).
- **New operators and expressions**: `SortAggregateExec` ([#4565]), the `PivotFirst` fast path for `PIVOT`
  ([#4798]), HyperLogLog sketch functions ([#4802]), distinct-combined `collect_list` ([#4727]),
  `AtLeastNNonNulls` ([#6180]), `replace` ([#6680]), hashing of wide decimals ([#6548]), `RANGE` window frames
  with an offset on a `DATE` key ([#4974]), and interval multiply and divide ([#4715], [#4901]).
- **Opt-in conversions**: a native `RangeExec` ([#6553]), operators above typed Dataset operations ([#6564]),
  native shuffle over row input ([#6607]), and join filter pushdown through deterministic residuals ([#6431]).
  Each conversion of RDD, range, cache and Data Source V1 inputs has its own `spark.comet.convert.*` setting
  ([#6602]).

### The in-memory cache stays opt-in

Comet can store Spark's in-memory cache in Arrow format and read it natively. During this cycle we planned to
turn it on by default, and made hardening changes for that: serializer and Kryo gating ([#6360], [#6537]),
EXPLAIN and SQL-tab fidelity ([#6453], [#6574], [#6577]), planner statistics ([#6412]) and a reader class
generated once per executor ([#6860]). The audit it prompted found cases where default settings could return
rows in the wrong order, so we decided to keep the feature opt-in (`spark.comet.exec.inMemoryCache.enabled`) for
1.2.0. One of those cases is fixed ([#6835]); the rest are tracked in [#6834].

## Reaching New Places

### Delta Lake (experimental)

A new contrib module plans Delta Lake scans on the JVM and runs them in Comet's native Parquet scan, including
deletion vectors, row-group pruning and page pruning ([#5365]). It is opt-in: build the separate
`comet-contrib-delta` jar and set `spark.comet.scan.delta.enabled=true`. See the
[Delta Lake guide](https://datafusion.apache.org/comet/user-guide/latest/delta.html). Thanks to [@dwsmith1983].

### Python UDFs (experimental)

Scalar Arrow Python UDFs can run in native Comet, passing Arrow data to Python without going through rows
([#6130]). It needs a native library built with the `python-udf` Cargo feature and PyArrow on every executor, and
is enabled with `spark.comet.exec.nativeArrowPythonUDF.enabled`. The PR reports a vectorized
`pyarrow.compute.negate` over 50 million rows running 3.6x faster than Spark, and a UDF that loops in Python
running 3.4x slower, so try it on your own workload before relying on it. Thanks to [@viirya]. Custom Rust UDFs
through Arrow FFI ([#4459]) remain experimental, and a new setting disables or restricts native library loading
([#6775]).

### Spark 4.2

Spark 4.2.0 is now a supported version rather than an experimental one. Comet's tests and Spark's SQL tests both
run against it nightly ([#4950], [#6417]).

## Performance

- **`CASE WHEN` and `IF`** are up to 12x faster ([#6350]), and **string-to-timestamp casts** up to 5.6x faster
  ([#5130]). Casts from integers, decimals, floats and booleans to timestamp are vectorized ([#6969]).
- **Spark-to-Arrow conversion**: columns are written in bulk ([#6566]), unsafe rows are converted straight from
  their memory ([#6730]), and JVM columnar shuffle converts strings, maps and arrays faster ([#6604]).
- **Columnar to row**: a direct path is up to 1.9x faster on decimal-heavy schemas, though the PR measured it 29%
  slower on a plain long, int, double and string schema ([#5496], thanks to [@peterxcli]).
- **Scans**: the next Parquet file's footer and page index load while the current file is read, which the PR
  reports as up to 1.9x faster on high-latency storage ([#7094]). Opt-in TopK threshold pushdown reaches the Parquet
  readers ([#6181], [#6263], thanks to [@pingzh]).
- **Joins**: decoded probe batches are filtered before intermediate joins ([#6433], thanks to [@sunchao]).

## Upgrading to 1.2.0

A few changes in 1.2.0 can affect a deployment. The [Comet Upgrade Guide] has the details.

[Comet Upgrade Guide]: https://datafusion.apache.org/comet/user-guide/latest/migration-guide.html

- **Native Iceberg writes use one setting.** 1.1.0's `spark.comet.iceberg.write.enabled` (a testing setting that
  also needed `spark.comet.write.iceberg.splitOperator.enabled`) is now `spark.comet.write.iceberg.enabled`, and
  Comet ignores the old name. Parquet writes were renamed in the same way, from `spark.comet.parquet.write.enabled`
  to `spark.comet.write.parquet.enabled` ([#6494]). Set the new names to keep native writes.
- **The native Iceberg scan reads two files at once.** `spark.comet.scan.icebergNative.dataFileConcurrencyLimit` now
  defaults to 2. A task can use more off-heap memory, and a query without `ORDER BY` can return rows in a
  different order. Set it to `1` to restore the old behavior.
- **Spark-to-Arrow conversions have their own settings.** Converting ranges, cached tables, RDDs, queries without a
  `FROM` clause and Data Source V1 relations through `spark.comet.sparkToColumnar.supportedOperatorList` is
  deprecated. Use the matching `spark.comet.convert.*` setting. The old setting still works and logs a warning.
- **Native libraries are extracted into private directories** ([#6987], thanks to [@manuzhang]), and the packaging
  of the published artifacts changed: `comet-common`, the parent pom and `comet-spark-integration` are no longer
  published ([#6888]).

## Compatibility

Supported platforms:

- **Spark 3.4.3** with Java 17 and Scala 2.12/2.13 (deprecated)
- **Spark 3.5.9** with Java 17 and Scala 2.12/2.13
- **Spark 4.0.4** with Java 17/21 and Scala 2.13
- **Spark 4.1.3** with Java 17/21 and Scala 2.13
- **Spark 4.2.0** with Java 17 and Scala 2.13

See the [Spark Version Compatibility] page for known limitations specific to each version.

[Spark Version Compatibility]: https://datafusion.apache.org/comet/user-guide/latest/compatibility/spark-versions.html

This release builds on **DataFusion 55.2** and **Arrow 59.2** ([#6766]).

## Get Started with Comet 1.2.0

Follow the [Comet 1.2.0 Installation Guide](https://datafusion.apache.org/comet/user-guide/1.2/installation.html)
to get up and running, then point Comet at your existing Spark workloads.

[@andygrove]: https://github.com/andygrove
[@LinSimon-901101]: https://github.com/LinSimon-901101
[@viirya]: https://github.com/viirya
[@rich7420]: https://github.com/rich7420
[@zhangfengcdt]: https://github.com/zhangfengcdt
[@Weijun-H]: https://github.com/Weijun-H
[@stantheman0128]: https://github.com/stantheman0128
[@sunchao]: https://github.com/sunchao
[@comphead]: https://github.com/comphead
[@dwsmith1983]: https://github.com/dwsmith1983
[@kazuyukitanimura]: https://github.com/kazuyukitanimura
[@snmvaughan]: https://github.com/snmvaughan
[@unikdahal]: https://github.com/unikdahal
[@sam-1112]: https://github.com/sam-1112
[@0lai0]: https://github.com/0lai0
[@parthchandra]: https://github.com/parthchandra
[@coderfender]: https://github.com/coderfender
[@peterxcli]: https://github.com/peterxcli
[@pingzh]: https://github.com/pingzh
[@manuzhang]: https://github.com/manuzhang

[#6341]: https://github.com/apache/datafusion-comet/pull/6341
[#6345]: https://github.com/apache/datafusion-comet/pull/6345
[#6347]: https://github.com/apache/datafusion-comet/pull/6347
[#6351]: https://github.com/apache/datafusion-comet/pull/6351
[#6354]: https://github.com/apache/datafusion-comet/pull/6354
[#6353]: https://github.com/apache/datafusion-comet/pull/6353
[#6868]: https://github.com/apache/datafusion-comet/pull/6868
[#6930]: https://github.com/apache/datafusion-comet/pull/6930
[#6413]: https://github.com/apache/datafusion-comet/pull/6413
[#6457]: https://github.com/apache/datafusion-comet/pull/6457
[#6760]: https://github.com/apache/datafusion-comet/pull/6760
[#6761]: https://github.com/apache/datafusion-comet/pull/6761
[#6475]: https://github.com/apache/datafusion-comet/pull/6475
[#6968]: https://github.com/apache/datafusion-comet/pull/6968
[#6829]: https://github.com/apache/datafusion-comet/pull/6829
[#6518]: https://github.com/apache/datafusion-comet/pull/6518
[#6563]: https://github.com/apache/datafusion-comet/pull/6563
[#6989]: https://github.com/apache/datafusion-comet/pull/6989
[#6556]: https://github.com/apache/datafusion-comet/pull/6556
[#6896]: https://github.com/apache/datafusion-comet/pull/6896
[#6992]: https://github.com/apache/datafusion-comet/pull/6992
[#5302]: https://github.com/apache/datafusion-comet/pull/5302
[#6206]: https://github.com/apache/datafusion-comet/pull/6206
[#6471]: https://github.com/apache/datafusion-comet/pull/6471
[#6480]: https://github.com/apache/datafusion-comet/pull/6480
[#5420]: https://github.com/apache/datafusion-comet/pull/5420
[#7017]: https://github.com/apache/datafusion-comet/pull/7017
[#6076]: https://github.com/apache/datafusion-comet/pull/6076
[#6900]: https://github.com/apache/datafusion-comet/pull/6900
[#6835]: https://github.com/apache/datafusion-comet/pull/6835
[#6810]: https://github.com/apache/datafusion-comet/pull/6810
[#7025]: https://github.com/apache/datafusion-comet/pull/7025
[#6830]: https://github.com/apache/datafusion-comet/pull/6830
[#6261]: https://github.com/apache/datafusion-comet/pull/6261
[#6310]: https://github.com/apache/datafusion-comet/pull/6310
[#6403]: https://github.com/apache/datafusion-comet/pull/6403
[#6813]: https://github.com/apache/datafusion-comet/pull/6813
[#6544]: https://github.com/apache/datafusion-comet/pull/6544
[#6370]: https://github.com/apache/datafusion-comet/pull/6370
[#6375]: https://github.com/apache/datafusion-comet/pull/6375
[#6698]: https://github.com/apache/datafusion-comet/pull/6698
[#6401]: https://github.com/apache/datafusion-comet/pull/6401
[#6250]: https://github.com/apache/datafusion-comet/pull/6250
[#6271]: https://github.com/apache/datafusion-comet/pull/6271
[#7059]: https://github.com/apache/datafusion-comet/pull/7059
[#6943]: https://github.com/apache/datafusion-comet/pull/6943
[#7065]: https://github.com/apache/datafusion-comet/pull/7065
[#7125]: https://github.com/apache/datafusion-comet/pull/7125
[#6805]: https://github.com/apache/datafusion-comet/pull/6805
[#7016]: https://github.com/apache/datafusion-comet/pull/7016
[#6672]: https://github.com/apache/datafusion-comet/pull/6672
[#6478]: https://github.com/apache/datafusion-comet/pull/6478
[#6241]: https://github.com/apache/datafusion-comet/pull/6241
[#6239]: https://github.com/apache/datafusion-comet/pull/6239
[#6851]: https://github.com/apache/datafusion-comet/pull/6851
[#6247]: https://github.com/apache/datafusion-comet/pull/6247
[#6773]: https://github.com/apache/datafusion-comet/pull/6773
[#6937]: https://github.com/apache/datafusion-comet/pull/6937
[#6441]: https://github.com/apache/datafusion-comet/pull/6441
[#6502]: https://github.com/apache/datafusion-comet/pull/6502
[#6677]: https://github.com/apache/datafusion-comet/pull/6677
[#7043]: https://github.com/apache/datafusion-comet/pull/7043
[#6725]: https://github.com/apache/datafusion-comet/pull/6725
[#7132]: https://github.com/apache/datafusion-comet/pull/7132
[#5318]: https://github.com/apache/datafusion-comet/pull/5318
[#6640]: https://github.com/apache/datafusion-comet/pull/6640
[#6587]: https://github.com/apache/datafusion-comet/pull/6587
[#4587]: https://github.com/apache/datafusion-comet/pull/4587
[#6666]: https://github.com/apache/datafusion-comet/pull/6666
[#6899]: https://github.com/apache/datafusion-comet/pull/6899
[#6927]: https://github.com/apache/datafusion-comet/pull/6927
[#6786]: https://github.com/apache/datafusion-comet/pull/6786
[#4565]: https://github.com/apache/datafusion-comet/pull/4565
[#4798]: https://github.com/apache/datafusion-comet/pull/4798
[#4802]: https://github.com/apache/datafusion-comet/pull/4802
[#4727]: https://github.com/apache/datafusion-comet/pull/4727
[#6180]: https://github.com/apache/datafusion-comet/pull/6180
[#6680]: https://github.com/apache/datafusion-comet/pull/6680
[#6548]: https://github.com/apache/datafusion-comet/pull/6548
[#4974]: https://github.com/apache/datafusion-comet/pull/4974
[#4715]: https://github.com/apache/datafusion-comet/pull/4715
[#4901]: https://github.com/apache/datafusion-comet/pull/4901
[#6553]: https://github.com/apache/datafusion-comet/pull/6553
[#6564]: https://github.com/apache/datafusion-comet/pull/6564
[#6607]: https://github.com/apache/datafusion-comet/pull/6607
[#6431]: https://github.com/apache/datafusion-comet/pull/6431
[#6602]: https://github.com/apache/datafusion-comet/pull/6602
[#6360]: https://github.com/apache/datafusion-comet/pull/6360
[#6537]: https://github.com/apache/datafusion-comet/pull/6537
[#6453]: https://github.com/apache/datafusion-comet/pull/6453
[#6574]: https://github.com/apache/datafusion-comet/pull/6574
[#6577]: https://github.com/apache/datafusion-comet/pull/6577
[#6412]: https://github.com/apache/datafusion-comet/pull/6412
[#6860]: https://github.com/apache/datafusion-comet/pull/6860
[#6834]: https://github.com/apache/datafusion-comet/pull/6834
[#5365]: https://github.com/apache/datafusion-comet/pull/5365
[#6130]: https://github.com/apache/datafusion-comet/pull/6130
[#4459]: https://github.com/apache/datafusion-comet/pull/4459
[#6775]: https://github.com/apache/datafusion-comet/pull/6775
[#4950]: https://github.com/apache/datafusion-comet/pull/4950
[#6417]: https://github.com/apache/datafusion-comet/pull/6417
[#6350]: https://github.com/apache/datafusion-comet/pull/6350
[#5130]: https://github.com/apache/datafusion-comet/pull/5130
[#6969]: https://github.com/apache/datafusion-comet/pull/6969
[#6566]: https://github.com/apache/datafusion-comet/pull/6566
[#6730]: https://github.com/apache/datafusion-comet/pull/6730
[#6604]: https://github.com/apache/datafusion-comet/pull/6604
[#5496]: https://github.com/apache/datafusion-comet/pull/5496
[#7094]: https://github.com/apache/datafusion-comet/pull/7094
[#6181]: https://github.com/apache/datafusion-comet/pull/6181
[#6263]: https://github.com/apache/datafusion-comet/pull/6263
[#6433]: https://github.com/apache/datafusion-comet/pull/6433
[#6494]: https://github.com/apache/datafusion-comet/pull/6494
[#6987]: https://github.com/apache/datafusion-comet/pull/6987
[#6888]: https://github.com/apache/datafusion-comet/pull/6888
[#6766]: https://github.com/apache/datafusion-comet/pull/6766
