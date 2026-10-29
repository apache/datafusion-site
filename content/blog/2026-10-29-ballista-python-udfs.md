---
layout: post
title: Distributed Python UDFs in Apache DataFusion Ballista
date: 2026-10-29
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

The Python client for [Apache DataFusion Ballista] can now run Python user-defined functions (UDFs) across a
cluster. Scalar, aggregate, and window UDFs written in Python are serialized into the query plan, shipped to
the scheduler, and executed on Ballista executors, from both the DataFrame API and SQL.

This comes alongside a larger change in how the Ballista Python client works. Instead of wrapping
[DataFusion Python], Ballista now plugs into a standard `datafusion.SessionContext` through DataFusion's FFI
layer. If you know the DataFusion Python API, you already know how to use Ballista.

Neither change would have been possible without a long series of improvements to DataFusion Python and the
`datafusion-ffi` crate. This post explains what changed, how it works, and who made it happen.

[Apache DataFusion Ballista]: https://datafusion.apache.org/ballista/
[DataFusion Python]: https://datafusion.apache.org/python/

## What it looks like

Define a Python function that operates on Arrow arrays, wrap it as a UDF, and use it as you would with
DataFusion Python:

```python
import pyarrow as pa
from datafusion import col, udf
from ballista import BallistaSessionContext

ctx = BallistaSessionContext("df://localhost:50050")
ctx.sql("create external table t stored as parquet location 'data/t.parquet'")


def is_null(array: pa.Array) -> pa.Array:
    return array.is_null()


is_null_udf = udf(is_null, [pa.int64()], pa.bool_(), "stable", name="is_null_udf")

# DataFrame API
df = ctx.table("t")
df.select(col("a"), is_null_udf(col("a")).alias("n")).show()

# SQL
ctx.register_udf(is_null_udf)
ctx.sql("select a, is_null_udf(a) as n from t").show()
```

The UDF does not need to be registered on the cluster ahead of time. Its code travels with the query.

## A native DataFusion Python experience

Earlier versions of the Ballista Python client subclassed DataFusion Python's `SessionContext` and `DataFrame`.
Every method that executed a plan was intercepted, the logical plan was serialized, and the query was
resubmitted through a separate Ballista session. This worked for the common cases, but it had real drawbacks:

