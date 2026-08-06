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

## The Road to 1.0

Comet was [donated] to the Apache DataFusion project in March 2024 and cut its first release, 0.1.0, five
months later with support for 13 operators and 106 expressions. Since then, the project has shipped 20
releases and drawn contributions from more than 120 developers, and the codebase now recognizes over 400
Spark expressions.

[donated]: https://datafusion.apache.org/blog/2024/03/06/comet-donation/

The 1.0 release marks the point at which Comet begins following semantic versioning. Users upgrading within
the 1.x line can expect backward-compatible changes only; features slated for removal will be deprecated in
a minor release before being dropped in the next major version. This is why the deprecations of JDK 11 and
Spark 3.4 announced below are scheduled for 1.1 rather than landing in 1.0 itself.

The rest of this section is a recap of the main advances since donation.

### Support for Spark 4.0+ with ANSI mode

Comet 1.0.0 supports Spark versions 3.4 though 4.1, with experimental support for 4.2. Comet fully supports Spark's ANSI mode, which is enabled by default starting with Spark 4.0.

### Correctness Testing

It is important that queries accelerated by Comet produce the same results as Spark. Correctness checking has always been a large effort in Comet development, but the approach has evolved over time.

- Comet has always run Spark's own test suite with Comet enabled, providing more than 24,000 unit tests effectively for free. These tests run in Comet's CI for all supported Spark versions.
- Scala tests: Comet has Scala tests that run queries end to end with Comet enabled vs disabled and ensure that the results match
- Fuzz testing: Many of the scala tests use a fuzz testing approach to generate randomized data that queries run against, helping to catch regressions around edge cases such as nulls, NaN, Infinity, and timezone issues
- Comet SQL Tests: In an effort to make it easier to write tests, Comet now provides a SQL-based testing approach that is inspired by sqllogictest
- Generative AI: More recently, Comet has taken advantage of agentic skills to perform audit sweeps of all expressions, comparing the implementation to Spark's source code and ensuring that Comet has tests covering all important edge cases

### Performance

The early Comet releases provided a very modest speedup and the published benchmark results were based on running TPC workloads at small scale factors on a single node. There are now independent benchmark results published by AWS Labs that show significant speedups for [TPC-DS @ 3TB running in EKS](https://awslabs.github.io/data-on-eks/docs/benchmarks/spark-datafusion-comet-benchmark).

### Codegen Dispatch

Comet 0.17.0 introduced a new approach to filling gaps in expression coverage. In earlier releases,
whenever Comet's planner encountered an expression that lacked a native Rust implementation, it fell back
to executing an entire subtree of the plan in Spark. That required converting Arrow columns back to Spark
rows before the expression ran and back to Arrow after, and the cost was often enough to erase the speedup
Comet had bought elsewhere in the plan.

Codegen dispatch scopes that fallback down to the expression itself: the batch stays in the Comet pipeline
and Comet invokes Spark's own generated code for just the missing expression, leaving the rest of the query
running natively. Three consequences are worth calling out.

- **Coverage.** Expressions that would previously have blocked native execution of a whole subtree are
  now supported immediately, without a Rust port. In 1.0, this pathway also handles cast fallbacks,
  several interval expressions, and additional string and timestamp functions.
- **Compatibility.** For categories where a native reimplementation would inevitably diverge from Spark's
  semantics — regular expressions being the canonical case, given the gap between Java's regex engine and
  any Rust or C++ equivalent — codegen dispatch delivers bit-for-bit Spark parity because it *is* Spark's
  implementation.
- **Scala and Java UDFs.** User-defined functions are compiled to the same codegen surface as built-in
  expressions, so they can flow through codegen dispatch without any change from the user. Queries that
  were previously disqualified from acceleration only because they contained a UDF can now benefit as
  long as the surrounding operators are supported. See the [Scala and Java UDF guide] for details.

[Scala and Java UDF guide]: https://datafusion.apache.org/comet/user-guide/latest/scala_java_udfs.html

## Improvements since 0.17.1

The rest of this post covers what is new since the 0.17.1 release.

### Experimental PyArrow UDF Support

This release adds experimental support for accelerated PyArrow UDFs, allowing PyArrow-based user-defined
functions to participate in native execution instead of forcing a fallback to Spark. When the feature is
disabled, Comet now hints at the native PyArrow UDF path in its fallback reasons so users know the option
exists. This is an early-stage feature and we welcome feedback from users experimenting with it.

### New Expression and Aggregate Support

This release expands the set of Spark expressions and aggregates that are accelerated by Comet:

- **Aggregates**: `approx_percentile` / `percentile_approx`, exact `percentile` / `median`,
  `approx_count_distinct`, and native `collect_list` / `array_agg`.
- **Cast**: Cast expressions where the native implementation is marked as incompatible or unsupported
  are now routed through codegen dispatch.
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

### Faster Parquet Scans

Parquet reads pick up several improvements as well. Full Parquet metadata, including the page index, is now
cached via DataFusion's `CachedParquetFileReaderFactory`; identity casts are unwrapped in the schema adapter
so Parquet statistics pruning can engage; filter pushdown configuration has been revised; the native scan
passes a metadata size hint so a single read usually captures the footer; and the native Parquet scan seeds
its reader options from the session config so Parquet settings you already set take effect.

### Iceberg Table Format V3

Comet now supports Iceberg 1.11 and Iceberg table format V3 (with native table decryption for V3 tables and
fallback to Spark for other V3 features). The native Iceberg scan supports the `_pos`, `_spec`, `_file`, and
`_partition` metadata columns, sizes delete files correctly to avoid dropped deletes, disambiguates scans that
share a `metadata_location`, and dedupes residuals and delete files in the native scan serde. A prior case
where Iceberg native scan exchange reuse with different pushed filters could produce wrong results is also

### Native Expression Performance

Many native expression implementations have been optimized to more efficiently leverage Arrow kernels or to avoid per-row builders.

- **Casts** between numeric, string, decimal, and date types, including a faster float-to-decimal cast, an
  optimized integer-to-integer cast, shared no-overflow fast paths in `CheckOverflow` and
  `DecimalRescaleCheckOverflow`, and a `cast_binary_to_string` that is up to 27x faster on binary-format
  styles.
- **JSON, regex, and URL parsing**: `get_json_object`, `regexp_extract`, and `parse_url`.
- **Date/time and decimal kernels**: `date_trunc`, `spark_ceil`, and a vectorized `spark_unscaled_value`.
- **String and array kernels**: `lpad`, `unhex`, `size`, `arrays_overlap`, `escape_string`, and the `try_*`
  arithmetic kernel.

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
