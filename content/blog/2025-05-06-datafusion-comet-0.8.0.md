---
layout: post
title: Apache DataFusion Comet 0.8.0 Release
date: 2025-05-06
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

The Apache DataFusion PMC is pleased to announce version 0.8.0 of the [Comet](https://datafusion.apache.org/comet/) subproject.

Comet is an accelerator for Apache Spark that translates Spark physical plans to DataFusion physical plans for
improved performance and efficiency without requiring any code changes.

This release covers approximately SIX weeks of development work and is the result of merging 81 PRs from 11
contributors. See the [change log] for more information.

[change log]: https://github.com/apache/datafusion-comet/blob/main/dev/changelog/0.8.0.md

## Release Highlights

### Performance & Stability

- Up to 4x speedup in jobs using `dropDuplicates`, thanks to optimizations in the `first_value` and `last_value`
  aggregate functions in DataFusion 47.0.0.
- Introduction of a global Tokio runtime, which resolves potential deadlocks in certain multi-task scenarios.

## Native Shuffle Improvements

Significant enhancements to the native shuffle mechanism include:

- Lower memory usage through using `interleave_record_batches` instead of using array builders.
- Support for complex types in shuffle data (note: hash partition expressions still require primitive types).
- Reclaimable shuffle files, reducing disk pressure.
- Respects `spark.local.dir` for temporary storage.
- Per-task shuffle metrics are now available, providing better visibility into execution behavior.

## Experimental Support for DataFusion’s Parquet Scan

It is now possible to configure Comet to use DataFusion’s Parquet reader instead of Comet’s current Parquet reader. This
has the advantage of supporting complex types, and also has performance optimizations that are not present in Comet's
existing reader.

This release continues with the ongoing improvements and bug fixes and supports more use cases, but there are still
some known issues:

- There are schema coercion bugs for nested types containing INT96 columns, which can cause incorrect results.
- There are compatibility issues when reading integer values that are larger than their type annotation, such as the
  value 1024 being stored in a field annotated as int(8).
- A small number of Spark SQL tests remain unsupported ([#1545](https://github.com/apache/datafusion-comet/issues/1545)).

To enable DataFusion’s Parquet reader, either set `spark.comet.scan.impl=native_datafusion` or set the environment
variable `COMET_PARQUET_SCAN_IMPL=native_datafusion`.

## Updates to Supported Spark Versions

- Added support for Spark 3.5.5
- Dropped support for Spark 3.3.x

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
