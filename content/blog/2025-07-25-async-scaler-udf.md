---
layout: post
title: Async Scaler User defined Functions in DataFusion
date: 2025-07-25
author: Aditya Singh Rathore
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

Imagine writing SQL that can call APIs, interact with AI models, or fetch data from external storage—all natively within your query. This isn't a dream anymore. [Apache DataFusion] has just introduced **Asynchronous User Defined Functions (Async UDFs)**, making it one of the **first SQL engines** to support native asynchronous operations in query execution.

## The Synchronous Limitation

Traditional [User Defined Functions (UDFs)] in DataFusion (and most SQL engines) are synchronous, limiting them to CPU-bound operations. While perfect for mathematical calculations or string manipulations, they fall short when you need to:

- Make HTTP requests to external APIs (Wikipedia, OpenAI, REST services)
- Fetch data from cloud object storage on demand
- Perform I/O-heavy operations or long-running computations
- Integrate with external databases or microservices

These real-world scenarios often require **waiting** for external resources—something synchronous functions simply can't handle efficiently.

[User Defined Functions (UDFs)]: https://datafusion.apache.org/library-user-guide/functions/adding-udfs.html#

## Enter Async UDFs: SQL That Talks to the World

DataFusion's async UDFs remove this fundamental limitation. Now you can write SQL queries that seamlessly integrate with the outside world, opening up possibilities like:

```sql
--Note - this is just an Example
-- Query with AI-powered content analysis
SELECT content, classify_sentiment(content) as sentiment
FROM social_posts
WHERE analyze_toxicity(content) = false;

-- Enrich data with external API calls
SELECT user_id, enrich_user_profile(user_id) as profile_data
FROM users
LIMIT 100;
```

## Understanding Sync vs Async UDFs

Before diving into implementation, it's crucial to understand when to use each type:
**Synchronous UDFs** are perfect for:

- Pure computations (math, string operations)
- CPU-intensive algorithms
- Operations that complete instantly
- Functions that don't need external resources

**Asynchronous UDFs** excel at:

- Network requests (HTTP APIs, database calls)
- File I/O operations
- Long-running computations that can yield control
- Any operation that involves "waiting"

**The key insight**: if your function might block waiting for something external, make it async.

## Building Your First Async UDF: An AI-Powered Example

Let's create a practical async UDF that simulates asking an LLM whether an animal is furry. While our example uses mock logic, it demonstrates the pattern you'd use for real AI service integration.

