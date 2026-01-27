---
layout: post
title: Optimizing SQL CASE Expression Evaluation
date: 2026-01-26
author: Pepijn Van Eeckhoudt
categories: [features]
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

<style>
figure {
  margin: 20px 0;
}

figure img {
  display: block;
  max-width: 80%;
  margin: auto;
}

figcaption {
  font-style: italic;
  color: #555;
  font-size: 0.9em;
  max-width: 80%;
  margin: auto;
  text-align: center;
}
</style>

[Apache DataFusion]: https://datafusion.apache.org/

SQL's `CASE` expression is one of the few explicit conditional evaluation constructs the language provides.
It lets you control which expression from a set of expressions is evaluated for each row based on arbitrary boolean expressions.
Its deceptively simple syntax hides significant implementation complexity.
Over the past few releases, we've landed a series of improvements to [Apache DataFusion]'s `CASE` expression evaluator that reduce both CPU time and memory allocations.
This post walks through the original implementation, its performance bottlenecks, and how we addressed them step by step.


## Background: CASE Expression Evaluation

SQL supports two forms of CASE expressions:

1. **Simple**: `CASE expr WHEN value1 THEN result1 WHEN value2 THEN result2 ... END`
2. **Searched**: `CASE WHEN condition1 THEN result1 WHEN condition2 THEN result2 ... END`

The simple form evaluates an expression once for each input row and then tests that value against the expressions (typically constants) in each `WHEN` clause using equality comparisons.
Think of it as a limited Rust `match` expression.

Here's an example of the simple form:

```sql
CASE status
    WHEN 'pending' THEN 1
    WHEN 'active' THEN 2
    WHEN 'complete' THEN 3
    ELSE 0
END
```

In this `CASE` expression, `status` is evaluated once per row, and then its value is tested for equality with the values `'pending'`, `'active'`, and `'complete'` in that order.
The `CASE` expression evaluates to the value of the `THEN` expression corresponding to the first matching `WHEN` expression.

The searched `CASE` form is a more flexible variant.
It evaluates completely independent boolean expressions for each branch.
This allows you to test different columns with different operators per branch, as can be seen in the following example:

```sql
CASE
    WHEN age > 65 THEN 'senior'
    WHEN childCount != 0 THEN 'parent'
    WHEN age < 21 THEN 'minor'
    ELSE 'adult'
END
```

In both forms, branches are evaluated sequentially with short-circuit semantics: for each row, once a `WHEN` condition matches, the corresponding `THEN` expression is evaluated.
Any further branches are not evaluated for that row.
This lazy evaluation model is critical for correctness.
It lets you safely write `CASE` expressions like

```sql
CASE
    WHEN denominator == 0 THEN NULL
    ELSE numerator / denominator
END
```

that are guaranteed to not trigger divide-by-zero errors.

