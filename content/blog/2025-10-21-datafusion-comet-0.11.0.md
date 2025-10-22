---
layout: post
title: Apache DataFusion Comet 0.11.0 Release
date: 2025-10-21
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

The Apache DataFusion PMC is pleased to announce version 0.11.0 of the [Comet](https://datafusion.apache.org/comet/) subproject.

Comet is an accelerator for Apache Spark that translates Spark physical plans to DataFusion physical plans for
improved performance and efficiency without requiring any code changes.

This release covers approximately five weeks of development work and is the result of merging 131 PRs from 15
contributors. See the [change log] for more information.

[change log]: https://github.com/apache/datafusion-comet/blob/main/dev/changelog/0.11.0.md

## Release Highlights

### Parquet Modular Encryption Support

Spark supports Parquet Modular Encryption to independently encrypt column values and metadata. Furthermore, Spark supports custom encryption factories for users to provide their own key-management service (KMS) implementations. Thanks to [a](https://github.com/apache/arrow-rs/issues/7278) [number](https://github.com/apache/datafusion/issues/15216) [of](https://github.com/apache/datafusion/pull/16351) [contributions](https://github.com/apache/datafusion/pull/16779) in upstream DataFusion and arrow-rs, Comet now [supports Parquet Modular Encryption with Spark KMS](https://github.com/apache/datafusion-comet/pull/2447) for native readers, enabling secure reading of encrypted Parquet files in production environments.

### Improved Memory Management

Comet 0.11.0 introduces significant improvements to memory management, making it easier to deploy and more resilient to out-of-memory conditions:

- **Changed default memory pool**: The default off-heap memory pool has been [changed from `greedy_unified` to `fair_unified`](https://github.com/apache/datafusion-comet/pull/2526), providing better memory fairness across operations
- **Off-heap deployment recommended**: To simplify configuration and improve performance, Comet now expects to be deployed with Spark's off-heap memory configuration. [On-heap memory is still available](https://github.com/apache/datafusion-comet/pull/2554) for development and debugging, but is not recommended for deployment
- **Better disk management**: The [DiskManager `max_temp_directory_size` is now configurable](https://github.com/apache/datafusion-comet/pull/2479) for better control over temporary disk usage
- **Enhanced safety**: Memory pool operations now [use checked arithmetic operations](https://github.com/apache/datafusion-comet/pull/2455) to prevent overflow issues

These changes make Comet significantly easier to configure and deploy in production environments.

### Improved Apache Spark 4.0 Support

Comet has improved its support for Apache Spark 4.0.1 with several important enhancements:

- [Updated support from Spark 4.0.0 to Spark 4.0.1](https://github.com/apache/datafusion-comet/pull/2414)
- [Spark 4.0 is now included in the release build script](https://github.com/apache/datafusion-comet/pull/2514)
- Expanded ANSI mode compatibility with several new implementations:
  - [ANSI evaluation mode arithmetic operations](https://github.com/apache/datafusion-comet/pull/2136)
  - [ANSI mode integral divide](https://github.com/apache/datafusion-comet/pull/2421)
  - [ANSI mode rounding functions](https://github.com/apache/datafusion-comet/pull/2542)
  - [ANSI mode remainder function](https://github.com/apache/datafusion-comet/pull/2556)

Spark 4.0 compatible jar files are now available on Maven Central. See the [installation guide](https://datafusion.apache.org/comet/user-guide/0.11/installation.html#using-a-published-jar-file) for instructions on using published jar files.

### Complex Types for Columnar Shuffle

[ashdnazg](https://github.com/ashdnazg) submitted a [fantastic refactoring PR](https://github.com/apache/datafusion-comet/pull/2571) that simplified the logic for writing rows in Comet’s JVM-based, columnar shuffle. A benefit of this refactoring is better support for complex types (*e.g.,* structs, lists, and arrays) in columnar shuffle. Comet no longer falls back to Spark to shuffle these types, enabling native acceleration for queries involving nested data structures. This enhancement significantly expands the range of queries that can benefit from Comet's columnar shuffle implementation.

### RangePartitioning for Native Shuffle

Comet's native shuffle now [supports RangePartitioning](https://github.com/apache/datafusion-comet/pull/2258), providing better performance for operations that require range-based data distribution. Comet now matches Spark behavior for computing and distributing range boundaries, and serializes them to native execution for faster shuffle operations.

### New Functionality

The following SQL functions are now supported:

- [`weekday`](https://github.com/apache/datafusion-comet/pull/2411) - Extract day of week from date
- [`lpad`](https://github.com/apache/datafusion-comet/pull/2102) - Left pad a string with column support for pad length
- [`rpad`](https://github.com/apache/datafusion-comet/pull/2099) - Right pad a string with [column support and additional character support](https://github.com/apache/datafusion-comet/pull/2436)
- [`reverse`](https://github.com/apache/datafusion-comet/pull/2481) - Support for ArrayType input in addition to strings
- [`count(distinct)`](https://github.com/apache/datafusion-comet/pull/2429) - Native support without falling back to Spark
- [`bit_get`](https://github.com/apache/datafusion-comet/pull/2466) - Get bit value at position

New expression capabilities include:

- [Nested array literal support](https://github.com/apache/datafusion-comet/pull/2181)
- [Array-to-string cast support](https://github.com/apache/datafusion-comet/pull/2425)
- [Spark-compatible cast from integral to decimal types](https://github.com/apache/datafusion-comet/pull/2472)
- [Support for decimal type to boolean cast](https://github.com/apache/datafusion-comet/pull/2490)
- [More date part expressions](https://github.com/apache/datafusion-comet/pull/2316)

### Performance Improvements

- [Improved BroadcastExchangeExec conversion](https://github.com/apache/datafusion-comet/pull/2417) for better broadcast join performance
- [Use of DataFusion's native `count_udaf`](https://github.com/apache/datafusion-comet/pull/2407) instead of `SUM(IF(expr IS NOT NULL, 1, 0))`
- [New configuration from shared conf](https://github.com/apache/datafusion-comet/pull/2402) to reduce overhead
- [Buffered index writes](https://github.com/apache/datafusion-comet/pull/2579) to reduce system calls in shuffle operations

### Comet 0.11.0 TPC-H Performance

Comet 0.11.0 continues to deliver significant performance improvements over Spark. In our [TPC-H benchmarks](https://github.com/apache/datafusion-comet/pull/2596), Comet reduced overall query runtime from 687 seconds to 302 seconds when processing 100 GB of Parquet data using a single 8-core executor, achieving a **2.2x speedup**.

![TPC-H Overall Performance](/images/comet-0.11.0/tpch_allqueries.png)

The performance gains are consistent across individual queries, with most queries showing substantial improvements:

![TPC-H Query-by-Query Comparison](/images/comet-0.11.0/tpch_queries_compare.png)

You can reproduce these benchmarks using our [Comet Benchmarking Guide](https://datafusion.apache.org/comet/contributor-guide/benchmarking.html). We encourage you to run your own performance tests with your workloads.

### Apache Iceberg Support

- [Updated support for Apache Iceberg 1.9.1](https://github.com/apache/datafusion-comet/pull/2386)
- [Additional Parquet-independent API improvements](https://github.com/apache/datafusion-comet/pull/2442) for Iceberg integration
- [Improved resource management](https://github.com/apache/datafusion-comet/pull/2510) in Iceberg reader instances

### UX Improvements

- [Added plan conversion statistics to extended explain info](https://github.com/apache/datafusion-comet/pull/2412) for better observability
- [Improved fallback information](https://github.com/apache/datafusion-comet/pull/2450) to help users understand when and why Comet falls back to Spark
- [Added `backtrace` feature](https://github.com/apache/datafusion-comet/pull/2515) to simplify enabling native backtraces in `CometNativeException`
- [Native log level is now configurable](https://github.com/apache/datafusion-comet/pull/2379) via Comet configuration

### Bug Fixes

- [Resolved issues with reused broadcast plans in non-AQE mode](https://github.com/apache/datafusion-comet/pull/2398)
- [Fixed thread safety in setNumPartitions](https://github.com/apache/datafusion-comet/pull/2420)
- [Improved error handling when resolving S3 bucket region](https://github.com/apache/datafusion-comet/pull/2440)
- [Fixed byte array literal casting issues](https://github.com/apache/datafusion-comet/pull/2432)
- [Corrected subquery filter pushdown behavior for native_datafusion scan](https://github.com/apache/datafusion-comet/pull/2438)

### Documentation Updates

- [Updated documentation for native shuffle configuration and tuning](https://github.com/apache/datafusion-comet/pull/2487)
- [Added documentation for ANSI mode support](https://github.com/apache/datafusion-comet/pull/2496) in various functions
- [Improved EC2 benchmarking guide](https://github.com/apache/datafusion-comet/pull/2474)
- [Split configuration guide into different sections](https://github.com/apache/datafusion-comet/pull/2568) (scan, exec, shuffle, etc.) for better organization
- Various clarifications and improvements throughout the documentation

### Spark Compatibility

- Spark 3.4.3 with JDK 11 & 17, Scala 2.12 & 2.13
- Spark 3.5.4 through 3.5.6 with JDK 11 & 17, Scala 2.12 & 2.13
- Spark 4.0.1 with JDK 17, Scala 2.13

We are looking for help from the community to fully support Spark 4.0.1. See [EPIC: Support 4.0.0] for more information.

[EPIC: Support 4.0.0]: https://github.com/apache/datafusion-comet/issues/1637

## Getting Involved

The Comet project welcomes new contributors. We use the same [Slack and Discord] channels as the main DataFusion
project and have a weekly [DataFusion video call].

[Slack and Discord]: https://datafusion.apache.org/contributor-guide/communication.html#slack-and-discord
[DataFusion video call]: https://docs.google.com/document/d/1NBpkIAuU7O9h8Br5CbFksDhX-L9TyO9wmGLPMe0Plc8/edit?usp=sharing

The easiest way to get involved is to test Comet with your current Spark jobs and file issues for any bugs or
performance regressions that you find. See the [Getting Started] guide for instructions on downloading and installing
Comet.

[Getting Started]: https://datafusion.apache.org/comet/user-guide/installation.html

There are also many [good first issues] waiting for contributions.

[good first issues]: https://github.com/apache/datafusion-comet/contribute
