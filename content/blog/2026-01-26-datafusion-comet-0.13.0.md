---
layout: post
title: Apache DataFusion Comet 0.13.0 Release
date: 2026-01-26
author: pmc
categories: [subprojects]
---

The Apache DataFusion PMC has released version 0.13.0 of Comet, an accelerator for Apache Spark. This version represents approximately eight weeks of development work encompassing 169 merged pull requests from 15 contributors.

## Key Features

### Native Parquet Write Support (Experimental)

This release introduces experimental native Parquet write capabilities, allowing Comet to intercept and execute Parquet write operations natively through DataFusion. Key capabilities include:

- File commit protocol support for reliable writes
- Remote HDFS writing via OpenDAL integration
- Complex type support (arrays, maps, structs)
- Proper handling of object store settings

To enable native Parquet writes, set:

```
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

## Bug Fixes and Documentation

The release addresses issues including decimal modulus type mismatches, shuffle manager hang scenarios, native write fallbacks for non-Arrow inputs, and various Iceberg-related fixes. Documentation improvements include comprehensive guidance on native Iceberg scans, shuffle implementation details, datetime rebasing behavior, and common development pitfalls.

## Compatibility

This release upgrades to DataFusion 51, Arrow 57, and the latest iceberg-rust. The minimum supported Rust version is now 1.88.

Supported platforms include Spark 3.4.3, 3.5.4-3.5.7, and Spark 4.0.x with various JDK and Scala combinations.

The community encourages users to test Comet with existing Spark workloads and welcomes contributions to ongoing development.
