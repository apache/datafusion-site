---
layout: post
title: Introducing Apache DataFusion Java 0.1.0
date: 2026-05-26
author: pmc
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

[TOC]

We are pleased to announce the [0.1.0] release of [Apache DataFusion Java], the first release
of the project. DataFusion Java is a thin Java binding over the [Apache DataFusion] query engine:
SQL and DataFrame queries are planned and executed in native Rust, and results return to the JVM
as [Apache Arrow] record batches through the [Arrow C Data Interface].

[0.1.0]: https://github.com/apache/datafusion-java/releases/tag/0.1.0
[Apache DataFusion Java]: https://github.com/apache/datafusion-java
[Apache DataFusion]: https://datafusion.apache.org
[Apache Arrow]: https://arrow.apache.org
[Arrow C Data Interface]: https://arrow.apache.org/docs/format/CDataInterface.html

This post focuses on what the project is and why it exists. The [changelog] has the full list of
features that landed in 0.1.0.

[changelog]: https://github.com/apache/datafusion-java/blob/0.1.0/dev/changelog/0.1.0.md

## Why DataFusion Java

DataFusion is already accessible from Rust, Python, and (via [Comet]) Spark. JVM applications that
want a fast, embeddable columnar query engine have so far had to either pull in Spark — which is a
heavy dependency for an embedded use case — or write their own JNI layer around DataFusion. The
goal of DataFusion Java is to make DataFusion a first-class JVM library: add it to your `pom.xml`,
construct a `SessionContext`, and run queries.

[Comet]: https://datafusion.apache.org/comet/

Typical use cases:

- **Embedded analytics** inside JVM services that need to run SQL or DataFrame queries over local
  files or object storage without standing up a separate query system.
- **Tools and frontends** that compile a higher-level surface language to DataFusion logical plans
  and need a JVM-side executor.
- **Spark and Hadoop ecosystem integrations** that already speak Arrow and want native columnar
  execution from Java or Scala code without going through Spark.

Because results cross the JNI boundary as Arrow C Data Interface streams, there is no row-by-row
marshalling or extra copy on the hot path — the JVM reads the same Arrow buffers DataFusion wrote.

## A first look

```java
import org.apache.arrow.memory.RootAllocator;
import org.apache.arrow.vector.ipc.ArrowReader;
import org.apache.datafusion.DataFrame;
import org.apache.datafusion.SessionContext;

try (var allocator = new RootAllocator();
     var ctx = new SessionContext()) {

    ctx.registerParquet("orders", "/path/to/orders.parquet");

    try (DataFrame df = ctx.sql(
            "SELECT o_orderpriority, COUNT(*) AS n " +
            "FROM orders GROUP BY o_orderpriority");
         ArrowReader reader = df.collect(allocator)) {
        while (reader.loadNextBatch()) {
            var batch = reader.getVectorSchemaRoot();
            // process batch...
        }
    }
}
```

`SessionContext` is the entry point — it owns the catalog of registered tables and the query
planner. `SessionContext` and `DataFrame` are `AutoCloseable`, so `try`-with-resources releases
native resources and Arrow buffers automatically.

## What 0.1.0 includes

The 0.1.0 surface is intentionally small but covers what most embedded analytics use cases need.

### Reading data

- **Parquet, CSV, JSON, Avro, and Arrow IPC** via `registerParquet` / `readParquet` (and the
  equivalent entry points for the other formats), with format-specific read options.
- **Object store backends** registered on `SessionContextBuilder` so queries can read directly
  from S3, GCS, or other object stores.
- **Java table providers.** `SessionContext.registerTable(name, provider)` exposes a
  Java-implemented `TableProvider`. The framework calls back into the Java side per query to fetch
  Arrow batches, with data flowing to native code over the Arrow C Data Interface.

### Querying

- **SQL** via `ctx.sql(String)` and a **DataFrame API** with `select`, `filter`, `limit`,
  `distinct`, `sort`, `repartition`, `join` / `joinOn`, `dropColumns`, and `withColumnRenamed`.
- **Introspection** methods on `DataFrame`: `schema`, `explain`, `cache`, `describe`.
- **Streaming execution** via `df.executeStream(allocator)` for pulling batches incrementally
  without materializing the full result set in memory.
