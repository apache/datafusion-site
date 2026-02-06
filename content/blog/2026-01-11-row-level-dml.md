---
layout: post
title: Row-Level DML in DataFusion
date: 2026-01-11
author: Ethan Urbanski
categories: [features]
---

<!--
{% comment %}
Licensed to the Apache Software Foundation (ASF) under one or more
contributor license agreements.  See the NOTICE file distributed with
this work for additional information regarding copyright ownership.
The ASF licenses this file to you under the Apache License, Version 2.0
(the "License"); you may not use this file except in compliance
with the License.  You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
{% endcomment %}
-->

[TOC]

DataFusion has always felt like a project built with real-world use in mind. It is fast and modular, and it has maintained a steady commitment to being a toolkit that other systems can build on. This distinction matters because the needs of an embedded analytics feature are not the needs of a lakehouse engine, and the needs of a command-line SQL tool are not the needs of a service that has to manage storage, transactions, and evolution over time.

As DataFusion has grown, more users have wanted to mutate data using familiar SQL. They want `DELETE` and `UPDATE` to be available when their table can support it, and they want it in a way that does not force every storage engine into one shared model.

DataFusion can plan `DELETE` and `UPDATE`, extract the predicates and assignments, and pass them to the provider. The provider executes the mutation according to its storage design and returns a simple result that reports the number of affected rows.

This aligns with DataFusion's architecture. The engine stays focused on planning and execution. The provider remains responsible for storage semantics, including durability, transactional behavior, and whatever representation it uses for row-level changes. DataFusion includes an in-memory reference implementation in `MemTable`, and it backs the behavior with tests that lock in correctness details that matter in practice.

In the rest of this post, we will walk through what changed, show how to implement these hooks in a custom `TableProvider`, and highlight the key correctness details that make `DELETE` and `UPDATE` behave the way SQL users expect.

## Availability

This work has been merged on main and is scheduled for the DataFusion 52.0.0 release.

It was implemented in `apache/datafusion` pull request [19142].

If you want release context, you can follow the release tracking issue [release-52], the release blog post tracking issue [release-blog-52], and the upgrade guide for 52.0.0 [upgrade-52].

For additional reference, the `TableProvider` API changes are in [tableprovider-src]. The `MemTable` reference implementation is in [memtable-src]. The end-to-end sqllogictests are in [dml-delete-slt] and [dml-update-slt].

## What changed

At a high level, this change establishes a new contract between DataFusion and the table layer.

DataFusion can now plan `DELETE` and `UPDATE` and delegate execution to the `TableProvider`. This makes the behavior more useful for SQL users, and it makes it far more practical for embedders who own their storage layer.

Two new capabilities were added to the `TableProvider` API.

The first is `delete_from`. It receives the filter expressions that represent the `WHERE` clause. An empty filter list means delete all rows.

The second is `update`. It receives the same kind of filter expressions and it also receives a set of assignments that represent the `SET` clause. Each assignment pairs a target column name with an expression that defines the new value.

```text
Contract summary

delete_from(state, filters: Vec<Expr>) -> ExecutionPlan
update(state, assignments: Vec<(String, Expr)>, filters: Vec<Expr>) -> ExecutionPlan
Filters are ANDed together. An empty filter list affects all rows.
Output is exactly one row with one UInt64 column named count.
```

Both hooks return an `ExecutionPlan` that produces exactly one row with one `UInt64` column named `count`, reporting affected rows. The convention is deliberately minimal. It is predictable for embedders, easy to test, and consistent with common SQL expectations for mutation statements.

DataFusion is responsible for SQL parsing and planning, expression extraction, and routing to the provider hook. Providers are responsible for semantics and the physical mutation strategy, including durability, atomicity, conflict handling, and how data is updated.

DataFusion also includes a reference implementation in `MemTable`. That reference is useful for two reasons. It provides a concrete baseline for semantics, and it provides a practical template for implementers who want to add DML support to their own providers.

## What this means for SQL users

From a SQL user perspective, the behavior is intentionally straightforward.

If the table you are mutating supports these hooks, `DELETE` and `UPDATE` can run and will return a count of affected rows. If the table does not support them, DataFusion will report that the operation is not supported for that table.

This may sound obvious, but it is an important property. It sets clear expectations while still making it straightforward for providers to adopt support over time.

The following example illustrates the experience.

```sql
CREATE TABLE t AS VALUES (1, 'a'), (2, 'b'), (3, 'c');

DELETE FROM t WHERE column1 > 1;

UPDATE t SET column2 = 'updated' WHERE column1 = 1;
```

By default, DataFusion assigns column names `column1`, `column2`, and so on for `VALUES`, unless you provide explicit aliases.

Each statement returns a single row that reports how many rows were affected.

## What this means for embedders and provider authors

For embedders, this change is a practical improvement.

Before this change, supporting mutations often required custom planning or custom execution plumbing. That is difficult to maintain and it makes it harder to stay close to upstream.

This introduces a clear integration point. DataFusion passes the intent of the operation as expressions, and the provider implements semantics that match its storage model.

That design is both pragmatic and flexible. It does not pretend there is one universal way to mutate data. It defines a small, stable interface and lets providers implement the semantics appropriate for their system.

## How DML flows through the planner

A useful mental model is to think of DML in two phases.

In the first phase, DataFusion parses and plans your SQL just like any other statement. The result is a logical plan that describes the target table, the mutation operation, and the expressions that define which rows are affected and how values should change.

In the second phase, DataFusion builds a physical plan. At that point it routes the DML operation to the table provider. The provider receives the extracted filter expressions. For `UPDATE`, it also receives the extracted assignments. The provider returns an execution plan that performs the work and produces the one row `count` result.

The provider hooks look like this.

