---
layout: post
title: Apache DataFusion Python 44.0.0 Released
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


We are happy to announce that [datafusion-python 46.0.0] has been released. This release
brings in all of the new features of the core [DataFusion 46.0.0] library. Since the last
blog post for [datafusion-python 43.1.0], a large number of improvements have been made
that can be found in the [changelogs].

We highly recommend reviewing the upstream [DataFusion 46.0.0] announcement.

[DataFusion 46.0.0]: https://datafusion.apache.org/blog/2025/03/24/datafusion-46.0.0
[datafusion-python 43.1.0]: https://datafusion.apache.org/blog/2024/12/14/datafusion-python-43.1.0/
[datafusion-python 46.0.0]: https://pypi.org/project/datafusion/46.0.0/
[changelogs]: https://github.com/apache/datafusion-python/tree/main/dev/changelog

## Easier file reading

https://github.com/apache/datafusion-python/pull/982

```python
from datafusion.io import read_parquet
df = read_parquet(path="./examples/tpch/data/customer.parquet")
```

```python
import datafusion
ctx = datafusion.SessionContext().enable_url_table()
df = ctx.table("./examples/tpch/data/customer.parquet")
```

## Registering Table Views

DataFusion supports registering a logical plan as a view with a session context. This
allows for work flows to create views in one part of the work flow and pass the session
context around to other places where that logical plan can be reused. This is an useful
feature for building up complex workflows and for code clarity. [PR 1016] enables this
feature in `datafusion-python`.

For example, supposing you have a DataFrame called `df1`, you could use this code snippet
to register the view and then use it in another place:

```python
ctx.register_view("view1", df1)
```

And then in another portion of your code which has access to the same session context
you can retrive the DataFrame with:

```
df2 = ctx.table("view1")
```

[PR 1016]: https://github.com/apache/datafusion-python/pull/1016

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

## UDF Decorators

https://github.com/apache/datafusion-python/pull/1040
https://github.com/apache/datafusion-python/pull/1061


## `uv` package management

[uv] is an extremely fast Python package manager, written in Rust. In the previous version
of `datafusion-python` we had a combination of settings of PyPi and Conda. Instead, we
switch to using [uv] is our primary method for dependency management.

For most users of DataFusion, this change will be transparent. You can still install
via `pip` or `conda`. For developers, the instructions in the repository have been updated.

[uv]: https://github.com/astral-sh/uv

## `ruff` code cleanup

https://github.com/apache/datafusion-python/pull/1055
https://github.com/apache/datafusion-python/pull/1062

## Improved Jupyter Notebook rendering

https://github.com/apache/datafusion-python/pull/1036

## Documentation

https://github.com/apache/datafusion-python/pull/1031/files

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
- We have upgraded the Python minimum version to 3.9 since 3.8 is no longer officially
supported.

[DataFusion 43.0.0]: https://github.com/apache/datafusion/blob/main/dev/changelog/43.0.0.md
[String View Pt 1]: https://datafusion.apache.org/blog/2024/09/13/string-view-german-style-strings-part-1/
[Pt 2]: https://datafusion.apache.org/blog/2024/09/13/string-view-german-style-strings-part-2/

## Coming Soon

- Reusable DataFusion UDFs
- contrib table providers
- catalog and schema providers

## Appreciation

TODO : UPDATE WITH LATEST LIST UP TO 46.0.0

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
