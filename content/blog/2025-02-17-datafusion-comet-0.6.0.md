---
layout: post
title: Apache DataFusion Comet 0.6.0 Release
date: 2025-02-17
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

The Apache DataFusion PMC is pleased to announce version 0.6.0 of the [Comet](https://datafusion.apache.org/comet/) subproject.

Comet is an accelerator for Apache Spark that translates Spark physical plans to DataFusion physical plans for
improved performance and efficiency without requiring any code changes.

Comet runs on commodity hardware and aims to provide 100% compatibility with Apache Spark. Any operators or
expressions that are not fully compatible will fall back to Spark unless explicitly enabled by the user. Refer
to the [compatibility guide] for more information.

[compatibility guide]: https://datafusion.apache.org/comet/user-guide/compatibility.html

This release covers approximately four weeks of development work and is the result of merging 39 PRs from 12
contributors. See the [change log] for more information.

Starting with this release, we now plan on releasing new versions of Comet more frequently, typically within 1-2 weeks
of each major DataFusion release. The main motivation for this change is to better support downstream Rust projects 
that depend on the [datafusion_comet_spark_expr] crate.

[datafusion_comet_spark_expr]: https://docs.rs/datafusion-comet-spark-expr/latest/datafusion_comet_spark_expr/

[change log]: https://github.com/apache/datafusion-comet/blob/main/dev/changelog/0.6.0.md

## Release Highlights

### DataFusion Upgrade

- Comet 0.6.0 uses DataFusion 45.0.0

### New Features

- Comet now supports `array_join`, `array_intersect`, and `arrays_overlap`.

### Performance & Stability

- Metrics from native execution are now updated in Spark every 3 seconds by default, rather than for each
  batch being processed. The mechanism for passing the metrics via JNI is also more efficient.
- New memory pool options "fair unified" and "unbounded" have been added. See the [Comet Tuning Guide] for more information.

[Comet Tuning Guide]: https://datafusion.apache.org/comet/user-guide/tuning.html

## Bug Fixes

- Hashing of decimal values with precision <= 18 is now compatible with Spark
- Comet falls back to Spark when hashing decimals with precision > 18

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
