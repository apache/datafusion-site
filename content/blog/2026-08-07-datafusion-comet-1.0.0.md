---
layout: post
title: Apache DataFusion Comet 1.0.0 Release
date: 2026-08-07
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

The Apache DataFusion PMC is pleased to announce version 1.0.0 of the [Comet](https://datafusion.apache.org/comet/) subproject.

Comet is an accelerator for Apache Spark that translates Spark physical plans to DataFusion physical plans for
improved performance and efficiency without requiring any code changes.

This release covers roughly six weeks of development since 0.17.0 and consists of 244 commits from 23
contributors. See the [change log] for the full list of changes.

[change log]: https://github.com/apache/datafusion-comet/blob/main/docs/source/changelog/1.0.0.md

## What 1.0 Means

The 1.0.0 release is the culmination of more than two years of work since the project was [donated] as an
Apache DataFusion subproject in March 2024, and is less about any single new feature than about the
accumulated maturity of the project:

[donated]: https://datafusion.apache.org/blog/2024/03/06/comet-donation/

- **Broad Spark coverage.** Comet supports Apache Spark 3.4.3, 3.5.9, 4.0.4, and 4.1.3 out of the same
  codebase, with dedicated Maven profiles, shim sources, and CI matrices for each, plus an experimental
  Spark 4.2 profile for early evaluation. A published Spark version adoption and support-lifetime policy
  now states how long each Spark minor stays supported.
- **ANSI SQL by default.** Spark 4 enables ANSI semantics by default. Comet implements ANSI behavior for the
  expressions it supports natively, including arithmetic overflow checks, ANSI cast behavior, and `try_*`
  variants, so ANSI workloads keep accelerating rather than falling back.
- **A correctness harness, not just unit tests.** Comet runs the full Apache Spark SQL test suite through its
  native execution path against every supported Spark version. Running Spark's own correctness tests is what
  surfaces semantic shifts before they reach user workloads, and it is the foundation of the confidence behind
  a 1.0 release.
- **A stable release line going forward.** With 1.0, the project commits to semantic versioning. Because Comet
  is a plugin rather than a library, its configuration is its primary API surface, so `spark.comet.*` keys, an
  explicitly enumerated public Java and Scala API, and query results documented as Compatible are all part of
  the compatibility surface. Behavior changes in a minor release now require a `spark.comet.legacy.*` key that
  restores the previous behavior, and each release records its behavior changes in a user-facing upgrade
  guide. Correctness fixes are exempt from being treated as breaking changes. The first deprecations under
  that policy are announced in this release (see [Deprecation Notice](#deprecation-notice) below).
- **Documented limitations.** Every open correctness issue is now surfaced in the generated compatibility
  guide, down to the expression level, so you can see where Comet is known to diverge from Spark before you
  hit it in production rather than after.

The rest of this post covers what is new since 0.17.0.

## Native Expression Performance

A large share of this release is dedicated to making Comet's native scalar expressions faster. These kernels
run per-row or per-batch, so improvements here compound across every query that uses them. Expressions with
optimized implementations in this release include:

- **Casts** between numeric, string, decimal, and date types, including a faster float-to-decimal cast, an
  optimized integer-to-integer cast, shared no-overflow fast paths in `CheckOverflow` and
  `DecimalRescaleCheckOverflow`, and a `cast_binary_to_string` that is up to 27x faster on binary-format
  styles.
- **JSON, regex, and URL parsing**: `get_json_object`, `regexp_extract`, and `parse_url`.
- **Date/time and decimal kernels**: `date_trunc`, `spark_ceil`, and a vectorized `spark_unscaled_value`.
- **String and array kernels**: `lpad`, `unhex`, `size`, `arrays_overlap`, `escape_string`, and the `try_*`
  arithmetic kernel.

To make this kind of work repeatable, the release also adds a scalar expression optimization guide
documenting how to benchmark a kernel, keep its output bit-identical to Spark, and gate changes on a
no-regression check.

Parquet reads pick up several improvements as well. Full Parquet metadata, including the page index, is now
cached via DataFusion's `CachedParquetFileReaderFactory`; identity casts are unwrapped in the schema adapter
so Parquet statistics pruning can engage; filter pushdown configuration has been revised; the native scan
passes a metadata size hint so a single read usually captures the footer; and the native Parquet scan seeds
its reader options from the session config so Parquet settings you already set take effect.

Query planning and plan serialization also got cheaper. `QueryContext` SQL text is now interned into a
per-plan pool, which makes serialized plans up to 20x smaller on TPC-DS — every plan crosses the JNI
boundary, so this shrinks per-query overhead across the board. Plan-data injection is now an O(1) lookup by
operator kind and no longer rebuilds operators it does not touch. Comet also makes far fewer timer calls in
the native execution loop.

## Correctness

Correctness fixes have been a regular part of every Comet release, but for 1.0 we made an extra push to
clear out the bulk of the known issues before drawing a line under the stable release. This release fixes
roughly 30 divergences from Spark, spanning casts, ANSI error semantics, wrong-result bugs, string and
encoding handling, collations, and error reporting. Most were found by running extensive AI-assisted audit
sweeps of the code base, comparing Comet's expression implementations with all supported versions of Spark.
See the [change log] for the full list; two representative fixes give a sense of the shape of the work:

- **Whitespace trimming in string-to-numeric casts.** Casts to `boolean`, integral types, `float`/`double`,
  and `decimal` now use Spark's exact trim rules. Comet's kernels had used four different trim sets, three of
  them wrong, so results diverged in both directions — returning null where Spark parses a value, and
  returning a value where Spark returns null.
- **ANSI errors swallowed by null short-circuit.** The codegen dispatcher's null short-circuit no longer
  swallows errors Spark raises. Spark evaluates null-intolerant expressions per node and left to right, so
  short-circuiting on the union of input ordinals skipped subtrees Spark would have evaluated, losing their
  errors. Roughly 70 built-in expressions route through this dispatcher and ANSI is on by default in Spark 4,
  so this affected a wide surface.

Alongside the bug fixes, Comet also adds conservative fallbacks where native behavior could not be made to
match — decimal `SUM` / `AVG` over sliding window frames, `FromUnixTime` with a non-default format, and a
handful of others — and falls back for predicates and datetime expressions under non-default collations
rather than risking a wrong result.

## New Expression and Aggregate Support

This release expands the set of Spark expressions and aggregates that run natively:

- **Aggregates**: `approx_percentile` / `percentile_approx`, exact `percentile` / `median`,
  `approx_count_distinct`, and native `collect_list` / `array_agg`.
- **Grouping**: `grouping()` and `grouping_id()`.
- **Intervals**: interval types via `make_ym_interval` and `make_dt_interval`, `CalendarIntervalType`,
  `multiply_dt_interval`, and interval codegen dispatch for nested values and native shuffle.
- **String**: `base64`, `split_part` via `StringSplitSQL`, native `levenshtein`, and native `randstr` and
  `uuid` — both bit-for-bit compatible with Spark for a given seed.
- **Array / map**: `array_prepend`, the `shuffle()` array function, `size()` for `MapType`, and `ElementAt`
  over `MapType`.
- **Date/time**: native `TimestampNTZ` inputs for `hour` / `minute` / `second` and
  `PreciseTimestampConversion` for native time-window grouping.
- **Windows**: extended native window function support and Spark 4 decimal window average.

## Native Sampling

Spark's `SampleExec` now runs natively when sampling without replacement, covering `DataFrame.sample`, SQL
`TABLESAMPLE`, and `DataFrame.randomSplit`. The native operator ports Spark's `BernoulliCellSampler` on top of
`XorShiftRandom` and seeds per partition exactly as Spark does, so it selects the same rows for a given seed —
sampling stays reproducible whether or not Comet is enabled. Sampling with replacement still falls back to
Spark.

## Experimental PyArrow UDF Support

This release adds experimental support for accelerated PyArrow UDFs, allowing PyArrow-based user-defined
functions to participate in native execution instead of forcing a fallback to Spark. When the feature is
disabled, Comet now hints at the native PyArrow UDF path in its fallback reasons so users know the option
exists. This is an early-stage feature and we welcome feedback from users experimenting with it.

## Iceberg

Comet now supports Iceberg 1.11 and Iceberg table format V3 (with native table decryption for V3 tables and
fallback to Spark for other V3 features). The native Iceberg scan supports the `_pos`, `_spec`, `_file`, and
`_partition` metadata columns, sizes delete files correctly to avoid dropped deletes, disambiguates scans that
share a `metadata_location`, and dedupes residuals and delete files in the native scan serde. A prior case
where Iceberg native scan exchange reuse with different pushed filters could produce wrong results is also
fixed.

## Native Parquet I/O and Cloud

Native Parquet writes now support gzip compression, and the native Parquet scan supports Azure authentication,
complementing the existing S3 credential support.

## Execution and Fallback Improvements

- **Mixed partial/final aggregation.** `sum` and non-decimal `avg` can now run with the partial and final
  aggregation stages split across Spark and Comet, keeping more aggregation plans partially native.
- **Codegen dispatch for opt-in serdes.** Expressions reported as `Unsupported` can now route through JVM
  codegen dispatch for opt-in serdes, and native opt-in expressions surface as compatible-by-default with a
  `COMET-INFO` plan hint. Casts join this path: an incompatible or unsupported cast now runs Spark's own
  generated code inside the Comet pipeline instead of pulling the whole operator back to Spark, so one
  awkward cast no longer de-accelerates a query. `sort_array` under strict floating-point mode and `concat`
  under non-`UTF8_BINARY` collations opt in the same way.
- **JVM columnar-to-row by default.** Isolated benchmarking showed the native columnar-to-row converter is
  roughly 3.7x slower per row than the JVM implementation at the default batch size — and up to 15.7x slower
  for small batches — because of a fixed per-batch JNI and FFI cost, with no end-to-end benefit in TPC-DS
  runs. It is now disabled by default.
- **Clearer fallback reasons.** Unsupported scalar serde cases are reported in the support level,
  mixed-execution fallback messages name the incompatible aggregate functions, unsupported metadata column
  names appear in fallback reasons, and the spurious "WriteFilesExec is not supported" message is suppressed.
- **Expression coverage in extended explain.** The extended explain summary previously reported operator
  coverage but said nothing about expressions. It now ends with a line such as `Comet accelerated 14
  expressions (14 native, 1 codegen dispatch)`, so you can see how much of a plan's expression evaluation
  runs in native DataFusion kernels versus Spark's generated code inside the dispatcher.
- **Quieter logs and runtime cleanup.** Logging levels on frequent call sites have been lowered so Comet no
  longer floods executor logs at default settings, and the Tokio runtime is now released on driver and
  executor exit.

## Shuffle Improvements

- **Native shuffle memory cap.** A new `spark.comet.shuffle.maxBufferBytes` config caps native shuffle writer
  memory to bound worst-case usage.
- **Shuffle IPC schema encoding.** The IPC schema is now encoded once per writer instead of per block,
  cutting per-batch shuffle overhead.
- **BatchCoalescer bypass.** Shuffle bypasses the `BatchCoalescer` for batches that are already appropriately
  sized.
- **Single-partition shuffle.** A redundant concatenation layer has been removed from the single-partition
  path.

## Configuration Changes

Because configuration is Comet's primary API surface, 1.0 is the release where the naming gets cleaned up.
Every rename below registers the old key as an alias, so existing configurations keep working and log a
deprecation warning when an old key is read:

- **Unified shuffle prefix.** Shuffle configs were spread across four disjoint prefixes
  (`spark.comet.exec.shuffle.*`, `spark.comet.columnar.shuffle.*`, `spark.comet.native.shuffle.*`,
  `spark.comet.shuffle.*`). They now all live under `spark.comet.shuffle.*`, with `.jvm.` and `.native.`
  sub-namespaces matching the `spark.comet.shuffle.mode` value you already set.
- **Grouped explain configs.** The orphan explain-related configs are collected under a single
  `spark.comet.explain.*` prefix, and the PyArrow UDF config is renamed to `pyarrowUDF` for consistency.
- **`spark.comet.version`.** The loaded Comet build version is now exposed as a runtime config, so you can
  confirm which Comet a cluster is actually running with `spark.conf.get` or `SET`.
- **Removed dead configs.** The Parquet parallel-IO knobs, `spark.comet.use.lazyMaterialization`, and
  `spark.comet.exceptionOnDatetimeRebase` had no remaining effect and were misleading anyone tuning against
  them.
- **Removed async columnar shuffle.** The `spark.comet.columnar.shuffle.async.*` path was off by default and
  untested, and has been removed rather than carried into a stable release line.

## Documentation

The documentation received a substantial overhaul for 1.0: a design refresh of the docs site, versioned user
guides with captioned sidebar sections, and a set of accessibility and navigation fixes. The
supported-expressions page now shows how each expression is implemented — native, codegen dispatch, or hybrid
— generated from the planner itself rather than maintained by hand. An expanded tuning guide covers the
performance and memory configs that matter in practice, and there is an updated post-1.0 roadmap and a new
blog posts and talks page.

## Deprecation Notice

With the move to a stable 1.0 release line, Comet begins deprecating older platforms under semantic
versioning:

- **JDK 11** is deprecated and scheduled for removal in Comet 1.1.0.
- **Apache Spark 3.4** is deprecated and scheduled for removal in Comet 1.1.0.

Users on these platforms should plan to move to JDK 17+ and Spark 3.5 or later before upgrading to 1.1.0.

## Compatibility

Supported platforms include:

- **Spark 3.4.3** with Java 11/17 and Scala 2.12/2.13 (deprecated, removal in 1.1.0)
- **Spark 3.5.9** with Java 11/17 and Scala 2.12/2.13
- **Spark 4.0.4** with Java 17 and Scala 2.13
- **Spark 4.1.3** with Java 17/21 and Scala 2.13
- **Spark 4.2** with Java 17 and Scala 2.13 (experimental, for early evaluation only)

See the [Spark Version Compatibility] page for known limitations specific to each version.

[Spark Version Compatibility]: https://datafusion.apache.org/comet/user-guide/latest/compatibility/spark-versions.html

This release upgrades to **DataFusion 54.1** and **Arrow 58.4**.

## Get Started with Comet 1.0.0

Ready to try it out? Follow the [Comet 1.0.0 Installation Guide](https://datafusion.apache.org/comet/user-guide/1.0/installation.html)
to get up and running, then point Comet at your existing Spark workloads and see the speedup for yourself.
