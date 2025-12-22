---
layout: post
title: Optimizing SQL `CASE` Expression Evaluation
date: 2025-11-11
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

# Optimizing CASE Expression Evaluation in DataFusion

SQL's `CASE` expression is one of the few constructs the language provides to perform conditional logic.
Its deceptively simple syntax hides significant implementation complexity.
Over the past few releases, we've landed a series of improvements to [Apache DataFusion]'s `CASE` expression evaluator that reduce both CPU time and memory allocations.
This post walks through the original implementation, its performance bottlenecks, and how we addressed them step by step.
Finally we'll also take a look at some future improvements to `CASE` that are in the works.

## Background: CASE Expression Evaluation

SQL supports two forms of CASE expressions:

1. **Simple**: `CASE expr WHEN value1 THEN result1 WHEN value2 THEN result2 ... END`
2. **Searched**: `CASE WHEN condition1 THEN result1 WHEN condition2 THEN result2 ... END`

The simple form evaluates an expression once for each input row and then tests that value against the expressions (typically constants) in each `WHEN` clause using equality comparisons.
Think of it as a limited Rust `match` expression.

Here's a simple example:

```sql
CASE status
    WHEN 'pending' THEN 1
    WHEN 'active' THEN 2
    WHEN 'complete' THEN 3
    ELSE 0
END
```

In this `CASE` expression, `status` is evaluated once per row, and then its value is tested for equality with the values `'pending'`, `'active'`, and `'complete'` in that order.
The `THEN` expression value for the first matching `WHEN` expression is returned per row.

The searched `CASE` form is a more flexible variant.
It evaluates completely independent boolean expressions for each branch.

This allows you to test different columns with different operators per branch as can be seen in the following example:

```sql
CASE
    WHEN age > 65 THEN 'senior'
    WHEN childCount != 0 THEN 'parent'
    WHEN age < 21 THEN 'minor'
    ELSE 'adult'
END
```

In both forms, branches are evaluated sequentially with short-circuit semantics: for each row, once a `WHEN` condition matches, the corresponding `THEN` expression is evaluated. Any further branches are not evaluated for that row.
This lazy evaluation model is critical for correctness.
It let's you safely write `CASE` expressions like

```sql
CASE
    WHEN denominator == 0 THEN NULL
    ELSE nominator / denominator
END
```

that are guaranteed to not trigger divide-by-zero errors.

## `CASE` Evaluation in DataFusion 50.0.0

For the rest of this post we'll be looking at 'searched case' evaluation.
'Simple case' uses a distinct, but very similar implementation.
The same set of improvements has been applied to both.

The baseline implementation in DataFusion 50.0.0 evaluated `CASE` using a straightforward approach:

1. Start with an output array `out` with the same length as the input batch, filled with nulls. Additionally, create a bit vector `remainder` with the same length and each value set to `true`.
2. For each `WHEN`/`THEN` branch:
  - Evaluate the `WHEN` condition for remaining unmatched rows using `PhysicalExpr::evaluate_selection`, passing in the input batch and the `remainder` mask
  - If any rows matched, evaluate the `THEN` expression for those rows using `PhysicalExpr::evaluate_selection`
  - Merge the results into the `out` using the `zip` kernel
  - Update the `remainder` mask to exclude matched rows
3. If there's an `ELSE` clause, evaluate it for any remaining unmatched rows and merge using `zip`

Here's a simplified version of the original loop:

```rust
let mut current_value = new_null_array(&return_type, batch.num_rows());
let mut remainder = BooleanArray::from(vec![true; batch.num_rows()]);

for (when_expr, then_expr) in &self.when_then_expr {
    let when_value = when_expr.evaluate_selection(batch, &remainder)?
        .into_array(batch.num_rows())?;
    let when_value = and(&when_value, &remainder)?;

    if when_value.true_count() == 0 {
        continue;
    }

    let then_value = then_expr.evaluate_selection(batch, &when_value)?;
    current_value = zip(&when_value, &then_value, &current_value)?;
    remainder = and_not(&remainder, &when_value)?;
}
```

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
        let filtered_batch = filter_record_batch(batch, selection)?;
        let filtered_result = self.evaluate(&filtered_batch)?;
        scatter(selection, filtered_result)
    }
}
```

The `evaluate_selection` method first filters the input batch to only include rows that match the `selection` mask.
It then calls the regular `evaluate` method using the filtered batch as input.
Finally, to return a result array with the same number of rows as `batch`, the `scatter` function is called.
This function produces a new array padded with `null` values for any rows that didn't match the `selection` mask.

So how does the simple evaluation strategy and use of `evaluate_selection` cause performance overhead?

### Problem 1: No Early Exit

The case evaluation loop always iterated through all branches, even when every row had already been matched.
In queries where early branches match many rows, this meant unnecessary work was done for remaining rows.

### Problem 2: Repeated Filtering, Scattering, and Merging

Each iteration performed operations that are very well-optimized but still not cost free to execute:
- **Filtering**: `PhysicalExpr::evaluate_selection` filters the entire `RecordBatch` (all columns) for each branch. For the `WHEN` expression, this was done even if the selection mask was entirely empty.
- **Scattering**: `PhysicalExpr::evaluate_selection` scatters the filtered result back to the original `RecordBatch` length.
- **Merging**: The `zip` kernel is called once per branch to merge partial results into the output array

Each of these steps allocates new arrays and shuffles a lot of data around. 

### Problem 3: Filtering Unused Columns

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

the implementation would filter all columns 26 columns even though only a single column is needed for the entire `CASE` expression evaluation.
Again this involves a non-negligible amount of allocation and data copying.

## Performance Improvements

### Optimization 1: Short-Circuit Early Exit

The first optimization added early exit logic to the evaluation loop:

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

**Impact**: For queries where early branches match all rows, this eliminates unnecessary branch evaluations and `ELSE` clause processing.

### Optimization 2: Optimized Result Merging

The second optimization fundamentally restructured how partial results are merged.
Instead of using `zip()` after each branch to merge results into an output array, we now:

1. Maintain the subset of rows still needing evaluation across loop iterations
2. Filter the batch progressively as rows are matched
3. Build an index structure that tracks which branch produced each row's result
4. Perform a single merge operation at the end

The key insight is that we can defer all merging until the end of the evaluation loop by tracking result provenance.
When a branch matches a number of rows, instead of immediately merging with `zip()`, we:
1. Store the partial result array
2. Mark the cells corresponding to each row in an indices array as needing to take one value from the partial result array

In the example below, three `WHEN/THEN` branches produced results.
The first branch produced the result `A` for 2, the second produced `B` for row 1, and the third produced `C` and `D` for rows 4 and 5.
The final result array is obtained by running the arrays through the merge operation.

```
┌───────────┐  ┌─────────┐                             ┌─────────┐
│┌─────────┐│  │   None  │                             │   NULL  │
││    A    ││  ├─────────┤                             ├─────────┤
│└─────────┘│  │    1    │                             │    B    │
│┌─────────┐│  ├─────────┤                             ├─────────┤
││    B    ││  │    0    │   merge_n(values, indices)  │    A    │
│└─────────┘│  ├─────────┤  ─────────────────────────▶ ├─────────┤
│┌─────────┐│  │   None  │                             │   NULL  │
││    C    ││  ├─────────┤                             ├─────────┤
│├─────────┤│  │    2    │                             │    C    │
││    D    ││  ├─────────┤                             ├─────────┤
│└─────────┘│  │    2    │                             │    D    │
└───────────┘  └─────────┘                             └─────────┘
   arrays        indices                                  result
```

The main benefits of this merge operation are that the `scatter` step is eliminated entirely, and instead of requiring
a `zip` per branch only a single `merge_n` is done.

Besides more efficient merging, we also maintain a progressively filtered `remainder_batch`.

```rust
let mut remainder_batch = Cow::Borrowed(batch);
let mut remainder_rows = UInt32Array::from_iter_values(0..batch.num_rows());

