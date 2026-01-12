---
layout: post
title: Extending SQL in DataFusion: from ->> to TABLESAMPLE
date: 2026-01-12
author: Geoffrey Claude (Datadog)
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

[TOC]

## When standard SQL isn't enough

If you embed [DataFusion][apache datafusion] in your product, your users will eventually run SQL that DataFusion does not recognize. Not because the query is unreasonable, but because SQL in practice includes many dialects and system-specific statements.

Suppose you store data as Parquet files on S3 and want users to attach an external catalog to query them. DataFusion has `CREATE EXTERNAL TABLE` for individual tables, but no built-in equivalent for catalogs. DuckDB has `ATTACH`, SQLite has its own variant, and maybe you really want something even more flexible:

```sql
CREATE EXTERNAL CATALOG my_lake
STORED AS iceberg
LOCATION 's3://my-bucket/warehouse'
OPTIONS ('region' 'eu-west-1');
```

This syntax does not exist in DataFusion today, but you can add it.

---

At the same time, many dialect gaps are smaller and show up in everyday queries:

```sql
-- Postgres-style JSON operators
SELECT payload->'user'->>'id' FROM logs;

-- MySQL-specific types
SELECT DATETIME '2001-01-01 18:00:00';

-- Statistical sampling
SELECT * FROM sensor_data TABLESAMPLE BERNOULLI(10 PERCENT);
```

You can implement all of these _without forking_ DataFusion:

1. **Parse** new syntax (custom statements / dialect quirks)
2. **Plan** new semantics (expressions, types, FROM-clause constructs)
3. **Execute** new operators when rewrites are not sufficient

This post explains where and how to hook into each stage. For complete, working code, see the linked `datafusion-examples`.

---

## Parse → Plan → Execute

DataFusion turns SQL into executable work in stages:

1. **Parse**: SQL text is parsed into an AST (`[Statement]` from [sqlparser-rs])
2. **Logical planning**: `[SqlToRel]` converts the AST into a `[LogicalPlan]`
3. **Physical planning**: The `[PhysicalPlanner]` turns the logical plan into an `[ExecutionPlan]`

Each stage has extension points.

<figure>
  <img src="/blog/images/extending-sql/architecture.svg" alt="DataFusion SQL processing pipeline: SQL String flows through Parser to AST, then SqlToRel (with Extension Planners) to LogicalPlan, then PhysicalPlanner to ExecutionPlan" width="100%" class="img-responsive">
  <figcaption>
    <b>Figure 1:</b> SQL flows through three stages: parsing, logical planning (via <code>SqlToRel</code>, where the Extension Planners hook in), and physical planning. Each stage has extension points: wrap the parser, implement planner traits, or add physical operators.
  </figcaption>
</figure>

To choose the right extension point, look at where the query fails.

| What fails? | What it looks like                          | Where to hook in                                |
| ----------- | ------------------------------------------- | ----------------------------------------------- |
| Parsing     | `Expected: TABLE, found: CATALOG`           | configure dialect or wrap `DFParser`            |
| Planning    | `This feature is not implemented: DATETIME` | `ExprPlanner`, `TypePlanner`, `RelationPlanner` |
| Execution   | `No physical plan for TableSample`          | `ExtensionPlanner` (+ physical operator)        |

We will follow that pipeline order.

---

## 1) Extending parsing: wrapping `DFParser` for custom statements

The `CREATE EXTERNAL CATALOG` syntax from the introduction fails at the parser because DataFusion only recognizes `CREATE EXTERNAL TABLE`. To support new statement-level syntax, you can **wrap `DFParser`**. Peek ahead **in the token stream** to detect your custom syntax, handle it yourself, and delegate everything else to DataFusion.

The [`custom_sql_parser.rs`][custom_sql_parser.rs] example demonstrates this pattern:

```rust
struct CustomParser<'a> { df_parser: DFParser<'a> }

impl<'a> CustomParser<'a> {
  pub fn parse_statement(&mut self) -> Result<CustomStatement> {
    // Peek tokens to detect CREATE EXTERNAL CATALOG
    if self.is_create_external_catalog() {
      return self.parse_create_external_catalog();
    }
    // Delegate everything else to DataFusion
    Ok(CustomStatement::DFStatement(Box::new(
      self.df_parser.parse_statement()?,
    )))
  }
}
```