- **Logical plans from `datafusion-proto`** via `SessionContext.fromProto(byte[])` — useful for
  cross-tool interop and for tools that compile their own surface language to DataFusion plans.
  The protobuf Java classes are generated from pinned `.proto` files at the matching upstream
  DataFusion tag.

### Writing data

- `DataFrame.writeCsv` and `DataFrame.writeJson` with format-specific options.

### Extending DataFusion from Java

- **Scalar UDFs.** Implement the `ScalarFunction` interface to add a vectorised, Arrow-native SQL
  function written in Java. The implementation declares its SQL name, argument fields, return
  field, and volatility, and supplies a per-batch `evaluate` body that reads input Arrow vectors
  and returns a result vector or a broadcast scalar.

```java
public final class AddOne implements ScalarFunction {
    private static final ArrowType INT32 = new ArrowType.Int(32, true);

    @Override public String name() { return "add_one"; }
    @Override public List<Field> argFields() { return List.of(Field.nullable("x", INT32)); }
    @Override public Field returnField() { return Field.nullable("y", INT32); }
    @Override public Volatility volatility() { return Volatility.IMMUTABLE; }

    @Override
    public ColumnarValue evaluate(BufferAllocator allocator, ScalarFunctionArgs args) {
        IntVector in = (IntVector) args.args().get(0).vector();
        IntVector out = new IntVector("add_one", allocator);
        out.allocateNew(in.getValueCount());
        for (int i = 0; i < in.getValueCount(); i++) {
            if (in.isNull(i)) out.setNull(i);
            else out.set(i, in.get(i) + 1);
        }
        out.setValueCount(in.getValueCount());
        return ColumnarValue.array(out);
    }
}

ctx.registerUdf(new ScalarUdf(new AddOne()));
```

### Operational details

- **JDK 17 or newer.** Set `JAVA_HOME` to point at it.
- **Bundled native library.** The published JAR contains pre-built native libraries for the
  supported platforms; `NativeLibraryLoader` selects and loads the right one at startup. You do
  not need a Rust toolchain to use the library — only to build it from source.
- **Typed exception hierarchy.** DataFusion errors crossing the JNI boundary surface as a typed
  `DataFusionException` hierarchy on the Java side rather than opaque runtime exceptions.
- **Configurable session.** `SessionContextBuilder` exposes batch size, target partitions,
  statistics collection, information schema, memory pool size, spill directory, and the built-in
  DataFusion cache manager.
- **Runtime visibility.** `SessionContext.memoryUsage` and `runtimeStats` expose DataFusion's
  internal allocator and runtime statistics for monitoring and capacity planning.

## What this release is not

DataFusion Java is at 0.1.0 and the API will change. A few specific limits are worth calling out
because they shape what you can build today:

- **Scalar UDFs only.** Aggregate, window, and table function UDFs are not yet exposed.
- **Single-partition Java `TableProvider`s.** DataFusion sees a Java-implemented table as one
  partition, and there is no projection or filter pushdown — DataFusion applies both on top of
  the batches the Java side returns. The interface is intentionally minimal so it can grow these
  capabilities as default methods without breaking implementations.
- **`SessionContext` is not thread-safe.** Use one per thread, or guard access externally.

## Looking ahead

The rough direction for upcoming releases:

1. **Round out the extension points.** Aggregate and window UDFs, multi-partition
   `TableProvider`s, and projection / filter pushdown into Java table providers.
2. **Close the gap with DataFusion's Rust API.** Anything that is reasonable to expose to a Java
   caller should be reachable from `SessionContext` and `DataFrame` with idiomatic Java
   signatures.
3. **Track DataFusion releases.** The aim is to follow DataFusion's release cadence so the Java
   binding stays current with new features and fixes in the engine.

## How to get involved

- **Source:** <https://github.com/apache/datafusion-java>
- **Issues:** <https://github.com/apache/datafusion-java/issues>
- **Documentation:** see `docs/source/` in the repository for the user and contributor guides.

Bug reports, design discussions, and pull requests are all welcome. Issues labelled
[good first issue] are a good place to start.

[good first issue]: https://github.com/apache/datafusion-java/issues?q=is%3Aopen+is%3Aissue+label%3A%22good+first+issue%22

## Thank you

Thanks to everyone who contributed to making the first release possible, and to the broader
DataFusion and Arrow communities whose work this project builds on directly.
