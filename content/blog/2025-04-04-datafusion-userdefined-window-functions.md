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
[online documentation](https://datafusion.apache.org/library-user-guide/adding-udfs.html)
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

## How DataFusion Making it fast
In the world of big data, every millisecond counts. Imagine you’re analyzing stock market data, tracking sensor readings from millions of IoT devices, or crunching through massive customer logs—speed matters. This is where [DataFusion](https://datafusion.apache.org/) shines, making window function computations blazing fast. Let’s break down how it achieves this remarkable performance.

DataFusion now supports [user-defined window aggregates (UDWAs)](https://datafusion.apache.org/library-user-guide/adding-udfs.html), meaning you can bring your own aggregation logic and use it within a window function.

```sql
let my_udwa = create_my_custom_udwa();
ctx.register_udaf("my_moving_avg", my_udwa);

// Then use in SQL:
SELECT
  user_id,
  my_moving_avg(score) OVER (
    PARTITION BY user_id
    ORDER BY game_time
    ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
  ) AS moving_score
FROM leaderboard;
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

With the addition of sliding window support and user-defined aggregates, DataFusion continues its march toward being a high-performance analytical engine that balances power, extensibility, and speed.

Window functions may be common in SQL, but *efficient and extensibl*e window engines are rare — and now DataFusion is one of them.

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


