---
layout: post
title: Apache DataFusion Comet 0.15.0 Release
date: 2026-04-18
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

The Apache DataFusion PMC is pleased to announce version 0.15.0 of the [Comet](https://datafusion.apache.org/comet/) subproject.

Comet is an accelerator for Apache Spark that translates Spark physical plans to DataFusion physical plans for
improved performance and efficiency without requiring any code changes.

This release covers approximately four weeks of development work and is the result of merging 142 PRs from 19
contributors. See the [change log] for more information.

[change log]: https://github.com/apache/datafusion-comet/blob/main/dev/changelog/0.15.0.md

## Performance

**Comet provides a 2x speedup for TPC-H @ 1TB, resulting in 50% cost savings.**

That 2x speedup gives you a choice: finish the same Spark workload in half the time on the cluster you already
have, or match your current Spark performance on roughly half the resources. Either way, the gain translates
directly into lower cloud bills, reduced on-prem capacity, and lower energy usage, with no changes to your
existing Spark SQL, DataFrame, or PySpark code. Comet runs on commodity hardware: no GPUs, FPGAs, or other
specialized accelerators are required, so the savings come from better utilization of the infrastructure you
already run on.

<img
src="/blog/images/comet-0.15.0/tpch_allqueries.png"
width="100%"
class="img-fluid"
alt="TPC-H Overall Performance"
/>

<img
src="/blog/images/comet-0.15.0/tpch_queries_compare.png"
width="100%"
class="img-fluid"
alt="TPC-H Query-by-Query Comparison"
/>

See the [Comet Benchmarking Guide](https://datafusion.apache.org/comet/contributor-guide/benchmarking.html) for
more details.

## Key Features

### Native Iceberg Reader Enabled by Default

This release marks a major milestone for Iceberg users: **Comet's fully-native Iceberg reader is now enabled by
default**. Workloads that read Iceberg tables will automatically benefit from native Rust-based scans built on
iceberg-rust, with no additional configuration required.

To support this change, the release bundles a broad set of Iceberg-focused improvements:

- **Correct classloader handling**: Iceberg classes are now loaded via the thread context classloader, resolving
  class-loading issues in environments where the executor classloader differs from the application classloader.
- **Continuous Iceberg CI**: Iceberg Spark integration tests now run on every PR and push to `main`, providing
  continuous validation of the native Iceberg code path. Test diffs for Spark 3.4 were updated to keep the matrix
  green across supported Spark versions.
- **iceberg-rust upgrade**: Comet picks up the latest iceberg-rust, pulling in fixes for Parquet reader edge cases
  discovered in earlier testing.
- **Refreshed documentation**: The Iceberg user guide has been rewritten to reflect current capabilities, and the
  contributor guide now documents how to run the Iceberg Spark test suites locally.

Users who need to fall back to the previous behavior can still opt out, but we encourage the community to exercise
the native reader and report any issues.

### Auto Mode Enables `native_datafusion` Scan

The `auto` scan mode now enables the `native_datafusion` scan where supported, giving users the benefits of the
native Parquet reader without having to explicitly opt in. This is part of the ongoing effort to make
`native_datafusion` the default Parquet path once the deprecation of `native_iceberg_compat` completes.

### New Expressions and Function Support

This release adds support for the following:

- **Date/time functions**: `days`, `hours`, `date_from_unix_date`
- **String/JSON functions**: native `get_json_object` with improved performance over the fallback path
- **Hash/math functions**: `crc32c`, `bin`
- **Array functions**: `sort_array`
- **Window functions**: `LEAD` and `LAG` with `IGNORE NULLS`
- **Aggregates**: SQL `FILTER (WHERE ...)` clauses now execute natively; `Corr` aggregate enabled

### Expanded Metrics and Observability

Comet metrics can now be exposed through Spark's external monitoring system, making it easier to integrate Comet
execution statistics with existing observability dashboards. Native DataFusion scans also now report accurate
`filesScanned` and `bytesScanned` input metrics, matching Spark's native Parquet scan reporting.

## Performance Improvements

Performance was a major theme of this release, with a series of targeted optimizations across the shuffle, scan,
and execution layers:

- **Shuffle read path**: The native shuffle reader no longer uses FFI on the read side, removing a per-batch cost
  that was particularly visible in shuffle-heavy queries.
- **Broadcast exchanges**: Batches are now coalesced before broadcasting, reducing the number of small batches
  crossing the JVM/native boundary.
- **Columnar-to-row (C2R)**: Native C2R conversion is now exercised for a broader set of query shapes.
- **FFI-safe operators**: More operators are marked as FFI-safe, avoiding unnecessary deep copies when crossing
  the JVM/native boundary.
- **Shared memory pools**: Unified memory pools are now shared across native execution contexts within a Spark
  task, improving memory accounting and reducing fragmentation.
- **Object store caching**: Object stores and bucket region lookups are cached, dramatically reducing DNS query
  volume on workloads that open many files.
- **`get_ranges` performance**: Picked up an upstream `opendal` fix that restores fast range reads from object
  storage.
- **Spill I/O**: Removed a redundant `BufReader` wrapper when copying spill files to shuffle output.

Together, these changes reduce CPU and memory overhead for shuffle-heavy, broadcast-heavy, and
object-storage-bound workloads.

## Stability and Correctness

A significant portion of this release is dedicated to stability and Spark compatibility. Highlights include:

- **Cast string to timestamp**: Multiple fixes for UTC timestamps, timezone handling, special formats
  (`epoch`, `now`, etc.), and compatibility with Spark's semantics.
- **Cast decimal to string**: Added legacy mode handling to match Spark's output formatting.
- **String to decimal**: Support for full-width characters, null characters, and negative scale.
- **Decimal arithmetic**: Fixes for decimal division and additional test coverage for ANSI overflow handling,
  including scalar decimal overflow.
- **Array expressions**: Corrected `GetArrayItem` null handling for dynamic indices; `array_append` return type
  fixed and marked `Compatible`; audited `array_insert` for correctness; `array_compact` marked `Compatible`;
  array-to-array cast enabled.
- **DateTrunc/TimestampTrunc**: Fixed native crashes when the input is a literal.
- **Ambiguous local times**: Correct handling of ambiguous and non-existent local times across DST transitions.
- **Case-insensitive Parquet fields**: `native_datafusion` now correctly detects duplicate/ambiguous fields in
  case-insensitive mode and falls back where appropriate.
- **Shuffle planning**: Shuffle fallback decisions are now "sticky" across planning passes, and Comet columnar
  shuffle is skipped for stages containing DPP scans to avoid mismatched partitioning.
- **Error propagation**: Native error messages are now propagated through `SparkException` even when the
  `errorClass` is empty, and file-not-found errors flow through the standard Spark error JSON path.
- **Trigonometric compatibility**: `tan` and `atan2` are now Spark-compatible.

## Dependency Upgrades

This release upgrades to **DataFusion 53.1** and **Arrow 58.1**, and picks up the latest `iceberg-rust` release
with additional reader fixes. The `jni` crate was upgraded to 0.22.4.

## Deprecations and Removals

The `SupportsComet` interface has been removed, along with the Java-based Iceberg integration path (which is
fully superseded by the native Iceberg reader). The `native_iceberg_compat` scan remains deprecated and is
expected to be removed in a future release in favor of `native_datafusion`.

## Compatibility

Supported platforms include Spark 3.4.3, 3.5.4–3.5.8, and Spark 4.0.x with various JDK and Scala combinations.

The community encourages users to test Comet with existing Spark and Iceberg workloads and welcomes contributions
to ongoing development.
