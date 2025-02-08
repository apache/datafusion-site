---
layout: post
title: Apache DataFusion Python 43.1.0 Released
date: 2025-02-07
author: timsaucer
categories: [release]
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

We are happy to announce that [datafusion-python 44.0.0] has been released. This release
brings in all of the new features of the core [DataFusion 44.0.0] library. You can see the
full details of the improvements in the [changelogs].

[DataFusion 44.0.0]: https://github.com/apache/datafusion/blob/main/dev/changelog/44.0.0.md
[datafusion-python 44.0.0]: https://pypi.org/project/datafusion/44.0.0/
[changelogs]: https://github.com/apache/datafusion-python/tree/main/dev/changelog

## Asynchronous Iteration of Record Batches

Retrieving a `RecordBatch` from a `RecordBatchStream` was a synchronous call, which would
require the end user's code to wait for the data retrieval. This is described in
[Issue 974]. We continue to support this as a synchronous iterator, but we have also added
in the ability to retrieve the `RecordBatch` using the Python asynchronous `anext`
function.

[Issue 974]: https://github.com/apache/datafusion-python/issues/974

# Default Compression for Parquet files

With [PR 981], we change the saving of Parquet files to use zstd compression by default.
Previously the default was uncompressed, causing excessive disk storage. Zstd is an
excellent compression scheme that balances speed and compression ratio. Users can still
save their Parquet files uncompressed by passing in the appropriate value to the
`compression` argument when calling `DataFrame.write_parquet`.

[PR 981]: https://github.com/apache/datafusion-python/pull/981

## `uv` package management

[uv] is an extremely fast Python package manager, written in Rust. In the previous version
of `datafusion-python` we had a combination of settings of PyPi and Conda. Instead, we
switch to using [uv] is our primary method for dependency management.

For most users of DataFusion, this change will be transparent. You can still install
via `pip` or `conda`. For developers, the instructions in the repository have been updated.

[uv]: https://github.com/astral-sh/uv

## Migration Guide

During the upgrade from [DataFusion 43.0.0] to [DataFusion 44.0.0] as our upstream core
dependency, we discovered a few changes were necessary within our repository and our
unit tests. These notes serve to help guide users who may encounter similar issues when
upgrading.

- `RuntimeConfig` is now deprecated in favor of `RuntimeEnvBuilder`. The migration is
fairly straightforward, and the corresponding classes have been marked as deprecated. For
end users it should be simply a matter of changing the class name.
- If you perform a `concat` of a `string_view` and `string`, it will now return a
`string_view` instead of a `string`. This likely only impacts unit tests that are validating
return types. In general, it is recommended to switch to using `string_view` whenever 
possible. You can see the blog articles [String View Pt 1] and [Pt 2] for more information
on these performance improvements.
- The function `date_part` now returns an `int32` instead of a `float64`. This is likely
only impactful to unit tests.

[DataFusion 43.0.0]: https://github.com/apache/datafusion/blob/main/dev/changelog/43.0.0.md
[String View Pt 1]: https://datafusion.apache.org/blog/2024/09/13/string-view-german-style-strings-part-1/
[Pt 2]: https://datafusion.apache.org/blog/2024/09/13/string-view-german-style-strings-part-2/

## Appreciation

We would like to thank everyone who has helped with these releases through their helpful
conversations, code review, issue descriptions, and code authoring. We would especially
like to thank the following authors of PRs who made these releases possible, listed in
alphabetical order by username: [@chenkovsky], [@ion-elgreco], [@kylebarron], and
[@kosiew].

Thank you!

[@chenkovsky]: https://github.com/chenkovsky
[@ion-elgreco]: https://github.com/ion-elgreco
[@kylebarron]: https://github.com/kylebarron
[@kosiew]: https://github.com/kosiew

## Get Involved

The DataFusion Python team is an active and engaging community and we would love
to have you join us and help the project.

Here are some ways to get involved:

* Learn more by visiting the [DataFusion Python project] page.

* Try out the project and provide feedback, file issues, and contribute code.

* Join us on [ASF Slack] or the [Arrow Rust Discord Server].

[DataFusion Python project]: https://datafusion.apache.org/python/index.html
[ASF Slack]: https://s.apache.org/slack-invite
[Arrow Rust Discord Server]: https://discord.gg/Qw5gKqHxUM