- Methods the wrapper did not know about ran locally instead of on the cluster.
- Users got a Ballista-specific `DistributedDataFrame` rather than a regular `datafusion.DataFrame`.
- The wrapper had to track every change to the DataFusion Python API.
- Python objects did not always cross the boundary between the two libraries cleanly. The issue that started
  this effort, [#1142], reported a `TypeError: argument 'group_by': 'Expr' object cannot be converted to 'Expr'`
  from a simple aggregate.

DataFusion Python 55 can install a custom query planner and extension codecs through FFI. Ballista now uses
this to configure a standard `datafusion.SessionContext`. DataFusion Python plans each query as usual, and
Ballista's query planner sends the plan to the scheduler. Any operation that executes a plan, including
`collect`, `show`, `to_pandas`, `write_parquet`, and `EXPLAIN ANALYZE`, runs on the cluster. The object you get
back from `BallistaSessionContext` is a `datafusion.SessionContext`, and the DataFrames it creates are regular
`datafusion.DataFrame`s.

[#1142]: https://github.com/apache/datafusion-ballista/issues/1142

## How Python UDFs travel with the plan

Ballista exchanges plans between the client, scheduler, and executors as protobuf, using DataFusion's
extension codecs for anything the built-in serialization does not cover. A Python UDF is a reference to a live
Python object, so it cannot be described by name alone.

DataFusion Python 55 added codecs that solve this. When a plan contains a Python UDF, the codec pickles the
function with [cloudpickle] and embeds the payload inline in the plan. On the receiving side, the codec
recognizes the payload and reconstructs the UDF. Ballista composes these codecs with its own:

- The client, scheduler, and executors started from the `ballista` Python package all use Python-aware
  logical and physical codecs, with Ballista's default codecs underneath.
- Plans that do not contain Python UDFs serialize exactly as before, so there is no overhead for queries that
  do not use them.

Because the function body is shipped as a pickle, a few requirements follow:

- The scheduler and executors must be started from the `ballista` Python package (`BallistaScheduler` and
  `BallistaExecutor`), since decoding a Python UDF requires a Python interpreter.
- They must run the same Python minor version as the client.
- Any module the UDF imports must be installed wherever it runs.

One known limitation remains: Python UDFs used as shuffle partitioning keys are not yet inlined.

[cloudpickle]: https://github.com/cloudpipe/cloudpickle

## The building blocks

Most of the work behind this feature happened upstream, in DataFusion Python and the `datafusion-ffi` crate.
[Tim Saucer] has led the DataFusion FFI effort for a long time, and over the DataFusion 54 and 55 cycles he
added the pieces Ballista needed:

- [Logical and physical extension codecs][dfp-1541] in DataFusion Python
- [Pickling of expressions][dfp-1544], then of [aggregate and window UDFs][dfp-1545]
- [Per-session control over UDF inlining][dfp-1546], with a strict mode that refuses to serialize UDFs
- [FFI query planner support][dfp-1677]
- [Composable extension codecs][dfp-1678], so projects like Ballista can layer their own codecs on top
- [Hardening the extension API][dfp-1759] before it shipped in 55
- [A user guide and runnable examples][dfp-1547] for distributing expressions

[Marko Milenković] then brought these together in Ballista. He rebuilt the Python client on the FFI query
planner ([#2588]) and wired the Python-aware codecs through the client, scheduler, and executors to support
UDFs ([#2619]).

[Tim Saucer]: https://github.com/timsaucer
[Marko Milenković]: https://github.com/milenkovicm
[dfp-1541]: https://github.com/apache/datafusion-python/pull/1541
[dfp-1544]: https://github.com/apache/datafusion-python/pull/1544
[dfp-1545]: https://github.com/apache/datafusion-python/pull/1545
[dfp-1546]: https://github.com/apache/datafusion-python/pull/1546
[dfp-1547]: https://github.com/apache/datafusion-python/pull/1547
[dfp-1677]: https://github.com/apache/datafusion-python/pull/1677
[dfp-1678]: https://github.com/apache/datafusion-python/pull/1678
[dfp-1759]: https://github.com/apache/datafusion-python/pull/1759
[#2588]: https://github.com/apache/datafusion-ballista/pull/2588
[#2619]: https://github.com/apache/datafusion-ballista/pull/2619

This is a good example of how the DataFusion ecosystem compounds. Extension points built to make DataFusion
Python more composable turned out to be exactly what a distributed engine needed to support Python natively.

## Trying it out

Python UDF support is on the `main` branch of Ballista and will be included in the next release of the
`ballista` Python package. Until then, you can build the package from source by following the instructions in
the [Python client README]. The [example script] starts a local test cluster and walks through both the
DataFrame and SQL forms shown above.

Progress on the Python client is tracked in [#2618]. If you try it out, we would love to hear how it goes.
Please report bugs and feature requests on [GitHub], or join the conversation on the
[DataFusion communication channels].

[Python client README]: https://github.com/apache/datafusion-ballista/blob/main/python/README.md
[example script]: https://github.com/apache/datafusion-ballista/blob/main/python/examples/ballista_execution.py
[#2618]: https://github.com/apache/datafusion-ballista/issues/2618
[GitHub]: https://github.com/apache/datafusion-ballista/issues
[DataFusion communication channels]: https://datafusion.apache.org/contributor-guide/communication.html

## Acknowledgements

Thank you to Tim Saucer for the DataFusion FFI and DataFusion Python work this builds on, to Marko Milenković
for integrating it into Ballista, and to everyone who contributes to DataFusion Python and the FFI crates.
