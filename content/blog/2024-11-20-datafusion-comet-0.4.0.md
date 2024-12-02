---
layout: post
title: Apache DataFusion Comet 0.4.0 Release
date: 2024-11-20
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

The Apache DataFusion PMC is pleased to announce version 0.4.0 of the [Comet](https://datafusion.apache.org/comet/) subproject.

Comet is an accelerator for Apache Spark that translates Spark physical plans to DataFusion physical plans for
improved performance and efficiency without requiring any code changes.

Comet runs on commodity hardware and aims to provide 100% compatibility with Apache Spark. Any operators or
expressions that are not fully compatible will fall back to Spark unless explicitly enabled by the user. Refer
to the [compatibility guide] for more information.

[compatibility guide]: https://datafusion.apache.org/comet/user-guide/compatibility.html

This release covers approximately six weeks of development work and is the result of merging 51 PRs from 10
contributors. See the [change log] for more information.

[change log]: https://github.com/apache/datafusion-comet/blob/main/dev/changelog/0.4.0.md

## Release Highlights

### Performance & Stability

There are a number of performance and stability improvements in this release. Here is a summary of some of the
larger changes. Current benchmarking results can be found in the [Comet Benchmarking Guide].

[Comet Benchmarking Guide]: https://datafusion.apache.org/comet/contributor-guide/benchmarking.html

#### Unified Memory Management

Comet now uses a unified memory management approach that shares an off-heap memory pool with Apache Spark, resulting
in a much simpler configuration. Comet now requires `spark.memory.offHeap.enabled=true`. This approach provides a
holistic view of memory usage in Spark and Comet and makes it easier to optimize system performance.

#### Faster Joins

Apache Spark supports sort-merge and hash joins, which have similar performance characteristics. Spark defaults to
using sort-merge joins because they are less likely to result in OutOfMemory exceptions. In vectorized query
engines such as DataFusion, hash joins outperform sort-merge joins. Comet now has an experimental feature to
replace Spark sort-merge joins with hash joins for improved performance. This feature is experimental because
there is currently no spill-to-disk support in the hash join implementation. This feature can be enabled by
setting `spark.comet.exec.replaceSortMergeJoin=true`.

#### Bloom Filter Aggregates

Spark’s optimizer can insert Bloom filter aggregations and filters to prune large result sets before a shuffle. However,
Comet would fall back to Spark for the aggregation. Comet now has native support for Bloom filter aggregations
after previously supporting Bloom filter testing. Users no longer need to set
`spark.sql.optimizer.runtime.bloomFilter.enabled=false` when using Comet.

#### Complex Type support

This release has the following improvements to complex type support:

- Implemented `ArrayAppend` and `GetArrayStructFields`.
- Implemented native cast between structs
- Implemented native cast from structs to string

## Roadmap

One of the highest priority items on the roadmap is to add support for reading complex types (maps, structs, and arrays)
from Parquet sources, both when reading Parquet directly and from Iceberg.

Comet currently has proprietary native code for decoding Parquet pages, native column readers for all of Spark’s
primitive types, and special handling for Spark-specific use cases such as timestamp rebasing and decimal type
promotion. This implementation does not yet support complex types. File IO, decryption, and decompression are handled
in JVM code, and Parquet pages are passed on to native code for decoding.

Rather than add complex type support to this existing code, we are exploring two main options to allow us to
leverage more of the upstream Arrow and DataFusion code.

### Use DataFusion’s ParquetExec

For use cases where DataFusion can support reading a Parquet source, Comet could create a native plan that uses
DataFusion’s ParquetExec. We are investigating using DataFusion’s SchemaAdapter to handle some Spark-specific
handling of timestamps and decimals.

### Use Arrow’s Parquet Batch Reader

For use cases not supported by DataFusion’s ParquetExec, such as integrating with Iceberg, we are exploring
replacing our current native Parquet decoding logic with the Arrow readers provided by the Parquet crate.

Iceberg already provides a vectorized Spark reader for Parquet. A [PR] is open against Iceberg for adding a native
version based on Comet, and we hope to update this to leverage the improvements outlined above.

[PR]: https://github.com/apache/iceberg/pull/9841

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
