---
layout: post
title: Apache DataFusion Comet 1.0.0 Release
date: 2026-07-31
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

This is a major milestone. Comet began as a code donation in early 2024 and has shipped steadily ever since,
one release at a time. Version 1.0.0 marks the point where the project is mature enough to commit to a stable
release line: broad Apache Spark coverage, ANSI SQL semantics, native Parquet and Iceberg scans, and a native
shuffle, all validated continuously against Spark's own test suites. This release covers roughly six weeks of
development since 0.17.0 and is the result of merging over 140 PRs from 19 contributors. See the
[change log] for more information.

[change log]: https://github.com/apache/datafusion-comet/blob/main/docs/source/changelog/1.0.0.md

## What 1.0 Means

Reaching 1.0 is less about any single new feature than about the accumulated maturity of the project:

- **Broad Spark coverage.** Comet supports Apache Spark 3.4.3, 3.5.8, 4.0.2, and 4.1.1 out of the same
  codebase, with dedicated Maven profiles, shim sources, and CI matrices for each.
- **ANSI SQL by default.** Spark 4 enables ANSI semantics by default. Comet implements ANSI behavior for the
  expressions it supports natively, including arithmetic overflow checks, ANSI cast behavior, and `try_*`
  variants, so ANSI workloads keep accelerating rather than falling back.
- **A correctness harness, not just unit tests.** Comet runs the full Apache Spark SQL test suite through its
  native execution path against every supported Spark version. Running Spark's own correctness tests is what
  surfaces semantic shifts before they reach user workloads, and it is the foundation of the confidence behind
  a 1.0 release.
