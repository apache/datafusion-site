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

This release covers roughly five weeks of development since 1.1.0: 400 commits from 40 contributors. See the
[change log] for the full list of changes.

[change log]: https://github.com/apache/datafusion-comet/blob/branch-1.2/docs/source/changelog/1.2.0.md

Comet has always aimed to return the same results as Spark. Much of this cycle went into the edge cases that
remained, working through whole categories at a time (timezones, floating-point `-0.0` and `NaN`, collations)
and adding tests that keep them fixed.

The highlights:

- **Results that match Spark**: native timestamp results carry the right timezone, `-0.0`, `0.0` and `NaN`
  follow Spark in hashing, comparison, sorting, aggregation and array functions, and fixes to decimal `AVG`,
  nested types, broadcasts and join order.
- **Memory, spill and shuffle at scale**: memory returned to Spark sooner, fewer memory-related task failures,
  much smaller JVM shuffle memory use with many partitions, and smaller shuffle files.
- **Iceberg**: native writes are a documented, opt-in feature with support for format-version 3 tables, and the
  native scan reads fewer nested fields and more files at once.
- **More of the plan runs natively**: existence joins, `SortAggregateExec`, the `PIVOT` fast path and
  HyperLogLog sketch functions, among others.
- **New places to run**: a native Delta Lake scan (experimental), Arrow Python UDFs (experimental), and Spark 4.2
  as a supported version.

## Results That Match Spark

Timestamps and floating point produced the most reports, so we started there, followed by collations. Individual
fixes in other areas come after that.

### Timestamps and timezones

Spark labels a timestamp with the session timezone, and Comet's native code has to produce the same label, not
only the same instant. Several native expressions got this wrong. 1.2.0 fixes them:

