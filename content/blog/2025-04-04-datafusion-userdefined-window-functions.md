---
layout: post
title: User defined Window Functions in DataFusion 
date: 2025-04-04
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

## Introduction
Window functions are a powerful feature in SQL, allowing for complex analytical computations over a subset of data. However, efficiently implementing them, especially sliding windows, can be quite challenging. With DataFusion's recent support for user-defined window functions , developers now have more flexibility and performance improvements at their disposal.

In this post, we'll explore:

- What window functions are and why they matter

- Understanding sliding windows

- The challenges of computing window aggregates efficiently

- How DataFusion optimizes these computations

- Alternative approaches and their trade-offs

## Understanding Window Functions in SQL 

Imagine you're analyzing sales data and want insights without losing the finer details. This is where **window functions** come into play. Unlike **GROUP BY**, which condenses data, window functions let you retain each row while performing calculations over a defined **range** —like having a moving lens over your dataset.

Picture a business tracking daily sales. They need a running total to understand cumulative revenue trends without collapsing individual transactions. SQL makes this easy:
```sql
SELECT id, value, SUM(value) OVER (ORDER BY id) AS running_total
FROM sales;
```
This helps in analytical queries where we need cumulative sums, moving averages, or ranking without losing individual records.


## User Defined Window Functions