You do not need to implement a full SQL parser. Reuse DataFusion's tokenizer and parser helpers to consume tokens, parse identifiers, and handle options—the example shows how.

Once parsed, the simplest integration is to treat custom statements as **application commands**:

```rust
match parser.parse_statement()? {
  CustomStatement::DFStatement(stmt) => ctx.sql(&stmt.to_string()).await?,
  CustomStatement::CreateExternalCatalog(stmt) => {
    handle_create_external_catalog(&ctx, stmt).await?
  }
}
```

This keeps the extension logic in your embedding application. The example includes a complete `handle_create_external_catalog` that registers tables from a location into a catalog, making them queryable immediately.

**Full working example:** [`custom_sql_parser.rs`][custom_sql_parser.rs]

---

## 2) Extending expression semantics: `ExprPlanner`

Once SQL _parses_, the next failure is often that DataFusion does not know what a particular expression means.

This is where dialect differences show up in day-to-day queries: operators like Postgres JSON arrows, vendor-specific functions, or small syntactic sugar that users expect to keep working when you switch engines.

`ExprPlanner` lets you define how specific SQL expressions become DataFusion `Expr`. Common examples:

- Non-standard operators (JSON / geometry / regex operators)
- Custom function syntaxes
- Special identifier behavior

### Example: Postgres JSON operators (`->`, `->>`)

The Postgres `->` operator is a good illustration because it is widely used and parses only under the PostgreSQL dialect.

Configure the dialect:

```rust
let config = SessionConfig::new()
    .set_str("datafusion.sql_parser.dialect", "postgres");
let ctx = SessionContext::new_with_config(config);
```

Then implement `ExprPlanner` to map the parsed operator (`BinaryOperator::Arrow`) to DataFusion semantics:

```rust
fn plan_binary_op(&self, expr: RawBinaryExpr, _schema: &DFSchema)
  -> Result<PlannerResult<RawBinaryExpr>> {
  match expr.op {
    BinaryOperator::Arrow => Ok(Planned(/* your Expr */)),
    _ => Ok(Original(expr)),
  }
}
```

Return `Planned(...)` when you handled the expression; return `Original(...)` to pass it to the next planner.

For a complete JSON implementation, see [datafusion-functions-json]. For a minimal end-to-end example in the DataFusion repo, see [`expr_planner_tests`][expr_planner_tests].

---

## 3) Extending type support: `TypePlanner`

After expressions, types are often the next thing to break. Schemas and DDL may reference types that DataFusion does not support out of the box, like MySQL's `DATETIME`.

Type planning tends to come up when interoperating with other systems. You want to accept DDL or infer schemas from external catalogs without forcing users to rewrite types.

`TypePlanner` maps SQL types to Arrow/DataFusion types:

```rust
impl TypePlanner for MyTypePlanner {
  fn plan_type(&self, sql_type: &ast::DataType) -> Result<Option<DataType>> {
    match sql_type {
      ast::DataType::Datetime(Some(3)) => Ok(Some(DataType::Timestamp(TimeUnit::Millisecond, None))),
      _ => Ok(None), // let the default planner handle it
    }
  }
}
```

It is installed when building session state:

```rust
let state = SessionStateBuilder::new()
  .with_default_features()
  .with_type_planner(Arc::new(MyTypePlanner))
  .build();
```

Once installed, if your `CREATE EXTERNAL CATALOG` statement exposes tables with MySQL types, DataFusion can interpret them correctly.

---

## 4) Extending the FROM clause: `RelationPlanner`

Some extensions change what a _relation_ means, not just expressions or types. `RelationPlanner` (available starting in DataFusion 52) intercepts FROM-clause constructs while SQL is being converted into a `LogicalPlan`.

Once you have `RelationPlanner`, there are two main approaches to implementing your extension.

### Strategy A: rewrite to existing operators (PIVOT / UNPIVOT)

If you can translate your syntax into relational algebra that DataFusion already supports, you can implement the feature with **no custom physical operator**.

`PIVOT` rotates rows into columns, and `UNPIVOT` does the reverse. Neither requires new execution logic: `PIVOT` is just `GROUP BY` with `CASE` expressions, and `UNPIVOT` is a `UNION ALL` of each column. The planner rewrites them accordingly:

```rust
match relation {
  TableFactor::Pivot { .. } => /* rewrite to GROUP BY + CASE */,
  TableFactor::Unpivot { .. } => /* rewrite to UNION ALL */,
  other => Original(other),
}
```

