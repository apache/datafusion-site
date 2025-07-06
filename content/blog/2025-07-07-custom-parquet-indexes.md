---
layout: post
title: Extending Apache Parquet with User Defined Indexes to Accelerate Query Processing with DataFusion
date: 2025-07-07
author: Qi Zhu and Andrew Lamb
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

## 

It’s a common misconception that [Apache Parquet] files can only store basic Min/Max/Null Count statistics and Bloom filters, and that adding anything "smarter" requires a change to the specification or an entirely new file format. In fact, footer metadata and offset based addressing already provide everything needed to embed user defined index structures within Parquet Files without breaking compatibility with other readers. 

In this post, we review indexing available in the Apache Parquet file format, explain the mechanism for storing user defined indexes inside Parquet files, and finally show how to read and write a user defined index  [Apache DataFusion] for file‑level pruning—all while preserving complete interoperability.


[Apache DataFusion]: https://datafusion.apache.org/
[Apache Parquet]: https://parquet.apache.org/

## Introduction

Apache Parquet is a popular columnar file format with well understood and [production grade libraries for high‑performance analytics]. Features such good encodings, column pruning, and predicate pushdown work well for many common query patterns. DataFusion includes a [highly optimized Parquet implementation] and has excellent performance in general. However, given the wide variety of production query patterns, there are some cases when the statistics included in the Parquet format itself may not be sufficient<sup>[1](#footnote1)</sup>. 

[production grade libraries for high‑performance analytics]: https://arrow.apache.org/blog/2022/12/26/querying-parquet-with-millisecond-latency/
[highly optimized Parquet implementation]: https://datafusion.apache.org/blog/2025/03/20/parquet-pruning/

Many systems improve query performance using *external* indexes or other metadata in addition to Parquet. For example, see Apache Iceberg's [Scan Planning] uses metadata stored in separate files or an in memory cache. However, managing separate files or a service adds operational overhead and risks out‑of‑sync data. Both of these drawbacks have been cited by new formats (see Microsoft’s [Amudai spec](https://github.com/microsoft/amudai/blob/main/docs/spec/src/what_about_parquet.md) for example).

**However, Parquet itself is extensible with User Defined Indexes**: it tolerates unknown bytes within the file body data and permits arbitrary key/value pairs in its footer. These two  to **embed** special **arbitrary** indexes directly in the file—no extra files, no format forks, and no compatibility breakage. 

[Scan Planning]: https://iceberg.apache.org/docs/latest/performance/#scan-planning

## 1. Parquet 101: File Anatomy & Standard Index Structures

Logically, Parquet files contain row groups, each containing column chunks, which in turn contain data pages. Physically, a Parquet file is a sequence of bytes with a Thrift-encoded footer containing metadata about the file structure. The footer includes information such as the schema, row groups, column chunks and other information required to read the file. 

The Parquet format includes three main types<sup>[2](#footnote2)</sup>. of index structures, all of which are optional, and may or may not be present. 

1. **[Min/Max/Null Count Statistics]** for each chunks in a row group. 

2. **[Page Index]**: THe page index contains information about the data pages in a row group, such as their offsets, sizes and statistics. Similarly to the row grow level statistics,  is used to quickly locate data pages without scanning the entire row group.

3. **[Bloom Filters]**: A Bloom filter is a probabilistic data structure that is used to test whether an element is a member of a set. It is used to quickly determine if a value is present in a column chunk without scanning the entire column chunk.


[Page Index]: https://parquet.apache.org/docs/file-format/pageindex/
[Bloom Filters]: https://parquet.apache.org/docs/file-format/bloomfilter/
[Min/Max/Null Count Statistics]: https://github.com/apache/parquet-format/blob/819adce0ec6aa848e56c56f20b9347f4ab50857f/src/main/thrift/parquet.thrift#L263-L266

<!-- Source: https://docs.google.com/presentation/d/1aFjTLEDJyDqzFZHgcmRxecCvLKKXV2OvyEpTQFCNZPw -->

<img src="/blog/images/custom-parquet-indexes/standard_index_structures.png" width="80%" class="img-responsive" alt="Parquet File layout with standard index structures."/>

**Figure 1**: Parquet File layout with standard index structures (as written by arrow-rs)

Only the Min/Max/Null Count Statistics are stored inline in the Parquet footer metadata. The Page Index and Bloom Filters are stored in the file body before the Thrift footer. The locations of the index structures are recorded in the footer metadata, as shown in Figure 1. Readers which do not understand these structures will simply ignore them.

Modern Parquet writers create these indexes automatically when writing Parquet files, and provide APIs for their generation and placement. For example, the [Apache Arrow Rust library] provides [Parquet WriterProperties], [EnabledStatistics], and [BloomFilterPosition].

[Apache Arrow Rust library]: https://docs.rs/parquet/latest/parquet/file/index/
[Parquet WriterProperties]: https://docs.rs/parquet/latest/parquet/file/properties/struct.WriterProperties.html
[EnabledStatistics]: https://docs.rs/parquet/latest/parquet/file/properties/enum.EnabledStatistics.html
[BloomFilterPosition]: https://docs.rs/parquet/latest/parquet/file/properties/enum.BloomFilterPosition.html


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
In the rest of this post, we’ll:

1. Walk through the simple binary layout for a distinct‑value list.
2. Show how to write it inline after the normal Parquet pages.
3. Record its offset in the footer’s metadata map.
4. Extend DataFusion’s `TableProvider` to discover and use that index for file‑level pruning.
5. Verify everything still works in DuckDB via `read_parquet()`.

---

> **Prerequisite:** Requires **arrow‑rs v55.2.0** or later, which includes the new “buffered write” API ([apache/arrow-rs#7714](https://github.com/apache/arrow-rs/pull/7714)).  
> This API keeps the internal byte count in sync so you can append index bytes immediately after data pages.

---


1. Review Parquet’s built‑in metadata hooks (Min/Max, page index, Bloom filters).
2. Introduce a simple on‑page binary format for a distinct‑value index.
3. Show how to append that index inline, record its offset in the footer, and have DataFusion consume it at query time.
4. Demonstrate end‑to‑end examples (including DuckDB compatibility) using code from
   [`parquet_embedded_index.rs`](https://github.com/apache/datafusion/blob/main/datafusion-examples/examples/parquet_embedded_index.rs).

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

This post is part of a series describing techniques for building high performance analytic systems with Parquet. In addition to custom indexes in Parquet files, it is possible to

1. **Use external indexes**: See [this talk](https://www.youtube.com/watch?v=74YsJT1-Rdk) and the
   [parquet_index.rs] and [advanced_parquet_index.rs] examples in the DataFusion repository for more details.

2. **Rewrite files to optimize for specific queries**: Resorting, repartitioning and tuning datapage and row group sizes can lead to significiant performance gains. See [XiangpengHao/liquid‑cache#227](https://github.com/XiangpengHao/liquid-cache/issues/227) and the conversation between [JigaoLuo](https://github.com/JigaoLuo) and [XiangpengHao](https://github.com/XiangpengHao) for details.


[parquet_index.rs]: https://github.com/apache/datafusion/blob/main/datafusion-examples/examples/parquet_index.rs
[advanced_parquet_index.rs]: https://github.com/apache/datafusion/blob/main/datafusion-examples/examples/advanced_parquet_index.rs


### Acknowledgements

We thank [JigaoLuo](https://github.com/JigaoLuo) for feedback on early drafts of this post. 

### Footnotes

<a id="footnote1"></a>`[1]` A commonly cited example is highly selective predicates (e.g. `category = 'foo'`) but for which the built in BloomFilters are not sufficient.

<a id="footnote2"></a>`[2]` There are other index structures such, but they are either 1) not widely supported (such as statistics in the page headers) or 2) not yet widely used in practice at the time of this writing (such as [GeospatialStatistics] and [SizeStatistics]).

[GeospatialStatistics]: https://github.com/apache/parquet-format/blob/819adce0ec6aa848e56c56f20b9347f4ab50857f/src/main/thrift/parquet.thrift#L256
[SizeStatistics]: https://github.com/apache/parquet-format/blob/819adce0ec6aa848e56c56f20b9347f4ab50857f/src/main/thrift/parquet.thrift#L194-L202