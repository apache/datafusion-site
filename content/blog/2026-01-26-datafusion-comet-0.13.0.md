---
layout: post
title: Apache DataFusion Comet 0.13.0 Release
date: 2026-01-30
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

The Apache DataFusion PMC is pleased to announce version 0.13.0 of the [Comet](https://datafusion.apache.org/comet/) subproject.

Comet is an accelerator for Apache Spark that translates Spark physical plans to DataFusion physical plans for
improved performance and efficiency without requiring any code changes.

This release covers approximately eight weeks of development work and is the result of merging 160 PRs from 15
contributors. See the [change log] for more information.

[change log]: https://github.com/apache/datafusion-comet/blob/main/dev/changelog/0.13.0.md

## Key Features

### Native Parquet Write Support (Experimental)

This release introduces experimental native Parquet write capabilities, allowing Comet to intercept and execute Parquet write operations natively through DataFusion. Key capabilities include:

- File commit protocol support for reliable writes
- Remote HDFS writing via OpenDAL integration
- Complex type support (arrays, maps, structs)
- Proper handling of object store settings

To enable native Parquet writes, set:

```
spark.comet.allowIncompatibleOp.DataWritingCommandExec=true
spark.comet.parquet.write.enabled=true
```

**Note**: This feature is highly experimental and should not be used in production environments. It is currently categorized as a testing feature and is disabled by default.

### Native Iceberg Improvements

Comet's fully-native Iceberg integration received significant enhancements in this release:

**REST Catalog Support**: Native Iceberg scans now support REST catalogs, enabling integration with catalog services like Apache Polaris and Tabular. Configure with:

```shell
--conf spark.sql.catalog.rest_cat=org.apache.iceberg.spark.SparkCatalog
--conf spark.sql.catalog.rest_cat.catalog-impl=org.apache.iceberg.rest.RESTCatalog
--conf spark.sql.catalog.rest_cat.uri=http://localhost:8181
--conf spark.comet.scan.icebergNative.enabled=true
```

**Session Token Authentication**: Added support for session tokens in native Iceberg scans for secure S3 access.

**Performance Optimizations**:

- Deduplicated serialized metadata reducing memory overhead
- Switched from JSON to protobuf for partition value serialization
- Removed IcebergFileStream in favor of iceberg-rust's built-in parallelization
- Reduced metadata serialization points
- Added SchemaAdapter caching

To enable fully-native Iceberg scanning:

```
spark.comet.scan.icebergNative.enabled=true
```

The native reader supports Iceberg table spec v1 and v2, all primitive and complex types, schema evolution, time travel, positional and equality deletes, filter pushdown, and various storage backends (local, HDFS, S3).

### Native CSV Reading (Experimental)

Experimental support for native CSV file reading has been added, expanding Comet's file format capabilities beyond Parquet.

### New Expressions

The release adds support for numerous expressions:

- Array functions: `explode`, `explode_outer`, `size`
- Date/time functions: `unix_date`, `date_format`, `datediff`, `last_day`, `unix_timestamp`
- String functions: `left`
- JSON functions: `from_json` (partial support)

### ANSI Mode Support

Sum and average aggregate expressions now support ANSI mode for both integer and decimal inputs, enabling overflow checking in strict SQL mode.

### Native Shuffle Improvements

- Round-robin partitioning is now supported in native shuffle
- Spill metrics are now reported correctly
- Configurable shuffle writer buffer size via `spark.comet.shuffle.write.bufferSize`

## Performance Improvements

This release includes extensive performance optimizations:

- **String to integer casting**: Significant speedups through optimized parsing
- **String functions**: Optimized `lpad`/`rpad` to remove unnecessary memory allocations
- **Date operations**: Improved `normalize_nan` and date truncate performance
- **Query planning**: Cached query plans to avoid per-partition serialization overhead
- **Memory efficiency**: Reduced GC pressure in protobuf serialization
- **Hash operations**: Optimized complex-type hash implementations including murmur3 support for nested types
- **Runtime efficiency**: Eliminated busy-polling of Tokio stream for plans without CometScan
- **Metrics overhead**: Reduced timer and syscall overhead in native shuffle writer

## Deprecations

The `native_comet` scan mode is now deprecated in favor of `native_iceberg_compat` and will be removed in a future release. The `auto` scan mode no longer falls back to `native_comet`.

## Compatibility

This release upgrades to DataFusion 51, Arrow 57, and the latest iceberg-rust. The minimum supported Rust version is now 1.88.

Supported platforms include Spark 3.4.3, 3.5.4-3.5.7, and Spark 4.0.x with various JDK and Scala combinations.

The community encourages users to test Comet with existing Spark workloads and welcomes contributions to ongoing development.