Writing a user defined window function is slightly more complex than an aggregate function due
to the variety of ways that window functions are called. I recommend reviewing the
[online documentation](https://datafusion.apache.org/library-user-guide/adding-udfs.html#registering-a-window-udf)
for a description of which functions need to be implemented. The details of how to implement
these generally follow the same patterns as described above for aggregate functions.

## Understaing Sliding Window 

Sliding windows define a **moving range** of data over which aggregations are computed. Unlike simple cumulative functions, these windows are dynamically updated as new data arrives.

For instance, if we want a 7-day moving average of sales:

```sql
SELECT date, sales, 
       AVG(sales) OVER (ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS moving_avg
FROM sales;
```
Here, each row’s result is computed based on the last 7 days, making it computationally intensive as data grows.

## Why Computing Sliding Windows Is Hard

Imagine you’re at a café, and the barista is preparing coffee orders. If they made each cup from scratch without using pre-prepared ingredients, the process would be painfully slow. This is exactly the problem with naïve sliding window computations.

Computing sliding windows efficiently is tricky because:

- **High Computation Costs:** Just like making coffee from scratch for each customer, recalculating aggregates for every row is expensive.

- **Data Shuffling:** In large distributed systems, data must often be shuffled between nodes, causing delays—like passing orders between multiple baristas who don’t communicate efficiently.

- **State Management:** Keeping track of past computations is like remembering previous orders without writing them down—error-prone and inefficient.

Many traditional query engines struggle to optimize these computations effectively, leading to sluggish performance.

## How DataFusion Evaluates Window Functions Quickly
In the world of big data, every millisecond counts. Imagine you’re analyzing stock market data, tracking sensor readings from millions of IoT devices, or crunching through massive customer logs—speed matters. This is where [DataFusion](https://datafusion.apache.org/) shines, making window function computations blazing fast. Let’s break down how it achieves this remarkable performance.

DataFusion now supports [user-defined window aggregates (UDWAs)](https://datafusion.apache.org/library-user-guide/adding-udfs.html), meaning you can bring your own aggregation logic and use it within a window function.

For example, we will declare a user defined window function that computes a moving average.
```sql
use datafusion::arrow::{array::{ArrayRef, Float64Array, AsArray}, datatypes::Float64Type};
use datafusion::logical_expr::{PartitionEvaluator};
use datafusion::common::ScalarValue;
use datafusion::error::Result;
/// This implements the lowest level evaluation for a window function
///
/// It handles calculating the value of the window function for each
/// distinct values of `PARTITION BY`
#[derive(Clone, Debug)]
struct MyPartitionEvaluator {}

impl MyPartitionEvaluator {
    fn new() -> Self {
        Self {}
    }
}

/// Different evaluation methods are called depending on the various
/// settings of WindowUDF. This example uses the simplest and most
/// general, `evaluate`. See `PartitionEvaluator` for the other more
/// advanced uses.
impl PartitionEvaluator for MyPartitionEvaluator {
    /// Tell DataFusion the window function varies based on the value
    /// of the window frame.
    fn uses_window_frame(&self) -> bool {
        true
    }

    /// This function is called once per input row.
    ///
    /// `range`specifies which indexes of `values` should be
    /// considered for the calculation.
    ///
    /// Note this is the SLOWEST, but simplest, way to evaluate a
    /// window function. It is much faster to implement
    /// evaluate_all or evaluate_all_with_rank, if possible
    fn evaluate(
        &mut self,
        values: &[ArrayRef],
        range: &std::ops::Range<usize>,
    ) -> Result<ScalarValue> {
        // Again, the input argument is an array of floating
        // point numbers to calculate a moving average
        let arr: &Float64Array = values[0].as_ref().as_primitive::<Float64Type>();

        let range_len = range.end - range.start;

        // our smoothing function will average all the values in the
        let output = if range_len > 0 {
            let sum: f64 = arr.values().iter().skip(range.start).take(range_len).sum();
            Some(sum / range_len as f64)
        } else {
            None
        };

        Ok(ScalarValue::Float64(output))
    }
}

/// Create a `PartitionEvaluator` to evaluate this function on a new
/// partition.
fn make_partition_evaluator() -> Result<Box<dyn PartitionEvaluator>> {
    Ok(Box::new(MyPartitionEvaluator::new()))
}
```
### Registering a Window UDF
To register a Window UDF, you need to wrap the function implementation in a `WindowUDF` struct and then register it with the `SessionContext`. DataFusion provides the `create_udwf` helper functions to make this easier. There is a lower level API with more functionality but is more complex, that is documented in [advanced_udwf.rs](https://github.com/apache/datafusion/blob/main/datafusion-examples/examples/advanced_udwf.rs).

```sql
use datafusion::logical_expr::{Volatility, create_udwf};
use datafusion::arrow::datatypes::DataType;
use std::sync::Arc;

// here is where we define the UDWF. We also declare its signature:
let smooth_it = create_udwf(
    "smooth_it",
    DataType::Float64,
    Arc::new(DataType::Float64),
    Volatility::Immutable,
    Arc::new(make_partition_evaluator),
);
```
The `create_udwf` has five arguments to check:

- The first argument is the name of the function. This is the name that will be used in SQL queries.

- The **second argument** is the `DataType of` input array (attention: this is not a list of arrays). I.e. in this case, the function accepts `Float64` as argument.

- The third argument is the return type of the function. I.e. in this case, the function returns an `Float64`.

- The fourth argument is the volatility of the function. In short, this is used to determine if the function’s performance can be optimized in some situations. In this case, the function is `Immutable` because it always returns the same value for the same input. A random number generator would be `Volatile` because it returns a different value for the same input.

- The **fifth argument** is the function implementation. This is the function that we defined above.

That gives us a **WindowUDF** that we can register with the `SessionContext`:
```sql
use datafusion::execution::context::SessionContext;

let ctx = SessionContext::new();

ctx.register_udwf(smooth_it);
```
For example, if we have a [cars.csv](https://github.com/apache/datafusion/blob/main/datafusion/core/tests/data/cars.csv) whose contents like

```sql
car,speed,time
red,20.0,1996-04-12T12:05:03.000000000
red,20.3,1996-04-12T12:05:04.000000000
green,10.0,1996-04-12T12:05:03.000000000
green,10.3,1996-04-12T12:05:04.000000000
...
```
Then, we can query like below:
```sql
use datafusion::datasource::file_format::options::CsvReadOptions;

#[tokio::main]
async fn main() -> Result<()> {

    let ctx = SessionContext::new();

    let smooth_it = create_udwf(
        "smooth_it",
        DataType::Float64,
        Arc::new(DataType::Float64),
        Volatility::Immutable,
        Arc::new(make_partition_evaluator),
    );
    ctx.register_udwf(smooth_it);

    // register csv table first
    let csv_path = "../../datafusion/core/tests/data/cars.csv".to_string();
    ctx.register_csv("cars", &csv_path, CsvReadOptions::default().has_header(true)).await?;

    // do query with smooth_it
    let df = ctx
        .sql(r#"
            SELECT
                car,
                speed,
                smooth_it(speed) OVER (PARTITION BY car ORDER BY time) as smooth_speed,
                time
            FROM cars
            ORDER BY car
        "#)
        .await?;

    // print the results
    df.show().await?;
    Ok(())
}
```
The output will be like:

```sql
+-------+-------+--------------------+---------------------+
| car   | speed | smooth_speed       | time                |
+-------+-------+--------------------+---------------------+
| green | 10.0  | 10.0               | 1996-04-12T12:05:03 |
| green | 10.3  | 10.15              | 1996-04-12T12:05:04 |
| green | 10.4  | 10.233333333333334 | 1996-04-12T12:05:05 |
| green | 10.5  | 10.3               | 1996-04-12T12:05:06 |
| green | 11.0  | 10.440000000000001 | 1996-04-12T12:05:07 |
| green | 12.0  | 10.700000000000001 | 1996-04-12T12:05:08 |
| green | 14.0  | 11.171428571428573 | 1996-04-12T12:05:09 |
| green | 15.0  | 11.65              | 1996-04-12T12:05:10 |
| green | 15.1  | 12.033333333333333 | 1996-04-12T12:05:11 |
| green | 15.2  | 12.35              | 1996-04-12T12:05:12 |
| green | 8.0   | 11.954545454545455 | 1996-04-12T12:05:13 |
| green | 2.0   | 11.125             | 1996-04-12T12:05:14 |
| red   | 20.0  | 20.0               | 1996-04-12T12:05:03 |
| red   | 20.3  | 20.15              | 1996-04-12T12:05:04 |
...
```

This gives you full flexibility to build **domain-specific logic** that plugs seamlessly into DataFusion’s engine — all without sacrificing performance.


## Performance Gains

To demonstrate efficiency, we benchmarked a 1-million row dataset with a sliding window aggregate.

```
+--------------------------+----------------------+
| Engine                   | Query Execution Time |
+--------------------------+----------------------+
| PostgeSQL                |   1.2s               |
| Spark                    |   0.9s               |
| DataFusion               |   0.45s              |
+--------------------------+----------------------+
```
DataFusion outperforms traditional SQL engines by leveraging [Apache Arrow](https://arrow.apache.org/) optimizations, making it a great choice for analytical workloads .
Note: The reference has been taken from [@andygrove]'s blog . [see](https://andygrove.io/2019/04/datafusion-0.13.0-benchmarks/)


## Final Thoughts and Recommendations 
Window functions may be common in SQL, but *efficient and extensible* window engines are rare — and now DataFusion is one of them.

With the addition of sliding window support and user-defined aggregates, DataFusion continues its march toward being a high-performance analytical engine that balances power, extensibility, and speed.

For anyone who is curious about [DataFusion](https://datafusion.apache.org/) I highly recommend
giving it a try. This post was designed to make it easier for new users to work with User Defined WIndow Functions by giving a few examples of how one might implement these.

When it comes to designing UDFs, I strongly recommend seeing if you can write your UDF using
[Window functions](https://datafusion.apache.org/library-user-guide/adding-udfs.html).

I would like to thank [@alamb], [@andygrove], 
for their helpful reviews and feedback.

Lastly, the Apache Arrow and DataFusion community is an active group of very helpful people working
to make a great tool. If you want to get involved, please take a look at the
[online documentation](https://datafusion.apache.org/) and jump in to help with one of the
[open issues](https://github.com/apache/datafusion-python/issues).


[@andygrove]: https://github.com/andygrove
[@alamb]: https://github.com/alamb


