---
layout: post
title: Optimizing CASE Expression Evaluation
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

SQL's `CASE` expression is ubiquitous in analytical queries, but its deceptively simple syntax hides significant implementation complexity. Over the past few weeks, we've landed a series of improvements to DataFusion's CASE expression evaluator that reduce both CPU time and memory allocations. This post walks through the original implementation, its performance bottlenecks, and how we addressed them step by step.

## Background: CASE Expression Evaluation

DataFusion supports two forms of CASE expressions:

1. **Value matching**: `CASE expr WHEN value1 THEN result1 WHEN value2 THEN result2 ... END`
2. **Boolean conditions**: `CASE WHEN condition1 THEN result1 WHEN condition2 THEN result2 ... END`

In both forms, the `WHEN` conditions are evaluated one-by-one in the order they're declared across a batch of data (a `RecordBatch`), with short-circuit semantics: once a `WHEN` condition matches for a particular row, subsequent branches are not evaluated for that row.

## The Original Implementation

Before our optimizations, the evaluation logic followed a straightforward approach:

1. Start with an output array filled with nulls
2. For each WHEN/THEN branch:
  - Evaluate the WHEN condition for remaining unmatched rows using `PhysicalExpr::evaluate_selection`
  - If any rows matched, evaluate the THEN expression for those rows
  - Merge the results into the output array using the `zip` kernel
  - Update the remainder mask to exclude matched rows
3. If there's an ELSE clause, evaluate it for any remaining unmatched rows and merge

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

While correct, this implementation had several performance issues.

### Problem 1: No Early Exit

The loop always iterated through all branches, even when every row had already been matched. In queries where early branches match most rows, this meant unnecessary work checking for remaining rows.

### Problem 2: Repeated Filtering and Merging

Each iteration performed expensive operations:
- **Filtering**: `PhysicalExpr::evaluate_selection` filters the entire `RecordBatch` (all columns) for each branch
- **Merging**: The `zip` kernel is called once per branch to merge partial results into the output array

For a CASE with N branches, this meant N filter operations and N merge operations, even though many branches might match very few rows.

### Problem 3: Filtering Unused Columns

The `PhysicalExpr::evaluate_selection` method filters the entire record batch, including columns that the current branch's `WHEN` and `THEN` expressions don't even reference. For wide tables (many columns) with narrow expressions (few column references), this is wasteful.

Consider:
```sql
CASE WHEN col_a > 10 THEN col_b ELSE NULL END
```

Even though only two columns, `col_a` and `col_b`, are accessed filtering would copy all columns in the batch.

### Problem 4: Unnecessary Scatter Operations

For the optimized `ExpressionOrExpression` fast path (single WHEN with both THEN and ELSE), the implementation used `evaluate_selection()` followed by `zip()`. The `evaluate_selection()` method produces a "scattered" array where values are aligned with the original batch, requiring memory allocation and copying even for rows that would be discarded.

## Optimization 1: Short-Circuit Early Exit (commit 7c215ed)

The first optimization added early exit logic:

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

Additionally, we avoid evaluating the ELSE clause when no rows remain:

```rust
if let Some(else_expr) = &self.else_expr {
    remainder = or(&base_nulls, &remainder)?;
    if remainder.true_count() > 0 {
        // ... evaluate else ...
    }
}
```

**Impact**: For queries where early branches match all rows, this eliminates unnecessary branch evaluations and ELSE clause processing.

## Optimization 2: Optimized Result Merging (commit e9431fc)

The second optimization fundamentally restructured how partial results are merged. Instead of calling `zip()` after each branch to merge results into a monolithic output array, we now:

1. Maintain the subset of rows still needing evaluation across loop iterations
2. Filter the batch progressively as rows are matched
3. Build an index structure that tracks which branch produced each row's result
4. Perform a single merge operation at the end

The key insight is that we can defer all merging until the end by tracking provenance:

```rust
struct ResultBuilder {
    arrays: Vec<ArrayData>,           // Partial result arrays
    indices: Vec<PartialResultIndex>, // Per-row: which array has this row's value?
}
```

When a branch matches rows `[1, 4, 7]`, instead of immediately merging with `zip()`, we:
1. Store the result array (containing 3 values)
2. Mark indices `1`, `4`, and `7` in the index vector to point to this array

At the end, we use a custom "multi-zip" operation that interleaves values from all partial result arrays according to the index vector in a single pass.

Additionally, we maintain a progressively filtered `remainder_batch`:

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

As rows are matched, the `remainder_batch` shrinks, making subsequent filter operations cheaper.

**Impact**: This eliminates N-1 merge operations and makes filtering progressively cheaper as branches match rows.

## Optimization 3: Column Projection (commit c3e49fb)

The third optimization addresses the "filtering unused columns" problem through projection. Before evaluating a CASE expression, we:

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

The projection logic is only applied when it would be beneficial (i.e., when the number of used columns is less than the total number of columns in the batch).

**Impact**: For wide tables with narrow CASE expressions, this dramatically reduces filtering overhead by avoiding copies of unused columns.

## Optimization 4: Eliminating Scatter in Two-Branch Case (commit 32d2618)

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

## Summary

Through four targeted optimizations, we've transformed CASE expression evaluation from a simple but inefficient implementation to a highly optimized path that:

1. **Exits early** when all rows are matched
2. **Defers merging** until the end with a single interleave operation
3. **Projects columns** to avoid filtering unused data
4. **Eliminates scatter** operations in common patterns

These improvements compound: a CASE expression on a wide table with multiple branches and early matches benefits from all four optimizations simultaneously. The result is significantly reduced CPU time and memory allocation in one of SQL's most frequently used constructs.

All of these changes maintain full compatibility with DataFusion's existing semantics and are covered by the existing test suite, demonstrating that performance optimization doesn't have to compromise correctness or require API changes.