- **A stable release line going forward.** With 1.0, the project commits to semantic versioning. The very
  first deprecations under that policy are announced in this release (see [Deprecation Notice](#deprecation-notice)
  below).

The rest of this post covers what is new since 0.17.0.

## Native Expression Performance

A large share of this release is dedicated to making Comet's native scalar expressions faster. These kernels
run per-row or per-batch, so improvements here compound across every query that uses them:

- **`get_json_object`** ([#4907](https://github.com/apache/datafusion-comet/pull/4907)): roughly 4x faster.
- **`regexp_extract`** ([#4894](https://github.com/apache/datafusion-comet/pull/4894)) and **`parse_url`**
  ([#4893](https://github.com/apache/datafusion-comet/pull/4893)): optimized regex and URL parsing paths.
- **Casts**: a faster floating-point-to-decimal cast
  ([#4940](https://github.com/apache/datafusion-comet/pull/4940)), an optimized integer-to-integer cast
  ([#4920](https://github.com/apache/datafusion-comet/pull/4920)), and shared no-overflow fast paths in
  `CheckOverflow` ([#4937](https://github.com/apache/datafusion-comet/pull/4937)) and
  `DecimalRescaleCheckOverflow` ([#4938](https://github.com/apache/datafusion-comet/pull/4938)).
- **String and array kernels**: `lpad` ([#4919](https://github.com/apache/datafusion-comet/pull/4919)),
  `unhex` ([#4876](https://github.com/apache/datafusion-comet/pull/4876)),
  `size` ([#4877](https://github.com/apache/datafusion-comet/pull/4877)),
  `arrays_overlap` ([#4906](https://github.com/apache/datafusion-comet/pull/4906)),
  `escape_string` ([#4902](https://github.com/apache/datafusion-comet/pull/4902)), and the
  `try_*` arithmetic kernel ([#4910](https://github.com/apache/datafusion-comet/pull/4910)).

To make this kind of work repeatable, the release also adds a
[scalar expression optimization guide](https://github.com/apache/datafusion-comet/pull/4933) documenting how
to benchmark a kernel, keep its output bit-identical to Spark, and gate changes on a no-regression check.

On the scan side, Parquet reads pick up several improvements: full Parquet metadata (including the page index)
is now cached via DataFusion's `CachedParquetFileReaderFactory`
([#4707](https://github.com/apache/datafusion-comet/pull/4707)), identity casts are unwrapped in the schema
adapter so Parquet statistics pruning can engage
([#4730](https://github.com/apache/datafusion-comet/pull/4730)), and filter pushdown configuration has been
revised ([#4722](https://github.com/apache/datafusion-comet/pull/4722)).

## New Expression and Aggregate Support

This release expands the set of Spark expressions and aggregates that run natively:

- **Aggregates**: `approx_percentile` / `percentile_approx`
  ([#4801](https://github.com/apache/datafusion-comet/pull/4801)) and exact `percentile` / `median`
  ([#4542](https://github.com/apache/datafusion-comet/pull/4542)).
- **Grouping**: `grouping()` and `grouping_id()` indicator functions
  ([#4815](https://github.com/apache/datafusion-comet/pull/4815)).
- **Intervals**: interval types with `make_ym_interval` and `make_dt_interval`
  ([#4541](https://github.com/apache/datafusion-comet/pull/4541)).
- **String**: `base64` ([#4778](https://github.com/apache/datafusion-comet/pull/4778)) and `split_part` via
  `StringSplitSQL` ([#4592](https://github.com/apache/datafusion-comet/pull/4592)).
- **Array / map**: `array_prepend` ([#4716](https://github.com/apache/datafusion-comet/pull/4716)),
  `size()` for `MapType` ([#4580](https://github.com/apache/datafusion-comet/pull/4580)), `ElementAt` over
  `MapType` ([#4697](https://github.com/apache/datafusion-comet/pull/4697)), and removal of the constraint on
  arrays of nested elements ([#4714](https://github.com/apache/datafusion-comet/pull/4714)).
- **Date/time**: native `TimestampNTZ` inputs for `hour` / `minute` / `second`
  ([#4753](https://github.com/apache/datafusion-comet/pull/4753)) and
  `PreciseTimestampConversion` for native time-window grouping
  ([#4784](https://github.com/apache/datafusion-comet/pull/4784)).
- **Windows**: extended native window function support
  ([#4209](https://github.com/apache/datafusion-comet/pull/4209)) and Spark 4 decimal window average
  ([#4749](https://github.com/apache/datafusion-comet/pull/4749)).

## Experimental PyArrow UDF Support

This release adds experimental support for accelerated PyArrow UDFs
([#4234](https://github.com/apache/datafusion-comet/pull/4234)), allowing PyArrow-based user-defined functions
to participate in native execution instead of forcing a fallback to Spark. When the feature is disabled, Comet
now hints at the native PyArrow UDF path in its fallback reasons
([#4892](https://github.com/apache/datafusion-comet/pull/4892)) so users know the option exists. This is an
early-stage feature and we welcome feedback from users experimenting with it.

## Iceberg

- **Iceberg 1.11 support** ([#4840](https://github.com/apache/datafusion-comet/pull/4840)): adds support for
  Iceberg 1.11, audits the existing Iceberg diffs, bumps the iceberg-rust dependency, and adds a
  `run-iceberg-tests` CI trigger.
- **Delete-file correctness** ([#4760](https://github.com/apache/datafusion-comet/pull/4760)): the native scan
  now sizes Iceberg delete files correctly, avoiding dropped deletes.
- **Exchange-reuse correctness** ([#4812](https://github.com/apache/datafusion-comet/pull/4812)): fixed a case
  where Iceberg native scan exchange reuse with different pushed filters could produce wrong results.

## Native Parquet I/O and Cloud

- **gzip Parquet writes** ([#4930](https://github.com/apache/datafusion-comet/pull/4930)): native Parquet
  writes now support gzip compression.
- **Azure authentication** ([#4783](https://github.com/apache/datafusion-comet/pull/4783)): the native
  Parquet scan now supports Azure authentication, complementing the existing S3 credential support.

## Execution and Fallback Improvements

- **Mixed partial/final aggregation** ([#4861](https://github.com/apache/datafusion-comet/pull/4861)):
  `sum` and non-decimal `avg` can now run with the partial and final aggregation stages split across Spark and
  Comet, keeping more aggregation plans partially native.
- **Stage-based fallback** ([#4519](https://github.com/apache/datafusion-comet/pull/4519)): a more granular
  fallback mechanism that operates at the stage level.
- **Codegen dispatch for opt-in serdes** ([#4728](https://github.com/apache/datafusion-comet/pull/4728)):
  expressions reported as `Unsupported` can now route through JVM codegen dispatch for opt-in serdes, and
  native opt-in expressions surface as compatible-by-default with a `COMET-INFO` plan hint
  ([#4721](https://github.com/apache/datafusion-comet/pull/4721)).
- **Runtime cleanup** ([#4734](https://github.com/apache/datafusion-comet/pull/4734)): the Tokio runtime is
  now released on driver and executor exit.
- **Contrib scan SPI** ([#4700](https://github.com/apache/datafusion-comet/pull/4700)): a core SPI for
  contrib leaf scans (`CometScanWithPlanData`), the first part of splitting the Delta integration into a
  contrib module.

## Deprecation Notice

With the move to a stable 1.0 release line, Comet begins deprecating older platforms under semantic versioning
([#4857](https://github.com/apache/datafusion-comet/pull/4857)):

- **JDK 11** is deprecated and scheduled for removal in Comet 1.1.0.
- **Apache Spark 3.4** is deprecated and scheduled for removal in Comet 1.1.0.

Users on these platforms should plan to move to JDK 17+ and Spark 3.5 or later before upgrading to 1.1.0.

## Compatibility

Supported platforms include:

- **Spark 3.4.3** with Java 11/17 and Scala 2.12/2.13 (deprecated, removal in 1.1.0)
- **Spark 3.5.8** with Java 11/17 and Scala 2.12/2.13
- **Spark 4.0.2** with Java 17 and Scala 2.13
- **Spark 4.1.1** with Java 17 and Scala 2.13

See the [Spark Version Compatibility] page for known limitations specific to each version.

[Spark Version Compatibility]: https://datafusion.apache.org/comet/user-guide/latest/compatibility/spark-versions.html

This release upgrades to **DataFusion 54** and **Arrow 58.3**.

## Get Started with Comet 1.0.0

Ready to try it out? Follow the [Comet 1.0.0 Installation Guide](https://datafusion.apache.org/comet/user-guide/1.0/installation.html)
to get up and running, then point Comet at your existing Spark workloads and see the speedup for yourself.
