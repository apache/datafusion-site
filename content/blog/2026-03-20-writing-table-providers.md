---
layout: post
title: Writing Custom Table Providers in Apache DataFusion
date: 2026-03-20
author: Tim Saucer (rerun.io)
categories: [tutorial]
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

One of DataFusion's greatest strengths is its extensibility. If your data lives
in a custom format, behind an API, or in a system that DataFusion does not
natively support, you can teach DataFusion to read it by implementing a
**custom table provider**. This post walks through the three layers you need to
understand and explains where your work should actually happen.

## The Three Layers

---

When DataFusion executes a query against a table, three abstractions collaborate
to produce results:

1. **[`TableProvider`]** -- Describes the table (schema, capabilities) and
   produces an execution plan when queried.
2. **[`ExecutionPlan`]** -- Describes *how* to compute the result: partitioning,
   ordering, and child plan relationships.
3. **[`SendableRecordBatchStream`]** -- The async stream that *actually does the
   work*, yielding `RecordBatch`es one at a time.

Think of these as a funnel: `TableProvider::scan()` is called once during
planning to create an `ExecutionPlan`, then `ExecutionPlan::execute()` is called
once per partition to create a stream, and those streams are where rows are
actually produced during execution.

[`TableProvider`]: https://docs.rs/datafusion/latest/datafusion/catalog/trait.TableProvider.html
[`ExecutionPlan`]: https://docs.rs/datafusion/latest/datafusion/physical_plan/trait.ExecutionPlan.html
[`SendableRecordBatchStream`]: https://docs.rs/datafusion/latest/datafusion/execution/type.SendableRecordBatchStream.html

## Layer 1: TableProvider

---

A [`TableProvider`] represents a queryable data source. For a minimal read-only
table, you need four methods:

```rust
impl TableProvider for MyTable {
    fn as_any(&self) -> &dyn Any { self }

    fn schema(&self) -> SchemaRef {
        Arc::clone(&self.schema)
    }

    fn table_type(&self) -> TableType {
        TableType::Base
    }

    async fn scan(
        &self,
        state: &dyn Session,
        projection: Option<&Vec<usize>>,
        filters: &[Expr],
        limit: Option<usize>,
    ) -> Result<Arc<dyn ExecutionPlan>> {
        // Build and return an ExecutionPlan -- keep this lightweight!
        Ok(Arc::new(MyExecPlan::new(
            Arc::clone(&self.schema),
            projection,
            limit,
        )))
    }
}
```

The `scan` method is the heart of `TableProvider`. It receives three pushdown
hints from the optimizer, each reducing the amount of data your source needs
to produce:

- **`projection`** -- Which columns are needed. This reduces the **width** of
  the output. If your source supports it, read only these columns rather than
  the full schema.
- **`filters`** -- Predicates the engine would like you to apply during the
  scan. This reduces the **number of rows** by skipping data that does not
  match. Implement `supports_filters_pushdown` to advertise which filters you
  can handle.
- **`limit`** -- A row count cap. This also reduces the **number of rows** --
  if you can stop reading early once you have produced enough rows, this avoids
  unnecessary work.

### Keep `scan()` Lightweight

This is a critical point: **`scan()` runs during planning, not execution.** It
should return quickly. Best practices are to avoid performing I/O, network
calls, or heavy computation here. The `scan` method's job is to *describe* how
the data will be produced, not to produce it. All the real work belongs in the
stream (Layer 3).

A common pitfall is to fetch data or open connections in `scan()`. This blocks
the planning thread and can cause timeouts or deadlocks, especially if the query
involves multiple tables or subqueries that all need to be planned before
execution begins.

### Existing Implementations to Learn From

DataFusion ships several `TableProvider` implementations that are excellent
references:

- **[`MemTable`]** -- Holds data in memory as `Vec<RecordBatch>`. The simplest
  possible provider; great for tests and small datasets.
- **[`StreamTable`]** -- Wraps a user-provided stream factory. Useful when your
  data arrives as a continuous stream (e.g., from Kafka or a socket).
- **[`SortedTableProvider`]** -- Wraps another `TableProvider` and advertises a
  known sort order, enabling the optimizer to skip redundant sorts.

[`MemTable`]: https://docs.rs/datafusion/latest/datafusion/datasource/memory/struct.MemTable.html
[`StreamTable`]: https://docs.rs/datafusion/latest/datafusion/datasource/stream/struct.StreamTable.html
[`SortedTableProvider`]: https://docs.rs/datafusion/latest/datafusion/datasource/struct.SortedTableProvider.html