for branch in branches {
    // Evaluate on progressively smaller batch
    let when_value = evaluate_on(&remainder_batch)?;

    // Filter remainder_batch for next iteration
    let next_filter = create_filter(&not(&when_value)?);
    remainder_batch = Cow::Owned(filter_record_batch(&remainder_batch, &next_filter)?);
    remainder_rows = filter_array(&remainder_rows, &next_filter)?;
}
```

As rows are matched, the `remainder_batch` shrinks, making subsequent filter operations a bit faster.

**Impact**: This eliminates N-1 merge operations and makes filtering progressively cheaper as branches match rows.

This new operation was initially developed specifically for DataFusion's `CASE` evaluation, but in the meantime has been generalized and moved into the `arrow-rs` crate as [`arrow_select::merge::merge_n`](https://docs.rs/arrow-select/57.1.0/arrow_select/merge/fn.merge_n.html).

### Optimization 3: Column Projection

The third optimization addresses the "filtering unused columns" problem through projection.
Before evaluating a CASE expression, we:

1. Analyze all WHEN/THEN/ELSE expressions to find referenced columns
2. Build a projection vector containing only those column indices
3. Derive new versions of the expressions with updated column references

For example, if the original CASE references columns at indices `[1, 5, 8]` in a 20-column batch:
- Project the batch to a 3-column batch with those columns
- Rewrite expressions from `col@1, col@5, col@8` to `col@0, col@1, col@2`
- Evaluate using the projected batch

This is encapsulated in a `ProjectedCaseBody` structure:

```rust
struct ProjectedCaseBody {
    projection: Vec<usize>,     // [1, 5, 8]
    body: CaseBody,             // Expressions with rewritten column indices
}
```

The projection logic is only applied when it would be beneficial (i.e., when the number of used columns is lower than the total number of columns in the batch).

**Impact**: For wide tables with narrow CASE expressions, this dramatically reduces filtering overhead by removing copying of unused columns.

### Optimization 4: Eliminating Scatter in Two-Branch Case

The final optimization targets a common pattern: `CASE WHEN condition THEN expr1 ELSE expr2 END`.

Previously, this used the specialized `ExpressionOrExpression` fast path, but still used `evaluate_selection()` which produces scattered results:

```rust
// Old approach: produces scattered array with batch.num_rows() elements
let then_value = then_expr.evaluate_selection(batch, &when_value)?
    .into_array(batch.num_rows())?;
```

The new approach filters the batch first, then evaluates:

```rust
// New approach: filter to only matching rows
let when_filter = create_filter(&when_value);
let then_batch = filter_record_batch(batch, &when_filter)?;
let then_value = then_expr.evaluate(&then_batch)?;  // Produces compact array

let else_filter = create_filter(&not(&when_value)?);
let else_batch = filter_record_batch(batch, &else_filter)?;
let else_value = else_expr.evaluate(&else_batch)?;
```

This produces two compact arrays (one for THEN values, one for ELSE values) which are then merged with a custom merge function that doesn't require pre-scattered inputs:

```rust
fn merge(mask: &BooleanArray, truthy: ColumnarValue, falsy: ColumnarValue) -> ArrayRef {
    // Interleave truthy and falsy values directly using mask
    // without requiring pre-alignment
}
```

**Impact**: This eliminates unnecessary scatter operations and memory allocations for one of the most common CASE expression patterns.

Just like `merge_n` this operation has been moved into `arrow-rs` as [`arrow_select::merge::merge`](https://docs.rs/arrow-select/57.1.0/arrow_select/merge/fn.merge.html).

## Summary

Through four targeted optimizations, we've transformed CASE expression evaluation from a simple but inefficient implementation to a highly optimized one that:

1. **Exits early** when all rows are matched
2. **Defers merging** until the end with a single interleave operation
3. **Projects columns** to avoid filtering unused data
4. **Eliminates scatter** operations in common patterns

These improvements compound: a CASE expression on a wide table with multiple branches and early matches benefits from all four optimizations simultaneously.
The result is significantly reduced CPU time and memory allocation in one of SQL's most frequently used constructs.