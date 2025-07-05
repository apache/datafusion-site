## Accelerating Query Processing in DataFusion with Embedded Parquet Indexes

It’s a common misconception that Parquet can only deliver basic Min/Max pruning and Bloom filters—and that adding anything "smarter" requires inventing a whole new file format. In fact, Parquet's column‑oriented design, with its well‑defined footer metadata and reserved byte regions, already provides the flexibility to embed arbitrary indexing structures without breaking compatibility. 

In this post, we'll first review the core concepts of the Apache Parquet file format. Then explain how to store custom indexes inside Parquet files, and finally show how Apache DataFusion can leverage a **compact distinct‑value index** to achieve ultra‑fast file‑level pruning—all while preserving complete interchangeability with other tools.

And besides the custom index, a straightforward rewritten parquet file can have good improvement also. 
For example, rewriting ClickBench partitioned dataset with better settings* (not resorting) improves
performance by more than 2x for many queries. So with a custom index, we can expect even more improvement.
More details: [Blog post about parquet vs custom file formats #16149
](https://github.com/apache/datafusion/issues/16149). [JigaoLuo](https://github.com/JigaoLuo) and [XiangpengHao](https://github.com/XiangpengHao) have been exploring these Parquet‑rewriting techniques over in the liquid‑cache which is using DataFusion, repo—check out [XiangpengHao/liquid‑cache#227](https://github.com/XiangpengHao/liquid-cache/issues/227) for more insights.

Building on the ideas from Andrew Lamb’s talk on [indexing Parquet with DataFusion](https://www.youtube.com/watch?v=74YsJT1-Rdk), we’ll:

1. Review Parquet’s built‑in metadata hooks (Min/Max, page index, Bloom filters).
2. Introduce a simple on‑page binary format for a distinct‑value index.
3. Show how to append that index inline, record its offset in the footer, and have DataFusion consume it at query time.
4. Demonstrate end‑to‑end examples (including DuckDB compatibility) using code from
   [`parquet_embedded_index.rs`](https://github.com/apache/datafusion/blob/main/datafusion-examples/examples/parquet_embedded_index.rs).

> **Prerequisite:** Requires **arrow‑rs v55.2.0** or later, which includes the new “buffered write” API ([apache/arrow-rs#7714](https://github.com/apache/arrow-rs/pull/7714)).  
> This API keeps the internal byte count in sync so you can append index bytes immediately after data pages.

---

## Introduction

Parquet is a popular columnar format tuned for high‑performance analytics: column pruning, predicate pushdown, page indices and Bloom filters all help reduce I/O. Yet when predicates are highly selective (e.g. `category = 'foo'`), engines often still scan entire row groups or files that contain zero matches.

Many systems solve this by producing *external* index files—Bloom filters, inverted lists, or custom sketches—alongside Parquet. But juggling separate index files adds operational overhead and risks out‑of‑sync data. Worse, some have used that pain point to justify brand‑new formats (see Microsoft’s [Amudai spec](https://github.com/microsoft/amudai/blob/main/docs/spec/src/what_about_parquet.md)).

**But Parquet itself is extensible**: it tolerates unknown bytes after data pages and arbitrary key/value pairs in its footer. We can exploit those hooks to **embed** a small, per‑file distinct‑value index directly in the file—no extra files, no format forks, and no compatibility breakage.

In the rest of this post, we’ll:

1. Walk through the simple binary layout for a distinct‑value list.
2. Show how to write it inline after the normal Parquet pages.
3. Record its offset in the footer’s metadata map.
4. Extend DataFusion’s `TableProvider` to discover and use that index for file‑level pruning.
5. Verify everything still works in DuckDB via `read_parquet()`.

---

## 1. Parquet 101: File Anatomy & Native Pruning Hooks
TODO add image here?

## 2. Why Parquet Still Scans Too Much

Several examples in the DataFusion repository illustrate the benefits of using external indexes for pruning:

* [`parquet_index.rs`](https://github.com/apache/datafusion/blob/main/datafusion-examples/examples/parquet_index.rs)
* [`advanced_parquet_index.rs`](https://github.com/apache/datafusion/blob/main/datafusion-examples/examples/advanced_parquet_index.rs)

Those demos work by building separate index files (Bloom filters, maps of distinct values) and associating them with Parquet files. While effective, this approach:

* **Increases operational complexity:** Two files per dataset to track.
* **Risks synchronization issues:** Removing or renaming one file breaks the index.
* **Reduces portability:** Harder to share or move Parquet data when the index is external.

Meanwhile, critics of Parquet’s extensibility point to the lack of a *standard* way to embed auxiliary data (see [Amudai](https://github.com/microsoft/amudai/blob/main/docs/spec/src/what_about_parquet.md)). But in practice, Parquet tolerates unknown content gracefully:

* **Arbitrary metadata:** Key/value pairs in the footer are opaque to readers.
* **Unused regions:** Bytes after data pages (before the Thrift footer) are ignored by standard readers.

We’ll exploit both to embed our index inline.

---

## Motivation

When scanning Parquet files, DataFusion (like other engines) reads row group metadata and then data pages sequentially. If you filter on a highly selective predicate (e.g., `category = 'foo'`), you may still incur I/O for files or row groups containing no matches.

Embedding a lightweight, per‑file distinct‑value index enables DataFusion to skip entire files that cannot satisfy the filter:

* **Format‑preserving:** Unknown footer keys are ignored by other readers.
* **Efficient lookup:** Checking a small in‑memory set of values is far cheaper than disk I/O.
* **Compact storage:** Store only the offset and payload, not a full duplicate of the data.

---

## High‑Level Design

Rather than diving into the specifics of our distinct‑value index format, we’ll keep this at a higher level so you can adapt the same approach to your own custom indexes:

1. **Choose or define your index payload** (e.g. bitmap, Bloom filter, sketch, distinct values list, etc.).
2. **Serialize your index bytes** and append them inline immediately after the Parquet data pages, before writing the footer.
3. **Record the index location** by adding a key/value entry (for example `"my_index_offset" -> "<byte‑offset>"`) in the Parquet footer metadata.
4. **Extend DataFusion** with a custom `TableProvider` (or wrap the existing Parquet provider) that:
   - Reads the footer metadata to discover your index offset.
   - Seeks to that offset and deserializes your index.
   - Applies file‑level pruning based on pushed‑down filters and your index’s lookup logic.
5. **Verify compatibility** with other tools (DuckDB, Spark, etc.)—they will ignore your unknown footer key and extra bytes, so your data remains fully interoperable.

For a concrete Rust example (including our distinct‑value index implementation), see the [`parquet_embedded_index.rs`](https://github.com/apache/datafusion/blob/main/datafusion-examples/examples/parquet_embedded_index.rs) demo in the DataFusion repository.

---

### Binary Layout in the Parquet File

```text
                   ┌──────────────────────┐
                   │┌───────────────────┐ │
                   ││     DataPage      │ │
                   │└───────────────────┘ │
  Standard Parquet │┌───────────────────┐ │
  Data Pages       ││     DataPage      │ │
                   │└───────────────────┘ │
                   │        ...           │
                   │┌───────────────────┐ │
                   ││     DataPage      │ │
                   │└───────────────────┘ │
                   │┏━━━━━━━━━━━━━━━━━━━┓ │
 Non‑standard      │┃                   ┃ │
 index (ignored by │┃ Custom Binary     ┃ │
 other Parquet     │┃ Index (Distinct)  ┃◀┼─ ─ ─
 readers)          │┃                   ┃ │   │  Inline after
                   │┗━━━━━━━━━━━━━━━━━━━┛ │   │  data pages
                   │┏━━━━━━━━━━━━━━━━━━━┓ │   │
 Standard Parquet  │┃    Page Index     ┃ │   │
 Page Index        │┗───────────────────┛ │   │  Footer
                   │╔═══════════════════╗ │   │  metadata
                   │║ Parquet Footer w/ ║ │◀──┼─ ─ ─ key/value
                   │║     Metadata      ║ │      map contains
                   │║ (Thrift Encoded)  ║ │      offset
                   │╚═══════════════════╝ │
                   └──────────────────────┘
```

Embedding a custom distinct‑value index inside Parquet files empowers DataFusion to skip non‑matching files with zero additional files to manage.

---

## Example Implementation Walkthrough

#### Serializing the Distinct‑Value Index

1. **Serialize distinct values** for the target column into a simple binary layout:
   * 4‑byte magic header (`IDX1`)
   * 8‑byte little‑endian length
   * newline‑separated UTF‑8 distinct values
2. **Append index bytes inline** immediately after the Parquet data pages, before writing the footer.
3. **Record index location** by adding a key/value entry (`"distinct_index_offset" -> <offset>`) in the Parquet footer metadata.

Other readers will parse the footer, see an unknown key, and ignore it. Only our DataFusion extension will use this index to prune files.

### Serializing the Index in Rust

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
2. Read the `DistinctIndex` payload at that offset.

### Extending DataFusion’s `TableProvider`

We implement a `DistinctIndexTable` that:

* During `try_new`, scans a directory of Parquet files and reads each file’s `DistinctIndex`.
* In `scan()`, inspects pushed‑down filters on the indexed column (e.g., `category = 'foo'`).
* Uses `distinct_index.contains(value)` to pick only matching files.
* Delegates actual row‑group reads to `ParquetSource` for the selected files.

### Usage Overview

```rust
// Write sample files with embedded indexes
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

---

## Verifying Compatibility with DuckDB

Even with the extra bytes and unknown footer key, standard readers ignore our index. For example:

```sql
SELECT * FROM read_parquet('/tmp/parquet_index_data/*');
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

DuckDB’s `read_parquet()` sees only the data pages and footer it understands—our embedded index is simply ignored, demonstrating seamless compatibility.

---

### 7. Summary and Next Steps

* **No sidecar files:** Index is embedded, simplifying operations.
* **File-level pruning:** Dramatically reduces I/O for highly selective queries.
* **Full format compatibility:** Works with existing Parquet tools.
* **Additional Parquet optimizations:** Parquet itself supports many more performance tweaks—such as physical sort order, row group sizing, compression codecs, and encoding choices—that you can apply alongside embedded indexes for even better results.

**Next steps:** Explore embedding more advanced structures (e.g., bitmaps or Bloom filters) for larger datasets and multi-column indexing.

> Try embedding custom indexes in your next DataFusion project to achieve faster query performance!