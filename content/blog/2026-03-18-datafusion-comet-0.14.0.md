---
layout: post
title: Apache DataFusion Comet 0.14.0 Release
date: 2026-03-18
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

The Apache DataFusion PMC is pleased to announce version 0.14.0 of the [Comet](https://datafusion.apache.org/comet/) subproject.

Comet is an accelerator for Apache Spark that translates Spark physical plans to DataFusion physical plans for
improved performance and efficiency without requiring any code changes.

This release covers approximately eight weeks of development work and is the result of merging 189 PRs from 21
contributors. See the [change log] for more information.

[change log]: https://github.com/apache/datafusion-comet/blob/main/dev/changelog/0.14.0.md

## Key Features

### Native Iceberg Improvements

Comet's fully-native Iceberg integration received several enhancements:

**Per-Partition Plan Serialization**: `CometExecRDD` now supports per-partition plan data, reducing serialization
overhead for native Iceberg scans and enabling dynamic partition pruning (DPP).

**Vended Credentials**: Native Iceberg scans now support passing vended credentials from the catalog, improving
integration with cloud storage services.

**Upstream Reader Performance Improvements**: The Comet team contributed a number of
[reader performance improvements](https://iceberg.apache.org/blog/apache-iceberg-rust-0.9.0-release/#reader-performance-improvements)
to iceberg-rust 0.9.0, which Comet now uses. These improvements benefit all iceberg-rust users.

**Performance Optimizations**:

- Single-pass `FileScanTask` validation for reduced planning overhead
- Configurable data file concurrency via `spark.comet.scan.icebergNative.dataFileConcurrencyLimit`
- Channel-based executor thread parking instead of `yield_now()` for reduced CPU overhead
- Reuse of `CometConf` and native utility instances in batch decoding

### Native Columnar-to-Row Conversion

Comet now uses a native columnar-to-row (C2R) conversion by default. This
feature replaces Comet's JVM-based columnar-to-row transition with a native Rust implementation, reducing JVM memory overhead
when data flows from Comet's native execution back to Spark operators that require row-based input.

### New Expressions

This release adds support for the following expressions:

- Date/time functions: `make_date`, `next_day`
- String functions: `right`, `string_split`, `luhn_check`
- Math functions: `crc32`
- Map functions: `map_contains_key`, `map_from_entries`
- Conversion functions: `to_csv`
- Cast support: date to timestamp, numeric to timestamp, integer to binary, boolean to decimal, date to numeric

### ANSI Mode Error Messages

ANSI SQL mode now produces proper error messages matching Spark's expected output, improving compatibility for
workloads that rely on strict SQL error handling.

### DataFusion Configuration Passthrough

DataFusion session-level configurations can now be set directly from Spark using the `spark.comet.datafusion.*`
prefix. This enables tuning DataFusion internals such as batch sizes and memory limits without modifying Comet code.

## Performance Improvements

This release includes extensive performance optimizations:

- **Sum aggregation**: Specialized implementations for each eval mode eliminate per-row mode checks
- **Contains expression**: SIMD-based scalar pattern search for faster string matching
- **Batch coalescing**: Reduced IPC schema overhead in `BufBatchWriter` by coalescing small batches
- **Tokio runtime**: Worker threads now initialize from `spark.executor.cores` for better resource utilization
- **Decimal expressions**: Optimized decimal arithmetic operations
- **Row-to-columnar transition**: Improved performance for JVM shuffle data conversion
- **Aligned pointer reads**: Optimized `SparkUnsafeRow` field accessors using aligned memory reads

## Deprecations and Removals

The deprecated `native_comet` scan mode has been removed. Use `native_datafusion` instead. Note 
that the `native_iceberg_compat` scan is now deprecated and will be removed from a future release. 

## Compatibility

This release upgrades to DataFusion 52.3, Arrow 57.3, and iceberg-rust 0.9.0. Published binaries now target
x86-64-v3 and neoverse-n1 CPU architectures for improved performance on modern hardware.

Supported platforms include Spark 3.4.3, 3.5.4-3.5.8, and Spark 4.0.x with various JDK and Scala combinations.

The community encourages users to test Comet with existing Spark workloads and welcomes contributions to ongoing development.
