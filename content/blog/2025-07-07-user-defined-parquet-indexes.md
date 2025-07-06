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

It’s a common misconception that [Apache Parquet] files can only store basic Min/Max/Null Count statistics and Bloom filters, and that adding anything "smarter" requires a change to the specification or an entirely new file format. In fact, footer metadata and offset based addressing already provide everything needed to embed user defined index structures within Parquet Files without breaking compatibility with other readers. 

In this post, we review the structure of existing Indexes in the Apache Parquet format, explain the mechanism for storing user defined indexes, and finally show how to read and write a user defined index usnig [Apache DataFusion] for file‑level pruning—all.


[Apache DataFusion]: https://datafusion.apache.org/
[Apache Parquet]: https://parquet.apache.org/

## Introduction

---

Apache Parquet is a popular columnar file format with well understood and [production grade libraries for high‑performance analytics]. Features such good encodings, column pruning, and predicate pushdown work well for many common query patterns. DataFusion includes a [highly optimized Parquet implementation] and has excellent performance in general. However, given the wide variety of production query patterns, there are some cases when the statistics included in the Parquet format itself may not be sufficient<sup>[1](#footnote1)</sup>. 

[production grade libraries for high‑performance analytics]: https://arrow.apache.org/blog/2022/12/26/querying-parquet-with-millisecond-latency/
[highly optimized Parquet implementation]: https://datafusion.apache.org/blog/2025/03/20/parquet-pruning/

Many systems improve query performance using *external* indexes or other metadata in addition to Parquet. For example, Apache Iceberg's [Scan Planning] uses metadata stored in separate files or an in memory cache, and the [parquet_index.rs] and [advanced_parquet_index.rs] examples in the DataFusion repository use external files for Parquet pruning (skipping).

These approaches are powerful and widespread, but have some drawbacks:

* **Increased Operational Complexity:** Two (or more) files per dataset to track.
* **Synchronization Risks:** The external index may become out of sync with the Parquet data if not managed carefully.
* **Reduced Portability:** Harder to share or move Parquet data when the index is external.

These risks have even been cited as justification for new file formats, such as Microsoft’s [Amudai](https://github.com/microsoft/amudai/blob/main/docs/spec/src/what_about_parquet.md).

**However, Parquet is extensible with User Defined Indexes**: Parquet tolerates unknown bytes within the file body data and permits arbitrary key/value pairs in its footer. These two  to **embed** special **arbitrary** indexes directly in the file—no extra files, no format forks, and no compatibility breakage. 

[Scan Planning]: https://iceberg.apache.org/docs/latest/performance/#scan-planning
[parquet_index.rs]: https://github.com/apache/datafusion/blob/main/datafusion-examples/examples/parquet_index.rs
[advanced_parquet_index.rs]: https://github.com/apache/datafusion/blob/main/datafusion-examples/examples/advanced_parquet_index.rs

## Parquet File Anatomy & Standard Index Structures

---

Logically, Parquet files contain row groups, each containing column chunks, which in turn contain data pages. Physically, a Parquet file is a sequence of bytes with a Thrift-encoded footer containing metadata about the file structure. The footer includes information such as the schema, row groups, column chunks and other information required to read the file. 

The Parquet format includes three main types<sup>[2](#footnote2)</sup>. of index structures, all of which are optional, and may or may not be present. 

1. **[Min/Max/Null Count Statistics]** for each chunks in a row group. 

2. **[Page Index]**: THe page index contains information about the data pages in a row group, such as their offsets, sizes and statistics. Similarly to the row grow level statistics,  is used to quickly locate data pages without scanning the entire row group.

3. **[Bloom Filters]**: A Bloom filter is a probabilistic data structure that is used to test whether an element is a member of a set. It is used to quickly determine if a value is present in a column chunk without scanning the entire column chunk.

[Page Index]: https://parquet.apache.org/docs/file-format/pageindex/
[Bloom Filters]: https://parquet.apache.org/docs/file-format/bloomfilter/
[Min/Max/Null Count Statistics]: https://github.com/apache/parquet-format/blob/819adce0ec6aa848e56c56f20b9347f4ab50857f/src/main/thrift/parquet.thrift#L263-L266

<!-- Source: https://docs.google.com/presentation/d/1aFjTLEDJyDqzFZHgcmRxecCvLKKXV2OvyEpTQFCNZPw -->

<img src="/blog/images/user-defined-parquet-indexes/standard_index_structures.png" width="80%" class="img-responsive" alt="Parquet File layout with standard index structures."/>

**Figure 1**: Parquet File layout with standard index structures (as written by arrow-rs)

Only the Min/Max/Null Count Statistics are stored inline in the Parquet footer metadata. The Page Index and Bloom Filters are stored in the file body before the Thrift footer. The locations of the index structures are recorded in the footer metadata, as shown in Figure 1. Readers which do not understand these structures will simply ignore them.

Modern Parquet writers create these indexes automatically when writing Parquet files, and provide APIs for their generation and placement. For example, the [Apache Arrow Rust library] provides [Parquet WriterProperties], [EnabledStatistics], and [BloomFilterPosition].

[Apache Arrow Rust library]: https://docs.rs/parquet/latest/parquet/file/index/
[Parquet WriterProperties]: https://docs.rs/parquet/latest/parquet/file/properties/struct.WriterProperties.html
[EnabledStatistics]: https://docs.rs/parquet/latest/parquet/file/properties/enum.EnabledStatistics.html
[BloomFilterPosition]: https://docs.rs/parquet/latest/parquet/file/properties/enum.BloomFilterPosition.html


## Embedding User Defined Indexes into Parquet Files

---

Embedding user defined indexes in Parquet files is straightforward, and follows the same principles as the standard index structures:

1. The index is serialized into a binary format and written into the file body prior to the Thrift footer.

2. The location of the index is recorded in the footer metadata as a key/value pair, such as `"my_index_offset" -> "<byte-offset>"`.

The resulting file layout is shown in Figure 2. 

<!-- Source: https://docs.google.com/presentation/d/1aFjTLEDJyDqzFZHgcmRxecCvLKKXV2OvyEpTQFCNZPw -->

<img src="/blog/images/user-defined-parquet-indexes/custom_index_structures.png" width="80%" class="img-responsive" alt="Parquet File layout with custom index structures."/>

**Figure 2**: Parquet File layout with user defined indexes. 

Similarly to standard index structures, user defined indexes can be stored anywhere in the file body, such as after row group data, or before the footer. There are no limitations on the number or type of index that can be embedded. Embedding user defined indexes makes the resulting Parquet files larger, and only readers that know how to use the index can take advantage of this increased size. 

You can use this technique to embed indexes for any granularity of Parquet data, such as to the entire file, specific row group(s), specific column chunk(s), specific data page(s) or specific row(s). Since the indexes are arbitrary bytes, it is possible to supercharge Parquet with techniques inspired by proprietary file formats such as

1. [HyperLogLog] sketches for distinct value counts

2. Additional [Small materialized aggregates] such as precomputed `sum`s at the column chunk or data page level

3. Histograms or samples at the row group or column chunk level for predicate selectivity estimates.

[HyperLogLog]: https://en.wikipedia.org/wiki/HyperLogLog
[Small materialized aggregates]: https://www.vldb.org/conf/1998/p476.pdf

## Example: Embedding a User Defined Distinct Value Index in Parquet Files

---

This section shows how to actually use the ideas above to embed a simple distinct value index in Parquet files and use that index to do file‑level pruning (skipping) in DataFusion.
The entire example is implemented in Rust and available in the DataFusion repository at
[parquet_embedded_index.rs].

[parquet_embedded_index.rs]: https://github.com/apache/datafusion/blob/main/datafusion-examples/examples/parquet_embedded_index.rs

The example requires **arrow‑rs v55.2.0** or later, which includes the new “buffered write” API ([apache/arrow-rs#7714]) which keeps the internal byte count in sync so you can append index bytes immediately after data pages.

[apache/arrow-rs#7714]: https://github.com/apache/arrow-rs/pull/7714  

This example is simple to make it easier to understand, but you can adapt the same approach for any arbitrary index type or data types. The high‑level design is:

1. **Choose or define your index payload** (e.g. bitmap, Bloom filter, sketch, distinct values list, etc.).
2. **Serialize your index to bytes** and append them into the Parquet file body, before writing the footer. 
3. **Record the index location** by adding a key/value entry (for example `"my_index_offset" -> "<byte‑offset>"`) in the Parquet footer metadata.
4. **Extend DataFusion** with a custom `TableProvider` (or wrap the existing Parquet provider) that:
   - Reads the footer metadata to discover your index offset.
   - Seeks to that offset and deserializes your index.
   - Uses the index to speed up processing (for example, skip files, row groups, data pages, etc). 

Note that the resulting parquet files are fully compatible with other tools such as DuckDB, Spark, etc. which will simply ignore the unknown index bytes and key/value metadata.


### Introduction to Distinct Value Indexes

---

A **distinct value index** stores distinct values of a specific column. This type of index is effective for columns that have a relatively small number of distinct values, can be used to quickly skip files which do not match the query. These indexes are popular in several engines, such as the ["set" Skip Index in ClickHouse] and the [Distinct Value Cache] in InfluxDB 3.0.

["set" Skip Index in ClickHouse]: https://clickhouse.com/docs/optimize/skipping-indexes#set
[Distinct Value Cache]: https://docs.influxdata.com/influxdb3/enterprise/admin/distinct-value-cache/

For example, if the files contain a column named `Category` like this

<table style="border-collapse:collapse;">
  <tr>
    <td style="border:1px solid #888;padding:2px 6px;"><b><code>Category</code></b></td>
  </tr>
  <tr>
    <td style="border:1px solid #888;padding:2px 6px;"><code>foo</code></td>
  </tr>
  <tr>
    <td style="border:1px solid #888;padding:2px 6px;"><code>bar</code></td>
  </tr>
  <tr>
    <td style="border:1px solid #888;padding:2px 6px;"><code>...</code></td>
  </tr>
  <tr>
    <td style="border:1px solid #888;padding:2px 6px;"><code>baz</code></td>
  </tr>
  <tr>
    <td style="border:1px solid #888;padding:2px 6px;"><code>foo</code></td>
  </tr>
</table>

Then the distinct value index will contain the values `foo` and `bar` and `baz`.
Using a traditional min/max statistics would store the minimum (`bar`) and maximum (`foo`)
values, which would not allow quickly
skipping this file for a query like `SELECT * FROM t WHERE Category = 'baq'` as 
`baq` is between `bar` and `foo`. 

We represent this in Rust as a simple `HashSet<String>`:

```rust
/// An index of distinct values for a single column
#[derive(Debug, Clone)]
struct DistinctIndex {
   inner: HashSet<String>,
}
```

### File Layout with Distinct Value Index

---

In this example, we will write a distinct value index for the `Category` column into the Parquet file body after all the data pages, and record the index location in the footer metadata. The resulting file layout will look like this:

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
Non standard      │┃                   ┃ │                           
index (ignored by │┃Custom Binary Index┃ │                           
other Parquet     │┃ (Distinct Values) ┃◀│─ ─ ─                      
readers)          │┃                   ┃ │     │                     
                  │┗━━━━━━━━━━━━━━━━━━━┛ │                           
Standard Parquet  │┏━━━━━━━━━━━━━━━━━━━┓ │     │  key/value metadata
Page Index        │┃    Page Index     ┃ │        contains location  
                  │┗━━━━━━━━━━━━━━━━━━━┛ │     │  of special index   
                  │╔═══════════════════╗ │                           
                  │║ Parquet Footer w/ ║ │     │                     
                  │║     Metadata      ║ ┼ ─ ─                       
                  │║ (Thrift Encoded)  ║ │                           
                  │╚═══════════════════╝ │                           
                  └──────────────────────┘                           
                                             
```

### Serializing the Distinct‑Value Index

---

The example uses a simple newline‑separated UTF‑8 format as the binary format. The code to serialize the distinct index is shown below:

```rust
/// Magic bytes to identify our custom index format
const INDEX_MAGIC: &[u8] = b"IDX1";

/// Serialize the distinct index to a writer as bytes
fn serialize<W: Write + Send>(
   &self,
   arrow_writer: &mut ArrowWriter<W>,
) -> Result<()> {
   let serialized = self
           .inner
           .iter()
           .map(|s| s.as_str())
           .collect::<Vec<_>>()
           .join("\n");
   let index_bytes = serialized.into_bytes();

   // Set the offset for the index
   let offset = arrow_writer.bytes_written();
   let index_len = index_bytes.len() as u64;

   // Write the index magic and length to the file
   arrow_writer.write_all(INDEX_MAGIC)?;
   arrow_writer.write_all(&index_len.to_le_bytes())?;

   // Write the index bytes
   arrow_writer.write_all(&index_bytes)?;

   // Append metadata about the index to the Parquet file footer
   arrow_writer.append_key_value_metadata(KeyValue::new(
      "distinct_index_offset".to_string(),
      offset.to_string(),
   ));
   Ok(())
}
```

This code does the following:
1. Creates a newline‑separated UTF‑8 string from the distinct values.
2. Writes a magic header (`IDX1`) and the length of the index.
3. Writes the index bytes to the file using the [`ArrowWriter`] API.
3. Records index location by adding a key/value entry (`"distinct_index_offset" -> <offset>`) in the Parquet footer metadata.

Note that it is important to use the [`ArrowWriter::write_all`] API to ensure that the offsets in the footer are correctly tracked. 

[ArrowWriter]: https://docs.rs/parquet/latest/parquet/arrow/arrow_writer/struct.ArrowWriter.html
[ArrowWriter::write_all]: https://docs.rs/parquet/latest/parquet/arrow/arrow_writer/struct.ArrowWriter.html#method.write_all


### Reading the Index

---

To read the distinct index from a Parquet file, 

```rust
/// Read a `DistinctIndex` from a Parquet file
fn read_distinct_index(path: &Path) -> Result<DistinctIndex> {
    let file = File::open(path)?;

    let file_size = file.metadata()?.len();
    println!("Reading index from {} (size: {file_size})", path.display(), );

    let reader = SerializedFileReader::new(file.try_clone()?)?;
    let meta = reader.metadata().file_metadata();

    let offset = get_key_value(meta, "distinct_index_offset")
        .ok_or_else(|| ParquetError::General("Missing index offset".into()))?
        .parse::<u64>()
        .map_err(|e| ParquetError::General(e.to_string()))?;

    println!("Reading index at offset: {offset}, length");
    DistinctIndex::new_from_reader(file, offset)
}
```

This function:
1. Opens the Parquet footer and extract `distinct_index_offset` from the metadata.
2. Calls `DistinctIndex::new_from_reader` to read the index from the file at that offset.

The code to actually read the index is shown below, and corresponds to the `serialize` function above.

```rust
 /// Read the distinct values index from a reader at the given offset and length
 pub fn new_from_reader<R: Read + Seek>(mut reader: R, offset: u64) -> Result<DistinctIndex> {
     reader.seek(SeekFrom::Start(offset))?;

     let mut magic_buf = [0u8; 4];
     reader.read_exact(&mut magic_buf)?;
     if magic_buf != INDEX_MAGIC {
         return exec_err!("Invalid index magic number at offset {offset}");
     }

     let mut len_buf = [0u8; 8];
     reader.read_exact(&mut len_buf)?;
     let stored_len = u64::from_le_bytes(len_buf) as usize;

     let mut index_buf = vec![0u8; stored_len];
     reader.read_exact(&mut index_buf)?;

     let Ok(s) = String::from_utf8(index_buf) else {
         return exec_err!("Invalid UTF-8 in index data");
     };

     Ok(Self {
         inner: s.lines().map(|s| s.to_string()).collect(),
     })
 }
```

This code:
1. Seeks to the offset of the index in the file.
2. Reads the magic bytes and checks they match `IDX1`.
3. Reads the length of the index and allocates a buffer.
4. Reads the index bytes into the buffer, converts it to a `String`, and splits it into lines to populate the `HashSet<String>`.

### Extending DataFusion’s `TableProvider`

---

In order to use the distinct index for file‑level pruning, we need to extend DataFusion's `TableProvider` to read the index and apply it during query execution as shown below:

```rust
impl TableProvider for DistinctIndexTable {
    /* ... */

    /// Prune files before reading: only keep files whose distinct set
    /// contains the filter value
    async fn scan(
        &self,
        _ctx: &dyn Session,
        _proj: Option<&Vec<usize>>,
        filters: &[Expr],
        _limit: Option<usize>,
    ) -> Result<Arc<dyn ExecutionPlan>> {
        // This example only handles filters of the form
        // `category = 'X'` where X is a string literal
        //
        // You can use `PruningPredicate` for much more general range and
        // equality analysis or write your own custom logic.
        let mut target: Option<&str> = None;

        if filters.len() == 1 {
            if let Expr::BinaryExpr(expr) = &filters[0] {
                if expr.op == Operator::Eq {
                    if let (
                        Expr::Column(c),
                        Expr::Literal(ScalarValue::Utf8(Some(v)), _),
                    ) = (&*expr.left, &*expr.right)
                    {
                        if c.name == "category" {
                            println!("Filtering for category: {v}");
                            target = Some(v);
                        }
                    }
                }
            }
        }
        // Determine which files to scan
        let files_to_scan: Vec<_> = self
            .files_and_index
            .iter()
            .filter_map(|(f, distinct_index)| {
                // keep file if no target or target is in the distinct set
                if target.is_none() || distinct_index.contains(target?) {
                    Some(f)
                } else {
                    None
                }
            })
            .collect();
       
        // Build ParquetSource to actually read the files
        let url = ObjectStoreUrl::parse("file://")?;
        let source = Arc::new(ParquetSource::default().with_enable_page_index(true));
        let mut builder = FileScanConfigBuilder::new(url, self.schema.clone(), source);
        for file in files_to_scan {
            let path = self.dir.join(file);
            let len = std::fs::metadata(&path)?.len();
           // If the index contained information about row groups or pages,
           // you could also pass that information here to further prune
           // the data read from the file.
           let partitioned_file =
                   PartitionedFile::new(path.to_str().unwrap().to_string(), len);
           builder = builder.with_file(partitioned_file);
        }
        Ok(DataSourceExec::from_data_source(builder.build()))
    }

    /// Tell DataFusion that we can handle filters on the "category" column
    fn supports_filters_pushdown(
        &self,
        fs: &[&Expr],
    ) -> Result<Vec<TableProviderFilterPushDown>> {
        // Mark as inexact since pruning is file‑granular
        Ok(vec![TableProviderFilterPushDown::Inexact; fs.len()])
    }
}

```

This code does the following:
1. Implements the `scan` method to filter files based on the distinct index.
2. Checks if the filter is an equality predicate on the `category` column.
3. If the target value is specified, it checks if the distinct index contains that value.
4. Builds a `FileScanConfig` with only the files that match the filter.

### Putting It All Together

To use the distinct index in a DataFusion query, we need to write some sample Parquet files with the embedded index, register the `DistinctIndexTable` provider, and then run a query that uses the index for file‑level pruning:

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


### Verifying Compatibility with DuckDB

---

Even with the extra bytes and unknown footer key, standard readers ignore our index. For example, we can use DuckDB to read the Parquet files we created with the embedded index:

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