---
layout: post
title: User defined Window Functions in DataFusion 
date: 2025-04-17
author: Aditya Singh Rathore , Andrew Lamb
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


Window functions are a powerful feature in SQL, allowing for complex analytical computations over a subset of data. However, efficiently implementing them, especially sliding windows, can be quite challenging. With [Apache DataFusion]'s user-defined window functions, developers can easily take advantage of all the effort put into DataFusion's implementation.

In this post, we'll explore:

- What window functions are and why they matter

- Understanding sliding windows

- The challenges of computing window aggregates efficiently

- How to implement user-defined window functions in DataFusion


[Apache DataFusion]: https://datafusion.apache.org/

## Understanding Window Functions in SQL 


Imagine you're analyzing sales data and want insights without losing the finer details. This is where **[window functions]** come into play. Unlike **GROUP BY**, which condenses data, window functions let you retain each row while performing calculations over a defined **range** —like having a moving lens over your dataset.

[window functions]: https://en.wikipedia.org/wiki/Window_function_(SQL)


Picture a business tracking daily sales. They need a running total to understand cumulative revenue trends without collapsing individual transactions. SQL makes this easy:
```sql
SELECT id, value, SUM(value) OVER (ORDER BY id) AS running_total
FROM sales;
```

```text
example:
+------------+--------+-------------------------------+
|   Date     | Sales  | Rows Considered               |
+------------+--------+-------------------------------+
| Jan 01     | 100    | [100]                         |
| Jan 02     | 120    | [100, 120]                    |
| Jan 03     | 130    | [100, 120, 130]               |
| Jan 04     | 150    | [100, 120, 130, 150]          |
| Jan 05     | 160    | [100, 120, 130, 150, 160]     |
| Jan 06     | 180    | [100, 120, 130, 150, 160, 180]|
| Jan 07     | 170    | [100, ..., 170] (7 days)      |
| Jan 08     | 175    | [120, ..., 175]               |
+------------+--------+-------------------------------+
```
**Figure 1**: A row-by-row representation of how a 7-day moving average includes the previous 6 days and the current one.


This helps in analytical queries where we need cumulative sums, moving averages, or ranking without losing individual records.


## User Defined Window Functions
DataFusion's [Built-in window functions] such as `first_value`, `rank` and `row_number` serve many common use cases, but sometimes custom logic is needed—for example:

- Calculating moving averages with complex conditions (e.g. exponential averages, integrals, etc)

- Implementing a custom ranking strategy

- Tracking non-standard cumulative logic

Thus, **User-Defined Window Functions (UDWFs)** allow developers to define their own behavior while allowing DataFusion to handle the calculations of the  windows and grouping specified in the `OVER` clause

