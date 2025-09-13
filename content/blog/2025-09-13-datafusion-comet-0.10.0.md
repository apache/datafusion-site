---
layout: post
title: Apache DataFusion Comet 0.10.0 Release
date: 2025-09-13
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

The Apache DataFusion PMC is pleased to announce version 0.10.0 of the [Comet](https://datafusion.apache.org/comet/) subproject.

Comet is an accelerator for Apache Spark that translates Spark physical plans to DataFusion physical plans for
improved performance and efficiency without requiring any code changes.

This release covers approximately ten weeks of development work and is the result of merging 183 PRs from 26
contributors. See the [change log] for more information.

[change log]: https://github.com/apache/datafusion-comet/blob/main/dev/changelog/0.10.0.md

## Release Highlights

### Improved Support for Apache Iceberg

It is now possible to use Comet with Apache Iceberg 1.8.1 to accelerate reads of Iceberg Parquet tables.

### Improved Spark 4.0.0 Support

Comet no longer falls back to Spark for all queries when ANSI mode is enabled (which is the default in Spark 4.0.0). 
Instead, Comet will now only fall back to Spark for arithmetic and aggregates expressions that support ANSI mode.

Setting `spark.comet.ansi.ignore=true` will override this behavior and force these expressions to continue to be 
accelerated by Comet. Full support for ANSI mode will be available in a future release.

Comet will now use the `native_iceberg_compat` scan for Spark 4.0.0 in most cases, which supports reading complex types.

### New Functionality

The following SQL functions are now supported:
 
- `array_min`
- `map_entries`
- `map_from_array`
- `randn`
- `from_unixtime`
- `monotonically_increasing_id`
- `spark_partition_id`
- `try_add`
- `try_divide`
- `try_mod`
- `try_multiply`
- `try_subtract`

Other new features include:

- Support for array literals
- Support for limit with offset

### UX Improvements

- Improved reporting of reasons why Comet cannot accelerate some operators and expressions
- New `spark.comet.logFallbackReasons.enabled` configuration setting for logging all fallback reasons
- CometScan nodes in the physical plan now show which scan implementation is being used (`native_comet`, 
`native_datafusion`, or `native_iceberg_compat`)

### Bug Fixes

- Improved memory safety for FFI transfers
- Fixed a double-free issue in the shuffle unified memory pool
- Non zero offset FFI issue
- Fixed HDFS buffer read issue 

### Benchmarking

Benchmarking scripts for benchmarks based on TPC-H and TPS-DS are now available in the repository under `dev/benchmarks`.

### Documentation Updates

- The documentation for supported [operators] and [expressions] is now more complete, and Spark-compatibility status 
  per operator/expression is now documented.
- The documentation now contains a [roadmap] section.
- New guide comparing Comet with Apache Gluten (incubating) + Velox
- User guides are now available for multiple Comet versions

[operators]: https://datafusion.apache.org/comet/user-guide/latest/operators.html
[expressions]: https://datafusion.apache.org/comet/user-guide/latest/expressions.html
[roadmap]: https://datafusion.apache.org/comet/contributor-guide/roadmap.html

### Spark Compatibility

- Spark 3.4.3 with JDK 11 & 17, Scala 2.12 & 2.13
- Spark 3.5.4 through 3.5.6 with JDK 11 & 17, Scala 2.12 & 2.13
- Experimental support for Spark 4.0.0 with JDK 17, Scala 2.13

We are looking for help from the community to fully support Spark 4.0.0. See [EPIC: Support 4.0.0] for more information.

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
