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

Python UDFs are most useful when logic is awkward to write with built-in SQL functions but natural to express
in Python, such as business rules kept in a Python data structure. To show what this looks like on a cluster,
we will rewrite a query from the [TPC-H] benchmark, the same benchmark Ballista uses to measure its own
performance, so you can try it on data you generate yourself.

[TPC-H Query 19] computes the revenue from parts that qualify for a discount. The rules differ by brand, and
the reference SQL spells them out as three nearly identical blocks joined with `OR`. With a Python UDF, the
rules can live in an ordinary Python dictionary, and the query is reduced to a join, the shared filters, and a
single call to the UDF.

To follow along, generate the two tables the query needs with [tpchgen-cli]:

```shell
pip install tpchgen-cli
tpchgen-cli parquet --scale-factor 1 --tables lineitem,part --output-dir data
```

Then start a local cluster. The `ballista` Python package can run both the scheduler and the executor. Start
each in its own terminal, from the same directory as `data/`, so the executor can find the files:

```shell
# terminal 1: scheduler, listening on localhost:50050
python -c "from ballista import BallistaScheduler; s = BallistaScheduler(); s.start(); s.wait_for_termination()"

# terminal 2: executor
python -c "from ballista import BallistaExecutor; e = BallistaExecutor(); e.start(); e.wait_for_termination()"
```

Alternatively, `ballista.setup_test_cluster()` starts both inside the current Python process and returns the
host and port to connect to. Until the next release, the `ballista` package needs to be built from source, as
described in [Trying it out](#trying-it-out).

The UDF is written with [pyarrow.compute], so each batch stays in Arrow rather than being converted to Python
objects:

```python
import functools
import os

import pyarrow as pa
import pyarrow.compute as pc
from datafusion import col, lit, udf
from datafusion import functions as f
from ballista import BallistaSessionContext

ctx = BallistaSessionContext("df://localhost:50050")
ctx.register_parquet("lineitem", "data/lineitem.parquet")
ctx.register_parquet("part", "data/part.parquet")

# brand -> (allowed containers, minimum quantity, maximum size)
DISCOUNT_RULES = {
    "Brand#12": (["SM CASE", "SM BOX", "SM PACK", "SM PKG"], 1, 5),
    "Brand#23": (["MED BAG", "MED BOX", "MED PKG", "MED PACK"], 10, 10),
    "Brand#34": (["LG CASE", "LG BOX", "LG PACK", "LG PKG"], 20, 15),
}


def is_discounted(
    brand: pa.Array, container: pa.Array, quantity: pa.Array, size: pa.Array
) -> pa.Array:
    print(f"is_discounted: {len(brand)} rows in process {os.getpid()}", flush=True)
    matches = [
        functools.reduce(
            pc.and_,
            [
                pc.equal(brand, b),
                pc.is_in(container, pa.array(containers)),
                pc.greater_equal(quantity, min_qty),
                pc.less_equal(quantity, min_qty + 10),
                pc.greater_equal(size, 1),
                pc.less_equal(size, max_size),
            ],
        )
        for b, (containers, min_qty, max_size) in DISCOUNT_RULES.items()
    ]
    return functools.reduce(pc.or_, matches)


is_discounted_udf = udf(
    is_discounted,
    [pa.string(), pa.string(), pa.decimal128(15, 2), pa.int32()],
    pa.bool_(),
    "immutable",
    name="is_discounted",
)

# DataFrame API
lineitem = ctx.table("lineitem").filter(
    f.in_list(col("l_shipmode"), [lit("AIR"), lit("AIR REG")]),
    col("l_shipinstruct") == lit("DELIVER IN PERSON"),
)

revenue = (
    lineitem.join(ctx.table("part"), left_on="l_partkey", right_on="p_partkey")
    .filter(
        is_discounted_udf(
            col("p_brand"), col("p_container"), col("l_quantity"), col("p_size")
        )
    )
    .aggregate(
        [], [f.sum(col("l_extendedprice") * (lit(1) - col("l_discount"))).alias("revenue")]
    )
)
revenue.show()

# SQL
ctx.register_udf(is_discounted_udf)
ctx.sql("""
    select sum(l_extendedprice * (1 - l_discount)) as revenue
    from lineitem join part on p_partkey = l_partkey
    where l_shipmode in ('AIR', 'AIR REG')
      and l_shipinstruct = 'DELIVER IN PERSON'
      and is_discounted(p_brand, p_container, l_quantity, p_size)
""").show()
```

The join and filters run as native DataFusion operators on the executors, and only the rows that survive them
are handed to `is_discounted`. The UDF does not need to be registered on the cluster ahead of time. Its code,
along with the `DISCOUNT_RULES` dictionary it references, travels with the query.

You can see this happen. The `print` call at the top of `is_discounted` writes one line per batch, and those
lines appear in the executor's terminal, not in the terminal where you ran the query:

```text
is_discounted: 8192 rows in process 61867
is_discounted: 8192 rows in process 61867
...
```

The client only prints the query results. The function was pickled into the plan, sent to the executor, and
run there, in a different Python process.

[TPC-H]: https://www.tpc.org/tpch/
[TPC-H Query 19]: https://github.com/apache/datafusion-ballista/blob/main/benchmarks/queries/q19.sql
[pyarrow.compute]: https://arrow.apache.org/docs/python/api/compute.html
[tpchgen-cli]: https://github.com/datafusion-contrib/tpcgen-rs

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