Because the output is a standard `LogicalPlan`, DataFusion's usual optimization and physical planning apply automatically.

**Full working example:** [`pivot_unpivot.rs`][pivot_unpivot.rs]

### Strategy B: custom logical + physical (TABLESAMPLE)

Sometimes rewriting is not sufficient. `TABLESAMPLE` returns a random subset of rows from a table and is useful for approximations or debugging on large datasets. Because it requires runtime randomness, you cannot express it as a rewrite to existing operators. Instead, you need a custom logical node and physical operator to execute it.

The approach (shown in [`table_sample.rs`][table_sample.rs]):

1. `RelationPlanner` recognizes `TABLESAMPLE` and produces a custom logical node
2. That node gets wrapped in `LogicalPlan::Extension`
3. `ExtensionPlanner` converts it to a custom `ExecutionPlan`

In code:

```rust
// Logical planning: FROM t TABLESAMPLE (...)  ->  LogicalPlan::Extension(...)
let plan = LogicalPlan::Extension(Extension { node: Arc::new(TableSamplePlanNode { /* ... */ }) });
```

```rust
// Physical planning: TableSamplePlanNode  ->  SampleExec
if let Some(sample_node) = node.as_any().downcast_ref::<TableSamplePlanNode>() {
  return Ok(Some(Arc::new(SampleExec::try_new(input, /* bounds, seed */)?)));
}
```

This is the general pattern for custom FROM constructs that need runtime behavior.

**Full working example:** [`table_sample.rs`][table_sample.rs]

### Background: Origin of the API

`RelationPlanner` originally came out of trying to build `MATCH_RECOGNIZE` support in DataFusion as a Datadog hackathon project. `MATCH_RECOGNIZE` is a complex SQL feature for detecting patterns in sequences of rows, and it made sense to prototype as an extension first. At the time, DataFusion had no extension point at the right stage of SQL-to-rel planning to intercept and reinterpret relations.

[@theirix]'s `TABLESAMPLE` work ([#13563], [#17633]) demonstrated exactly where the gap was: their extension only worked when `TABLESAMPLE` appeared at the query root and any `TABLESAMPLE` inside a CTE or JOIN would error. That limitation motivated [#17843], which introduced `RelationPlanner` to intercept relations at any nesting level. The same hook now supports `PIVOT`, `UNPIVOT`, `TABLESAMPLE`, and can translate dialect-specific FROM-clause syntax (for example, bridging Trino constructs into DataFusion plans).

This is how Datadog approaches compatibility work: build features in real systems first, then upstream the building blocks. A full `MATCH_RECOGNIZE` extension is now in progress, built on top of `RelationPlanner`, with the [`match_recognize.rs`][match_recognize.rs] example as a starting point.

---

## Summary: The Extensibility Workflow

DataFusion's SQL extensibility follows its processing pipeline. When building your own dialect extension, work incrementally:

1.  **Parse**: Use a parser wrapper to intercept custom syntax in the token stream. Produce either a standard `Statement` or your own application-specific command.
2.  **Plan**: Implement the planning traits (`ExprPlanner`, `TypePlanner`, `RelationPlanner`) to give your syntax meaning.
3.  **Execute**: Prefer rewrites to existing operators (like `PIVOT` to `CASE`). Only add custom physical operators via `ExtensionPlanner` when you need specific runtime behavior like randomness or specialized I/O.

---

## Debugging tips

### Print the logical plan

```rust
let df = ctx.sql("SELECT * FROM t TABLESAMPLE (10 PERCENT)").await?;
println!("{}", df.logical_plan().display_indent());
```

### Use [`EXPLAIN`][EXPLAIN]

```sql
EXPLAIN SELECT * FROM t TABLESAMPLE (10 PERCENT);
```

If your extension is not being invoked, it is usually visible in the logical plan first.

---

## When hooks aren't enough

While these extension points cover the majority of dialect needs, some deep architectural areas still have limited or no hooks. If you are working in these parts of the SQL surface area, you may need to contribute upstream:

- Statement-level planning: [`statement.rs`][df_statement_planning]
- JOIN planning: [`relation/join.rs`][df_join_planning]
- TOP / FETCH clauses: [`select.rs`][df_select_planning], [`query.rs`][df_query_planning]

