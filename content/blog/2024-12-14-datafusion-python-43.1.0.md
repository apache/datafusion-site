---
layout: post
title: Apache DataFusion Python 43.1.0 Released
date: 2024-12-14
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

We are happy to announce that [datafusion-python 43.1.0] has been released. This release
brings in all of the new features of the core [DataFusion 43.0.0] library. Since the last
blog post for [datafusion-python 40.1.0], a large number of improvements have been made
that can be found in the [changelogs].

We would like to point out four features that are particularly noteworthy.

- Arrow PyCapsule import and export
- User-Defined Window Functions
- Foreign Table Providers
- String View performance enhancements

[DataFusion 43.0.0]: https://github.com/apache/datafusion/blob/main/dev/changelog/43.0.0.md
[datafusion-python 43.1.0]: https://pypi.org/project/datafusion/43.1.0/
[datafusion-python 40.1.0]: https://datafusion.apache.org/blog/2024/08/20/python-datafusion-40.0.0/
[changelogs]: https://github.com/apache/datafusion-python/tree/main/dev/changelog

## Arrow PyCapsule import and export

Arrow has stable C interface for moving data between different libraries, but difficulties
sometimes arise when different Python libraries expose this interface through different
methods, requiring developers to write function calls for each library they are attempting
to work with. A better approach is to use the [Arrow PyCapsule Interface] which gives a
consistent method for exposing these data structures across libraries.

In [PR #825], we introduced support for both importing and exporting Arrow data in
`datafusion-python`. With this improvement, you can now use a single function call to import
a table from **any** Python library that implements the [Arrow PyCapsule Interface].
Many popular libaries, such as [Pandas](https://pandas.pydata.org/) and [Polars](https://pola.rs/)
already support these interfaces.

Suppose you have a Pandas and Polars DataFrames named `df_pandas` or `df_polars`, respectively:

```python
ctx = SessionContext()
df_dfn1 = ctx.from_arrow(df_pandas)
df_dfn1.show()

df_dfn2 = ctx.from_arrow(df_polars)
df_dfn2.show()
```

One great thing about using this interface is that as any new library is developed and
uses these stable interfaces, they will work out of the box with DataFusion!

Additionally, DataFusion DataFrames allow for exporting via the PyCapsule interface. For example,
to convert a DataFrame to a PyArrow table, it is simply

```python
import pyarrow as pa
table = pa.table(df)
```

[Arrow PyCapsule Interface]: https://arrow.apache.org/docs/format/CDataInterface/PyCapsuleInterface.html
[PR #825]: https://github.com/apache/datafusion-python/pull/825

## User-Defined Window Functions

In `datafusion-python 42.0.0` we released User-Defined Window Support in [PR #880].
For a detailed description of how these work please see the online documentation for
all [user-defined functions]. Additionally the [examples folder] contains a complete
example demonstrating the four different modes of operation of window functions
within DataFusion.

[PR #880]: https://github.com/apache/datafusion-python/pull/880
[user-defined functions]: https://datafusion.apache.org/python/user-guide/common-operations/udf-and-udfa.html
[examples folder]: https://github.com/apache/datafusion-python/tree/main/examples

## Foreign Table Providers

In the core [DataFusion 43.0.0] release, support was added for a Foreign Function
Interface to table providers. This creates a stable way for sharing functionality
across different libraries, similar to the [Arrow C data interface] operates. This
enables libraries, such as [delta lake] and [datafusion-contrib] to write their own
table providers in Rust and expose them in Python without requiring a Rust dependency
on `datafusion-python`. This is important because it allows these libraries to
operate with `datafusion-python` regardless of which version of `datafusion` they
were built against.

To implement this feature in a table provider is quite simple. There is a complete
example in the [examples folder], but the relevant code is here, exposed as a
Python function via [pyo3]:

```rust
    fn __datafusion_table_provider__<'py>(
        &self,
        py: Python<'py>,
    ) -> PyResult<Bound<'py, PyCapsule>> {
        let name = CString::new("datafusion_table_provider").unwrap();

        let provider = self
            .create_table()
            .map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
        let provider = FFI_TableProvider::new(Arc::new(provider), false);

        PyCapsule::new_bound(py, provider, Some(name.clone()))
    }
```

That's it! All of the work of converting the table provider to use the FFI interface
is performed by the core library.

[Arrow C data interface]: https://arrow.apache.org/docs/format/CDataInterface.html
[PR #921]: https://github.com/apache/datafusion-python/pull/921
[delta lake]: https://delta.io/docs/
[datafusion-contrib]: https://github.com/datafusion-contrib/datafusion-table-providers
[pyo3]: https://pyo3.rs/

## String View performance enhancements

In the core [DataFusion 43.0.0] release, the option to enable StringView by default
was turned on. This leads to some significant performance enhancements, but it *may*
require some changes to users of `datafusion-python`.

To learn more about the excellent work on this feature please read [part 1] and [part 2]
of the blog post describing how these enhancements can lead to 20-200% performance
gains in some tests.

During our testing we identified some cases where we needed to adjust workflows to
account for the fact that StringView is now the default type for string based operations.
First, when performing manipulations on string objects there is a perfomance loss when
needing to cast from string to string view or vice versa. To reap the best performance,
ideally all of your string type data will use StringView. For most users this should be
transparent. However if you specify a schema for reading or creating data, then you
likely need to change from `pa.string()` to `pa.string_view()`. For our testing, this
primarily happens during data loading operations and in unit tests.

[part 1]: https://datafusion.apache.org/blog/2024/09/13/string-view-german-style-strings-part-1/
[part 2]: https://datafusion.apache.org/blog/2024/09/13/string-view-german-style-strings-part-2/

If you wish to disable StringView as the default type to retain the old approach,
you can do so following this example:

```python
from datafusion import SessionContext
from datafusion import SessionConfig
config = SessionConfig({"datafusion.execution.parquet.schema_force_view_types": "false"})
ctx = SessionContext(config=config)
```

## Appreciation

We would like to thank everyone who has helped with these releases through their helpful
conversations, code review, issue descriptions, and code authoring. We would especially
like to thank the following authors of PRs who made these releases possible, listed in
alphabetical order by username: [@andygrove], [@drauschenbach], [@emgeee], [@ion-elgreco],
[@jcrist], [@kosiew], [@mesejo], [@Michael-J-Ward], and [@sir-sigurd].

Thank you!

[@andygrove]: https://github.com/andygrove
[@drauschenbach]: https://github.com/drauschenbach
[@emgeee]: https://github.com/emgeee
[@ion-elgreco]: https://github.com/ion-elgreco
[@jcrist]: https://github.com/jcrist
[@kosiew]: https://github.com/kosiew
[@mesejo]: https://github.com/mesejo
[@Michael-J-Ward]: https://github.com/Michael-J-Ward
[@sir-sigurd]: https://github.com/sir-sigurd

## Get Involved

The DataFusion Python team is an active and engaging community and we would love
to have you join us and help the project.

Here are some ways to get involved:

* Learn more by visiting the [DataFusion Python project]
page.

* Try out the project and provide feedback, file issues, and contribute code.

[DataFusion Python project]: https://datafusion.apache.org/python/index.html
