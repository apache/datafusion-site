---
layout: post
title: Implementing your own SQL dialect and SQL statements with DataFusion
date: 2025-07-26
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

Have you ever wished you could extend SQL with custom statements tailored to your specific use case? Maybe you're working with a parquet-files-on-S3 storage approach and need an `ATTACH DATABASE` statement, or perhaps you want to implement catalog management features similar to [DuckDB] or [SQLite]. With [Apache DataFusion], you can do exactly that – and it's more straightforward than you might think.

[DuckDB]: https://duckdb.org/
[SQLite]: https://www.sqlite.org/
[Apache DataFusion]: https://datafusion.apache.org/

## The Challenge: Beyond Standard SQL

Imagine you're building a data platform that uses a parquet-files-on-S3 storage pattern. Your application needs to dynamically discover and attach databases, similar to how [DuckDB] handles multiple databases with its `ATTACH` statement. While [DataFusion] supports `CREATE EXTERNAL TABLE`, you need something more flexible – perhaps a statement like:

```sql
CREATE EXTERNAL CATALOG my_catalog
STORED AS PARQUET
LOCATION 's3://my-bucket/data/'
OPTIONS (
  'aws.region' = 'us-west-2',
  'catalog.type' = 'hive_metastore'
);
```

Standard SQL doesn't have this capability, but DataFusion's extensible architecture makes it possible to add custom SQL statements like this.

## Understanding the SQL Processing Pipeline

Before diving into custom implementations, let's understand how DataFusion processes SQL queries. The journey from SQL text to execution follows this path:

```text
+----------+     +-----+      +--------------+      +---------------+      +-----------+
| SQL Text |---> | AST | ---> | Logical Plan | ---> | Physical Plan | ---> | Execution |
+----------+     +-----+      +--------------+      +---------------+      +-----------+
```

1. **SQL Text:** The raw SQL string you write
2. **Parser:** DataFusion's `DFParser` converts SQL text into an Abstract Syntax Tree (AST)
3. **AST:** A structured representation of the SQL statement using DataFusion's `Statement` enum
4. **Logical Plan:** DataFusion's internal representation that describes what to do
5. **Physical Plan:** The executable plan that describes how to do it
6. **Execution:** The actual query execution

The key insight is that DataFusion allows you to wrap and extend the existing `DFParser` to handle custom statements while still leveraging all the built-in SQL parsing capabilities

## Extending the SQL Parser: Learning from the Example

