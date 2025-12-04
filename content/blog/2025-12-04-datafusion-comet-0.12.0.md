---
layout: post
title: Apache DataFusion Comet 0.12.0 Release
date: 2025-12-04
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

The Apache DataFusion PMC is pleased to announce version 0.12.0 of the [Comet](https://datafusion.apache.org/comet/) subproject.

Comet is an accelerator for Apache Spark that translates Spark physical plans to DataFusion physical plans for
improved performance and efficiency without requiring any code changes.

This release covers approximately four weeks of development work and is the result of merging 105 PRs from 13
contributors. See the [change log] for more information.

[change log]: https://github.com/apache/datafusion-comet/blob/main/dev/changelog/0.12.0.md

## Release Highlights

### Experimental Native Apache Iceberg Scan Support

Comet has a new, experimental, [native Iceberg scan](https://github.com/apache/datafusion-comet/pull/2528). This work relies on [iceberg-rust](https://github.com/apache/iceberg-rust) and the Parquet reader from [arrow-rs](https://github.com/apache/arrow-rs) that Comet already uses to great effect. Comet’s [existing Iceberg integration](https://datafusion.apache.org/comet/user-guide/0.12/iceberg.html) relies on a modified Iceberg Java build to accelerate Parquet decoding. This new approach allows unmodified Iceberg Java to handle query planning (*i.e.*, catalog access, partition pruning, etc.), then Comet serializes Iceberg `FileScanTask` objects directly to iceberg-rust, enabling native execution of Iceberg table scans through DataFusion.

This represents a significant step forward in Comet's support for data lakehouse architectures and expands the range of workloads that can benefit from native acceleration. Please take a look at the PR and Comet’s documentation to understand the current limitations and try it on your workloads! We are eager for feedback on this approach.

### Code Architecture Improvements

This release includes significant refactoring to improve code maintainability and extensibility, and we will continue those efforts into 0.13.0 development:

- **Unified operator serialization**: The [CometExecRule refactor](https://github.com/apache/datafusion-comet/pull/2768) unifies CometNativeExec creation with serialization through the new `CometOperatorSerde` trait
- **Expression serde refactoring**: Multiple PRs ([#2738](https://github.com/apache/datafusion-comet/pull/2738), [#2741](https://github.com/apache/datafusion-comet/pull/2741), [#2791](https://github.com/apache/datafusion-comet/pull/2791)) moved expression serialization logic out of `QueryPlanSerde` into specialized traits
- **Aggregate expression improvements**: [Added getSupportLevel to CometAggregateExpressionSerde trait](https://github.com/apache/datafusion-comet/pull/2777) for better aggregate function handling

These architectural improvements make it easier for contributors to add new operators and expressions while reducing code complexity.

### New SQL Functions

The following SQL functions are now supported:

- [`concat`](https://github.com/apache/datafusion-comet/pull/2604) - String concatenation
- [`abs`](https://github.com/apache/datafusion-comet/pull/2689) - Absolute value
- [`sha1`](https://github.com/apache/datafusion-comet/pull/2471) - SHA-1 hash function
- [`cot`](https://github.com/apache/datafusion-comet/pull/2755) - Cotangent function
- [Hyperbolic trigonometric functions](https://github.com/apache/datafusion-comet/pull/2784) - sinh, cosh, tanh, and their inverse functions

### New Operators

- [`CometLocalTableScanExec`](https://github.com/apache/datafusion-comet/pull/2735) - Native support for local table scans, eliminating fallback to Spark for small, in-memory datasets

### Configuration and Usability Improvements

- **Simplified on-heap configuration**: [Simplified on-heap memory configuration](https://github.com/apache/datafusion-comet/pull/2599) for easier setup
- **Extended explain format**: [Renamed and improved COMET_EXTENDED_EXPLAIN_FORMAT](https://github.com/apache/datafusion-comet/pull/2644) with better defaults
- **Environment variable support**: [Improved framework for setting configs with environment variables](https://github.com/apache/datafusion-comet/pull/2722)
- **Native config passing**: [All Comet configs now passed to native plan](https://github.com/apache/datafusion-comet/pull/2801)
- **Config categorization**: [Categorized testing configs](https://github.com/apache/datafusion-comet/pull/2740) and added notes about known timezone issues
- **Removed legacy configs**: [Removed COMET_EXPR_ALLOW_INCOMPATIBLE config](https://github.com/apache/datafusion-comet/pull/2786) to simplify configuration

### Bug Fixes

This release includes numerous bug fixes:

- [Fixed None.get in stringDecode](https://github.com/apache/datafusion-comet/pull/2606) when binary child cannot be converted
- [Proper fallback for lpad/rpad with unsupported arguments](https://github.com/apache/datafusion-comet/pull/2630)
- [Fixed trunc/date_trunc with unsupported format strings](https://github.com/apache/datafusion-comet/pull/2634)
- [Corrected single partition handling in native_datafusion](https://github.com/apache/datafusion-comet/pull/2675)
- [Fixed LeftSemi join handling](https://github.com/apache/datafusion-comet/pull/2687) - do not replace SMJ with HJ
- [Fixed CometLiteral class cast exception with arrays](https://github.com/apache/datafusion-comet/pull/2718)
- [Fixed missing SortOrder fallback reason in range partitioning](https://github.com/apache/datafusion-comet/pull/2716)
- [Improved checkSparkMaybeThrows to compare results in success case](https://github.com/apache/datafusion-comet/pull/2728)
- [Fixed null handling in CometVector implementations](https://github.com/apache/datafusion-comet/pull/2643)

### Documentation Improvements

- [Added FFI documentation to contributor guide](https://github.com/apache/datafusion-comet/pull/2668)
- [Updated contributor guide for adding new expressions](https://github.com/apache/datafusion-comet/pull/2704) and [operators](https://github.com/apache/datafusion-comet/pull/2758)
- [Improved documentation layout](https://github.com/apache/datafusion-comet/pull/2587) and [navigation](https://github.com/apache/datafusion-comet/pull/2597)
- [Added prettier enforcement](https://github.com/apache/datafusion-comet/pull/2783) for consistent markdown formatting
- [CI check to ensure generated docs are in sync](https://github.com/apache/datafusion-comet/pull/2779)
- Various documentation updates for [SortOrder expressions](https://github.com/apache/datafusion-comet/pull/2694), [LocalTableScan and WindowExec](https://github.com/apache/datafusion-comet/pull/2742), and [Spark SQL tests](https://github.com/apache/datafusion-comet/pull/2712)

### Dependency Updates

- [Upgraded to Spark 3.5.7](https://github.com/apache/datafusion-comet/pull/2574)
- [Upgraded to DataFusion 50.3.0](https://github.com/apache/datafusion-comet/pull/2605)
- [Upgraded Parquet from 56.0.0 to 56.2.0](https://github.com/apache/datafusion-comet/pull/2608)
- Various other dependency updates via Dependabot

### Spark Compatibility

- Spark 3.4.3 with JDK 11 & 17, Scala 2.12 & 2.13
- Spark 3.5.4 through 3.5.7 with JDK 11 & 17, Scala 2.12 & 2.13
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