```rust
use arrow::array::{ArrayRef, BooleanArray, Int64Array, RecordBatch, StringArray};
use arrow_schema::{DataType, Field, Schema};
use async_trait::async_trait;
use datafusion::assert_batches_eq;
use datafusion::common::cast::as_string_view_array;
use datafusion::common::error::Result;
use datafusion::common::not_impl_err;
use datafusion::common::utils::take_function_args;
use datafusion::config::ConfigOptions;
use datafusion::execution::SessionStateBuilder;
use datafusion::logical_expr::async_udf::{AsyncScalarUDF, AsyncScalarUDFImpl};
use datafusion::logical_expr::{
    ColumnarValue, ScalarFunctionArgs, ScalarUDFImpl, Signature, Volatility,
};
use datafusion::prelude::{SessionConfig, SessionContext};
use std::any::Any;
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<()> {
    // Use a hard coded parallelism level of 4 so the explain plan
    // is consistent across machines.
    let config = SessionConfig::new().with_target_partitions(4);
    let ctx =
        SessionContext::from(SessionStateBuilder::new().with_config(config).build());

    // Similarly to regular UDFs, you create an AsyncScalarUDF by implementing
    // `AsyncScalarUDFImpl` and creating an instance of `AsyncScalarUDF`.
    let async_equal = AskLLM::new();
    let udf = AsyncScalarUDF::new(Arc::new(async_equal));

    // Async UDFs are registered with the SessionContext, using the same
    // `register_udf` method as regular UDFs.
    ctx.register_udf(udf.into_scalar_udf());

    // Create a table named 'animal' with some sample data
    ctx.register_batch("animal", animal()?)?;

    // You can use the async UDF as normal in SQL queries
    //
    // Note: Async UDFs can currently be used in the select list and filter conditions.
    let results = ctx
        .sql("select * from animal a where ask_llm(a.name, 'Is this animal furry?')")
        .await?
        .collect()
        .await?;

    assert_batches_eq!(
        [
            "+----+------+",
            "| id | name |",
            "+----+------+",
            "| 1  | cat  |",
            "| 2  | dog  |",
            "+----+------+",
        ],
        &results
    );

    // While the interface is the same for both normal and async UDFs, you can
    // use `EXPLAIN` output to see that the async UDF uses a special
    // `AsyncFuncExec` node in the physical plan:
    let results = ctx
        .sql("explain select * from animal a where ask_llm(a.name, 'Is this animal furry?')")
        .await?
        .collect()
        .await?;

    assert_batches_eq!(
        [
    "+---------------+--------------------------------------------------------------------------------------------------------------------------------+",
    "| plan_type     | plan                                                                                                                           |",
    "+---------------+--------------------------------------------------------------------------------------------------------------------------------+",
    "| logical_plan  | SubqueryAlias: a                                                                                                               |",
    "|               |   Filter: ask_llm(CAST(animal.name AS Utf8View), Utf8View(\"Is this animal furry?\"))                                            |",
    "|               |     TableScan: animal projection=[id, name]                                                                                    |",
    "| physical_plan | CoalesceBatchesExec: target_batch_size=8192                                                                                    |",
    "|               |   FilterExec: __async_fn_0@2, projection=[id@0, name@1]                                                                        |",
    "|               |     RepartitionExec: partitioning=RoundRobinBatch(4), input_partitions=1                                                       |",
    "|               |       AsyncFuncExec: async_expr=[async_expr(name=__async_fn_0, expr=ask_llm(CAST(name@1 AS Utf8View), Is this animal furry?))] |",
    "|               |         CoalesceBatchesExec: target_batch_size=8192                                                                            |",
    "|               |           DataSourceExec: partitions=1, partition_sizes=[1]                                                                    |",
    "|               |                                                                                                                                |",
    "+---------------+--------------------------------------------------------------------------------------------------------------------------------+",
        ],
        &results
    );

    Ok(())
}

/// Returns a sample `RecordBatch` representing an "animal" table with two columns:
fn animal() -> Result<RecordBatch> {
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("name", DataType::Utf8, false),
    ]));

    let id_array = Arc::new(Int64Array::from(vec![1, 2, 3, 4, 5]));
    let name_array = Arc::new(StringArray::from(vec![
        "cat", "dog", "fish", "bird", "snake",
    ]));

    Ok(RecordBatch::try_new(schema, vec![id_array, name_array])?)
}

/// An async UDF that simulates asking a large language model (LLM) service a
/// question based on the content of two columns. The UDF will return a boolean
/// indicating whether the LLM thinks the first argument matches the question in
/// the second argument.
///
/// Since this is a simplified example, it does not call an LLM service, but
/// could be extended to do so in a real-world scenario.
#[derive(Debug)]
struct AskLLM {
    signature: Signature,
}

impl Default for AskLLM {
    fn default() -> Self {
        Self::new()
    }
}

impl AskLLM {
    pub fn new() -> Self {
        Self {
            signature: Signature::exact(
                vec![DataType::Utf8View, DataType::Utf8View],
                Volatility::Volatile,
            ),
        }
    }
}

/// All async UDFs implement the `ScalarUDFImpl` trait, which provides the basic
/// information for the function, such as its name, signature, and return type.
/// [async_trait]
impl ScalarUDFImpl for AskLLM {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn name(&self) -> &str {
        "ask_llm"
    }

    fn signature(&self) -> &Signature {
        &self.signature
    }

    fn return_type(&self, _arg_types: &[DataType]) -> Result<DataType> {
        Ok(DataType::Boolean)
    }

    /// Since this is an async UDF, the `invoke_with_args` method will not be
    /// called directly.
    fn invoke_with_args(&self, _args: ScalarFunctionArgs) -> Result<ColumnarValue> {
        not_impl_err!("AskLLM can only be called from async contexts")
    }
}

/// In addition to [`ScalarUDFImpl`], we also need to implement the
/// [`AsyncScalarUDFImpl`] trait.
#[async_trait]
impl AsyncScalarUDFImpl for AskLLM {
    /// The `invoke_async_with_args` method is similar to `invoke_with_args`,
    /// but it returns a `Future` that resolves to the result.
    ///
    /// Since this signature is `async`, it can do any `async` operations, such
    /// as network requests. This method is run on the same tokio `Runtime` that
    /// is processing the query, so you may wish to make actual network requests
    /// on a different `Runtime`, as explained in the `thread_pools.rs` example
    /// in this directory.
    async fn invoke_async_with_args(
        &self,
        args: ScalarFunctionArgs,
        _option: &ConfigOptions,
    ) -> Result<ArrayRef> {
        // in a real UDF you would likely want to special case constant
        // arguments to improve performance, but this example converts the
        // arguments to arrays for simplicity.
        let args = ColumnarValue::values_to_arrays(&args.args)?;
        let [content_column, question_column] = take_function_args(self.name(), args)?;

        // In a real function, you would use a library such as `reqwest` here to
        // make an async HTTP request. Credentials and other configurations can
        // be supplied via the `ConfigOptions` parameter.

        // In this example, we will simulate the LLM response by comparing the two
        // input arguments using some static strings
        let content_column = as_string_view_array(&content_column)?;
        let question_column = as_string_view_array(&question_column)?;

        let result_array: BooleanArray = content_column
            .iter()
            .zip(question_column.iter())
            .map(|(a, b)| {
                // If either value is null, return None
                let a = a?;
                let b = b?;
                // Simulate an LLM response by checking the arguments to some
                // hardcoded conditions.
                if a.contains("cat") && b.contains("furry")
                    || a.contains("dog") && b.contains("furry")
                {
                    Some(true)
                } else {
                    Some(false)
                }
            })
            .collect();

        Ok(Arc::new(result_array))
    }
}

```