DataFusion provides an excellent example of custom SQL dialect implementation in their [sql_dialect.rs] example. Let's break down how it works and then apply the pattern to our `ATTACH DATABASE` use case.
[sql_dialect.rs](https://github.com/apache/datafusion/blob/main/datafusion-examples/examples/sql_dialect.rs)

## The DataFusion Pattern: Wrapping and Extending

Let's examine the actual DataFusion example to understand the pattern:

### Step 1: Wrap the DataFusion Parser

```rust

use datafusion::sql::{
    parser::{CopyToSource, CopyToStatement, DFParser, DFParserBuilder, Statement},
    sqlparser::{keywords::Keyword, tokenizer::Token},
};

/// Wrap the existing DFParser rather than replacing it
struct MyParser<'a> {
    df_parser: DFParser<'a>,
}

impl<'a> MyParser<'a> {
    fn new(sql: &'a str) -> Result<Self> {
        let df_parser = DFParserBuilder::new(sql).build()?;
        Ok(Self { df_parser })
    }

    /// Check if we're dealing with a COPY statement
    fn is_copy(&self) -> bool {
        matches!(
            self.df_parser.parser.peek_token().token,
            Token::Word(w) if w.keyword == Keyword::COPY
        )
    }
}

```

### Step 2: Delegate Parsing, Add Custom Logic

The crucial part – let DataFusion do the parsing, then add your custom logic:

```rust
impl<'a> MyParser<'a> {
    pub fn parse_statement(&mut self) -> Result<MyStatement, DataFusionError> {
        if self.is_copy() {
            // Let DataFusion parse the COPY statement structure
            self.df_parser.parser.next_token(); // consume COPY
            let df_statement = self.df_parser.parse_copy()?;

            // Now add our custom logic
            if let Statement::CopyTo(s) = df_statement {
                Ok(MyStatement::from(s))  // This is where the magic happens
            } else {
                Ok(MyStatement::DFStatement(Box::from(df_statement)))
            }
        } else {
            // For non-COPY statements, delegate completely to DataFusion
            let df_statement = self.df_parser.parse_statement()?;
            Ok(MyStatement::from(df_statement))
        }
    }
}
```

### Step 3: Custom Statement Types with Smart Conversion

Here's the elegant part – the custom logic happens in the type conversion:

```rust
enum MyStatement {
    DFStatement(Box<Statement>),        // Standard DataFusion statements
    MyCopyTo(MyCopyToStatement),        // Our custom COPY handling
}

// The key insight: custom logic in the From implementation
impl From<CopyToStatement> for MyStatement {
    fn from(s: CopyToStatement) -> Self {
        // Check if this is our special case
        if s.stored_as == Some("FASTA".to_string()) {
            // Handle FASTA format with custom logic
            Self::MyCopyTo(MyCopyToStatement::from(s))
        } else {
            // Fall back to standard DataFusion behavior
            Self::DFStatement(Box::from(Statement::CopyTo(s)))
        }
    }
}

// Our custom COPY statement for FASTA format
struct MyCopyToStatement {
    pub source: CopyToSource,
    pub target: String,
}

impl From<CopyToStatement> for MyCopyToStatement {
    fn from(s: CopyToStatement) -> Self {
        Self {
            source: s.source,
            target: s.target,
        }
    }
}
```

## The Power of This Pattern

What makes this approach so powerful is its simplicity and reusability. Notice how the example:

1. **Reuses all DataFusion parsing logic** - no need to handle SQL syntax errors, keyword parsing, or complex grammar rules
2. **Extends through type conversion** - the custom behavior is cleanly separated in the `From` implementations
3. **Maintains backward compatibility** - standard `COPY` statements work exactly as before
4. **Provides clear extension points** - you can easily add more custom formats

### Running the Example

Here's how the complete example works in practice:

```rust
#[tokio::main]
async fn main() -> Result<()> {
    let mut my_parser =
        MyParser::new("COPY source_table TO 'file.fasta' STORED AS FASTA")?;

    let my_statement = my_parser.parse_statement()?;

    match my_statement {
        MyStatement::DFStatement(s) => {
            println!("Standard DataFusion statement: {s}");
            // Handle with regular DataFusion execution
        }
        MyStatement::MyCopyTo(s) => {
            println!("Custom FASTA export: {s}");
            // Execute your custom FASTA export logic
            execute_fasta_export(s).await?;
        }
    }

    Ok(())
}

async fn execute_fasta_export(stmt: MyCopyToStatement) -> Result<()> {
    println!("Exporting {} to {} in FASTA format", stmt.source, stmt.target);

    // Your custom FASTA export implementation here:
    // 1. Execute the query to get results
    // 2. Format results as FASTA sequences
    // 3. Write to the target file

    Ok(())
}
```

## Key Insights from the DataFusion Example

The DataFusion [sql_dialect.rs] example teaches us several crucial patterns:

1. **Don't reinvent SQL parsing** - Wrap `DFParser` and leverage its robust SQL handling
2. **Extend through type conversion** - Put custom logic in `From` implementations, not parsing code
3. **Maintain compatibility** - Standard statements continue to work unchanged
4. **Keep it simple** - The example focuses on one clear extension rather than trying to do everything
5. **Use enums for clean abstraction** - `MyStatement` provides a unified interface for both standard and custom statements
   [sql_dialect.rs]:https://github.com/apache/datafusion/blob/main/datafusion-examples/examples/sql_dialect.rs

## Conclusion

The DataFusion's example demonstrates a remarkably elegant approach to extending SQL: don't fight the existing system, enhance it. By wrapping `DFParser` and adding custom logic through type conversions, you get the best of both worlds – robust SQL parsing and domain-specific functionality.
The pattern's power lies in its simplicity. You write minimal code, reuse [DataFusion]'s battle-tested SQL parsing, and create clean extension points for your custom logic. Whether you need specialized export formats, custom catalog management, or domain-specific data operations, this approach provides a solid foundation.
Start with the DataFusion example, understand how the type conversions work, and then apply the same pattern to extend the SQL statements that matter for your use case. The DataFusion community has created an excellent template – now it's time to build something amazing on top of it.
[DataFusion]: https://datafusion.apache.org/

A heartfelt thank you to [@alamb] and [@andygrove] for their invaluable reviews and thoughtful feedback—they’ve been instrumental in shaping this post.

The Apache Arrow and Apache DataFusion communities are vibrant, welcoming, and full of passionate developers building something truly powerful. If you’re excited about high-performance analytics and want to be part of an open-source journey, I highly encourage you to explore the [official documentation](<(https://datafusion.apache.org/)>) and dive into one of the many [open issues](https://github.com/apache/datafusion/issues). There’s never been a better time to get involved!

[@andygrove]: https://github.com/andygrove
[@alamb]: https://github.com/alamb
