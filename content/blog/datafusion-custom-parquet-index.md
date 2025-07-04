# Accelerating Query Processing in DataFusion with Embedded Parquet Indexes

Recent work in the DataFusion community has explored the use of **specialized indexes** to improve query performance, as introduced in this [talk on indexing Parquet](https://www.youtube.com/watch?v=74YsJT1-Rdk). In that presentation, several techniques were discussed for reducing scan overhead by enabling file-level or row-group-level pruning.

Building on those ideas, this blog post demonstrates a concrete implementation of one such technique: **embedding a compact distinct-value index directly inside Parquet files**—preserving format compatibility while enabling fast query pruning during execution.
The example implementation is available in the [parquet_embedded_index.rs](https://github.com/apache/datafusion/blob/main/datafusion-examples/examples/parquet_embedded_index.rs) which is the using distinct values index to speed up query processing in DataFusion. This blog will based on the example implementation and will walk through the design and implementation of this technique.

> **Prerequisite:** this example requires the new “buffered write” API in  
> [apache/arrow‑rs#7714](https://github.com/apache/arrow-rs/pull/7714),  
> which adds a public `write_all`‑style method on `SerializedFileWriter`  
> so its internal byte‑count stays in sync with appended data.  
> That alignment is crucial: it lets us append our custom index bytes  
> immediately after the data pages (alongside Parquet’s page‑index)  
> without breaking any offsets when writing the footer.


## Introduction

Parquet is a popular columnar storage format that balances storage efficiency with fast analytical reads. However, even with column pruning and predicate pushdown, queries over highly selective predicates may still scan unnecessary row groups or even entire files.

To address this, query engines like [DataFusion](https://github.com/apache/datafusion) have explored **indexing techniques** to support file-level pruning. For example, DataFusion includes demos that build **external indexes** alongside Parquet files to accelerate filtering.

However, these solutions require managing a separate index file for every data file, which introduces operational complexity and potential consistency issues. In this post, we show how to embed an application-specific “distinct value” index **directly** inside the Parquet file itself—preserving format compatibility while enabling efficient pruning during query execution.

## Background

Several examples in the DataFusion repository illustrate the benefits of using indexes for pruning:

* [`parquet_index.rs`](https://github.com/apache/datafusion/blob/main/datafusion-examples/examples/parquet_index.rs)
* [`advanced_parquet_index.rs`](https://github.com/apache/datafusion/blob/main/datafusion-examples/examples/advanced_parquet_index.rs)

These examples work by building a separate index file (e.g., a Bloom filter or a map of distinct values) and associating it with a Parquet file on the filesystem. While this allows for faster filtering, it introduces some downsides:

* **Operational complexity:** You now need to track two files per dataset (data + index).
* **Synchronization issues:** Deletion, renaming, or movement of one file without the other causes silent failures.
* **Reduced portability:** It's harder to move or share Parquet data when the index is not self-contained.

This problem has even been cited as a reason for building new formats entirely. For instance, [Amudai’s spec](https://github.com/microsoft/amudai/blob/main/docs/spec/src/what_about_parquet.md) critiques Parquet’s lack of a standardized way to embed auxiliary data like inverted indexes or sketches.

However, **Parquet’s format is extensible by design**: it allows arbitrary key-value metadata in the footer and tolerates unknown content beyond the data pages. This means we *can* safely embed an index inside a Parquet file—*without* breaking compatibility with existing tools.

That’s what we do in this post: embed a compact index of distinct values inline with the data pages, record its offset in the footer, and let DataFusion use it during query planning.


## Motivation

When scanning Parquet files, DataFusion (like other engines) reads row group metadata and data pages sequentially. If you filter on a highly selective predicate (e.g., `category = 'foo'`), you may still incur I/O for row groups that contain no matching values. Embedding a lightweight, per‑file distinct‑value index enables DataFusion to skip entire files that cannot satisfy the filter.

**Key requirements:**

* **Format‑preserving:** Other Parquet readers ignore unknown footer metadata keys, so our custom data does not break compatibility.
* **Efficient lookup:** Checking the index must be cheaper than scanning row groups.
* **Compact storage:** We avoid bloating the Thrift footer by embedding the index inline and recording only its offset in the footer metadata.

## High‑Level Design

1. **Serialize distinct values** for the target column into a simple binary layout:

    * 4‑byte magic header (`IDX1`)
    * 8‑byte little‑endian length
    * newline‑separated UTF‑8 distinct values
2. **Append index bytes inline** immediately after the Parquet data pages, before writing the footer.
3. **Record index location** by adding a key/value entry (`"distinct_index_offset" -> <offset>`) in the Parquet footer metadata.

Other readers will parse the footer, see an unknown key, and ignore it. Only our DataFusion extension will use this index to prune files.

### The Custom Binary Index location in parquet file


```rust
//!                   ┌──────────────────────┐                           
//!                   │┌───────────────────┐ │                           
//!                   ││     DataPage      │ │                           
//!                   │└───────────────────┘ │                           
//!  Standard Parquet │┌───────────────────┐ │                           
//!  Data Pages       ││     DataPage      │ │                           
//!                   │└───────────────────┘ │                           
//!                   │        ...           │                           
//!                   │┌───────────────────┐ │                           
//!                   ││     DataPage      │ │                           
//!                   │└───────────────────┘ │                           
//!                   │┏━━━━━━━━━━━━━━━━━━━┓ │                           
//! Non standard      │┃                   ┃ │                           
//! index (ignored by │┃Custom Binary Index┃ │                           
//! other Parquet     │┃ (Distinct Values) ┃◀│─ ─ ─                      
//! readers)          │┃                   ┃ │     │                     
//!                   │┗━━━━━━━━━━━━━━━━━━━┛ │                           
//! Standard Parquet  │┏━━━━━━━━━━━━━━━━━━━┓ │     │  key/value metadata
//! Page Index        │┃    Page Index     ┃ │        contains location  
//!                   │┗───────────────────┛ │     │  of special index   
//!                   │╔═══════════════════╗ │                           
//!                   │║ Parquet Footer w/ ║ │     │                     
//!                   │║     Metadata      ║ ┼ ─ ─                       
//!                   │║ (Thrift Encoded)  ║ │                           
//!                   │╚═══════════════════╝ │                           
//!                   └──────────────────────┘                           
//!                                                                     
//!                         Parquet File                                 
```

### Crossing checking for DuckDB with our custom distinct‑value index Parquet file:

Embedding a custom distinct‑value index in Parquet files empowers DataFusion to perform file‑level pruning with minimal I/O overhead, while maintaining full compatibility with standard Parquet readers.

To verify this, we tested the output files with [DuckDB](https://duckdb.org/) using its built-in `read_parquet()` function:

```sql
D select * from read_parquet('/tmp/parquet_index_data/*');
┌──────────┐
│ category │
│ varchar  │
├──────────┤
│ foo      │
│ bar      │
│ foo      │
│ baz      │
│ qux      │
│ foo      │
│ quux     │
│ quux     │
└──────────┘
```
It works well without any conflicts. Because we only add an unrecognized footer key (and embed bytes in an unused region), all standard readers—including DuckDB—continue to work seamlessly.

## Example Implementation Walkthrough

### Serializing the Index

```rust
/// Magic bytes to identify our custom index format
const INDEX_MAGIC: &[u8] = b"IDX1";

/// Serialize the distinct index using ArrowWriter to account for byte offsets
fn serialize_index<W: Write + Send>(
    index: &DistinctIndex,
    writer: &mut ArrowWriter<W>,
) -> Result<()> {
    // Get current byte offset (end of data pages)
    let offset = writer.bytes_written();

    // Build newline‑separated UTF‑8 payload
    let serialized = index.inner.iter().cloned().collect::<Vec<_>>().join("\n");
    let bytes = serialized.into_bytes();

    // Write magic + length
    writer.write_all(INDEX_MAGIC)?;
    writer.write_all(&(bytes.len() as u64).to_le_bytes())?;

    // Write index payload
    writer.write_all(&bytes)?;

    // Append offset metadata to footer
    writer.append_key_value_metadata(
        KeyValue::new(
            "distinct_index_offset".to_string(),
            offset.to_string(),
        ),
    );
    Ok(())
}
```

### Reading the Index

On the read path, we:

1. Open the Parquet footer and extract `distinct_index_offset`.
2. Seek to that offset in the file.
3. Read and validate `IDX1` magic.
4. Read the 8‑byte length and then the payload.
5. Reconstruct `DistinctIndex` from newline‑delimited strings.

### DataFusion `TableProvider`

We implement `DistinctIndexTable` that:

* During `try_new`, scans a directory of Parquet files and reads each file’s `DistinctIndex`.
* In `scan()`, inspects pushed‑down filters on the indexed column (e.g., `category = 'foo'`).
* Uses `distinct_index.contains(value)` to pick only matching files.
* Delegates actual row‑group reads to `ParquetSource` for the selected files.

### Usage overview

```rust
// Write sample files with indexes
tmp_dir.iter().for_each(|(name, vals)| {
    write_file_with_index(&dir.join(name), vals).unwrap();
});

// Register provider and query
let provider = Arc::new(DistinctIndexTable::try_new(dir, schema.clone())?);
ctx.register_table("t", provider)?;

// Only files containing 'foo' will be scanned
let df = ctx.sql("SELECT * FROM t WHERE category = 'foo'").await?;
df.show().await?;
```

## Conclusion

Embedding a custom distinct‑value index in Parquet files empowers DataFusion to perform file‑level pruning with minimal I/O overhead, while maintaining full compatibility with standard Parquet readers.