```rust
async fn delete_from(
    &self,
    state: &dyn Session,
    filters: Vec<Expr>,
) -> Result<Arc<dyn ExecutionPlan>>;

async fn update(
    &self,
    state: &dyn Session,
    assignments: Vec<(String, Expr)>,
    filters: Vec<Expr>,
) -> Result<Arc<dyn ExecutionPlan>>;
```

DataFusion passes filters and assignments as `Expr` values from the logical plan. Filter predicates arrive as a list of expressions. DataFusion decomposes AND conjunctions into individual expressions and strips table qualifiers so the expressions can be evaluated against the provider schema. Providers should treat the list as ANDed together. Expressions can be simple or complex. If the planner cannot represent a construct in this form, planning fails before the provider is called. Providers should still validate the expression shapes they support and return a clear error when needed.

This design keeps the core planner simple while giving the table layer a first-class integration point for execution.

## Implementing DML in your TableProvider

This section is written for people implementing a custom `TableProvider`. The goal is to be clear and actionable, and to point out the places where correctness usually matters most.

A minimal implementation skeleton looks like this.

```rust
// Pseudocode illustrating the overall structure.
// Your provider may translate Expr values into its own predicate and update formats.

async fn delete_from(
    &self,
    _state: &dyn Session,
    filters: Vec<Expr>,
) -> Result<Arc<dyn ExecutionPlan>> {
    // Filters are passed as a list and should be treated as ANDed together.
    // An empty list should match all rows.
    let predicate = self.translate_filters(filters)?;

    let rows_affected = self.storage.delete_where(predicate).await?;

    Ok(self.make_count_plan(rows_affected))
}

async fn update(
    &self,
    _state: &dyn Session,
    assignments: Vec<(String, Expr)>,
    filters: Vec<Expr>,
) -> Result<Arc<dyn ExecutionPlan>> {
    let predicate = self.translate_filters(filters)?;
    let update_spec = self.translate_assignments(assignments)?;

    let rows_affected = self.storage.update_where(predicate, update_spec).await?;

    Ok(self.make_count_plan(rows_affected))
}
```

Implementations of `translate_filters` and `translate_assignments` vary. Some providers translate `Expr` into an internal predicate language. Others compile expressions to an executable form. If you cannot support a particular expression shape, return a clear error rather than trying to guess.

Assignment expressions can reference other columns. Standard SQL semantics evaluate all assignments against the original row, so be careful not to evaluate later assignments against partially updated values. It is also worth testing type coercions and any non-deterministic functions you intend to support.

Finally, return a predictable result. Both hooks should return exactly one row with one `UInt64` column named `count`. MemTable includes a small execution plan that exists just to return this one row count.

## Correctness details that matter in practice

There is one correctness detail worth calling out because it is easy to miss and it is essential for SQL users.

SQL uses three-valued logic. A predicate can evaluate to true, false, or null. For mutation statements, only true matches. Rows where the predicate evaluates to false should not be affected. Rows where the predicate evaluates to null should also not be affected.

This matters whenever a filter expression touches nullable data. It is also one of those details that can silently create surprising behavior if it is implemented incorrectly.

DataFusion’s tests lock this behavior in for MemTable, which is a good model to follow when you implement DML for other providers.

## MemTable as a reference and a practical tool

MemTable provides an in-memory reference implementation for `DELETE` and `UPDATE`. It offers a compact, readable reference and a practical tool for tests and prototypes.

It is not a transactional storage engine, and it is not meant to replace table formats that provide durability and conflict handling. However, it provides a useful baseline. It gives implementers a known-good semantics target and makes it easier to validate that planning and execution are wired correctly.

## Testing and confidence

There are two kinds of tests that matter for a change like this.

One kind validates that planning wires the operation to the provider correctly. It ensures the provider receives the right filters and assignments.

The other kind validates the user-visible SQL behavior end-to-end. It ensures that `DELETE` and `UPDATE` behave like SQL users expect, including the tricky null semantics.

If you are implementing these hooks for a custom provider, this two-layer approach is a strong pattern. It helps prevent regressions in both wiring and semantics.

## Limitations and future work

This work defines the interface between the planner and the table layer. It does not add a new SQL statement such as `MERGE`. It also does not define transactional semantics. Those are the responsibility of the provider.

If you are implementing these hooks for a provider backed by files or an external catalog, you will likely need to think about concurrency, durability, and how to represent deletes and updates. Some engines will rewrite files. Others will use delete markers. DataFusion does not require any particular approach.

Over time, it would be useful to extend the same pattern to additional DML statements and to add more examples and documentation for provider authors.

## Closing

This work adds a small but important piece of infrastructure. It improves the SQL experience where the provider supports mutations, and it gives embedders a clean interface for implementing row-level DML in the table layer.

If you maintain a custom table provider, this is a good time to add support for these hooks. If you are a user, it is worth trying `DELETE` and `UPDATE` on providers that support them and sharing feedback with the community.

[19142]: https://github.com/apache/datafusion/pull/19142
[release-52]: https://github.com/apache/datafusion/issues/18566
[release-blog-52]: https://github.com/apache/datafusion/issues/19691
[upgrade-52]: https://datafusion.apache.org/library-user-guide/upgrading.html#datafusion-52-0-0
[tableprovider-src]: https://github.com/apache/datafusion/blob/main/datafusion/catalog/src/table.rs
[memtable-src]: https://github.com/apache/datafusion/blob/main/datafusion/catalog/src/memory/table.rs
[dml-delete-slt]: https://github.com/apache/datafusion/blob/main/datafusion/sqllogictest/test_files/dml_delete.slt
[dml-update-slt]: https://github.com/apache/datafusion/blob/main/datafusion/sqllogictest/test_files/dml_update.slt
