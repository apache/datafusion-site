---
layout: post
title: Apache DataFusion Comet 0.7.0 Release
date: 2025-03-20
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

The Apache DataFusion PMC is pleased to announce version 0.7.0 of the [Comet](https://datafusion.apache.org/comet/) subproject.

Comet is an accelerator for Apache Spark that translates Spark physical plans to DataFusion physical plans for
improved performance and efficiency without requiring any code changes.

Comet runs on commodity hardware and aims to provide 100% compatibility with Apache Spark. Any operators or
expressions that are not fully compatible will fall back to Spark unless explicitly enabled by the user. Refer
to the [compatibility guide] for more information.

[compatibility guide]: https://datafusion.apache.org/comet/user-guide/compatibility.html

This release covers approximately four weeks of development work and is the result of merging 46 PRs from 11
contributors. See the [change log] for more information.

[change log]: https://github.com/apache/datafusion-comet/blob/main/dev/changelog/0.7.0.md

## Release Highlights

### Performance

Comet 0.7.0 has improved performance compared to the previous release due to improvements in the native shuffle 
implementation and performance improvements in DataFusion 46.

For single-node TPC-H at 100 GB, Comet now delivers a **2.2x speedup** compared to Spark using the same CPU and RAM. Even 
with **half the resources**, Comet still provides a measurable performance improvement.

<img
src="/blog/images/comet-0.7.0/performance.png"
width="100%"
class="img-responsive"
alt="Chart showing TPC-H benchmark results for Comet 0.7.0"
/>

*These benchmarks were performed on a Linux workstation with PCIe 5, AMD 7950X CPU (16 cores), 128 GB RAM, and data 
stored locally in Parquet format on NVMe storage. Spark was running in Kubernetes with hard memory limits.*

## Shuffle Improvements

There are several improvements to shuffle in this release:

- When running in off-heap mode (which is the recommended approach), Comet was using the wrong memory allocator 
  implementation for some types of shuffle operation, which could result in OOM rather than spilling to disk.
- The number of spill files is drastically reduced. In previous releases, each instance of ShuffleMapTask could 
  potentially create a new spill file for each output partition each time that spill was invoked. Comet now creates 
  a maximum of one spill file per output partition per instance of ShuffleMapTask, which is appended to in subsequent 
  spills.
- There was a flaw in the memory accounting which resulted in Comet requesting approximately twice the amount of 
  memory that was needed, resulting in premature spilling. This is now resolved.
- The metric for number of spilled bytes is now accurate. It was previously reporting invalid information.

## Improved Hash Join Performance

When using the `spark.comet.exec.replaceSortMergeJoin` setting to replace sort-merge joins with hash joins, Comet 
will now do a better job of picking the optimal build side (thanks to [@hayman42] for suggesting this, and thanks to the 
[Apache Gluten(incubating)] project for the inspiration in implementing this feature).

[@hayman42](https://github.com/hayman42)

## Experimental Support for DataFusion’s DataSourceExec

It is now possible to configure Comet to use DataFusion’s `DataSourceExec` instead of Comet’s current Parquet reader. 
Support should still be considered experimental, but most of Comet’s unit tests are now passing with the new reader. 
Known issues include handling of `INT96` timestamps and negative bytes and shorts.

To enable DataFusion’s `DataSourceExec`, either set `spark.comet.scan.impl=native_datafusion` or set the environment 
variable `COMET_PARQUET_SCAN_IMPL=native_datafusion`.

## Complex Type Support

With DataFusion’s `DataSourceExec` enabled, there is now some early support for reading structs from Parquet. This is 
largely untested and we would welcome additional testing from the community to help determine what is and isn’t working, 
as well as contributions to improve support for structs and other complex types. The tracking issue is 
https://github.com/apache/datafusion-comet/issues/1043.

## Updates to supported Spark versions

- Comet 0.7.0 is now tested against Spark 3.5.4 rather than 3.5.1
- This will be the last Comet release to support Spark 3.3.x

## Improved Tuning Guide

The [Comet Tuning Guide] has been improved and now provides guidance on determining how much memory to allocate to 
Comet.

[Comet Tuning Guide]: https://datafusion.apache.org/comet/user-guide/tuning.html

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
