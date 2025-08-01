---
layout: post
title: Using External Indexes and Metadata Stores to Accelerate Queries on Apache Parquet
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


In this blog, we describe an important aspect of query performance in analytic
systems, namely how to quickly find where the desired data is stored using
indexes and metadata stores for Apache Parquet based system. We will then
illustrate how to implement such systems using Apache DataFusion.

* Note there is a companion [video] and [presentation] for this blog. */

[video]: https://www.youtube.com/watch?v=74YsJT1-Rdk
[presentation]: https://docs.google.com/presentation/d/1e_Z_F8nt2rcvlNvhU11khF5lzJJVqNtqtyJ-G3mp4-Q/edit




(TODO picture / diagram about the pruning process)

Existing data platforms each make a certain set of tradeoffs for performance,
cost, availability, interoperability, deployment target, and operational ease.
For some usecases an existing solution works great, and for others you must
assemble your own platform to get the tradeoffs that are most optimal for your
usecase. Thankfully,  the era of Composable Data Systems (link) makes it
increasingly easy to build custom data platforms, observability stacks, and
databases without having to re-create all the pisces

# Using Apache Parquet for Storage

Apache Parquet’s (TODO link) combination of good compression, high-performance,
high quality open source ilbraries, and wide ecosystem interoperability make it
a compelling choice when building new systems. While there are some niche use
case that may benefit from using a different format, for many usecases Parquet
is the obvious choice.

As I argue in the companion video of this blog, even in ClickBench (todo link), the current analytics benchmark that vendors love to BenchMaxx, there is less than a factor of two in performance between custom file formats such as DuckDB or Vortex and Parquet. The difference is even lower if the benchmark parquet files are rewritten to use more of the features Parquet already provides such as Column or Offset Indexes or Bloom Filters. Compared to the low interoperability and expensive transcoding/loading step of alternate file formats, Parquet looks pretty good.

# Apache Parquet Overview

This section provides a brief background on the organization of Apache Parquet files.

organizes data into row groups and column chunks, as shown in figure 1.

<img
src="/blog/images/external-parquet-indexes/parquet-layout.png"
width="80%"
class="img-responsive"
alt="Parquet File layout: Row Groups and Column Chunks."
/>

**Figure**: Parquet File Layout

<img
src="/blog/images/external-parquet-indexes/parquet-metadata.png"
width="80%"
class="img-responsive"
alt="Parquet File layout: Metadata and footer."
/>

**Figure**: Parquet Metadata in the Footer


<img
src="/blog/images/external-parquet-indexes/parquet-filter-pushdown.png"
width="80%"
class="img-responsive"
alt="Parquet Filter Pushdown: use filter predicate to skip pages."
/>

**Figure**: Filter Pushdown in Parquet: use the predicate "C > 25" from the query
along with various statistics from the indexes / metadata to skip pages that
cannot match the predicate.


Pruning in parquet

Please refer to XXX for more details

While more recent file formats differ in the details, almost all of them have
the same high level structure (and many even use the same terminology) of
metadata in the footer, and then data that is divided into row groups (called
“PAX” in the database literature after the first research paper to describe the
technique) and then into smaller units of IO. This structure is so similar
because it enables a hierarchical approach to pruning (finding what you want
quickly) as described in the next section

Proprietary formats have same high level structure:
PAX + Data Pages + Metadata
e.g Clickhouse: Parts + Granules + Indexes

Differences: where metadata stored (and encodings, which I ignore)

⇒ Nothing theoretically prevents other metadata with Parquet (only software engineering)

There are many different existing integrations of this type of extenral index such as
[Iceberg](https://iceberg.apache.org/), [Delta Lake](https://delta.io/),
[DuckLake](https://duckdb.org/2025/05/27/ducklake.html). Using these may be a good choice
if they meet your needs, but if you need something more custom or want to
experiment, you can build your own with DataFusion which we discuss below.


# Making Queries Fast: Skip as Much as Possible

All query processing systems are optimized first by quickly figuring how to skip
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



<img
src="/blog/images/external-parquet-indexes/prune-files.png"
width="80%"
class="img-responsive"
alt="Data Skipping: Pruning Files."
/>

**Figure**: Step 1: File Pruning. Given a query predicate, systems use external
indexes / metadata stores to quickly rule out files that cannot match the query.
In this case, by consulting the index all but two files can be ruled out.




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

Parquet File Optimization Techniques





<img
src="/blog/images/external-parquet-indexes/prune-row-groups.png"
width="80%"
class="img-responsive"
alt="Data Skipping: Pruning Row Groups and DataPages"
/>

**Figure**: Step 1: Pruning Parquet Row Groups and Data Pages. Given a query predicate,
systems can use external indexes / metadata stores along with Parquet's built-in
structures to quickly rule out row groups and data pages that cannot match the query.
In this case, the index has ruled out all but three data pages.

Andrew explained that while reading Parquet files can be slow due to footer
parsing, stateful systems can optimize this by memoizing footer information and
using advanced features in Data Fusion to efficiently read and scan specific row
groups and data pages. 



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


<sup>[2](#footnote2)</sup>
### Footnotes

<a id="footnote1"></a>`1`: A commonly cited example is highly selective predicates (e.g. `category = 'foo'`) but for which the built in BloomFilters are not sufficient.
