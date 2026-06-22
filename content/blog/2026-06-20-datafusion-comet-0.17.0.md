---
layout: post
title: Apache DataFusion Comet 0.17.0 Release
date: 2026-06-20
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

The Apache DataFusion PMC is pleased to announce version 0.17.0 of the [Comet](https://datafusion.apache.org/comet/) subproject.

This release covers approximately five weeks of development work and is the result of merging 192 PRs from 19
contributors. See the [change log] for more information.

[change log]: https://github.com/apache/datafusion-comet/blob/main/dev/changelog/0.17.0.md

## Fewer Fallbacks to Spark

The headline feature of 0.17.0 is a new mechanism that keeps more of your query running inside Comet instead
of falling back to Spark: the **JVM codegen dispatcher**.

Comet has always fallen back to Spark row-based execution whenever an expression had no native Rust implementation, or where the
Rust implementation could diverge from Spark on edge cases. A fallback is correct, but a columnar-to-row
conversion is needed to feed the data into Spark's row-based operators, which adds overhead when processing billions of rows of data.

The codegen dispatcher avoids the fallback to row-based processing by running Spark's own
generated code (`doGenCode`) inside the Comet pipeline, operating directly on Arrow batches. The result is a
JVM-implemented Arrow-native expression: the data stays in Arrow format, and because the expression is
evaluated by Spark's own code, the result is guaranteed to match Spark exactly across every supported Spark
version. When the dispatcher is disabled, Comet falls back as before.

A dispatched expression is no faster than it would be in Spark, since it runs the same generated code. The
benefit is that a single unsupported expression no longer forces an entire
query stage back to row-based execution. The surrounding operators stay Arrow-native, and the
stage avoids the columnar-to-row conversion and row-based Spark execution that a fallback would otherwise
impose.

This release puts the dispatcher to work across a wide surface:

- **100% Spark-compatible regular expressions.** Regex expressions now dispatch to Spark's own
  implementation, eliminating the long-standing compatibility gaps of a separate native regex engine.
- **100% Spark-compatible JSON functions.** JSON expression handling follows the same approach, matching
  Spark's behavior precisely.
- **More scalar and structured-text functions**, including a batch of math and string functions, AES
  encryption and decryption (`aes_encrypt` / `aes_decrypt` / `try_aes_decrypt`), `Upper` / `Lower` /
  `InitCap`, `GetTimestamp`, `mask`, `try_to_number`, and an expanded set of date, time, and
  timezone expressions.
- **Collection and higher-order expressions**, including `array_intersect`, `array_except`, `array_join`,
  `create_map`, and lambda-based higher-order functions such as `filter`.

  0.17.0 also changes how Comet treats expressions whose native Rust path is known to diverge
  from Spark (marked `Incompatible`). Previously such an expression forced the entire projection back to Spark
  unless the user opted into the divergent native behavior with the per-expression
  `spark.comet.expression.<name>.allowIncompatible` flag. By default, that flag is unset, and the expression is
  now routed through the codegen dispatcher and evaluated correctly inside Comet rather than triggering a
  fallback. Setting it to `true` becomes a performance knob for users who accept the faster native path's
  divergence. Expressions such as `from_unixtime`, and the `TimestampNTZ` branches of `hour`, `minute`, and
  `second`, now stay in the pipeline by default.

## User-Defined Functions in Java and Scala

Building on the codegen dispatcher, 0.17.0 adds support for arbitrary user-defined functions written in Java
and Scala, enabled by default. Eligible Spark `ScalaUDF` expressions are routed through the dispatcher and
executed inside the Comet pipeline, so a project around a UDF no longer forces a fallback and a
columnar-to-row conversion.

The path has broad type coverage — scalars, arbitrarily nested complex types, and higher-order functions — and
is backed by end-to-end, fuzz, and Iceberg test coverage. It can be disabled with
`spark.comet.exec.scalaUDF.codegen.enabled=false`.

## Arrow-Native, End to End

The codegen dispatcher works because of a property that runs through all of Comet: queries stay **Arrow-native
end to end**. Operators, expressions, shuffle, and broadcast all remain in Apache Arrow columnar format,
avoiding the per-row overhead that Spark's row-based engine incurs from materializing and transitioning data
one row at a time.

Within that Arrow-native pipeline, the work of an operator or expression runs in one of two ways:

- **Rust-implemented**: native Rust code, executed through Apache DataFusion. This is what most people picture
  when they think of Comet.
- **JVM-implemented**: Scala or Java code that operates directly on Arrow batches, including the
  codegen-dispatched expressions and UDFs described above.

Because the data never leaves Arrow columnar format, there is no per-row materialization cost at the boundary
between a Rust-implemented and a JVM-implemented step. A dispatched expression sits in the pipeline alongside
Rust-implemented operators with no columnar-to-row transition between them. Expanding the JVM-implemented path
in 0.17.0 lets Comet keep more work Arrow-native instead of handing it back to Spark.

## Expanded Expression Coverage

Partly through the codegen dispatcher and partly through new Rust implementations, Comet's expression coverage
grew substantially in this release. More than 120 Spark expressions have gained support since 0.16.0, across
most function families:

- **Date and time** (~25): `convert_timezone`, `make_date`, `months_between`, `next_day`,
  `from_utc_timestamp` / `to_utc_timestamp`, `date_from_unix_date`, the `timestamp_*` and `unix_*` second /
  milli / micro conversions, and the current date/time/timezone functions.
- **Math** (~24): `acosh`, `asinh`, `atanh`, `cbrt`, `csc`, `sec`, `hypot`, `log1p`, `bin`, `conv`,
  `factorial`, `pmod`, `width_bucket`, `rint`, and more.
- **String** (~16): `elt`, `find_in_set`, `format_number`, `format_string`, `levenshtein`, `locate`,
  `overlay`, `soundex`, `split`, `substring_index`, `unbase64`, `to_char`, and `to_number`.
- **XPath** (9): the full `xpath`, `xpath_boolean`, `xpath_double`, `xpath_int`, `xpath_long`, `xpath_string`
  family.
- **JSON, CSV, and XML** (9): `from_csv`, `to_csv`, `schema_of_csv`, `schema_of_json`, `json_object_keys`,
  `json_array_length`, `from_xml`, `to_xml`, and `schema_of_xml`.
- **Array and map** (11): `array_position`, `array_size`, `arrays_zip`, `slice`, `sort_array`, `sequence`,
  `map_concat`, `map_contains_key`, and `map_from_entries`.
- **Aggregate and window** (7): `any_value`, `count_if`, the `regr_*` regression aggregates, plus `lag` and
  `lead`.
- **Conditional and null handling** (7): `greatest`, `least`, `nullif`, `ifnull` / `nvl`, `nvl2`, and
  `equal_null`.

For the full list of supported expressions in this release, see the
[Spark Expression Support](https://datafusion.apache.org/comet/user-guide/0.17/expressions.html) reference.

Operator coverage grew too: 0.17.0 adds a native **broadcast nested loop join**, so queries with non-equi or
cross join conditions can now stay in the Comet pipeline rather than falling back to Spark.

## Performance

### Removing an FFI Round Trip from Native Shuffle

The most significant performance change in 0.17.0 targets the shuffle write path. When a native subtree feeds
a Comet shuffle, Comet previously ran two separate native iterators per partition: one for the upstream
subtree, and a second rooted at a synthetic `Scan("ShuffleWriterInput") -> ShuffleWriter` that consumed the
batches back. The JVM never actually read this data, so the native-to-JVM-and-back hop was pure overhead.

Although the Arrow C Data Interface is zero-copy, this particular round trip was not. The synthetic scan left
its batches marked as not FFI-safe, so on import every batch was deep-copied into freshly allocated buffers.
0.17.0 collapses the two iterators into a single native plan rooted at the shuffle writer, with the upstream
subtree as a direct child. That removes the Arrow FFI export and import, the per-batch deep copy, and one
`createPlan` / `releasePlan` pair per partition, while preserving all of the existing per-partition setup
(broadcast alignment, subqueries, encryption) and input metrics reporting. The gain comes from removing the
round trip, not from copying its data more efficiently.

### A Single Arrow Stream on the Input Path

0.17.0 also reworks the other side of the JVM/native boundary — the path that feeds JVM-sourced data _into_
native execution. Previously each batch crossed via a bespoke `CometBatchIterator`, with a `hasNext` / `next`
JNI pair per batch and every column imported through its own Arrow FFI array and schema. This release replaces
that path with the **Arrow C Stream Interface**: the JVM exports each per-partition iterator once, and native
imports the schema once and pulls each batch through a single C callback, taking ownership by reference count.
This removes the per-batch, per-column FFI export and JNI round trips for all JVM-sourced inputs, lets the
old `CometBatchIterator` and a now-unnecessary deep copy be deleted, and is the input-side counterpart to the
shuffle-write change above. TPC-DS at 1TB is about 9% faster in 0.17.0 than in 0.16.0, and these two FFI
changes are the largest contributor to that gain.

### Lower Per-Batch Overhead in Arrow Vectors

Two changes reduce repeated work when reading Arrow columns across the JNI boundary. Comet now caches the
validity buffer address on `CometDecodedVector` and the offset buffer address for variable-width vectors on
`CometPlainVector`, so these addresses are resolved once per vector rather than on every access.

### Faster Statistical Aggregates

The variance, standard deviation, covariance, and correlation aggregates now use DataFusion's
`GroupsAccumulator` interface, which is substantially more efficient for grouped aggregation than the
row-accumulator path they used previously.

Additional smaller improvements include bulk-NULL handling in `split` and `substring` (skipping a per-row
allocation), and a new `interleave_time` shuffle metric with tuned output buffer sizing to make shuffle cost
easier to attribute.

## Preparing for the 1.0.0 Release

Much of the correctness work in this release is part of an ongoing push toward a **1.0.0 release**.
Planning for 1.0.0 is being tracked in [issue #4082], where the community is discussing what the milestone
should mean. The criteria under consideration go well beyond correctness and include:

- Demonstrated cost savings for TPC-H and TPC-DS at SF1000 (1TB)
- Thorough documentation of compatibility status
- A review of all configuration options, renaming some for consistency
- Consistent logging
- A documented policy for how long each Spark version will be supported
- A documented process for preventing major performance regressions
- A documented semantic-versioning policy and what it means for Comet going forward

[issue #4082]: https://github.com/apache/datafusion-comet/issues/4082

Correctness is central to that list: reaching 1.0.0 means being able to state precisely which Spark
expressions Comet accelerates, and how faithfully it matches Spark on each one. Two efforts in 0.17.0 move
toward that goal.

First, the codegen dispatcher guarantees an exact match for every dispatched expression, since Spark's own
generated code does the evaluation. That raises our confidence that Comet matches Spark across the supported
versions, and it makes the Spark Expression Support reference something the project can stand behind as it
approaches 1.0.0.

Second, this release included a systematic audit of Comet's existing expression implementations against Spark,
detailed below.

### Expression Audit

The audit compared Comet's expression implementations against Apache Spark 3.4.3, 3.5.8, 4.0.1, and 4.1.1,
covering the hash, JSON, collection, map, predicate, bitwise, conditional, array, struct, math, and cast
expression families, along with cast behavior. Each audit compared Comet's behavior to Spark across all four
versions and expanded test coverage where gaps were found.

This edge-case-by-edge-case comparison surfaced most of the behavior differences fixed in this
release. By working through each expression's corner cases and writing targeted Comet SQL tests for them, the
audit caught divergences that broader testing does not reliably exercise. Comet also runs the full Apache
Spark SQL test suite against each supported Spark version as part of CI, which continues to catch some
cross-version differences, but the audit's focused approach found considerably more.

## Compatibility

Supported platforms include:

- **Spark 3.4.3** with Java 11/17 and Scala 2.12/2.13
- **Spark 3.5.8** with Java 11/17 and Scala 2.12/2.13
- **Spark 4.0.2** with Java 17 and Scala 2.13
- **Spark 4.1.2** with Java 17 and Scala 2.13

See the [Spark Version Compatibility] page for known limitations specific to each version.

[Spark Version Compatibility]: https://datafusion.apache.org/comet/user-guide/latest/compatibility/spark-versions.html

This release builds on **DataFusion 53.1** and **Arrow 58.3**.

## Get Started with Comet 0.17.0

Ready to try it out? Follow the [Comet 0.17.0 Installation Guide](https://datafusion.apache.org/comet/user-guide/0.17/installation.html)
to get up and running, then point Comet at your existing Spark workloads, including Scala and Java UDFs and
Spark 4 with ANSI mode enabled, and see the speedup for yourself.