- Native timestamp results carry the correct timezone label: `timestamp_seconds` results are labeled as UTC
  timestamps ([#6341]), `date_trunc` keeps its input's label ([#6345]), and `CASE` and `COALESCE` relabel
  timestamp branches instead of panicking ([#6347]).
- Session timezone IDs are normalized before they reach native code ([#6351]).
- `date_trunc` with a format that differs from row to row uses the same kernel as a literal format ([#6354]).
- The driver warns when the native and JVM timezone databases differ ([#6353]), because Comet cannot correct
  for that difference.
- The test harness now fails a test when a native plan mislabels a timestamp, so this class of bug can't come
  back unnoticed ([#6868], [#6930]).

Thanks to [@andygrove] for the timezone sweep and [@LinSimon-901101] for the label checks. The new
[timezone handling page] in the contributor guide explains the rules.

[timezone handling page]: https://datafusion.apache.org/comet/contributor-guide/timezones.html

### Floating point: `-0.0`, `0.0` and `NaN`

In some operations Spark treats `-0.0` and `0.0` as equal and every `NaN` as one value; in others it treats them
as distinct. Which rule applies depends on the operation and the Spark version, and DataFusion makes different
choices. The differences are easy to miss in testing and show up as wrong joins, groups and sort orders. In
1.2.0, these follow Spark:

- **Hashing**: `hash`, `xxhash64` and native shuffle hash `NaN` as Spark does ([#6413]).
- **Comparison and ordering**: `min`, `max`, `greatest` and `least` ([#6457]), sort and window keys nested in
  arrays and structs ([#6475]), and `percentile` for negative `NaN`s ([#6829]).
- **Array functions**: `array_remove`, `sort_array`, `array_distinct` and `array_union` ([#6518], [#6563]), and
  `arrays_overlap` on the Spark versions where `-0.0` and `0.0` are one value ([#6989]).
- **Arithmetic**: `signum(-0.0)` ([#6556]) and the zero check in `Remainder` ([#6896]).
- **Maps**: Comet no longer builds a map natively when its key type holds a `FLOAT` or `DOUBLE`, because Spark 4.0+
  normalizes those keys and rejects duplicates in a way native code did not ([#6992]).

The contributor guide now has a [floating point page] that says which Spark rule each expression follows and how
to test for it. A sweep suite crosses edge values with every operator context, so a DataFusion upgrade that
shifts float behavior will fail a test before it reaches users.

Thanks to [@andygrove] for the float sweep, [@rich7420] for `percentile` and [@zhangfengcdt] for `signum`.

[floating point page]: https://datafusion.apache.org/comet/contributor-guide/floating_point.html

### Collations

Strings with a non-default collation compare differently from ordinary strings. For collated casts, sort keys and
comparisons, Comet now falls back to Spark or runs the expression through [codegen dispatch] instead of comparing
bytes ([#5302], [#6206], [#6471], [#6480]). Thanks to [@stantheman0128], [@LinSimon-901101] and [@viirya].

[codegen dispatch]: https://datafusion.apache.org/blog/2026/06/20/datafusion-comet-0.17.0/

### Other wrong-results fixes

- **Decimal `AVG`**: results were `NULL` or wrong for sums that overflowed an intermediate `i128`, and empty and
  overflowing partial states were mixed up. 1.2.0 repairs the division and the buffers ([#5420], thanks to
  [@sunchao]) and falls back to Spark for the cases it cannot yet do correctly ([#7017]).
- **Variance, covariance and correlation**: these now update and merge in Spark's order, so values that are large
  and close together give Spark's result, and `regr_r2` returns `NULL` or `DIVIDE_BY_ZERO` where Spark does
  ([#6076], thanks to [@rich7420]).
- **Nested values in comparisons and sorts**: `greatest` and `least` compare struct arguments by position and
  order nulls inside nested values first ([#6760], [#6761], thanks to [@viirya]), and native sort keeps Spark's
  null ordering inside nested values ([#6968], thanks to [@Weijun-H]).
- **Missing nested Parquet fields**: when every nested field a query asks for is missing from a Parquet file,
  Comet could return a non-null struct, array or map where Spark returns `NULL`, which changed `IS NULL`, filters
  and `count`. Comet now follows Spark's version-dependent rules, and falls back for nested reads of name-mapped
  Iceberg tables ([#7085], thanks to [@rich7420]).
- **Nested binary read as strings**: a nested Parquet `BINARY` value read as a string that held invalid UTF-8
  became `NULL`. It is now decoded the way Comet's `CAST(binary AS STRING)` decodes it, replacing ill-formed bytes
  with U+FFFD ([#7106], thanks to [@manuzhang]).
- **Sliced broadcasts**: broadcasts of sliced string, binary, array or map batches could return wrong values or
  fail with `OversizedAllocationException` ([#6900], thanks to [@comphead]).
- **Identity broadcasts**: a Spark operator that keeps every row of a Comet broadcast could see the last row of
  each batch repeated in place of the others. Comet now copies each row ([#7260], thanks to [@pingzh]).
- **Join output order**: Spark drops a sort above a hash join because the join keeps its streamed side's order.
  Comet's native hash join did not keep it for some inputs, so the query could return unsorted partitions
  ([#6835], [#6810], thanks to [@dwsmith1983]).
- **Spark patch releases**: Spark 4.0.5, 4.1.4 and 4.2.1 change what `sequence` returns when `stop - start`
  overflows a long, and the result of casting a zero with a large exponent, such as `'0e79'`, to decimal. Comet
  follows the behavior of the Spark version it runs on ([#7171], thanks to [@snmvaughan]).
- **ANSI mode**: `array_append` now evaluates its item on rows whose array is `NULL`, so it raises the errors
  Spark raises, and `corr` raises `DIVIDE_BY_ZERO` ([#7025], [#6830], thanks to [@kazuyukitanimura]).

## Memory, Spill and Shuffle

1.1.0 made Comet's memory use visible. 1.2.0 fixes more of the ways it went wrong, and makes shuffle cheaper.

### Memory

- **Memory is returned sooner.** Native plans return their memory before the Spark task ends ([#6261]). When
  Spark has already dropped a task's memory entry, a failed native memory request or shuffle page allocation is
  now retried instead of failing the task ([#6310], [#6403], [#6813]).
- **Spilling works in more places.** A final aggregate that spilled can now read its spill files back even when
  they exceed its memory share ([#6544]). A partial merge aggregate whose input is sorted on some of its grouping
  keys spills instead of failing the task ([#7222]). Grouped integer `SUM` state now counts toward the memory
  reservation ([#6370]).
- **Container sizing.** The native memory limit follows how YARN and Kubernetes size executor containers
  ([#6375]).
- **Spill files are compressed with lz4 by default.** The codec is set by
  `spark.comet.exec.spill.compression.codec` ([#6698]). The PR reports TPC-H q21 going from 380 s to 250 s,
  against 367 s for Spark.
- **The memory usage log is in the Spark event log.** It can be read after the application ends ([#6401],
  [#6250], [#6271]).

Thanks to [@andygrove] for most of this work, with [@dwsmith1983] and [@viirya] on the retry fixes and
[@comphead] on spill compression and the event log.

### Shuffle and broadcast

- **JVM shuffle with many partitions.** The bypass-merge writer gave every partition a page of Spark's page size,
  32 to 64 MB, as soon as it buffered a row. When a task's memory could not hold one page per partition, every
  new page forced a spill. Pages now start small and grow ([#7059]). The PR reports `REPARTITION(64)` on TPC-H
  `orders` going from 266 s and 2.48 GB to 1.1 s and 156 MB, and on `lineitem` from 15.5 minutes to 3.3 s.
- **Smaller shuffle files.** Shuffle files with string, binary, array and map columns are 9% to 40% smaller in
  the PR's benchmarks, because offsets are now stored as lengths and compressed with zstd ([#6943]).
- **Faster spills.** A JVM shuffle spill writes every partition in one native call ([#7065]). The PR reports this
  as 21% to 28% faster with 1,000 partitions, and 45% to 49% faster when the writer spills every 100,000 rows.
  Spill pointers are now sorted in the sorter's scratch space ([#7125]).
- **Shuffle reads.** Shuffle blocks are read in 64 KiB pieces ([#6805]).
- **Broadcast.** Every task that read a Comet broadcast decoded the whole broadcast for itself. Tasks on an
  executor now share one decoded copy ([#7016]). In the PR's benchmark, a 1M-row build side read by 128 tasks on
  `local[8]` went from 1,321 ms to 684 ms.

Thanks to [@viirya] for the spill pointer sort, [@comphead] for the block reads and [@andygrove] for the rest.

## Iceberg

### Native writes

Native Iceberg writes stay **off by default** in 1.2.0, as they were in 1.1.0 when they were experimental. We
considered turning them on, but this is their first release as a documented, user-facing feature, and we would
rather users opt in and report what they find first. We plan to revisit the default in a later release.

To use them, set `spark.comet.write.iceberg.enabled=true`. This replaces the pair of settings used in 1.1.0, so see
[Upgrading to 1.2.0](#upgrading-to-120) if you enabled the feature then. What changed in the writer:

- **Format-version 3 tables**: written natively ([#6672]).
- **Per-location credentials**: applied to native reads and writes ([#6478]).
- **Files match iceberg-java more closely**: dictionary encoding is chosen the way iceberg-java does ([#6241]),
  partitions past year 262142 match ([#6239]), and float and double identity partitions are written natively
  ([#6851]).
- **Memory**: write buffers are charged to the task's memory pool ([#6247]), and when the pool refuses a new
  buffer the writer closes fanout partitions early instead of failing ([#6773]).
- **Speed**: the writer's dictionary pre-pass is 1.8x to 3.9x faster ([#6937]).
- **Fallbacks**: more unsupported writes are detected up front and run through iceberg-java, such as writes with
  unsupported S3 settings or through a void partition field whose source column was dropped ([#6441], [#6502],
  [#6677]).

The [Iceberg guide] lists the supported operations, every fallback, and every known difference from iceberg-java.

[Iceberg guide]: https://datafusion.apache.org/comet/user-guide/latest/iceberg.html#writes

### Reads and row-level operations

- The native scan reads only the nested fields Spark keeps ([#6725]) and opens **two data files at once** by
  default ([#7132]), which hides the latency of opening files on tables with many small files or on S3. See
  [Upgrading to 1.2.0](#upgrading-to-120) for the trade-offs and how to turn it off.
- The native scan falls back to Spark when Iceberg reports an output ordering, since it does not keep that order
  and Spark would otherwise drop the sort above it ([#7043]).
- `MERGE INTO` can run natively in `MergeRowsExec` on Spark 3.5+ ([#5318]). It is off by default; enable it with
  `spark.comet.exec.mergeRows.enabled`. It also supports `MergeSummary` on Spark 4.1+ ([#6640]) and Spark 4.2
  write transactions ([#6587]).

Thanks to [@andygrove] for the writer work, [@snmvaughan] for per-location credentials, [@unikdahal] for the
row-level operations, [@comphead] for nested-field pruning, and [@sam-1112], [@0lai0] and [@parthchandra] for
fallback gates.

## More of the Plan Runs Natively

- **On by default**: existence joins ([#4587], thanks to [@coderfender]), queries without a `FROM` clause
  (`OneRowRelation`, [#6666]), aggregates with neither grouping keys nor aggregate functions ([#6899]), and `min`
  and `max` over strings and binary ([#6927]). Broadcast joins whose build side holds an unsupported scan now run
  natively too ([#6786], thanks to [@parthchandra]), except that a Text scan on the build side stays in Spark
  unless `spark.comet.convert.text.enabled` is set, because converting it replaces bytes that are not valid UTF-8
  with U+FFFD ([#7123]).
- **New operators and expressions**: `SortAggregateExec` ([#4565]), the `PivotFirst` fast path for `PIVOT`
  ([#4798]), HyperLogLog sketch functions ([#4802]), distinct-combined `collect_list` ([#4727]),
  `AtLeastNNonNulls` ([#6180]), `replace` ([#6680]), hashing of wide decimals ([#6548]), `RANGE` window frames
  with an offset on a `DATE` key ([#4974]), and interval multiply and divide ([#4715], [#4901]).
- **Opt-in conversions**: a native `RangeExec` ([#6553]), operators above typed Dataset operations ([#6564]),
  native shuffle over row input ([#6607]), and join filter pushdown through deterministic residuals ([#6431]).

### The in-memory cache stays opt-in

Comet can store Spark's in-memory cache in Arrow format and read it natively. We planned to turn this on by
default in 1.2.0 and hardened it first: serializer and Kryo gating ([#6360], [#6537]), EXPLAIN and SQL-tab
fidelity ([#6453], [#6574], [#6577]), planner statistics ([#6412]) and a reader class generated once per executor
([#6860]). Auditing the feature turned up cases where default settings could return rows in the wrong order, so
it stays opt-in (`spark.comet.exec.inMemoryCache.enabled`) for 1.2.0. One of those cases, the join output order
fix above, is in this release ([#6835]); the rest are tracked in [#6834].

## Reaching New Places

### Delta Lake (experimental)

A new contrib module plans Delta Lake scans on the JVM and runs them in Comet's native Parquet scan, including
deletion vectors, row-group pruning and page pruning ([#5365]). It is opt-in: build the separate
`comet-contrib-delta` jar and set `spark.comet.scan.delta.enabled=true`. See the [Delta Lake guide]. Thanks to
[@dwsmith1983].

[Delta Lake guide]: https://datafusion.apache.org/comet/user-guide/latest/delta.html

### Python UDFs (experimental)

Scalar Arrow Python UDFs can run in native Comet, passing Arrow data to Python without going through rows
([#6130]). They need a native library built with the `python-udf` Cargo feature and PyArrow on every executor,
and are enabled with `spark.comet.exec.nativeArrowPythonUDF.enabled`. The PR reports a vectorized
`pyarrow.compute.negate` over 50 million rows running 3.6x faster than Spark, and a UDF that loops in Python
running 3.4x slower, so try it on your own workload before relying on it. Thanks to [@viirya].

Custom Rust UDFs through Arrow FFI ([#4459]) remain experimental. A new setting disables or restricts native
library loading ([#6775]).

### Parquet writes to S3 with the magic committer

The native Parquet writer can now write to S3 through the S3A magic committer ([#6940]), which Spark 4.1
configures by default when spark-hadoop-cloud is on the classpath. S3A creates each file, so its write settings,
such as server-side encryption, ACLs and storage class, apply as they do for Spark. Other S3 writes fall back to
Spark. The native Parquet writer is still for testing only and is off by default
(`spark.comet.write.parquet.enabled`). See the [Parquet guide]. Thanks to [@andygrove].

[Parquet guide]: https://datafusion.apache.org/comet/user-guide/latest/parquet.html#writing

### Spark 4.2

Spark 4.2.0 is now a supported version rather than an experimental one. Comet's tests and Spark's SQL tests both
run against it nightly ([#4950], [#6417]).

## Performance

- **Casts and conditionals**: `CASE WHEN` and `IF` are up to 12x faster ([#6350]), string-to-timestamp casts up
  to 5.6x faster ([#5130]), and casts from integers, decimals, floats and booleans to timestamp are vectorized
  ([#6969]).
- **Spark-to-Arrow conversion**: columns are written in bulk ([#6566]), unsafe rows are converted straight from
  their memory ([#6730]), and JVM columnar shuffle converts strings, maps and arrays faster ([#6604]).
- **Columnar to row**: a new experimental converter writes Arrow values straight into Spark rows without
  allocating an object per value, and is up to 1.9x faster on decimal-heavy schemas. It is opt-in
  (`spark.comet.exec.columnarToRow.direct.enabled`), since the existing path is already fast for schemas without
  decimals ([#5496], thanks to [@peterxcli]).
- **Scans**: the next Parquet file's footer and page index load while the current file is read, which the PR
  reports as up to 1.9x faster on high-latency storage ([#7094]). Opt-in TopK threshold pushdown reaches the
  Parquet readers ([#6181], [#6263], thanks to [@pingzh]).
- **Joins**: decoded probe batches are filtered before intermediate joins ([#6433], thanks to [@sunchao]).

## Upgrading to 1.2.0

A few changes in 1.2.0 can affect a deployment. The [Comet Upgrade Guide] has the details.

[Comet Upgrade Guide]: https://datafusion.apache.org/comet/user-guide/latest/migration-guide.html

- **Native Iceberg writes use one setting.** In 1.1.0, native Iceberg writes were a testing feature that needed
  both `spark.comet.iceberg.write.enabled` and `spark.comet.write.iceberg.splitOperator.enabled`. The setting is
  now `spark.comet.write.iceberg.enabled`, and Comet ignores the old name. Parquet writes were renamed the same
  way, from `spark.comet.parquet.write.enabled` to `spark.comet.write.parquet.enabled` ([#6494]). Set the new
  names to keep native writes.
- **The native Iceberg scan reads two files at once.** `spark.comet.scan.icebergNative.dataFileConcurrencyLimit` now
  defaults to 2. A task can use more off-heap memory, and a query without `ORDER BY` can return rows in a
  different order. Set it to `1` to restore the old behavior.
- **Spark-to-Arrow conversions have their own settings.** Using
  `spark.comet.sparkToColumnar.supportedOperatorList` to convert ranges, cached tables, RDDs, queries without a
  `FROM` clause, Data Source V1 relations or Text scans is deprecated. Use the matching `spark.comet.convert.*`
  setting instead ([#6602], [#7123]). The old setting still works and logs a warning.
- **Comet settings reach every stage.** A job launched from a query's RDD, such as through `Dataset.rdd`, ran its
  map stages with every `spark.comet.*` setting at its default, including the memory pool. Those stages now use
  the session's settings, so their behavior can change after upgrading ([#7302], thanks to [@comphead]).
- **Three known differences from Spark are new in 1.2.0.** The operators involved now run natively where 1.1.0
  fell back. The upgrade guide gives a setting that avoids each one:
    - `collect_set` over `FLOAT` or `DOUBLE` next to `count(DISTINCT ...)` on Spark before 4.2 ([#7203])
    - `RANGE` window frames over a `DATE` column with an offset of roughly 92 million days or more ([#5022])
    - memory accounting for `min` and `max` over strings in a hash aggregate ([#6936])
- **Native libraries are extracted into private directories** ([#6987], thanks to [@manuzhang]).
- **Fewer published artifacts.** `comet-common`, the parent pom and `comet-spark-integration` are no longer
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
[#6834]: https://github.com/apache/datafusion-comet/issues/6834
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
[#7171]: https://github.com/apache/datafusion-comet/pull/7171
[#7222]: https://github.com/apache/datafusion-comet/pull/7222
[#7123]: https://github.com/apache/datafusion-comet/pull/7123
[#7203]: https://github.com/apache/datafusion-comet/issues/7203
[#5022]: https://github.com/apache/datafusion-comet/issues/5022
[#6936]: https://github.com/apache/datafusion-comet/issues/6936
[#6940]: https://github.com/apache/datafusion-comet/pull/6940
[#7085]: https://github.com/apache/datafusion-comet/pull/7085
[#7106]: https://github.com/apache/datafusion-comet/pull/7106
[#7260]: https://github.com/apache/datafusion-comet/pull/7260
[#7302]: https://github.com/apache/datafusion-comet/pull/7302
