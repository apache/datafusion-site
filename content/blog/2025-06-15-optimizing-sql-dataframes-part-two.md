---
layout: post
title: Optimizing SQL (and DataFrames) in DataFusion, Part 2: Optimizers in Apache DataFusion
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

*Note, this blog was originally published [on the InfluxData blog].*

[on the InfluxData blog]: https://www.influxdata.com/blog/optimizing-sql-dataframes-part-two/

In the [first part of this post], we discussed what a Query Optimizer is, what
role it plays, and described how industrial optimizers are organized. In this
second post, we describe various optimizations that are found in [Apache
DataFusion](https://datafusion.apache.org/) and other industrial systems in more
detail.


DataFusion contains high quality, full-featured implementations for *Always
Optimizations* and *Engine Specific Optimizations* (defined in Part 1).
Optimizers are implemented as rewrites of `LogicalPlan` in the [logical
optimizer](https://github.com/apache/datafusion/tree/main/datafusion/optimizer)
or rewrites of `ExecutionPlan` in the [physical
optimizer](https://github.com/apache/datafusion/tree/main/datafusion/physical-optimizer).
This design means the same optimizer passes are applied for SQL queries,
DataFrame queries, as well as plans for other query language frontends such as
[InfluxQL](https://github.com/influxdata/influxdb3_core/tree/26a30bf8d6e2b6b3f1dd905c4ec27e3db6e20d5f/iox_query_influxql)
in InfluxDB 3.0,
[PromQL](https://github.com/GreptimeTeam/greptimedb/blob/0bd322a078cae4f128b791475ec91149499de33a/src/query/src/promql/planner.rs#L1)
in [Greptime](https://greptime.com/), and
[vega](https://github.com/vega/vegafusion/tree/dc15c1b9fc7d297f12bea919795d58cda1c88fcf/vegafusion-core/src/planning)
in [VegaFusion](https://vegafusion.io/).


[first part of this post]: https://datafusion.apache.org/blog/2025/06/15/optimizing-sql-dataframes-part-one

## Always Optimizations

Some optimizations are so important they are found in almost all query engines
and are typically the first implemented as they provide the largest cost /
benefit ratio (and performance is terrible without them).


### Predicate/Filter Pushdown

**Why**: Avoid carrying unneeded *rows *as soon as possible

**What**: Moves filters “down” in the plan so they run earlier during execution, as shown in Figure 1.

**Example Implementations**: [DataFusion], [DuckDB], [ClickHouse]

[DataFusion]: https://github.com/apache/datafusion/blob/main/datafusion/optimizer/src/push_down_filter.rs
[DuckDB]: https://github.com/duckdb/duckdb/blob/main/src/optimizer/filter_pushdown.cpp 
[ClickHouse]: https://github.com/ClickHouse/ClickHouse/blob/master/src/Processors/QueryPlan/Optimizations/filterPushDown.cpp

The earlier data is filtered out in the plan, the less work the rest of the plan
has to do. Most mature databases aggressively use filter pushdown / early
filtering combined with techniques such as partition and storage pruning (e.g.
[Parquet Row Group pruning]) for performance.

[Parquet Row Group pruning]: https://blog.xiangpeng.systems/posts/parquet-to-arrow/

An extreme, and somewhat contrived, is the query

```sql
SELECT city, COUNT(*) FROM population GROUP BY city HAVING city = 'BOSTON';
```

Semantically, `HAVING` is [evaluated after] `GROUP BY` in SQL. However, computing
the population of all cities and discarding everything except Boston is much
slower than only computing the population for Boston and so most Query
Optimizers will evaluate the filter before the aggregation.

[evaluated after]: https://www.datacamp.com/tutorial/sql-order-of-execution

<img src="/blog/images/optimizing-sql-dataframes/filter-pushdown.png" width="80%" class="img-responsive" alt="Fig 1: Filter Pushdown."/>

**Figure 1**: Filter Pushdown.  In (**A**) without filter pushdown, the operator
processes more rows, reducing efficiency. In (**B**) with filter pushdown, the
operator receives fewer rows, resulting in less overall work and leading to a
faster and more efficient query.


### Projection Pushdown

**Why**: Avoid carrying unneeded *columns *as soon as possible

**What: **Pushes “projection” (keeping only certain columns) earlier in the plan, as shown in Figure 2.

**Example Implementations: **Implementations: [DataFusion](https://github.com/apache/datafusion/blob/main/datafusion/physical-optimizer/src/projection_pushdown.rs), [DuckDB](https://github.com/duckdb/duckdb/blob/a8a6a080c8809d5d4b3c955e9f113574f6f0bfe0/src/optimizer/pushdown/pushdown_projection.cpp), [ClickHouse](https://github.com/ClickHouse/ClickHouse/blob/master/src/Processors/QueryPlan/Optimizations/optimizeUseNormalProjection.cpp)

Similarly to the motivation for *Filter Pushdown*, the earlier the plan stops
doing something, the less work it does overall and thus the faster it runs. For
Projection Pushdown, if columns are not needed later in a plan, copying the data
to the output of other operators is unnecessary and the costs of copying can add
up. For example, in Figure 3 of Part 1, the `species` column is only needed to
evaluate the Filter within the scan and `notes` are never used, so it is
unnecessary to copy them through the rest of the plan.

Projection Pushdown is especially effective and important for column store
databases, where the storage format itself (such as [Apache Parquet]) supports
efficiently reading only a subset of required columns, and is [especially
powerful in combination with filter pushdown]. Projection Pushdown is still
important, but less effective for row oriented formats such as JSON or CSV where
each column in each row must be parsed even if it is not used in the plan.

[Apache Parquet]: https://parquet.apache.org/
[especially powerful in combination with filter pushdown]: https://blog.xiangpeng.systems/posts/parquet-pushdown/

<img src="/blog/images/optimizing-sql-dataframes/projection-pushdown.png" width="80%" class="img-responsive" alt="Fig 2: Projection Pushdown."/>

**Figure 2:** In (**A**) without projection pushdown, the operator receives more
columns, reducing efficiency. In (**B**) with projection pushdown, the operator
receives fewer columns, leading to optimized execution.

### Limit Pushdown

**Why**: The earlier the plan stops generating data, the less overall work it
does, and some operators have more efficient limited implementations.

**What: **Pushes limits (maximum row counts) down in a plan as early as possible.

**Example Implementations:** [DataFusion](https://github.com/apache/datafusion/blob/main/datafusion/optimizer/src/push_down_limit.rs), [DuckDB](https://github.com/duckdb/duckdb/blob/main/src/optimizer/limit_pushdown.cpp), [ClickHouse](https://github.com/ClickHouse/ClickHouse/blob/master/src/Processors/QueryPlan/Optimizations/limitPushDown.cpp), Spark ([Window](https://github.com/apache/spark/blob/7bc8e99cde424c59b98fe915e3fdaaa30beadb76/sql/catalyst/src/main/scala/org/apache/spark/sql/catalyst/optimizer/LimitPushDownThroughWindow.scala) and [Projection](https://github.com/apache/spark/blob/7bc8e99cde424c59b98fe915e3fdaaa30beadb76/sql/catalyst/src/main/scala/org/apache/spark/sql/catalyst/optimizer/PushProjectionThroughLimit.scala))

Often queries have a `LIMIT ` or other clause that allows them to stop generating
results early so the sooner they can stop execution, the more efficiently they
will execute.

In addition, DataFusion and other systems have more efficient implementations of
some operators that can be used if there is a limit. The classic example is
replacing a full sort + limit with a [TopK] operator that only tracks the top
values using a heap. Similarly,  DataFusion’s Parquet reader stops fetching and
opening additional files once the limit has been hit.

[TopK]: https://docs.rs/datafusion/latest/datafusion/physical_plan/struct.TopK.html

<img src="/blog/images/optimizing-sql-dataframes/limit-pushdown.png" width="80%" class="img-responsive" alt="Fig 3: Limit Pushdown."/>

**Figure 3**: In (**A**), without limit pushdown all data is sorted and
everything except the first few rows are discarded. In (**B**), with limit
pushdown, Sort is replaced with TopK operator which does much less work.


### Expression Simplification / Constant Folding

**Why**: Evaluating the same expression for each row when the value doesn’t change is wasteful.

**What**: Partially evaluates and/or algebraically simplify expressions.

**Example Implementations:** [DataFusion](https://github.com/apache/datafusion/tree/main/datafusion/optimizer/src/simplify_expressions), DuckDB (has several [rules](https://github.com/duckdb/duckdb/tree/7b18f0f3691c1b6367cf68ed2598d7034e14f41b/src/optimizer/rule) such as [constant folding](https://github.com/duckdb/duckdb/blob/7b18f0f3691c1b6367cf68ed2598d7034e14f41b/src/optimizer/rule/constant_folding.cpp), and [comparison simplification](https://github.com/duckdb/duckdb/blob/7b18f0f3691c1b6367cf68ed2598d7034e14f41b/src/optimizer/rule/comparison_simplification.cpp)), [Spark](https://github.com/apache/spark/blob/7bc8e99cde424c59b98fe915e3fdaaa30beadb76/sql/catalyst/src/main/scala/org/apache/spark/sql/catalyst/optimizer/expressions.scala)

If an expression doesn’t change from row to row, it is better to evaluate the
expression **once** during planning. This is a classic compiler technique and is
also used in database systems

For example, given a query that finds all values from the current year

```sql
SELECT … WHERE extract(year from time_column) = extract(year from now())
```

Evaluating `extract(year from now())` on every row is much more expensive than
evaluating it once during planning time so that the query becomes comparison to
a constant

```sql
SELECT … WHERE extract(year from time_column) = 2025
```

Furthermore, it is often possible to push such predicates **into** scans.

### Rewriting `OUTER JOIN` → `INNER JOIN`

**Why:** `INNER JOIN`  implementations are almost always faster (as they are
simpler) than `OUTER JOIN` implementations, and `INNER JOIN` s impose fewer
restrictions on other optimizer passes (such as join reordering and additional
filter pushdown).

**What**: In cases where it is known that NULL rows introduced by an `OUTER
JOIN` will not appear in the results, it can be rewritten to an <code>INNER
JOIN</code>.

**Example Implementations:** [DataFusion](https://github.com/apache/datafusion/blob/6028474969f0bfead96eb7f413791470afb6bf82/datafusion/optimizer/src/eliminate_outer_join.rs), [Spark](https://github.com/apache/spark/blob/7bc8e99cde424c59b98fe915e3fdaaa30beadb76/sql/catalyst/src/main/scala/org/apache/spark/sql/catalyst/optimizer/joins.scala#L124-L158), [ClickHouse](https://github.com/ClickHouse/ClickHouse/blob/master/src/Processors/QueryPlan/Optimizations/convertOuterJoinToInnerJoin.cpp).

For example, given a query such as the following

```SQL
SELECT …
FROM orders LEFT OUTER JOIN customer ON (orders.cid = customer.id)
WHERE customer.last_name = 'Lamb'
```

The `LEFT OUTER JOIN` keeps all rows in `orders`  that don’t have a matching
customer, but fills in the fields with `null`. All such rows will be filtered
out by `customer.last_name = 'Lamb'`, and thus an INNER JOIN produces the same
answer. This is illustrated in Figure 4.

<img src="/blog/images/optimizing-sql-dataframes/join-rewrite.png" width="80%" class="img-responsive" alt="Fig 4: Join Rewrite."/>

**Figure 4**: Rewriting `OUTER JOIN` to `INNER JOIN`. In (A) the original query
contains an `OUTER JOIN` but also a filter on `customer.last_name`, which
filters out all rows that might be introduced by the `OUTER JOIN`. In (B) the
`OUTER JOIN` is converted to inner join, a more efficient implementation can be
used.


## Engine Specific Optimizations

As discussed in Part 1 of this blog, optimizers also contain a set of passes
that are still always good to do, but are closely tied to the specifics of the
query engine. This section describes some common types

### Subquery Rewrites

**Why**: Actually implementing subqueries by running a query for each row of the outer query is very expensive.

**What**: It is possible to rewrite subqueries as joins which often perform much better.

**Example Implementations:** DataFusion ([one](https://github.com/apache/datafusion/blob/main/datafusion/optimizer/src/decorrelate.rs), [two](https://github.com/apache/datafusion/blob/main/datafusion/optimizer/src/decorrelate_predicate_subquery.rs), [three](https://github.com/apache/datafusion/blob/main/datafusion/optimizer/src/scalar_subquery_to_join.rs)), [Spark](https://github.com/apache/spark/blob/7bc8e99cde424c59b98fe915e3fdaaa30beadb76/sql/catalyst/src/main/scala/org/apache/spark/sql/catalyst/optimizer/subquery.scala)

Evaluating subqueries a row at a time is so expensive that execution engines in
high performance analytic systems such as DataFusion and [Vertica] may not even
support row-at-a-time evaluation given how terrible the performance would be. 
Instead, analytic systems rewrite such queries into joins which can perform 100s
or 1000s of times faster for large datasets. However, transforming subqueries to
joins requires “exotic” join semantics such as `SEMI JOIN`, `ANTI JOIN`  and
variations on how to treat equality with null<sup id="fn7">[7](#footnote7).

[Vertica]: https://vertica.com/

For a simple example, consider that a query like this:

```sql
SELECT customer.name 
FROM customer 
WHERE (SELECT sum(value) 
       FROM orders WHERE
       orders.cid = customer.id) > 10;
```

Can be rewritten like this:

```sql
SELECT customer.name 
FROM customer 
JOIN (
  SELECT customer.id as cid_inner, sum(value) s 
  FROM orders 
  GROUP BY customer.id
 ) ON (customer.id = cid_inner AND s > 10);
```

We don’t have space to detail this transformation or why it is so much faster to
run, but using this and many other transformations allow efficient subquery
evaluation.

### Optimized Expression Evaluation

**Why**: The capabilities of expression evaluation vary from system to system.

**What**: Optimize expression evaluation for the particular execution environment.

**Example Implementations**: There are many examples of this type of
optimization, including DataFusion’s [Common Subexpression
Elimination](https://github.com/apache/datafusion/blob/main/datafusion/optimizer/src/common_subexpr_eliminate.rs),
[unwrap_cast](https://github.com/apache/datafusion/blob/8f3f70877febaa79be3349875e979d3a6e65c30e/datafusion/optimizer/src/simplify_expressions/unwrap_cast.rs#L70),
and [identifying equality join
predicates](https://github.com/apache/datafusion/blob/main/datafusion/optimizer/src/extract_equijoin_predicate.rs).
DuckDB [rewrites IN
clauses](https://github.com/duckdb/duckdb/blob/main/src/optimizer/in_clause_rewriter.cpp),
and [SUM
expressions](https://github.com/duckdb/duckdb/blob/main/src/optimizer/sum_rewriter.cpp).
Spark also [unwraps casts in binary
comparisons](https://github.com/apache/spark/blob/7bc8e99cde424c59b98fe915e3fdaaa30beadb76/sql/catalyst/src/main/scala/org/apache/spark/sql/catalyst/optimizer/UnwrapCastInBinaryComparison.scala),
and [adds special runtime
filters](https://github.com/apache/spark/blob/7bc8e99cde424c59b98fe915e3fdaaa30beadb76/sql/catalyst/src/main/scala/org/apache/spark/sql/catalyst/optimizer/InjectRuntimeFilter.scala).

To give a specific example of what DataFusion’s common subexpression elimination
does, consider this query that refers to a complex expression multiple times:

```sql
SELECT date_bin('1 hour', time, '1970-01-01') 
FROM table 
WHERE date_bin('1 hour', time, '1970-01-01') >= '2025-01-01 00:00:00'
ORDER BY date_bin('1 hour', time, '1970-01-01')
```

Evaluating `date_bin('1 hour', time, '1970-01-01')`each time it is encountered
is inefficient compared to calculating its result once, and reusing that result
in when it is encountered again (similar to caching). This reuse is called
*Common Subexpression Elimination*.

Some execution engines implement this optimization internally to their
expression evaluation engine, but DataFusion represents it explicitly using a
separate Projection plan node, as illustrated in Figure 5.  Effectively, the
query above is rewritten to the following

```sql
SELECT time_chunk 
FROM(SELECT date_bin('1 hour', time, '1970-01-01') as time_chunk 
     FROM table)
WHERE time_chunk >= '2025-01-01 00:00:00'
ORDER BY time_chunk
```


<img src="/blog/images/optimizing-sql-dataframes/common-subexpression-elimination.png" width="80%" class="img-responsive" alt="Fig 5: Common Subquery Elimination."/>

**Figure 5:** Adding a Projection to evaluate common complex sub expression
decreases complexity for later stages.


### Algorithm Selection

**Why**: Different engines have different specialized operators for certain
operations.

**What: **Selects specific implementations from the available operators, based
on properties of the query.

**Example Implementations:** DataFusion’s [EnforceSorting](https://github.com/apache/datafusion/blob/8f3f70877febaa79be3349875e979d3a6e65c30e/datafusion/physical-optimizer/src/enforce_sorting/mod.rs) pass uses sort optimized implementations, Spark’s [rewrite to use a special operator for ASOF joins](https://github.com/apache/spark/blob/7bc8e99cde424c59b98fe915e3fdaaa30beadb76/sql/catalyst/src/main/scala/org/apache/spark/sql/catalyst/optimizer/RewriteAsOfJoin.scala), and ClickHouse’s[ join algorithm selection ](https://github.com/ClickHouse/ClickHouse/blob/7d15deda4b33282f356bb3e40a190d005acf72f2/src/Interpreters/ExpressionAnalyzer.cpp#L1066-L1080) such as [when to use MergeJoin](https://github.com/ClickHouse/ClickHouse/blob/7d15deda4b33282f356bb3e40a190d005acf72f2/src/Interpreters/ExpressionAnalyzer.cpp#L1022)

For example, DataFusion uses a `TopK` ([source]) operator rather than a full
`Sort` if there is also a limit on the query. Similarly, it may choose to use the
more efficient `PartialOrdered` grouping operation when the data is sorted on
group keys or a `MergeJoin`

[source]: https://docs.rs/datafusion/latest/datafusion/physical_plan/struct.TopK.html

<img src="/blog/images/optimizing-sql-dataframes/specialized-grouping.png" width="80%" class="img-responsive" alt="Fig 6: Specialized Grouping."/>

**Figure 6: **An example of specialized operation for grouping. In (**A**), input data has no specified ordering and DataFusion uses a hashing-based grouping operator ([source](https://github.com/apache/datafusion/blob/main/datafusion/physical-plan/src/aggregates/row_hash.rs)) to determine distinct groups. In (**B**), when the input data is ordered by the group keys, DataFusion uses a specialized grouping operator ([source](https://github.com/apache/datafusion/tree/main/datafusion/physical-plan/src/aggregates/order)) to find boundaries that separate groups.


### Using Statistics Directly

**Why**: Using pre-computed statistics from a table, without actually reading or
opening files, is much faster than processing data.

**What**: Replace calculations on data with the value from statistics.

**Example Implementations:** [DataFusion](https://github.com/apache/datafusion/blob/8f3f70877febaa79be3349875e979d3a6e65c30e/datafusion/physical-optimizer/src/aggregate_statistics.rs), [DuckDB](https://github.com/duckdb/duckdb/blob/main/src/optimizer/statistics_propagator.cpp),

Some queries, such as the classic `COUNT(*) from my_table` used for data
exploration can be answered using only statistics. Optimizers often have access
to statistics for other reasons (such as Access Path and Join Order Selection)
and statistics are commonly stored in analytic file formats. For example, the
[Metadata] of Apache Parquet files stores `MIN`, `MAX`, and `COUNT` information.

[Metadata]: https://docs.rs/parquet/latest/parquet/file/metadata/index.html

<img src="/blog/images/optimizing-sql-dataframes/using-statistics.png" width="80%" class="img-responsive" alt="Fig 7: Using Statistics."/>

**Figure 7: **When the aggregation result is already stored in the statistics,
the query can be evaluated using the values from statistics without looking at
any compressed data. The optimizer replaces the Aggregation operation with
values from statistics.

## Access Path and Join Order Selection


### Overview

Last, but certainly not least, are optimizations that choose between plans with
potentially (very) different performance. The major options in this category are

1. **Join Order:** In what order to combine tables using JOINs?
2. **Access Paths:** Which copy of the data or index should be read to find matching tuples?
3. **[Materialized View]**: Can the query can be rewritten to use a materialized view (partially computed query results)? This topic deserves its own blog (or book) and we don’t discuss further here.

[Materialized View]: https://en.wikipedia.org/wiki/Materialized_view

<img src="/blog/images/optimizing-sql-dataframes/access-path-and-join-order.png" width="80%" class="img-responsive" alt="Fig 8: Access Path and Join Order."/>

**Figure 8:** Access Path and Join Order Selection in Query Optimizers. Optimizers use heuristics to enumerate some subset of potential join orders (shape) and access paths (color). The plan with the smallest estimated cost according to some cost model is chosen. In this case, Plan 2 with a cost of 180,000 is chosen for execution as it has the lowest estimated cost.

This class of optimizations is a hard problem for at least the following reasons:

1. **Exponential Search Space**: the number of potential plans increases
   exponentially as the number of joins and indexes increases.

2. **Performance Sensitivity**: Often different plans that are very similar in
   structure perform very differently. For example, swapping the input order to
   a hash join can result in 1000x or more (yes, a thousand-fold!) run time
   differences.

3. **Cardinality Estimation Errors**: Determining the optimal plan relies on
   cardinality estimates (e.g., how many rows will come out of each join). It is a
   [known hard problem] to estimate this cardinality, and in practice queries with
   as few as 3 joins often have large cardinality estimation errors.

[known hard problem]: https://www.vldb.org/pvldb/vol9/p204-leis.pdf

### Heuristics and Cost-Based Optimization

Industrial optimizers handle these problems using a combination of

1. **Heuristics:** to prune the search space and avoid considering plans that
   are (almost) never good. Examples include considering left-deep trees, or
   using `Foreign Key` / `Primary Key` relationships to pick the build size of a
   hash join.

2. **Cost Model**: Given the smaller set of candidate plans, the Optimizer then
   estimates their cost and picks the one using the lowest cost.

For some examples, you can read about [Spark’s cost-based optimizer] or look at
the code for [DataFusion’s join selection] and [DuckDB’s cost model] and [join
order enumeration].

[Spark’s cost-based optimizer]: https://docs.databricks.com/aws/en/optimizations/cbo
[DataFusion’s join selection]: https://github.com/apache/datafusion/blob/main/datafusion/physical-optimizer/src/join_selection.rs
[DuckDB’s cost model]: https://github.com/duckdb/duckdb/blob/main/src/optimizer/join_order/cost_model.cpp
[join order enumeration]: https://github.com/duckdb/duckdb/blob/84c87b12fa9554a8775dc243b4d0afd5b407321a/src/optimizer/join_order/plan_enumerator.cpp#L469-L472

However, the use of heuristics and (imprecise) cost models means optimizers must


1. **Make deep assumptions about the execution environment: **For example the
   heuristics often include assumptions that joins implement [sideways information
   passing (RuntimeFilters)], or that Join operators always preserve a particular
   input's order.

2. **Use one particular objective function: **There are almost always trade-offs
   between desirable plan properties, such as execution speed, memory use, and
   robustness in the face of cardinality estimation. Industrial optimizers
   typically have one cost function which attempts to balance between the
   properties or a series of hard to use indirect tuning knobs to control the
   behavior.

3. **Require statistics**: Typically cost models require up-to-date statistics,
   which can be expensive to compute, must be kept up to date as new data
   arrives, and often have trouble capturing the non-uniformity of real world
   datasets

[sideways information passing (RuntimeFilters)]: (https://www.alibabacloud.com/blog/alibaba-cloud-analyticdb-for-mysql-create-ultimate-runtimefilter-capability_600228


### Join Ordering in DataFusion

DataFusion purposely does not include a sophisticated cost based optimizer.
Instead, keeping with its [design goals] it provides a reasonable default
implementation along with extension points to customize behavior.

[design goals]: https://docs.rs/datafusion/latest/datafusion/#design-goals

Specifically, DataFusion includes

1. “Syntactic Optimizer” (joins in the order they are listed in the query<sup id="fn8">[8](#footnote8)) with basic join re-ordering ([source](https://github.com/apache/datafusion/blob/main/datafusion/physical-optimizer/src/join_selection.rs)) to prevent join disasters.
2. Support for [ColumnStatistics](https://docs.rs/datafusion/latest/datafusion/common/struct.ColumnStatistics.html) and [Table Statistics](https://docs.rs/datafusion/latest/datafusion/common/struct.Statistics.html)
3. The framework for [filter selectivity](https://docs.rs/datafusion/latest/datafusion/physical_expr/struct.AnalysisContext.html#structfield.selectivity) + join cardinality estimation.
4. APIs for easily rewriting plans, such as the [TreeNode API](https://docs.rs/datafusion/latest/datafusion/common/tree_node/trait.TreeNode.html#overview) and [reordering joins](https://docs.rs/datafusion/latest/datafusion/physical_plan/joins/struct.HashJoinExec.html#method.swap_inputs)

This combination of features along with [custom optimizer passes] lets users
customize the behavior to their use case, such as custom indexes like [uWheel]
and [materialized views].

[custom optimizer passes]: https://docs.rs/datafusion/latest/datafusion/execution/session_state/struct.SessionStateBuilder.html#method.with_physical_optimizer_rule
[uWheel]: https://uwheel.rs/post/datafusion_uwheel/
[materialized views]: https://github.com/datafusion-contrib/datafusion-materialized-views

The rationale for including only a basic optimizer is that any one particular
set of heuristics and cost model is unlikely to work well for the wide variety
of DataFusion users because of the tradeoffs involved. 

For example, some users may always have access to adequate resources, and want
the fastest query execution, and are willing to tolerate runtime errors or a
performance cliff when there is insufficient memory. Other users, however, may
be willing to accept a slower maximum performance in return for more predictable
performance when running in a resource constrained environment. This approach is
not universally agreed. One of us has [previously argued the case for
specialized optimizers] in a more academic paper, and the topic comes up
regularly in the DataFusion community, (e.g. [this recent comment]).

[previously argued the case for specialized optimizers]: https://www.researchgate.net/publication/269306314_The_Vertica_Query_Optimizer_The_case_for_specialized_query_optimizers
[this recent comment]: https://github.com/apache/datafusion/issues/9846#issuecomment-2566568654

Note: We are [actively improving] this part of the code to help people write
their own optimizers (🎣 come help us define and implement it!)

[actively improving]: https://github.com/apache/datafusion/issues/3929

# Conclusion

Optimizers are awesome, and we hope these two posts have demystified what they
are and how they are implemented in industrial systems. Like many modern query
engine designs, the common techniques are well known, though require substantial
effort to get right.  DataFusion’s industrial strength optimizers can and do
serve many real world systems well and we expect that number to grow over time.

We also think DataFusion provides interesting opportunities for optimizer
research. As we discussed, there are still unsolved problems such as optimal
join ordering. Experiments in papers often use academic systems or modify
optimizers in tightly integrated open source systems (for example, the recent
[POLARs paper] uses DuckDB). However, using a tightly integrated system
constrains the research to the set of heuristics and structure provided by that
system. Hopefully DataFusion’s documentation, [newly citeable SIGMOD paper], and
modular design will encourage more broadly applicable research in this area.

[POLARs paper]: https://www.vldb.org/pvldb/vol17/p1350-justen.pdf
[newly citeable SIGMOD paper]: https://dl.acm.org/doi/10.1145/3626246.3653368

And finally, as always, if you are interested in working on query engines and
learning more about how they are designed and implemented, please [join our
community]. We welcome first time contributors as well as long time participants
to the fun of building a database together.

[join our community]: https://datafusion.apache.org/contributor-guide/communication.html

## Notes

<a id="footnote7"></a><sup>[7]</sup> See [Unnesting Arbitrary Queries](https://btw-2015.informatik.uni-hamburg.de/res/proceedings/Hauptband/Wiss/Neumann-Unnesting_Arbitrary_Querie.pdf) from Neumann and Kemper for a more academic treatment.

<a id="footnote8"></a><sup>[8]</sup> One of my favorite terms I learned from Andy Pavlo’s CMU online lectures