## Key Implementation Points

### 1. Dual Trait Implementation

Async UDFs implement both `ScalarUDFImpl` (for metadata) and `AsyncScalarUDFImpl` (for async execution).This design allows DataFusion to optimize async operations while maintaining compatibility with the existing UDF system.

### 2. Natural SQL Integration

Once registered, async UDFs work seamlessly in SQL queries—users don't need to know they're async.

### 3. Special Execution Path

DataFusion automatically uses `AsyncFuncExec` nodes in the physical plan for efficient async execution.

### 4. Production Considerations

For heavy I/O operations, consider using a separate tokio runtime to prevent blocking the query engine's main runtime.

## Real-World Use Cases

Async UDFs unlock powerful patterns:
**AI-Powered Analytics:**

```sql
SELECT product_id,
       sentiment_score(review_text) as sentiment,
       classify_intent(review_text) as intent
FROM product_reviews
WHERE toxicity_check(review_text) = 'safe';
```

**External Validation:**

```sql
SELECT email,
       validate_email_deliverability(email) as is_valid
FROM email_list
WHERE domain_reputation_check(email) > 0.8;
```

## Performance and Best Practices

1. **Batch Processing**: Async UDFs process entire Arrow arrays, enabling efficient bulk operations
2. **Runtime Isolation**: Consider separate tokio runtimes for heavy I/O to prevent blocking
3. **Error Handling**: Implement robust retry logic and graceful degradation
4. **Caching**: Cache expensive API responses when appropriate
5. **Rate Limiting**: Respect external service limits with proper throttling

## The Bigger picture: Why This Matters

[DataFusion](https://datafusion.apache.org/)'s sync UDF implementation isn't just another feature-it's a **paradigm shift** in how we think about SQL engines. While user-defined scalar and aggregate functions are common across databases, **native async support in SQL execution** puts DataFusion in uncharted territory.

Traditional SQL engines treat the database as an island. Data flows in through ETL pipelines, gets processed, and flows out through reports or APIs. But modern applications need something more fluid—they need SQL that can reach out to the world in real-time, making decisions based on live data from multiple sources.

Consider the transformative possibilities:

- **Financial services** running fraud detection that queries real-time risk APIs during transaction processing
- **E-commerce platforms** enriching product catalogs with live pricing from competitor APIs
- **Healthcare systems** validating patient data against external medical databases
- **IoT platforms** correlating sensor data with weather services and maintenance APIs

This isn't just about convenience—it's about **breaking down the barriers** between analytical workloads and operational systems.

## Getting Started and Best Practices

Ready to dive in? Here's your roadmap:

1. **Start Simple**: Begin with mock implementations like our LLM example, then gradually add real HTTP clients and external integrations.
2. **Study the Patterns**: The DataFusion [UDF documentation](https://datafusion.apache.org/library-user-guide/functions/adding-udfs.html#) provides essential patterns for both sync and async implementations.
3. **Performance First**: Async doesn't automatically mean faster. Profile your implementations and consider batching strategies for external API calls.
4. **Error Resilience**: Network calls fail. Design your UDFs with circuit breakers, retries, and graceful degradation from the start.
5. **Security Mindset**: External integrations introduce new attack vectors. Validate inputs, sanitize outputs, and consider rate limiting.

## Join the Revolution

The [Apache Arrow](https://arrow.apache.org/) and [DataFusion](https://datafusion.apache.org/) communities aren't just building a query engine—they're **reimagining what analytical computing can be**. Every contribution, from bug reports to feature implementations, helps push the boundaries of what's possible.
Whether you're a Rust veteran or just getting started, there's a place for you:

- **Developers:** Dive into the [open issues](https://github.com/apache/datafusion/issues) and help build the future
- **Users:** Share your async UDF use cases and help shape the roadmap
- **Advocates:** Write about your experiences and help others discover these capabilities
- **Researchers:** Explore the performance characteristics and help optimize async execution

For anyone who is curious about [DataFusion](https://datafusion.apache.org/) I highly recommend
giving it a try. This post was designed to make it easier for new users to work with Aync User Defined Window Functions by providing practical examples and real-world patterns.

The async UDF feature is just the beginning. As more developers experiment and share their innovations, we'll see new patterns emerge that we can't even imagine today.

Heartfelt thanks to [@alamb] for the invaluable reviews and insights that shaped this exploration, and to [@andygrove] and the entire DataFusion community for making this groundbreaking feature a reality.

`The future of SQL is async, distributed, and connected. Welcome to the new era of analytical computing.`

[@alamb]: https://github.com/alamb
[@andygrove]: https://github.com/andygrove