---

## Ideas to try

If you want to experiment with these extension points, here are a few suggestions:

- Geometry operators (for example `@>`, `<@`) via `ExprPlanner`
- Oracle `NUMBER` or SQL Server `MONEY` via `TypePlanner`
- `JSON_TABLE` or semantic-layer style relations via `RelationPlanner`

---

## See also

- Extending SQL Guide: [Extending SQL Guide][extending sql guide]
- Parser wrapping example: [`custom_sql_parser.rs`][custom_sql_parser.rs]
- RelationPlanner examples:

  - `PIVOT` / `UNPIVOT`: [`pivot_unpivot.rs`][pivot_unpivot.rs]
  - `TABLESAMPLE`: [`table_sample.rs`][table_sample.rs]

- ExprPlanner test examples: [`expr_planner_tests`][expr_planner_tests]

## Acknowledgements

Thank you to [@jayzhan211] for designing and implementing the original `ExprPlanner` API ([#11180]), to [@goldmedal] for adding `TypePlanner` ([#13294]), and to [@theirix] for the `TABLESAMPLE` work ([#13563], [#17633]) that helped shape `RelationPlanner`. Thank you to [@alamb] for driving DataFusion's extensibility philosophy and for feedback on this post.

## Get Involved

- **Try it out**: Implement one of the extension points and share your experience
- **File issues or join the conversation**: [GitHub][datafusion github] for bugs and feature requests, [Slack or Discord][communication] for discussion

<!-- Reference links -->

[apache datafusion]: https://datafusion.apache.org/
[datafusion github]: https://github.com/apache/datafusion/
[sqlparser-rs]: https://github.com/sqlparser-rs/sqlparser-rs
[extending sql guide]: https://datafusion.apache.org/library-user-guide/extending-sql.html
[custom_sql_parser.rs]: https://github.com/apache/datafusion/blob/main/datafusion-examples/examples/sql_ops/custom_sql_parser.rs
[pivot_unpivot.rs]: https://github.com/apache/datafusion/blob/main/datafusion-examples/examples/relation_planner/pivot_unpivot.rs
[table_sample.rs]: https://github.com/apache/datafusion/blob/main/datafusion-examples/examples/relation_planner/table_sample.rs
[match_recognize.rs]: https://github.com/apache/datafusion/blob/main/datafusion-examples/examples/relation_planner/match_recognize.rs
[expr_planner_tests]: https://github.com/apache/datafusion/blob/main/datafusion/core/tests/user_defined/expr_planner.rs
[datafusion-functions-json]: https://github.com/datafusion-contrib/datafusion-functions-json
[communication]: https://datafusion.apache.org/contributor-guide/communication.html
[@jayzhan211]: https://github.com/jayzhan211
[@goldmedal]: https://github.com/goldmedal
[@alamb]: https://github.com/alamb
[@theirix]: https://github.com/theirix
[#11180]: https://github.com/apache/datafusion/pull/11180
[#13294]: https://github.com/apache/datafusion/pull/13294
[#13563]: https://github.com/apache/datafusion/issues/13563
[#17633]: https://github.com/apache/datafusion/pull/17633
[#17843]: https://github.com/apache/datafusion/pull/17843
[df_statement_planning]: https://github.com/apache/datafusion/blob/main/datafusion/sql/src/statement.rs
[df_join_planning]: https://github.com/apache/datafusion/blob/main/datafusion/sql/src/relation/join.rs
[df_select_planning]: https://github.com/apache/datafusion/blob/main/datafusion/sql/src/select.rs
[df_query_planning]: https://github.com/apache/datafusion/blob/main/datafusion/sql/src/query.rs
[Statement]: https://docs.rs/sqlparser/latest/sqlparser/ast/enum.Statement.html
[SqlToRel]: https://docs.rs/datafusion/latest/datafusion/sql/planner/struct.SqlToRel.html
[LogicalPlan]: https://docs.rs/datafusion/latest/datafusion/logical_expr/enum.LogicalPlan.html
[PhysicalPlanner]: https://docs.rs/datafusion/latest/datafusion/physical_planner/trait.PhysicalPlanner.html
[ExecutionPlan]: https://docs.rs/datafusion/latest/datafusion/physical_plan/trait.ExecutionPlan.html
[EXPLAIN]: https://datafusion.apache.org/user-guide/sql/explain.html