## Layer 2: ExecutionPlan

---

An [`ExecutionPlan`] is a node in the physical query plan tree. Your table
provider's `scan()` method returns one. The required methods are:

```rust
impl ExecutionPlan for MyExecPlan {
    fn name(&self) -> &str { "MyExecPlan" }

    fn as_any(&self) -> &dyn Any { self }

    fn properties(&self) -> &PlanProperties {
        &self.properties
    }

    fn children(&self) -> Vec<&Arc<dyn ExecutionPlan>> {
        vec![]  // Leaf node -- no children
    }

    fn with_new_children(
        self: Arc<Self>,
        children: Vec<Arc<dyn ExecutionPlan>>,
    ) -> Result<Arc<dyn ExecutionPlan>> {
        assert!(children.is_empty());
        Ok(self)
    }

    fn execute(
        &self,
        partition: usize,
        context: Arc<TaskContext>,
    ) -> Result<SendableRecordBatchStream> {
        // This is where you build and return your stream
        // ...
    }
}
```

The key properties to set correctly in [`PlanProperties`] are **output
partitioning** and **output ordering**.

**Output partitioning** tells the engine how many partitions your data has,
which determines parallelism. If your source naturally partitions data (e.g.,
by file or by shard), expose that here.

**Output ordering** declares whether your data is naturally sorted. This
enables the optimizer to avoid inserting a `SortExec` when a query requires
ordered data. Getting this right can be a significant performance win.

### Partitioning Strategies

Since `execute()` is called once per partition, partitioning directly controls
the parallelism of your table scan. Each partition runs on its own task, so
more partitions means more concurrent work -- up to the number of available
cores.

Consider how your data source naturally divides its data:

- **By file or object:** If you are reading from S3, each file can be a
  partition. DataFusion will read them in parallel.
- **By shard or region:** If your source is a sharded database, each shard
  maps naturally to a partition.
- **By key range:** If your data is keyed (e.g., by timestamp or customer ID),
  you can split it into ranges.

Getting partitioning right matters because it affects everything downstream in
the plan. When DataFusion needs to perform an aggregation or join, it
repartitions data by hashing the relevant columns. If your source already
produces data partitioned by the join or group-by key, DataFusion can skip the
repartition step entirely -- avoiding a potentially expensive shuffle.

For example, if you are building a table provider for a system that stores
data partitioned by `customer_id`, and a common query groups by `customer_id`:

```sql
SELECT customer_id, SUM(amount)
FROM my_table
GROUP BY customer_id;
```

If you declare your output partitioning as `Hash([customer_id], N)`, the
optimizer recognizes that the data is already distributed correctly for the
aggregation and eliminates the `RepartitionExec` that would otherwise appear
in the plan. You can verify this with `EXPLAIN` (more on this below).

Conversely, if you report `UnknownPartitioning`, DataFusion must assume the
worst case and will always insert repartitioning operators as needed.

### Keep `execute()` Lightweight Too

Like `scan()`, the `execute()` method should construct and return a stream
without doing heavy work. The actual data production happens when the stream
is polled. Do not block on async operations here -- build the stream and let
the runtime drive it.

### Existing Implementations to Learn From

- **[`StreamingTableExec`]** -- Executes a streaming table scan. It takes a
  stream factory (a closure that produces streams) and handles partitioning.
  Good reference for wrapping external streams.
- **[`DataSourceExec`]** -- The execution plan behind DataFusion's built-in file
  scanning (Parquet, CSV, JSON). It demonstrates sophisticated partitioning,
  filter pushdown, and projection pushdown.

[`StreamingTableExec`]: https://docs.rs/datafusion/latest/datafusion/datasource/stream/struct.StreamingTableExec.html
[`DataSourceExec`]: https://docs.rs/datafusion/latest/datafusion/datasource/struct.DataSourceExec.html
[`PlanProperties`]: https://docs.rs/datafusion/latest/datafusion/physical_plan/struct.PlanProperties.html

## Layer 3: SendableRecordBatchStream

---

[`SendableRecordBatchStream`] is where the real work happens. It is defined as:

```rust
type SendableRecordBatchStream =
    Pin<Box<dyn RecordBatchStream<Item = Result<RecordBatch>> + Send>>;
```

This is an async stream of `RecordBatch`es that can be sent across threads. When
the DataFusion runtime polls this stream, your code runs: reading files, calling
APIs, transforming data, etc.