Writing a user defined window function is slightly more complex than an aggregate function due
to the variety of ways that window functions are called. I recommend reviewing the
[online documentation](https://datafusion.apache.org/library-user-guide/adding-udfs.html#registering-a-window-udf)
for a description of which functions need to be implemented. 

[Built-in window functions]: https://datafusion.apache.org/user-guide/sql/window_functions.html

## Understanding Sliding Window 

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

DataFusion implements the battle tested sort-based approach described in [this
paper] which is also used in systems such as Postgresql and Vertica. The input
is first sorted by both the `PARTITION BY` and `ORDER BY` expressions and
then the [WindowAggExec] operator efficiently determines the partition boundaries and
creates appropriate [PartitionEvaluator] instances. 

The sort-based approach is well understood, scales to large data sets, and
leverages DataFusion's highly optimized sort implementation. DataFusion minimizes
resorting by leveraging the sort order tracking and optimizations described in
the [Using Ordering for Better Plans blog]. 

For example, given the query such as the following to compute the starting,
ending and average price for each stock:

```sql
SELECT 
  FIRST_VALUE(price) OVER (PARTITION BY date_bin('1 month', time) ORDER BY time DESC) AS start_price, 
  FIRST_VALUE(price) OVER (PARTITION BY date_bin('1 month', time) ORDER BY time DESC) AS end_price,
  AVG(price)         OVER (PARTITION BY date_bin('1 month', time))                    AS avg_price
FROM quotes;
```

If the input data is not sorted, DataFusion will first sort the data by the
`date_bin` and `time` and then [WindowAggExec] computes the partition boundaries
and invokes the appropriate [PartitionEvaluator] API methods depending on the window
definition in the `OVER` clause and the declared capabilities of the function.

For example, evaluating `window_func(val) OVER (PARTITION BY col)`
on the following data:

```text
col | val
--- + ----
 A  | 10
 A  | 10
 C  | 20
 D  | 30
 D  | 30
```

Will instantiate three [PartitionEvaluator]s, one each for the
partitions defined by `col=A`, `col=B`, and `col=C`.

```text
col | val
--- + ----
 A  | 10     <--- partition 1
 A  | 10

col | val
--- + ----
 C  | 20     <--- partition 2

col | val
--- + ----
 D  | 30     <--- partition 3
 D  | 30
```

[this paper]: https://www.vldb.org/pvldb/vol8/p1058-leis.pdf
[Using Ordering for Better Plans blog]: https://datafusion.apache.org/blog/2025/03/11/ordering-analysis/
[WindowAggExec]: https://github.com/apache/datafusion/blob/7ff6c7e68540c69b399a171654d00577e6f886bf/datafusion/physical-plan/src/windows/window_agg_exec.rs
[PartitionEvaluator]: https://docs.rs/datafusion/latest/datafusion/logical_expr/trait.PartitionEvaluator.html#background

### Creating your own Window Function

DataFusion supports [user-defined window aggregates (UDWAs)](https://datafusion.apache.org/library-user-guide/adding-udfs.html), meaning you can bring your own window function logic using the exact same APIs and performance as the built in functions.

For example, we will declare a user defined window function that computes a moving average.

```rust
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
```

Different evaluation methods are called depending on the various
settings of WindowUDF and the query. In the first example, we use the simplest and most
general, `evaluate` function. We will see how to use `PartitionEvaluator` for the other more
advanced uses later in the article.
 
```rust
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
To register a Window UDF, you need to wrap the function implementation in a [WindowUDF] struct and then register it with the `SessionContext`. DataFusion provides the [create_udwf] helper functions to make this easier. There is a lower level API with more functionality but is more complex, that is documented in [advanced_udwf.rs](https://github.com/apache/datafusion/blob/main/datafusion-examples/examples/advanced_udwf.rs).

[WindowUDF]: https://docs.rs/datafusion/latest/datafusion/logical_expr/struct.WindowUDF.html
[create_udwf]: https://docs.rs/datafusion/latest/datafusion/logical_expr/fn.create_udwf.html

```rust
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
The [create_udwf] functions take  five arguments:

- The **first argument** is the name of the function. This is the name that will be used in SQL queries.

- The **second argument** is the `DataType of` input array (attention: this is not a list of arrays). I.e. in this case, the function accepts `Float64` as argument.

- The **third argument** is the return type of the function. I.e. in this case, the function returns an `Float64`.

- The **fourth argument** is the volatility of the function. In short, this is used to determine if the function’s performance can be optimized in some situations. In this case, the function is `Immutable` because it always returns the same value for the same input. A random number generator would be `Volatile` because it returns a different value for the same input.

- The **fifth argument** is the function implementation. This is the function that we defined above.

[create_udwf]: https://docs.rs/datafusion/latest/datafusion/logical_expr/fn.create_udwf.html

That gives us a **WindowUDF** that we can register with the `SessionContext`:

```rust
use datafusion::execution::context::SessionContext;

let ctx = SessionContext::new();

ctx.register_udwf(smooth_it);
```

For example, if we have a [cars.csv](https://github.com/apache/datafusion/blob/main/datafusion/core/tests/data/cars.csv) whose contents like

```text
car,speed,time
red,20.0,1996-04-12T12:05:03.000000000
red,20.3,1996-04-12T12:05:04.000000000
green,10.0,1996-04-12T12:05:03.000000000
green,10.3,1996-04-12T12:05:04.000000000
...
```
Then, we can query like below:

```rust
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
...
+-------+-------+--------------------+---------------------+
```

This gives you full flexibility to build **domain-specific logic** that plugs seamlessly into DataFusion’s engine — all without sacrificing performance.


## Final Thoughts and Recommendations 
Window functions may be common in SQL, but *efficient and extensible* window functions in engines are rare. 
While many databases support user defined scalar and user defined aggregate functions, user defined window functions are not as common and Datafusion making it easier for all .

For anyone who is curious about [DataFusion](https://datafusion.apache.org/) I highly recommend
giving it a try. This post was designed to make it easier for new users to work with User Defined Window Functions by giving a few examples of how one might implement these.

When it comes to designing UDFs, I strongly recommend reviewing the 
[Window functions](https://datafusion.apache.org/library-user-guide/adding-udfs.html) documentation.

A heartfelt thank you to [@alamb] and [@andygrove] for their invaluable reviews and thoughtful feedback—they’ve been instrumental in shaping this post.

The Apache Arrow and DataFusion communities are vibrant, welcoming, and full of passionate developers building something truly powerful. If you’re excited about high-performance analytics and want to be part of an open-source journey, I highly encourage you to explore the [official documentation]((https://datafusion.apache.org/)) and dive into one of the many [open issues](https://github.com/apache/datafusion/issues). There’s never been a better time to get involved!


[@andygrove]: https://github.com/andygrove
[@alamb]: https://github.com/alamb


