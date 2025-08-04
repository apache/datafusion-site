---
layout: post
title: Using External Indexes / Metadata Stores / Catalogs to Accelerate Queries on Apache Parquet
date: 2025-08-15
author: and Andrew Lamb (InfluxData)
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


It is a common misconception that [Apache Parquet] is limited to indexing
structures built into the format. However, you can use Parquet's heirarchal data
organization to easily build custom external indexes to significantly speed up query
processing.

In this blog, we describe why you might need external indexes, what they are,
how analytic systems use them to accelerate query processing, and provide a
working example using [Apache DataFusion].

*Note there is a [companion video] and [presentation].*

# Motivation

System designers choose between a pre-configured data system or the very
challenging task of building their own custom data platform from scratch.

For many users and use cases, one of the existing traditional data systems will
likely be good enough. However, systems such as [Apache Spark], [DuckDB],
[ClickHouse], [Hive], [Snowflake] are each optimized for a certain set of
tradeoffs between performance, cost, availability, interoperability, deployment
target, cloud / on prem, operational ease and many other factors.

For new, or especially demanding use cases, where no existing system has your
optimal tradeoffs, you can build your own custom data platform. Previously this
was a long and expensive endeavor, but today, in the era of [Composable Data
Systems] it is increasingly feasible. High quality, open source building blocks
such as [Apache Parquet] for storage, [Apache Arrow] for in-memory processing,
and [Apache DataFusion] for query execution make it possible to quickly build
custom data platforms optimized for your specific
needs<sup>[1](#footnote1)</sup>.


[companion video]: https://www.youtube.com/watch?v=74YsJT1-Rdk
[presentation]: https://docs.google.com/presentation/d/1e_Z_F8nt2rcvlNvhU11khF5lzJJVqNtqtyJ-G3mp4-Q/edit

[Apache Parquet]: https://parquet.apache.org/
[Apache DataFusion]: https://datafusion.apache.org/
[Apache Arrow]: https://arrow.apache.org/
[FDAP Stack]: https://www.influxdata.com/blog/flight-datafusion-arrow-parquet-fdap-architecture-influxdb/
[Composable Data Systems]: https://www.vldb.org/pvldb/vol16/p2679-pedreira.pdf


# Introduction to External Indexes / Catalogs / Metadata Stores

<div class="text-center">
<img
src="/blog/images/external-parquet-indexes/external-index-overview.png"
width="80%"
class="img-responsive"
alt="Using External Indexes to Accelerate Queries"
/>
</div>

**Figure 1**: Using external indexes to speed up queries in an analytic system.
Given a user's query (Step 1), the system uses an external index (that is not
stored as part of the data files) to quickly find the files that may contain
relevant data (Step 2). Then, for each file, the system uses the external index
to further narrow the required data by locating only those parts of each file
(data pages) that are relevant (Step 3). Finally, the system reads only those
parts of the file and returns the results to the user (Step 4).

All Data Systems have some way of storing information (metadata) to find data
relevant to a query, often stored in structures with names like "index" or
"catalog." In this blog, we use the term **"index"** to mean any structure that
helps locate relevant data during processing.

There are many different types of indexes, content stored in indexes, strategies
to keep indexes up to date, and ways to apply indexes during query processing.
This wide variety means that there is no one-size-fits-all solution for
metadata, and instead, there are many different approaches, each with their own
tradeoffs. For example, in Hive uses the [Hive Metastore], a more classic
analytic database like Vertica uses a [Catalog] and recently open data lake
systems store such information using a table format like [Apache Iceberg] or
[Delta Lake].

**External indexes** store information separately ("external") to the data files
themselves. External indexes are flexible and widely used in data systems, but
require additional operational overhead to keep in sync with the Data files
files. For example, if you add a new Parquet file to your data lake you must
also update the external index to include information about the new file. Note,
it is possible to avoid external indexes embed user-defined indexes directly in
Parquet files, which is describe our previous blog [Embedding User-Defined
Indexes in Apache Parquet Files].

Examples of information stored in external indexes include:

* Min/Max statistics
* Bloom filters
* Inverted indexes
* Full text indexes 
* Other use case specific indexes
* Information needed to read the remote file (such as the location of data pages within a Parquet file, typically stored in the footer)

Examples of index storage include:

* In a separate file (e.g. a JSON or Parquet file that contains the index)
* In a database (e.g. a [PostgreSQL] table that contains the index)
* In a distributed key-value store (e.g. [Redis] or [Cassandra])
* In an in-memory cache