### Using RecordBatchStreamAdapter

The easiest way to create a `SendableRecordBatchStream` is with
[`RecordBatchStreamAdapter`]. It bridges any `futures::Stream<Item =
Result<RecordBatch>>` into the `SendableRecordBatchStream` type:

```rust
use datafusion::physical_plan::stream::RecordBatchStreamAdapter;

fn execute(
    &self,
    partition: usize,
    context: Arc<TaskContext>,
) -> Result<SendableRecordBatchStream> {
    let schema = self.schema();
    let config = self.config.clone();

    let stream = futures::stream::once(async move {
        // ALL the heavy work happens here, inside the stream:
        // - Open connections
        // - Read data from external sources
        // - Transform and batch the results
        let batches = fetch_data_from_source(&config).await?;
        Ok(batches)
    })
    .flat_map(|result| match result {
        Ok(batch) => futures::stream::iter(vec![Ok(batch)]),
        Err(e) => futures::stream::iter(vec![Err(e)]),
    });

    Ok(Box::pin(RecordBatchStreamAdapter::new(schema, stream)))
}
```

[`RecordBatchStreamAdapter`]: https://docs.rs/datafusion/latest/datafusion/physical_plan/stream/struct.RecordBatchStreamAdapter.html

### CPU-Intensive Work: Use a Separate Thread Pool

If your stream performs CPU-intensive work (parsing, decompression, complex
transformations), avoid blocking the tokio runtime. Instead, offload to a
dedicated thread pool and send results back through a channel:

```rust
fn execute(
    &self,
    partition: usize,
    context: Arc<TaskContext>,
) -> Result<SendableRecordBatchStream> {
    let schema = self.schema();
    let config = self.config.clone();

    let (tx, rx) = tokio::sync::mpsc::channel(2);

    // Spawn CPU-heavy work on a blocking thread pool
    tokio::task::spawn_blocking(move || {
        let batches = generate_data(&config);
        for batch in batches {
            if tx.blocking_send(Ok(batch)).is_err() {
                break; // Receiver dropped, query was cancelled
            }
        }
    });

    let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
    Ok(Box::pin(RecordBatchStreamAdapter::new(schema, stream)))
}
```

This pattern keeps the async runtime responsive while your data generation
runs on its own threads.

## Where Should the Work Happen?

---

This table summarizes what belongs at each layer:

| Layer | Runs During | Should Do | Should NOT Do |
|---|---|---|---|
| `TableProvider::scan()` | Planning | Build an `ExecutionPlan` with metadata | I/O, network calls, heavy computation |
| `ExecutionPlan::execute()` | Execution (once per partition) | Construct a stream, set up channels | Block on async work, read data |
| `RecordBatchStream` (polling) | Execution | All I/O, computation, data production | -- |

The guiding principle: **push work as late as possible.** Planning should be
fast so the optimizer can do its job. Execution setup should be fast so all
partitions can start promptly. The stream is where you spend time producing
data.

### Why This Matters

When `scan()` does heavy work, several problems arise:

1. **Planning becomes slow.** If a query touches 10 tables and each `scan()`
   takes 500ms, planning alone takes 5 seconds before any data flows.
2. **The optimizer cannot help.** The optimizer runs between planning and
   execution. If you have already fetched data during planning, optimizations
   like predicate pushdown or partition pruning cannot reduce the work.
3. **Resource management breaks down.** DataFusion manages concurrency and
   memory during execution. Work done during planning bypasses these controls.

## Filter Pushdown: Doing Less Work

---

One of the most impactful optimizations you can add to a custom table provider
is **filter pushdown** -- letting the source skip data that the query does not
need, rather than reading everything and filtering it afterward.

### How Filter Pushdown Works

When DataFusion plans a query with a `WHERE` clause, it passes the filter
predicates to your `scan()` method as the `filters` parameter. By default,
DataFusion assumes your provider cannot handle any filters and inserts a
`FilterExec` node above your scan to apply them. But if your source *can*
evaluate some predicates during scanning -- for example, by skipping files,
partitions, or row groups that cannot match -- you can eliminate a huge amount
of unnecessary I/O.

To opt in, implement `supports_filters_pushdown`:

```rust
fn supports_filters_pushdown(
    &self,
    filters: &[&Expr],
) -> Result<Vec<TableProviderFilterPushDown>> {
    Ok(filters.iter().map(|f| {
        match f {
            // We can fully evaluate equality filters on
            // the partition column at the source
            Expr::BinaryExpr(BinaryExpr {
                left, op: Operator::Eq, right
            }) if is_partition_column(left) || is_partition_column(right) => {
                TableProviderFilterPushDown::Exact
            }
            // All other filters: let DataFusion handle them
            _ => TableProviderFilterPushDown::Unsupported,
        }
    }).collect())
}
```

The three possible responses for each filter are:

- **`Exact`** -- Your source guarantees that no output rows will have a false
  value for this predicate. Because the filter is fully evaluated at the source,
  DataFusion will **not** add a `FilterExec` for it.
- **`Inexact`** -- Your source has the ability to reduce the data produced, but
  the output may still include rows that do not satisfy the predicate. For
  example, you might skip entire files based on metadata statistics but not
  filter individual rows within a file. DataFusion will still add a `FilterExec`
  above your scan to remove any remaining rows that slipped through.
- **`Unsupported`** -- Your source ignores this filter entirely. DataFusion
  handles it.

### Why Filter Pushdown Matters

Consider a table with 1 billion rows partitioned by `region`, and a query:

```sql
SELECT * FROM events WHERE region = 'us-east-1' AND event_type = 'click';
```

**Without filter pushdown:** Your table provider reads all 1 billion rows
across all regions. DataFusion then applies both filters, discarding the vast
majority of the data.

**With filter pushdown on `region`:** Your `scan()` method sees the
`region = 'us-east-1'` filter and constructs an execution plan that only reads
the `us-east-1` partition. If that partition holds 100 million rows, you have
just eliminated 90% of the I/O. DataFusion still applies the `event_type`
filter via `FilterExec` if you reported it as `Unsupported`.

### Using EXPLAIN to Debug Your Table Provider

The `EXPLAIN` statement is your best tool for understanding what DataFusion is
actually doing with your table provider. It shows the physical plan that
DataFusion will execute, including any operators it inserted:

```sql
EXPLAIN SELECT * FROM events WHERE region = 'us-east-1' AND event_type = 'click';
```

If you are using DataFrames, call `.explain(false, false)` for the logical plan
or `.explain(false, true)` for the physical plan. You can also print the plans
in verbose mode with `.explain(true, true)`.

**Before filter pushdown**, the plan might look like:

```text
FilterExec: region@0 = us-east-1 AND event_type@1 = click
  MyExecPlan: partitions=50
```

Here DataFusion is reading all 50 partitions and filtering everything
afterward. The `FilterExec` above your scan is doing all the predicate work.

**After implementing pushdown for `region`** (reported as `Exact`):

```text
FilterExec: event_type@1 = click
  MyExecPlan: partitions=5, filter=[region = us-east-1]
```

Now your exec reads only the 5 partitions for `us-east-1`, and the remaining
`FilterExec` only handles the `event_type` predicate. The `region` filter has
been fully absorbed by your scan.

**After implementing pushdown for both filters** (both `Exact`):

```text
MyExecPlan: partitions=5, filter=[region = us-east-1 AND event_type = click]
```

No `FilterExec` at all -- your source handles everything.

Similarly, `EXPLAIN` will reveal whether DataFusion is inserting unnecessary
`SortExec` or `RepartitionExec` nodes that you could eliminate by declaring
better output properties. Whenever your queries seem slower than expected,
`EXPLAIN` is the first place to look.

## Putting It All Together

---

Here is a minimal but complete example of a custom table provider that generates
data lazily during streaming:

