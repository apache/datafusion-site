---
layout: post
title: Optimizing SQL (and DataFrames) in DataFusion, Part 1: Query Optimization Overview
date: 2025-06-15
author: alamb, akurmustafa
categories: [core]
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



*Note: this blog was originally published [on the InfluxData blog](https://www.influxdata.com/blog/optimizing-sql-dataframes-part-one/)*


## Introduction

Sometimes Query Optimizers are seen as a sort of black magic, [“the most
challenging problem in computer
science,”](https://15799.courses.cs.cmu.edu/spring2025/) according to Father
Pavlo, or some behind-the-scenes player. We believe this perception is because:


1. One must implement the rest of a database system (data storage, transactions,
   SQL parser, expression evaluation, plan execution, etc.) **before** the
   optimizer becomes critical<sup id="fn5">[5](#footnote5)</sup>.

2. Some parts of the optimizer are tightly tied to the rest of the system (e.g.,
   storage or indexes), so many classic optimizers are described with
   system-specific terminology.

3. Some optimizer tasks, such as access path selection and join order are known
   challenges and not yet solved (practically)—maybe they really do require
   black magic 🤔.

However, Query Optimizers are no more complicated in theory or practice than other parts of a database system, as we will argue in a series of posts:

**Part 1: (this post)**:

* Review what a Query Optimizer is, what it does, and why you need one for SQL and DataFrames.
* Describe how industrial Query Optimizers are structured and standard optimization classes.

**Part 2:**

* Describe the optimization categories with examples and pointers to implementations.
* Describe [Apache DataFusion](https://datafusion.apache.org/)’s rationale and approach to query optimization, specifically for access path and join ordering.

After reading these blogs, we hope people will use DataFusion to:

1. Build their own system specific optimizers.
2. Perform practical academic research on optimization (especially researchers
   working on new optimizations / join ordering—looking at you [CMU
   15-799](https://15799.courses.cs.cmu.edu/spring2025/), next year).


## Query Optimizer Background

The key pitch for querying databases, and likely the key to the longevity of SQL
(despite people’s love/hate relationship—see [SQL or Death? Seminar Series –
Spring 2025](https://db.cs.cmu.edu/seminar2025/)), is that it disconnects the
`WHAT` you want to compute from the `HOW` to do it. SQL is a *declarative*
language—it describes what answers are desired rather than an *imperative*
language such as Python, where you describe how to do the computation as shown
in Figure 1.

<img src="/blog/images/optimizing-sql-dataframes/query-execution.png" width="80%" class="img-responsive" alt="Fig 1: Query Execution."/>

**Figure 1**: Query Execution: Users describe the answer they want using either
a DataFrame or SQL. The query planner or DataFrame API translates that
description into an *Initial Plan*, which is correct but slow. The Query
Optimizer then rewrites the initial plan to an *Optimized Plan*, which computes
the same results but faster and more efficiently. Finally, the Execution Engine
executes the optimized plan producing results.

## SQL, DataFrames, LogicalPlan Equivalence

Given their name, it is not surprising that Query Optimizers can improve the
performance of SQL queries. However, it is under-appreciated that this also
applies to DataFrame style APIs.

Classic DataFrame systems such as [pandas] and [Polars] (by default) execute
eagerly and thus have limited opportunities for optimization. However, more
modern APIs such as [Polar's lazy API], [Apache Spark's DataFrame]. and
[DataFusion's DataFrame] are much faster as they use the design shown in Figure
1 and apply many query optimization techniques.

[pandas]: https://pandas.pydata.org/
[Polars]: https://pola.rs/) 
[Polar'’'s lazy API]: https://docs.pola.rs/user-guide/lazy/using/
[Apache Spark's DataFrame]: https://spark.apache.org/docs/latest/sql-programming-guide.html#datasets-and-dataframes),
[DataFusion's DataFrame]: https://datafusion.apache.org/user-guide/dataframe.html

## Example of Query Optimizer

This section motivates the value of a Query Optimizer with an example. Let’s say
you have some observations of animal behavior, as illustrated in Table 1.

<img src="/blog/images/optimizing-sql-dataframes/table1.png" width="75%" class="img-responsive" alt="Table 1: Observational Data."/>

**Table 1**: Example observational data.

If the user wants to know the average population for some species in the last
month, a user can write a SQL query or a DataFrame such as the following:

SQL:

```sql
SELECT location, AVG(population)
FROM observations
WHERE species = ‘contrarian spider’ AND 
  observation_time >= now() - interval '1 month'
GROUP BY location
```

DataFrame:

```rust
df.scan("observations")
  .filter(col("species").eq("contrarian spider"))
  .filter(col("observation_time").ge(now()).sub(interval('1 month')))
  .agg(vec![col(location)], vec![avg(col("population")])
```

Within DataFusion, both the SQL and DataFrame are translated into the same
[`LogicalPlan`] , a “tree of relational operators.” This is a fancy way of
saying data flow graphs where the edges represent tabular data (rows + columns)
and the nodes represent a transformation (see [this DataFusion overview video]
for more details). The initial `LogicalPlan` for the queries above is shown in
Figure 2.

[`LogicalPlan`]: https://docs.rs/datafusion/latest/datafusion/logical_expr/enum.LogicalPlan.html
[this DataFusion overview video]: https://youtu.be/EzZTLiSJnhY

<img src="/blog/images/optimizing-sql-dataframes/initial-logical-plan.png" width="72%" class="img-responsive" alt="Fig 2: Initial Logical Plan."/>

**Figure 2**: Example initial `LogicalPlan` for SQL and DataFrame query. The
plan is read from bottom to top, computing the results in each step.

The optimizer's job is to take this query plan and rewrite it into an alternate
plan that computes the same results but faster, such as the one shown in Figure
3.

<img src="/blog/images/optimizing-sql-dataframes/optimized-logical-plan.png" width="80%" class="img-responsive" alt="Fig 3: Optimized Logical Plan."/>

**Figure 3**: An example optimized plan that computes the same result as the
plan in Figure 2 more efficiently. The diagram highlights where the optimizer
has applied *Projection Pushdown*, *Filter Pushdown*, and *Constant Evaluation*.
Note that this is a simplified example for explanatory purposes, and actual
optimizers such as the one in DataFusion perform additional tasks such as
choosing specific aggregation algorithms.


## Query Optimizer Implementation

Industrial optimizers, such as 
DataFusion’s ([source](https://github.com/apache/datafusion/tree/334d6ec50f36659403c96e1bffef4228be7c458e/datafusion/optimizer/src)),
ClickHouse ([source](https://github.com/ClickHouse/ClickHouse/tree/master/src/Analyzer/Passes), [source](https://github.com/ClickHouse/ClickHouse/tree/master/src/Processors/QueryPlan/Optimizations)),
DuckDB ([source](https://github.com/duckdb/duckdb/tree/4afa85c6a4dacc39524d1649fd8eb8c19c28ad14/src/optimizer)),
and Apache Spark ([source](https://github.com/apache/spark/tree/7bc8e99cde424c59b98fe915e3fdaaa30beadb76/sql/catalyst/src/main/scala/org/apache/spark/sql/catalyst/optimizer)),
are implemented as a series of passes or rules that rewrite a query plan. The
overall optimizer is composed of a sequence of these rules,<sup id="fn6">[6](#footnote6)</sup> as shown in
Figure 4. The specific order of the rules also often matters, but we will not
discuss this detail in this post.

A multi-pass design is standard because it helps:

1. Understand, implement, and test each pass in isolation
2. Easily extend the optimizer by adding new passes

<img src="/blog/images/optimizing-sql-dataframes/optimizer-passes.png" width="80%" class="img-responsive" alt="Fig 4: Query Optimizer Passes."/>

**Figure 4**: Query Optimizers are implemented as a series of rules that each
rewrite the query plan. Each rule’s algorithm is expressed as a transformation
of a previous plan.

There are three major classes of optimizations in industrial optimizers:

1. **Always Optimizations**: These are always good to do and thus are always
   applied. This class of optimization includes expression simplification,
   predicate pushdown, and limit pushdown. These optimizations are typically
   simple in theory, though they require nontrivial amounts of code and tests to
   implement in practice.

2. **Engine Specific Optimizations: **These optimizations take advantage of
   specific engine features, such as how expressions are evaluated or what
   particular hash or join implementations are available.

3. **Access Path and Join Order Selection**: These passes choose one access
   method per table and a join order for execution, typically using heuristics
   and a cost model to make tradeoffs between the options. Databases often have
   multiple ways to access the data (e.g., index scan or full-table scan), as
   well as many potential orders to combine (join) multiple tables. These
   methods compute the same result but can vary drastically in performance.

This brings us to the end of Part 1. In Part 2, we will explain these classes of
optimizations in more detail and provide examples of how they are implemented in
DataFusion and other systems.

# About the Authors

[Andrew Lamb](https://www.linkedin.com/in/andrewalamb/) is a Staff Engineer at
[InfluxData](https://www.influxdata.com/) and an [Apache
DataFusion](https://datafusion.apache.org/) PMC member. A Database Optimizer
connoisseur, he worked on the [Vertica Analytic
Database](https://vldb.org/pvldb/vol5/p1790_andrewlamb_vldb2012.pdf) Query
Optimizer for six years, has several granted US patents related to query
optimization<sup id="fn1">[1](#footnote1)</sup>, co-authored several papers<sup id="fn2">[2](#footnote2)</sup>  about the topic (including in
VLDB 2024<sup id="fn3">[3](#footnote3)</sup>), and spent several weeks<sup id="fn4">[4](#footnote4)</sup> deeply geeking out about this topic
with other experts (thank you Dagstuhl).

[Mustafa Akur](https://www.linkedin.com/in/akurmustafa/) is a PhD Student at
[OHSU](https://www.ohsu.edu/) Knight Cancer Institute and an [Apache
DataFusion](https://datafusion.apache.org/) PMC member. He was previously a
Software Developer at [Synnada](https://www.synnada.ai/) where he contributed
significant features to the DataFusion optimizer, including many [sort-based
optimizations](https://datafusion.apache.org/blog/2025/03/11/ordering-analysis/).


## Notes

<a id="footnote1"></a><sup>[1]</sup> *Modular Query Optimizer, US 8,312,027 · Issued Nov 13, 2012*, Query Optimizer with schema conversion US 8,086,598 · Issued Dec 27, 2011

<a id="footnote2"></a><sup>[2]</sup> [The Vertica Query Optimizer: The case for specialized Query Optimizers](https://www.researchgate.net/publication/269306314_The_Vertica_Query_Optimizer_The_case_for_specialized_query_optimizers)

<a id="footnote3"></a><sup>[3]</sup> [https://www.vldb.org/pvldb/vol17/p1350-justen.pdf](https://www.vldb.org/pvldb/vol17/p1350-justen.pdf)

<a id="footnote4"></a><sup>[4]</sup> [https://www.dagstuhl.de/en/seminars/seminar-calendar/seminar-details/24101](https://www.dagstuhl.de/en/seminars/seminar-calendar/seminar-details/24101) , [https://www.dagstuhl.de/en/seminars/seminar-calendar/seminar-details/22111](https://www.dagstuhl.de/en/seminars/seminar-calendar/seminar-details/22111) [https://www.dagstuhl.de/en/seminars/seminar-calendar/seminar-details/12321](https://www.dagstuhl.de/en/seminars/seminar-calendar/seminar-details/12321)

<a id="footnote5"></a><sup>[5]</sup>  And thus in academic classes, by the time you get around to an optimizer the semester is over and everyone is ready for the semester to be done. Once industrial systems mature to the point where the optimizer is a bottleneck, the shiny new-ness of the[ hype cycle](https://en.wikipedia.org/wiki/Gartner_hype_cycle) has worn off and it is likely in the trough of disappointment.

<a id="footnote6"></a><sup>[6]</sup> Often systems will classify these passes into different categories, but I am simplifying here