[Hive Metastore]: https://cwiki.apache.org/confluence/display/Hive/Design#Design-Metastore
[Catalog]: https://www.vertica.com/docs/latest/HTML/Content/Authoring/AdministratorsGuide/Managing/Metadata/CatalogOverview.htm
[Apache Iceberg]: https://iceberg.apache.org/
[Delta Lake]: https://delta.io/
[Embedding User-Defined Indexes in Apache Parquet Files]: https://datafusion.apache.org/blog/2025/07/14/user-defined-parquet-indexes/
[PostgreSQL]: https://www.postgresql.org/
[Redis]: https://redis.io/
[Cassandra]: https://cassandra.apache.org/

# Using Apache Parquet for Storage

Apache Parquet's combination of good compression, high-performance, high quality
open source libraries, and wide ecosystem interoperability make it a compelling
choice when building new systems. While there are some niche use case that may
benefit from specialized formats, for many usecases Parquet is the obvious
choice and the rest of this blog shows how to build external indexes with
Parquet based systems.

While recent proprietary file formats differ in details, they all use the same
high level structure<sup>[2](#footnote2)</sup>: metadata, typically at the end
of the file, and data divided into columns and then into horizontal slices (e.g.
Parquet Row Groups and/or Data Pages). The structure is widespread because it
enables a hierarchical approach to pruning (finding what you want quickly) as
described in the next section.

For example, the [Clickhouse MergeTree] format consists of *Parts* (similar to
Parquet files), and *Granules* (similar to Row Groups), and the [Clickhouse
indexing strategy] is designed to quickly locate the parts and granules that may
contain relevant data for the query. This is directly analogous to finding files
and then Row Groups / Data Pages within those files for Parquet based systems.

[Clickhouse MergeTree]: https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree
[Clickhouse indexing strategy]: https://clickhouse.com/docs/guides/best-practices/sparse-primary-indexes#clickhouse-index-design

A common criticism of Parquet is that it is not as performant as some new
proposal. These criticisms typically cherry pick a few queries and/or datasets
and then build a specialized index or data layout for that specific cases.
However, as described in the [companion video] of this blog, even for
[ClickBench], the current benchmaxxing<sup>[3](#footnote3)</sup> darling of
analytics vendors that has a wide variety of query patterns, there is less than
a factor of two difference in performance between custom file formats and
Parquet. The difference becomes even lower when the benchmark is run with
Parquet files that contain more modern Parquet files such as including Column
and Offset Indexes or Bloom Filters (see XXXX). Compared to the low
interoperability and expensive transcoding/loading step of alternate file
formats, Parquet is often hard to beat. 


[DuckDB]: https://duckdb.org/
[Vortex]: https://docs.vortex.dev/
[ClickBench]: https://clickbench.com/
[companion video]: https://www.youtube.com/watch?v=74YsJT1-Rdk


# Apache Parquet Overview

This section provides a brief background on the organization of Apache Parquet
files which is needed to full understand how external indexes accelerate query
processing. If you are already familiar with Parquet, you can skip this section.


Parquet organizes data into row groups and column chunks, as shown below. 

<div class="text-center">
<img
src="/blog/images/external-parquet-indexes/parquet-layout.png"
width="80%"
class="img-responsive"
alt="Parquet File layout: Row Groups and Column Chunks."
/>
</div>

**Figure 2**: Parquet File Layout

<div class="text-center">
<img
src="/blog/images/external-parquet-indexes/parquet-metadata.png"
width="80%"
class="img-responsive"
alt="Parquet File layout: Metadata and footer."
/>
</div>
**Figure**: Parquet Metadata in the Footer

<div class="text-center">
<img
  src="/blog/images/external-parquet-indexes/parquet-filter-pushdown.png"
  width="80%"
  class="img-responsive"
  alt="Parquet Filter Pushdown: use filter predicate to skip pages."
/>
</div>
**Figure**: Filter Pushdown in Parquet: use the predicate "C > 25" from the query
along with various statistics from the indexes / metadata to skip pages that
cannot match the predicate.

Please refer to XXX for more details

# Query Acceleration: Skip as Much as Possible

Query processing systems in general are optimized first by quickly figuring how to skip
as much data as quickly as possible. Analytic systems typically do this via a
hierarchical approach,nwhich progressively narrows the set of data needed –
first entire files are ruled out, and then within each file , large sections
(e.g. row groups) are ruled out, followed by ruling out data pages and finally
to individual rows, as shown in the figure below:

<img 
  src="/blog/images/external-parquet-indexes/processing-pipeline.png" 
  width="80%" 
  class="img-responsive" 
  alt="Standard Pruning Layers."
/>

**Figure**: Layered Filtering.

Again, while there are differences in metadata placement and encoding between
systems, the overall processing pipeline is similar.

# Pruning Files with External Indexes

The first step in the pruning process is to quickly rule out files that cannot
match the query. This is typically done using external indexes or metadata stores
that store summary information about each file. For example, if a query has a
predicate on the `time` column, the index might store the minimum and maximum `time` 
values in each file, allowing the system to quickly rule out files that
cannot possibly match the predicate.

<div class="text-center">
<img
src="/blog/images/external-parquet-indexes/prune-files.png"
width="80%"
class="img-responsive"
alt="Data Skipping: Pruning Files."
/>
</div>  
**Figure**: Step 1: File Pruning. Given a query predicate, systems use external
indexes / metadata stores to quickly rule out files that cannot match the query.
In this case, by consulting the index all but two files can be ruled out.

There are many different existing example of this type of "index" such as the
[Hive Metadata Store](https://cwiki.apache.org/confluence/display/Hive/Design#Design-Metastore),

[Iceberg](https://iceberg.apache.org/), [Delta Lake](https://delta.io/),
[DuckLake](https://duckdb.org/2025/05/27/ducklake.html)
[Hive style partitioning](https://sparkbyexamples.com/apache-hive/hive-partitions-explained-with-examples/) (which is a simple form of indexing).

Each of these systems works well for their intended usecases, and has different tradeoffs in terms of
the size of the index, the types of queries that can be accelerated, the operational
overhead (e.g. external services) and the complexity of maintaining the index.

If none of the existing systems meets your needs, or want to experiment, you can
build your own with DataFusion. This is part of the full working and well
commented [parquet_index.rs] example in the DataFusion repository.

[parquet_index.rs]: https://github.com/apache/datafusion/blob/main/datafusion-examples/examples/parquet_index.rs

The basic idea is to implement a custom `TableProvider` that
implements the `supports_filter_pushdown` and `scan` methods. In the
`supports_filter_pushdown` method, you can analyze the filter predicates and
determine which files need to be scanned. In the `scan` method, you can return
a `ParquetExec` that only scans the files that need to be scanned.

For example, when you run a query that includes the predicate `value = 150`, the
IndexTableProvider will use the index to determine that only two files are needed. 

```sql
SELECT file_name, value FROM index_table WHERE value = 150
```

The code to implement this looks like the following (slightly simplified for
clarity):

```rust
impl TableProvider for IndexTableProvider {
    async fn scan(
        &self,
        state: &dyn Session,
        projection: Option<&Vec<usize>>,
        filters: &[Expr],
        limit: Option<usize>,
    ) -> Result<Arc<dyn ExecutionPlan>> {
        let df_schema = DFSchema::try_from(self.schema())?;
        // Combine all the filters into a single ANDed predicate
        let predicate = conjunction(filters.to_vec());

        // Use the index to find the files that might have data that matches the
        // predicate. Any file that can not have data that matches the predicate
        // will not be returned.
        let files = self.index.get_files(predicate.clone())?;

        let object_store_url = ObjectStoreUrl::parse("file://")?;
        let source = Arc::new(ParquetSource::default().with_predicate(predicate));
        let mut file_scan_config_builder =
            FileScanConfigBuilder::new(object_store_url, self.schema(), source)
                .with_projection(projection.cloned())
                .with_limit(limit);

        // Add the files to the scan config
        for (file) in files {
            file_scan_config_builder = file_scan_config_builder.with_file(
                PartitionedFile::new(file.path(), file_size.size()),
            );
        }
        Ok(DataSourceExec::from_data_source(
            file_scan_config_builder.build(),
        ))
    }
    ...
}
```

While the example in DataFusion uses a simple min/max index, you can implement any 
indexing strategy that meets your needs. For example, you might want to
implement a bloom filter index, or a full text index, or a more complex
multi-dimensional index. 

DataFusion handles the details of pushing down the filters to the
`TableProvider` and the mechanics of reading the parquet files, so you you can
focus on the system specific details such as building, storing and applying the
index. 

DataFusion also includes code to help you with common filtering tasks, such as:

* Range Based Pruning ([PruningPredicate]) for cases where your index stores min/max values for  some/all columns.

* Expression simplification ([ExprSimplifier] for simplifying predicates before applying them to the index.

* Range analysis for predicates [cp_solver] for interval based range analysis (e.g. `col > 5 AND col < 10`)

[PruningPredicate]: https://docs.rs/datafusion/latest/datafusion/physical_optimizer/pruning/struct.PruningPredicate.html
[ExprSimplifier]: https://docs.rs/datafusion/latest/datafusion/optimizer/simplify_expressions/struct.ExprSimplifier.html#method.simplify
[cp_solver]: https://docs.rs/datafusion/latest/datafusion/physical_expr/intervals/cp_solver/index.html

# Pruning Parts of Parquet Files using Indexes

Once the set of files to be scanned has been determined, the next step is to
prune parts of each Parquet file that cannot match the query. While the Parquet format
itself contains some built-in metadata that can be used for this purpose (e.g.
min/max statistics (TODO link) , and bloom filters (TODO LINK))), you are not limited to just the built-in
metadata, and you can also use external indexes for filtering *WITIHIN* Parquet files.

<img
src="/blog/images/external-parquet-indexes/prune-row-groups.png"
width="80%"
class="img-responsive"
alt="Data Skipping: Pruning Row Groups and DataPages"
/>

**Figure**: Step 2: Pruning Parquet Row Groups and Data Pages. Given a query predicate,
systems can use external indexes / metadata stores along with Parquet's built-in
structures to quickly rule out row groups and data pages that cannot match the query.
In this case, the index has ruled out all but three data pages.

At a high level you can provide an optional [ParquetAccessPlan] for each file
that tells DataFusion what parts of the file to read. This plan is then further
processed by the DataFusion parquet reader based on the with the built-in
Parquet metadata to potentially prune additional row groups and data pages
during query execution. You can find a full working example of using information
from an external index to prune parts of a Parquet file in the
[advanced_parquet_index.rs] example.

```rust
// Default to scan all row groups
let mut access_plan = ParquetAccessPlan::new_all(4);
access_plan.skip(0); // skip row group
// Use parquet reader RowSelector to specify scanning rows 100-200 and 350-400
// in a row group that has 1000 rows
let row_selection = RowSelection::from(vec![
   RowSelector::skip(100),
   RowSelector::select(100),
   RowSelector::skip(150),
   RowSelector::select(50),
   RowSelector::skip(600),  // skip last 600 rows
]);
access_plan.scan_selection(1, row_selection);
access_plan.skip(2); // skip row group 2
// row group 3 is scanned by default
```

The resulting plan looks like this:

```text
┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐

│                   │  SKIP

└ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
Row Group 0
┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
┌────────────────┐    SCAN ONLY ROWS
│└────────────────┘ │  100-200
┌────────────────┐    350-400
│└────────────────┘ │
─ ─ ─ ─ ─ ─ ─ ─ ─ ─
Row Group 1
┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
SKIP
│                   │

└ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
Row Group 2
┌───────────────────┐
│                   │  SCAN ALL ROWS
│                   │
│                   │
└───────────────────┘
Row Group 3
```

You connect this to your `TableProvider` in a similar way as described in the previous section
for pruning files. In the `scan` method, you can return a `ParquetExec` that includes the
`ParquetAccessPlan` for each file as show in the simplified except below:

```rust
impl TableProvider for IndexTableProvider {
    async fn scan(
        &self,
        state: &dyn Session,
        projection: Option<&Vec<usize>>,
        filters: &[Expr],
        limit: Option<usize>,
    ) -> Result<Arc<dyn ExecutionPlan>> {
        let indexed_file = &self.indexed_file;
        let predicate = self.filters_to_predicate(state, filters)?;

        // Use the external index to create a starting ParquetAccessPlan
        // that determines which row groups to scan based on the predicate
        let access_plan = self.create_plan(&predicate)?;

        let partitioned_file = indexed_file
            .partitioned_file()
            // provide the access plan to the DataSourceExec by
            // storing it as  "extensions" on PartitionedFile
            .with_extensions(Arc::new(access_plan) as _);

        let file_source = Arc::new(
            ParquetSource::default()
                // provide the predicate to the standard DataFusion source as well so
                // DataFusion's parquet reader will apply row group pruning based on
                // the built-in parquet metadata (min/max, bloom filters, etc) as well
                .with_predicate(predicate)
        );
        let file_scan_config =
            FileScanConfigBuilder::new(object_store_url, schema, file_source)
                .with_limit(limit)
                .with_projection(projection.cloned())
                .with_file(partitioned_file)
                .build();

        // Finally, put it all together into a DataSourceExec
        Ok(DataSourceExec::from_data_source(file_scan_config))
    }
    ...
}

```


[advanced_parquet_index.rs]:  https://github.com/apache/datafusion/blob/main/datafusion-examples/examples/advanced_parquet_index.rs
[ParquetAccessPlan]: https://docs.rs/datafusion/latest/datafusion/datasource/physical_plan/parquet/struct.ParquetAccessPlan.html


# Caching Parquet Metadata

It is often said that Parquet is not suitable for low latency queries because
the footer must be read and parsed for each query. While I am convinced that
existing parquet libraries can be made significantly faster with additional
engineering effort (see Xiangpeng Hao's (TODO LINK)) [previous blog on the topic]),
in practice most analytic systems are stateful and have
some sort of caching layer. In these systems, it is common to cache
the parsed footer in memory or stored in the external index or metadata store so 
there is no need to re-read and re-parse the footer for each query.

[previous blog on the topic]: https://www.influxdata.com/blog/how-good-parquet-wide-tables/

This technique is also shown in the [advanced_parquet_index.rs] example. The high level flow
involves reading and caching the metadata for each file when the index is built and then 
using the cached metadata when reading the files during query execution.

[advanced_parquet_index.rs]:  https://github.com/apache/datafusion/blob/main/datafusion-examples/examples/advanced_parquet_index.rs

You can do this first by implementing a custom [ParquetFileReaderFactory] like this (again slightly simplified for clarity):

[ParquetFileReaderFactory]: https://docs.rs/datafusion/latest/datafusion/datasource/physical_plan/trait.ParquetFileReaderFactory.html

```rust
impl ParquetFileReaderFactory for CachedParquetFileReaderFactory {
    fn create_reader(
        &self,
        _partition_index: usize,
        file_meta: FileMeta,
        metadata_size_hint: Option<usize>,
        _metrics: &ExecutionPlanMetricsSet,
    ) -> Result<Box<dyn AsyncFileReader + Send>> {
        let filename = file_meta.location();
        
        // Pass along the information to access the underlying storage
        // (e.g. S3, GCS, local filesystem, etc)
        let object_store = Arc::clone(&self.object_store);
        let mut inner =
            ParquetObjectReader::new(object_store, file_meta.object_meta.location)
                .with_file_size(file_meta.object_meta.size);
      
        // retrieve the pre-parsed metadata from the cache
        // (which was built when the index was built and is kept in memory)
        let metadata = self
            .metadata
            .get(&filename)
            .expect("metadata for file not found: {filename}");
      
        // Return a ParquetReader that uses the cached metadata
        Ok(Box::new(ParquetReaderWithCache {
            filename,
            metadata: Arc::clone(metadata),
            inner,
        }))
    }
}
```

Then, in your TableProvider use the factory to avoid re-reading the metadata
for each file:

```rust
impl TableProvider for IndexTableProvider {
    async fn scan(
        &self,
        state: &dyn Session,
        projection: Option<&Vec<usize>>,
        filters: &[Expr],
        limit: Option<usize>,
    ) -> Result<Arc<dyn ExecutionPlan>> {
      
        // Configure a factory interface to avoid re-reading the metadata for each file
        let reader_factory =
            CachedParquetFileReaderFactory::new(Arc::clone(&self.object_store))
                .with_file(indexed_file);

        // build the partitioned file (see example for details)
        let partitioned_file = ...; 
      
        // Create the ParquetSource with the predicate and the factory
        let file_source = Arc::new(
            ParquetSource::default()
                // provide the factory to create parquet reader without re-reading metadata
                .with_parquet_file_reader_factory(Arc::new(reader_factory)),
        );
      
        // Pass along the information needed to read the files
        let file_scan_config =
            FileScanConfigBuilder::new(object_store_url, schema, file_source)
                .with_limit(limit)
                .with_projection(projection.cloned())
                .with_file(partitioned_file)
                .build();

        // Finally, put it all together into a DataSourceExec
        Ok(DataSourceExec::from_data_source(file_scan_config))
    }
    ...
}
```


# Conclusion

Parquet has the right structure for high performance analytics
You can indexing more than the built in Metadata
⇒ We don’t need new file formats, we need more investment in Apache DataFusion and special indexes
Come Join Us! 🎣
https://datafusion.apache.org/



## About the Author

[Andrew Lamb](https://www.linkedin.com/in/andrewalamb/) is a Staff Engineer at
[InfluxData](https://www.influxdata.com/), and a member of the [Apache
DataFusion](https://datafusion.apache.org/) and [Apache Arrow](https://arrow.apache.org/) PMCs. He has been working on
Databases and related systems more than 20 years.

## About DataFusion

[Apache DataFusion] is an extensible query engine toolkit, written
in Rust, that uses [Apache Arrow] as its in-memory format. DataFusion and
similar technology are part of the next generation “Deconstructed Database”
architectures, where new systems are built on a foundation of fast, modular
components, rather than as a single tightly integrated system.

The [DataFusion community] is always looking for new contributors to help
improve the project. If you are interested in learning more about how query
execution works, help document or improve the DataFusion codebase, or just try
it out, we would love for you to join us.

[Apache Arrow]: https://arrow.apache.org/
[Apache DataFusion]: https://datafusion.apache.org/
[DataFusion community]: https://datafusion.apache.org/contributor-guide/communication.html


### Footnotes

<a id="footnote1"></a>`1`: This trend is described in more detail in the [FDAP Stack] blog

<a id="footnote2"></a>`2`: This layout is referred to a “PAX” in the
database literature (TODO LINK) after the first research paper to describe the technique,

<a id="footnote3"></a>`3`: Benchmaxxing (verb): to add specific optimizations that only
impact benchmark results and are not widely applicable to real world use cases.




Andrew explained that while reading Parquet files can be slow due to footer
parsing, stateful systems can optimize this by memoizing footer information and
using advanced features in Data Fusion to efficiently read and scan specific row
groups and data pages.




Database Pruning in Analytic Systems

Andrew discussed the application of database pruning techniques in Parquet
systems, emphasizing that similar methods could be implemented in other systems
like Data Fusion. He explained that given filters or predicates, the system can
determine which files need to be scanned for further processing, a concept
applicable across various analytic systems. Andrew provided an example using
Data Fusion, mentioning a Parquet Index video that demonstrates how to configure
the system to read only relevant files based on index structures. He concluded
by presenting Rust code that illustrates the basic idea of a table provider in
Data Fusion, highlighting its simplicity and applicability.

API for Filter Optimization

Andrew explained the API for handling filters and file reading, emphasizing its
ability to optimize data access by determining which files need to be consulted
based on query predicates. He described how the API can handle complex
algorithms, including range analysis for minimum and maximum values, and
highlighted that data fusion includes the necessary logic for such analyses.
Andrew also mentioned that the API is flexible, allowing for various
optimizations like bloom filters or full-text indexes, and provided a concrete
example of using the API to extract and store max values for columns in a
separate structure.

Catalog Systems Data Filtering Techniques

Andrew discussed various catalog systems and their approaches to filtering and
querying data. He explained how systems like his use PostgreSQL to store
metadata and quickly narrow down file subsets using time predicates. Andrew also
described how Log Fire and Iceberg use similar techniques, with Log Fire
rewriting query predicates into SQL for metadata filtering. He then shifted
focus to Parquet files, explaining how Data Fusion can not only filter which
files to consider but also rule out unnecessary portions within individual
Parquet files by using index structures and additional information outside the
files.



He demonstrated an example from the Data Fusion
repository showing how to implement this optimization, highlighting that while
many systems choose to read entire files, it's possible to build more efficient
systems that only process necessary data.

Parquet File Scanning Optimization

Andrew explained how Parquet files are scanned using access plans that specify
which row groups to scan and which ranges to target. He described how special
indexes can efficiently locate specific rows within row groups by skipping
unnecessary data and only fetching relevant data pages. Andrew also mentioned
that pre-parsed metadata can be used to avoid parsing the footer for each query,
reducing I/O and parsing costs during the query execution.

Parquet Analytics and Performance Improvements

Andrew discussed the use of Parquet files for analytics, emphasizing that they
can be used for both high-performance and low-latency analytics without being
restricted to built-in metadata. He highlighted the importance of allowing
additional indexes on top of Parquet and encouraged collaboration to improve
data fusion, noting that it is an open-source project. Andrew also invited
attendees to join efforts to enhance performance and regain a leading position
in benchmarks, providing a web page for further information.