```rust
use std::any::Any;
use std::sync::Arc;

use arrow::array::{Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Schema, SchemaRef};
use arrow::record_batch::RecordBatch;
use datafusion::catalog::TableProvider;
use datafusion::common::Result;
use datafusion::datasource::TableType;
use datafusion::execution::context::SessionState;
use datafusion::execution::SendableRecordBatchStream;
use datafusion::logical_expr::Expr;
use datafusion::physical_expr::EquivalenceProperties;
use datafusion::physical_plan::execution_plan::{Boundedness, EmissionType};
use datafusion::physical_plan::stream::RecordBatchStreamAdapter;
use datafusion::physical_plan::{
    ExecutionPlan, Partitioning, PlanProperties,
};
use futures::stream;

/// A table provider that generates sequential numbers on demand.
struct CountingTable {
    schema: SchemaRef,
    num_partitions: usize,
    rows_per_partition: usize,
}

impl CountingTable {
    fn new(num_partitions: usize, rows_per_partition: usize) -> Self {
        let schema = Arc::new(Schema::new(vec![
            Field::new("partition", DataType::Int64, false),
            Field::new("value", DataType::Int64, false),
        ]));
        Self { schema, num_partitions, rows_per_partition }
    }
}

#[async_trait::async_trait]
impl TableProvider for CountingTable {
    fn as_any(&self) -> &dyn Any { self }
    fn schema(&self) -> SchemaRef { Arc::clone(&self.schema) }
    fn table_type(&self) -> TableType { TableType::Base }

    async fn scan(
        &self,
        _state: &dyn Session,
        projection: Option<&Vec<usize>>,
        _filters: &[Expr],
        limit: Option<usize>,
    ) -> Result<Arc<dyn ExecutionPlan>> {
        // Light work only: build the plan with metadata
        Ok(Arc::new(CountingExec {
            schema: Arc::clone(&self.schema),
            num_partitions: self.num_partitions,
            rows_per_partition: limit
                .unwrap_or(self.rows_per_partition)
                .min(self.rows_per_partition),
            properties: PlanProperties::new(
                EquivalenceProperties::new(Arc::clone(&self.schema)),
                Partitioning::UnknownPartitioning(self.num_partitions),
                EmissionType::Incremental,
                Boundedness::Bounded,
            ),
        }))
    }
}

struct CountingExec {
    schema: SchemaRef,
    num_partitions: usize,
    rows_per_partition: usize,
    properties: PlanProperties,
}

impl ExecutionPlan for CountingExec {
    fn name(&self) -> &str { "CountingExec" }
    fn as_any(&self) -> &dyn Any { self }
    fn properties(&self) -> &PlanProperties { &self.properties }
    fn children(&self) -> Vec<&Arc<dyn ExecutionPlan>> { vec![] }

    fn with_new_children(
        self: Arc<Self>,
        _children: Vec<Arc<dyn ExecutionPlan>>,
    ) -> Result<Arc<dyn ExecutionPlan>> {
        Ok(self)
    }

    fn execute(
        &self,
        partition: usize,
        _context: Arc<TaskContext>,
    ) -> Result<SendableRecordBatchStream> {
        let schema = Arc::clone(&self.schema);
        let rows = self.rows_per_partition;

        // The heavy work (data generation) happens inside the stream,
        // not here in execute().
        let batch_stream = stream::once(async move {
            let partitions = Int64Array::from(
                vec![partition as i64; rows],
            );
            let values = Int64Array::from(
                (0..rows as i64).collect::<Vec<_>>(),
            );
            let batch = RecordBatch::try_new(
                Arc::clone(&schema),
                vec![Arc::new(partitions), Arc::new(values)],
            )?;
            Ok(batch)
        });

        Ok(Box::pin(RecordBatchStreamAdapter::new(
            Arc::clone(&self.schema),
            batch_stream,
        )))
    }
}
```

## Choosing the Right Starting Point

---

Not every custom data source requires implementing all three layers from
scratch. DataFusion provides building blocks that let you plug in at whatever
level makes sense:

| If your data is... | Start with | You implement |
|---|---|---|
| Already in `RecordBatch`es in memory | [`MemTable`] | Nothing -- just construct it |
| An async stream of batches | [`StreamTable`] | A stream factory |
| A table with known sort order | [`SortedTableProvider`] wrapping another provider | The inner provider |
| A custom source needing full control | `TableProvider` + `ExecutionPlan` + stream | All three layers |

For most integrations, [`StreamTable`] combined with
[`RecordBatchStreamAdapter`] provides a good balance of simplicity and
flexibility. You provide a closure that returns a stream, and DataFusion handles
the rest.

## Acknowledgements

I would like to thank [Rerun.io] for sponsoring the development of this work. [Rerun.io]
is building a data visualization system for Physical AI and makes heavy use of DataFusion
table providers for working with data analytics.

[Rerun.io]: https://rerun.io

## Further Reading

---

- [TableProvider API docs][`TableProvider`]
- [ExecutionPlan API docs][`ExecutionPlan`]
- [SendableRecordBatchStream API docs][`SendableRecordBatchStream`]
- [GitHub issue discussing table provider examples](https://github.com/apache/datafusion/issues/16821)
- [DataFusion examples directory](https://github.com/apache/datafusion/tree/main/datafusion-examples/examples) --
  contains working examples including custom table providers

---

*Note: Portions of this blog post were written with the assistance of an AI agent.*