Besides `CASE`, there are a few [conditional scalar functions](https://datafusion.apache.org/user-guide/sql/scalar_functions.html#conditional-functions) that provide similar, more restricted capabilities.
These include `COALESCE`, `IFNULL`, and `NVL2`.

Each of these functions can be seen as the equivalent of a macro for `CASE`.
`COALESCE(expr1, expr2, expr3)` for instance, would expand to:

```sql
CASE
  WHEN expr1 IS NOT NULL THEN expr1
  WHEN expr2 IS NOT NULL THEN expr2
  ELSE expr3
END
```

[Apache DataFusion] implements these conditional functions by rewriting them to their equivalent `CASE` expression.
As a consequence, any optimizations related to `CASE` described in this post also apply to conditional function evaluation.

## Basic `CASE` Evaluation

For the remainder of this post, we'll be looking at `searched CASE` evaluation.
`Simple CASE` uses a distinct, but very similar implementation.
The same set of improvements has been applied to both.

DataFusion 50.0.0 uses a common, straightforward approach to evaluate `CASE`:

1. Start with an output array `out` with the same length as the input batch, filled with nulls. Additionally, create a bit vector `remainder` with the same length and each value set to `true`.
2. For each `WHEN`/`THEN` branch:
  - Evaluate the `WHEN` condition for remaining unmatched rows using [`PhysicalExpr::evaluate_selection`](https://docs.rs/datafusion/latest/datafusion/physical_expr/trait.PhysicalExpr.html#method.evaluate_selection), passing in the input batch and the `remainder` mask
  - If any rows matched, evaluate the `THEN` expression for those rows using `PhysicalExpr::evaluate_selection`
  - Merge the results into the `out` using the [`zip`](https://docs.rs/arrow/latest/arrow/compute/kernels/zip/fn.zip.html) kernel
  - Update the `remainder` mask to exclude matched rows
3. If there's an `ELSE` clause, evaluate it for any remaining unmatched rows and merge using [`zip`](https://docs.rs/arrow/latest/arrow/compute/kernels/zip/fn.zip.html)

Here's a simplified version of the original loop:

```rust
let mut out = new_null_array(&return_type, batch.num_rows());
let mut remainder = BooleanArray::from(vec![true; batch.num_rows()]);

for (when_expr, then_expr) in &self.when_then_expr {
    // Determine for which remaining rows the WHEN condition matches
    let when = when_expr.evaluate_selection(batch, &remainder)?
        .into_array(batch.num_rows())?;
    // Ensure any `NULL` values are treated as false
    let when_and_rem = and(&when, &remainder)?;

    if when_and_rem.true_count() == 0 {
        continue;
    }

    // Evaluate the THEN expression for matching rows
    let then = then_expr.evaluate_selection(batch, &when_and_rem)?;
    // Merge results into output array
    out = zip(&when_and_rem, &then_value, &out)?;
    // Update remainder mask to exclude matched rows
    remainder = and_not(&remainder, &when_and_rem)?;
}
```

Schematically, one iteration of this loop for the case expression

```sql
CASE
    WHEN col = 'b' THEN 100
    ELSE 200
END
```

looks like this:

<figure>
<img src="/blog/images/case/original_loop.svg" alt="Schematic representation of data flow in the original CASE implementation" width="100%" class="img-responsive">
<figcaption>One iteration of the `CASE` evaluation loop</figcaption>
</figure>

While correct, this implementation has significant room for optimization, mostly related to the usage of `evaluate_selection`.
To understand why, we need to dig a little deeper into the implementation of that function.
Here's a simplified version of it that captures the relevant parts:

```rust
pub trait PhysicalExpr {
    fn evaluate_selection(
        &self,
        batch: &RecordBatch,
        selection: &BooleanArray,
    ) -> Result<ColumnarValue> {
        // Reduce record batch to only include rows that match selection
        let filtered_batch = filter_record_batch(batch, selection)?;
        // Perform regular evaluation on filtered batch
        let filtered_result = self.evaluate(&filtered_batch)?;
        // Expand result array to match original batch length
        scatter(selection, filtered_result)
    }
}
```

Going back to the same example as before, the data flow looks like this:

<figure>
<img src="/blog/images/case/evaluate_selection.svg" alt="Schematic representation of `evaluate_selection` evaluation" width="100%" class="img-responsive">
<figcaption>evaluate_selection data flow</figcaption>
</figure>

The `evaluate_selection` method first filters the input batch to only include rows that match the `selection` mask.
It then calls the regular `evaluate` method using the filtered batch as input.
Finally, to return a result array with the same number of rows as `batch`, the `scatter` function is called.
This function produces a new array padded with `null` values for any rows that didn't match the `selection` mask.

So how can we improve the performance of the simple evaluation strategy and use of `evaluate_selection`?

### Observation 1: No Early Exit

The case evaluation loop always iterated through all branches, even when every row had already been matched.
In queries where early branches match many rows, this meant unnecessary work was done for remaining rows.

### Observation 2: Repeated Filtering, Scattering, and Merging

Each iteration performed a number of operations that are very well-optimized, but still take up a significant amount of CPU time:

- **Filtering**: `PhysicalExpr::evaluate_selection` filters the entire `RecordBatch` for each branch. For the `WHEN` expression, this was done even if the selection mask was entirely empty.
- **Scattering**: `PhysicalExpr::evaluate_selection` scatters the filtered result back to the original `RecordBatch` length.
- **Merging**: The `zip` kernel is called once per branch to merge partial results into the output array

Each of these operations needs to allocate memory for new arrays and shuffle quite a bit of data around. 

### Observation 3: Filtering Unused Columns

The `PhysicalExpr::evaluate_selection` method filters the entire record batch, including columns that the current branch's `WHEN` and `THEN` expressions don't reference.
For wide tables (many columns) with narrow expressions (few column references), this is wasteful.

Suppose we have a table with 26 columns named `a` through `z`.
For a simple CASE expression like:

```sql
CASE
  WHEN a > 1000 THEN 'large'
  WHEN a >= 0 THEN 'positive'
  ELSE 'negative'
END
```

the implementation would filter all 26 columns even though only a single column is needed for the entire `CASE` expression evaluation.
Again this involves a non-negligible amount of allocation and data copying.

## Performance Optimizations

### Optimization 1: Short-Circuit Early Exit

The first optimization is an easy one.
As soon as we can detect that all rows of the batch have been matched we break out of the evaluation loop:

```rust
let mut remainder_count = batch.num_rows();

for (when_expr, then_expr) in &self.when_then_expr {
    if remainder_count == 0 {
        break;  // All rows matched, exit early
    }

    // ... evaluate branch ...

    let when_match_count = when_value.true_count();
    remainder_count -= when_match_count;
}
```

Additionally, we avoid evaluating the `ELSE` clause when no rows remain:

```rust
if let Some(else_expr) = &self.else_expr {
    remainder = or(&base_nulls, &remainder)?;
    if remainder.true_count() > 0 {
        // ... evaluate else ...
    }
}
```

For queries where early branches match all rows, this eliminates unnecessary branch evaluations and `ELSE` clause processing.

This optimization was implemented by Pepijn Van Eeckhoudt ([`@pepijnve`](https://github.com/pepijnve)) in [PR #17898](https://github.com/apache/datafusion/pull/17898)

### Optimization 2: Optimized Result Merging

The second optimization fundamentally restructured how the results of each loop iteration are merged.
The diagram below illustrates the optimized data flow when evaluating the `CASE WHEN col = 'b' THEN 100 ELSE 200 END` from before:

<figure>
<img src="/blog/images/case/merging.svg" alt="Schematic representation of optimized evaluation loop" width="100%" class="img-responsive">
<figcaption>optimized evaluation loop</figcaption>
</figure>

In the reworked implementation, `evaluate_selection` is no longer used.
The key insight is that we can defer all merging until the end of the evaluation loop by tracking result provenance.
This was implemented with the following changes:

1. Augment the input batch with a column containing row indices
2. Reduce the augmented batch after each loop iteration to only contain the remaining rows
3. Use the row index column to track which partial result array contains the value for each row 
4. Perform a single merge operation at the end instead of a `zip` operation after each loop iteration 

With these changes it is no longer necessary to `scatter` and `zip` results in each loop iteration.
Instead, when all rows have been matched, we can then merge the partial results using [`arrow_select::merge::merge_n`](https://docs.rs/arrow-select/57.1.0/arrow_select/merge/fn.merge_n.html).

The diagram below illustrates how `merge_n` works for an example where three `WHEN/THEN` branches produced results.
The first branch produced the result `A` for 2, the second produced `B` for row 1, and the third produced `C` and `D` for rows 4 and 5.

<figure>
<img src="/blog/images/case/merge_n.svg" alt="Schematic illustration of the merge_n algorithm" width="100%" class="img-responsive">
<figcaption>merge_n example</figcaption>
</figure>

The `merge_n` algorithm scans through the indices array.
For each non-empty cell, it takes one value from the corresponding values array.
In the example above, we first encounter `1`.
This takes the first element from the values array with index `1`, resulting in `B`.
The next cell contains `0` which takes `A`, from the first array.
Finally, we encounter `2` twice.
This takes the first and second element from the last values array respectively.

This algorithm was initially implemented in DataFusion for `CASE` evaluation, but in the meantime has been generalized and moved into the `arrow-rs` crate as [`arrow_select::merge::merge_n`](https://docs.rs/arrow-select/57.1.0/arrow_select/merge/fn.merge_n.html).

This optimization was implemented by Pepijn Van Eeckhoudt ([`@pepijnve`](https://github.com/pepijnve)) in [PR #18152](https://github.com/apache/datafusion/pull/18152)

### Optimization 3: Column Projection

The third optimization addresses the "filtering unused columns" overhead through projection.

Suppose we have a query like:

```sql
SELECT *, 
  CASE 
    WHEN country = 'USA' THEN state 
    ELSE country 
  END AS region
FROM mailing_address 

where the `mailing_address` table has columns `name`, `surname`, `street`, `number`, `city`, `state`, `country`.
We can see that the `CASE` expression only references columns `country` and `state`, but because all columns are being queried, projection pushdown cannot reduce the number of columns being fed in to the projection operator.

<figure>
<img src="/blog/images/case/no_projection.svg" alt="Schematic illustration of CASE evaluation without projection" width="100%" class="img-responsive">
<figcaption>CASE evaluation without projection</figcaption>
</figure>

During `CASE` evaluation, the batch needs to be filtered using the `WHEN` expression in order to evaluate the `THEN` expression values.
As the diagram above shows, this filtering creates a reduced copy of all columns.

This unnecessary copying can be avoided by first narrowing the batch to only include the columns that are actually needed.

<figure>
<img src="/blog/images/case/projection.svg" alt="Schematic illustration of CASE evaluation with projection" width="100%" class="img-responsive">
<figcaption>CASE evaluation with projection</figcaption>
</figure>

At first glance this might not seem beneficial, since we're introducing an additional processing step.
Luckily projection of a record batch only requires a shallow copy of the record batch.
The column arrays themselves are not copied, and the only work that is actually done is incrementing the reference counts of the columns.

**Impact**: For wide tables with narrow CASE expressions, this dramatically reduces filtering overhead by removing copying of unused columns.

This optimization was implemented by Pepijn Van Eeckhoudt ([`@pepijnve`](https://github.com/pepijnve)) in [PR #18329](https://github.com/apache/datafusion/pull/18329)

### Optimization 4: Eliminating Scatter in Two-Branch Case

Some of the earlier examples in this post used an expression of the form `CASE WHEN condition THEN expr1 ELSE expr2 END` to explain how the general evaluation loop works.
For this kind of two-branch `CASE` expression, [Apache DataFusion] has a more optimized implementation that unrolls the loop.
This specialized `ExpressionOrExpression` fast path still used `evaluate_selection()` for both branches which uses `scatter` and `zip` to combine the results incurring the same performance overhead as the general implementation.

The revised implementation eliminates the use of `evaluate_selection` as follows:

```rust
// Compute the `WHEN` condition for the entire batch
let when_filter = create_filter(&when_value);

// Compute a compact array of `THEN` values for the matching rows
let then_batch = filter_record_batch(batch, &when_filter)?;
let then_value = then_expr.evaluate(&then_batch)?;

// Compute a compact array of `ELSE` values for the non-matching rows
let else_filter = create_filter(&not(&when_value)?);
let else_batch = filter_record_batch(batch, &else_filter)?;
let else_value = else_expr.evaluate(&else_batch)?;
```

This produces two compact arrays (one for THEN values, one for ELSE values) which are then merged with the `merge` function.
In contrast to `zip`, `merge` does not require both of its value inputs to have the same length.
Instead it requires that the sum of the length of the value inputs matches the length of the mask array.

<figure>
<img src="/blog/images/case/merge.svg" alt="Schematic illustration of the merge algorithm" width="100%" class="img-responsive">
<figcaption>merge example</figcaption>
</figure>

This eliminates unnecessary scatter operations and memory allocations for one of the most common `CASE` expression patterns.

Just like `merge_n` this operation has been moved into `arrow-rs` as [`arrow_select::merge::merge`](https://docs.rs/arrow-select/57.1.0/arrow_select/merge/fn.merge.html).

This optimization was implemented by Pepijn Van Eeckhoudt ([`@pepijnve`](https://github.com/pepijnve)) in [PR #18444](https://github.com/apache/datafusion/pull/18444)

### Optimization 5: Table Lookup of Constants

Up until now we've been discussing the implementations for generic `CASE` expressions with arbitrary expressions for both `WHEN` and `THEN`.
Another common use of `CASE` though is to perform a mapping from one set of constants to another.
For instance, expanding numeric constants to human-readable strings can be done using

```sql
CASE status
  WHEN 0 THEN 'idle'
  WHEN 1 THEN 'running'
  WHEN 2 THEN 'paused'
  WHEN 3 THEN 'stopped'
  ELSE 'unknown'
END
```

A final `CASE` optimization recognizes this pattern and compiles the `CASE` expression into a hash table.
Rather than evaluating the `WHEN` and `THEN` expressions, the input expression is evaluated once, and the result array is computed using a vectorized hash table lookup.
This approach avoids the need to filter the input batch and combine partial results entirely.
Instead the result array is computed in a single pass over the input values and the computation time is independent of the number of `WHEN` branches in the `CASE` expression.

This optimization was implemented by Raz Luvaton ([`@rluvaton`](https://github.com/rluvaton)) in [PR #18183](https://github.com/apache/datafusion/pull/18183)

## Results

The degree to which the performance optimizations described in this post will benefit your queries is highly dependent on both your data and your queries.
To give some idea of the impact we ran the following query on the TPC_H `orders` table with a scale factor of 100:

```sql
SELECT
    *,
    case o_orderstatus
        when 'O' then 'ordered'
        when 'F' then 'filled'
        when 'P' then 'pending'
        else 'other'
    end
from orders
```

This query was first run with DataFusion 50.0.0 to get a baseline measurement.
The same query was then run with each optimization applied in turn.
The recorded times are presented as the blue series in the chart below.
The green series shows the time measurement for the `SELECT * FROM orders` to give an idea of the cost the addition of a `CASE` expression in a query incurs.
All measurements were made with a target partition count of `1`.

<figure>
<img src="/blog/images/case/results.png" alt="Performance measurements chart" width="100%" class="img-responsive">
<figcaption>Performance measurements</figcaption>
</figure>

What can be seen in the chart is that the effect of the various optimizations compounds up to the `project` measurement.
Up to that point these results are applicable to any `CASE` expression.
The final improvement in the `hash` measurement is only applicable to simple `CASE` expressions with constant `WHEN` and `THEN` expressions.

The cumulative effect of these optimizations is a 63-71% reduction in CPU time spent evaluating `CASE` expressions compared to the baseline. 

## Summary

Through a number of targeted optimizations, we've transformed `CASE` expression evaluation from a simple, but unoptimized implementation to a highly optimized one.
The optimizations described in this post compound: a `CASE` expression on a wide table with multiple branches and early matches benefits from all four optimizations simultaneously.
The result is significantly reduced CPU time and memory allocation in SQL constructs that are essential for ETL-like queries.
