---
layout: post
title: Efficient Filter Pushdown in Parquet
date: 2025-03-21
author: Xiangpeng Hao
categories: [performance]
---

<style>
figure {
  margin: 20px 0;
}

figure img {
  display: block;
  max-width: 80%;
}

figcaption {
  font-style: italic;
  margin-top: 10px;
  color: #555;
  font-size: 0.9em;
  max-width: 80%;
}
</style>

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

_Editor's Note: This blog was first published on [Xiangpeng Hao's blog]. Thanks to [InfluxData] for sponsoring this work as part of his PhD funding._

[Xiangpeng Hao's blog]: https://blog.xiangpeng.systems/posts/parquet-pushdown/
[InfluxData]: https://www.influxdata.com/
<hr/>


In the [previous post], we discussed how [Apache DataFusion] prunes [Apache Parquet] files to skip irrelevant **files/row_groups** (sometimes also [pages](https://parquet.apache.org/docs/file-format/pageindex/)).

This post discusses how Parquet readers skip irrelevant **rows** while scanning data,
leveraging Parquet's columnar layout by first reading only filter columns,
and then selectively reading other columns only for matching rows.


[previous post]: https://datafusion.apache.org/blog/2025/03/20/parquet-pruning
[Apache DataFusion]: https://datafusion.apache.org/
[Apache Parquet]: https://parquet.apache.org/

## Why filter pushdown in Parquet? 

Below is an example query that reads sensor data with filters on `date_time` and `location`.
Without filter pushdown, all rows from location, val, and date_time columns are decoded before `location='office'` is evaluated. Filter pushdown is especially useful when the filter is selective, i.e., removes many rows.


```sql
SELECT val, location 
FROM sensor_data 
WHERE date_time > '2025-03-11' AND location = 'office';
```

<figure>
  <img src="/blog/images/parquet-pushdown/pushdown-vs-no-pushdown.jpg" alt="Parquet pruning skips irrelevant files/row_groups, while filter pushdown skips irrelevant rows. Without filter pushdown, all rows from location, val, and date_time columns are decoded before `location='office'` is evaluated. Filter pushdown is especially useful when the filter is selective, i.e., removes many rows." width="80%" class="img-responsive">
  <figcaption>
    Parquet pruning skips irrelevant files/row_groups, while filter pushdown skips irrelevant rows. Without filter pushdown, all rows from location, val, and date_time columns are decoded before `location='office'` is evaluated. Filter pushdown is especially useful when the filter is selective, i.e., removes many rows.
  </figcaption>
</figure>


In our setup, sensor data is aggregated by date — each day has its own Parquet file.
At planning time, DataFusion prunes the unneeded Parquet files, i.e., `2025-03-10.parquet` and `2025-03-11.parquet`.

Once the files to read are located, the [*DataFusion's current default implementation*](https://github.com/apache/datafusion/issues/3463) reads all the projected columns (`sensor_id`, `val`, and `location`) into Arrow RecordBatches, then applies the filters over `location` to get the final set of rows.

A better approach is called **filter pushdown**, which evaluates filter conditions first and only decodes data that passes these conditions.
In practice, this works by first processing only the filter columns (`date_time` and `location`), building a boolean mask of rows that satisfy our conditions, then using this mask to selectively decode only the relevant rows from other columns (`sensor_id`, `val`). 
This eliminates the waste of decoding rows that will be immediately filtered out.

While simple in theory, practical implementations often make performance worse.

## How can filter pushdown be slower?

At a high level, the Parquet reader first builds a filter mask -- essentially a boolean array indicating which rows meet the filter criteria -- and then uses this mask to selectively decode only the needed rows from the remaining columns in the projection.

Let's dig into details of [how filter pushdown is implemented](https://github.com/apache/arrow-rs/blob/d5339f31a60a4bd8a4256e7120fe32603249d88e/parquet/src/arrow/async_reader/mod.rs#L618-L712) in the current Rust Parquet reader implementation, illustrated in the following figure.

<figure>
  <img src="/blog/images/parquet-pushdown/baseline-impl.jpg" alt="Implementation of filter pushdown in Rust Parquet readers" class="img-responsive" with="70%">
  <figcaption>
    Implementation of filter pushdown in Rust Parquet readers -- the first phase builds the filter mask, the second phase applies the filter mask to the other columns
  </figcaption>
</figure>

The filter pushdown has two phases:

1. Build the filter mask (steps 1-3)

2. Use the filter mask to selectively decode other columns (steps 4-7), e.g., output step 3 is used as input for step 5 and 7.

Within each phase, it takes three steps from Parquet to Arrow:

1. Decompress the Parquet pages using generic decompression algorithms like LZ4, Zstd, etc. (steps 1, 4, 6)

2. Decode the page content into Arrow format (steps 2, 5, 7)

3. Evaluate the filter over Arrow data (step 3)

In the figure above, we can see that `location` is **decompressed and decoded twice**, first when building the filter mask (steps 1, 2), and second when building the output (steps 4, 5).
This happens for all columns that appear both in the filter and output.

The table below shows the corresponding CPU time on the [ClickBench query 22](https://github.com/apache/datafusion/blob/main/benchmarks/queries/clickbench/queries.sql#L23):

```
+------------+--------+-------------+--------+
| Decompress | Decode | Apply filter| Others |
+------------+--------+-------------+--------+
| 206 ms     | 117 ms | 22 ms       | 48 ms  |
+------------+--------+-------------+--------+
```

Clearly, decompress/decode operations dominate the time spent. With filter pushdown, it needs to decompress/decode twice; but without filter pushdown, it only needs to do this once.
This explains why filter pushdown is slower in some cases.


> **Note:** Highly selective filters may skip the entire page; but as long as it reads one row from the page, it needs to decompress and often decode the entire page.


## Attempt: cache filter columns

Intuitively, caching the filter columns and reusing them later could help.

But naively caching decoded pages consumes prohibitively high memory:

1. It needs to cache Arrow arrays, which are on average [4x larger than Parquet data](https://github.com/XiangpengHao/liquid-cache/blob/main/dev/doc/liquid-cache-vldb.pdf).

2. It needs to cache the **entire column chunk in memory**, because in Phase 1 it builds filters over the column chunk, and only use it in Phase 2.  

3. The memory usage is proportional to the number of filter columns, which can be unboundedly high. 

Worse, caching filter columns means it needs to read partially from Parquet and partially from cache, which is complex to implement, likely requiring a substantial change to the current implementation. 

> **Feel the complexity:** consider building a cache that properly handles nested columns, multiple filters, and filters with multiple columns.

## Real solution

We need a solution that:

1. Is simple to implement, i.e., doesn't require thousands of lines of code.

2. Incurs minimal memory overhead.

This section describes my [<700 LOC PR (with lots of comments and tests)](https://github.com/apache/arrow-rs/pull/6921#issuecomment-2718792433) that **reduces total ClickBench time by 15%, with up to 2x lower latency for some queries, no obvious regression on other queries, and caches at most 2 pages (~2MB) per column in memory**.


<figure>
  <img src="/blog/images/parquet-pushdown/new-pipeline.jpg" alt="New decoding pipeline, building filter mask and output columns are interleaved in a single pass, allowing us to cache minimal pages for minimal amount of time" width="80%" class="img-responsive">
  <figcaption>
    New decoding pipeline, building filter mask and output columns are interleaved in a single pass, allowing us to cache minimal pages for minimal amount of time
  </figcaption>
</figure>

The new pipeline interleaves the previous two phases into a single pass, so that:

1. The page being decompressed is immediately used to build filter masks and output columns.

2. Decompressed pages are cached for minimal time; after one pass (steps 1-6), the cache memory is released for the next pass. 

This allows the cache to only hold 1 page at a time, and to immediately discard the previous page after it's used, significantly reducing the memory requirement for caching.

### What pages are cached?
You may have noticed that only `location` is cached, not `val`, because `val` is only used for output.
More generally, only columns that appear both in the filter and output are cached, and at most 1 page is cached for each such column.

More examples:
```sql
SELECT val 
FROM sensor_data 
WHERE date_time > '2025-03-12' AND location = 'office';
```

In this case, no columns are cached, because `val` is not used for filtering.

```sql
SELECT COUNT(*) 
FROM sensor_data 
WHERE date_time > '2025-03-12' AND location = 'office';
```

In this case, again, no columns are cached, because the output projection is empty after query plan optimization.

### Then why cache 2 pages per column instead of 1? 
This is another real-world nuance regarding how Parquet layouts the pages.

Parquet by default encodes data using [dictionary encoding](https://parquet.apache.org/docs/file-format/data-pages/encodings/), which writes a dictionary page as the first page of a column chunk, followed by the keys referencing the dictionary.

You can see this in action using [parquet-viewer](https://parquet-viewer.xiangpeng.systems):

<figure>
  <img src="/blog/images/parquet-pushdown/parquet-viewer.jpg" alt="Parquet viewer shows the page layout of a column chunk" width="80%" class="img-responsive">
  <figcaption>
    Parquet viewer shows the page layout of a column chunk
  </figcaption>
</figure>

This means that to decode a page of data, it actually references two pages: the dictionary page and the data page.

This is why it caches 2 pages per column: one dictionary page and one data page.
The data page slot will move forward as it reads the data; but the dictionary page slot always references the first page.

<figure>
  <img src="/blog/images/parquet-pushdown/cached-pages.jpg" alt="Cached two pages, one for dictionary (pinned), one for data (moves as it reads the data)" width="80%" class="img-responsive">
  <figcaption>
    Cached two pages, one for dictionary (pinned), one for data (moves as it reads the data)
  </figcaption>
</figure>


## How does it perform?

Here are my results on [ClickBench](https://github.com/apache/datafusion/tree/main/benchmarks#clickbench) on my AMD 9900X machine. The total time is reduced by 15%, with Q23 being 2.24x faster,
and queries that get slower are likely due to noise.

```
┏━━━━━━━━━━━━━━┳━━━━━━━━━━━━━┳━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━┓
┃ Query        ┃ no-pushdown ┃ new-pushdown ┃        Change ┃
┡━━━━━━━━━━━━━━╇━━━━━━━━━━━━━╇━━━━━━━━━━━━━━╇━━━━━━━━━━━━━━━┩
│ QQuery 0     │      0.47ms │       0.43ms │ +1.10x faster │
│ QQuery 1     │     51.10ms │      50.10ms │     no change │
│ QQuery 2     │     68.23ms │      64.49ms │ +1.06x faster │
│ QQuery 3     │     90.68ms │      86.73ms │     no change │
│ QQuery 4     │    458.93ms │     458.59ms │     no change │
│ QQuery 5     │    522.06ms │     478.50ms │ +1.09x faster │
│ QQuery 6     │     49.84ms │      49.94ms │     no change │
│ QQuery 7     │     55.09ms │      55.77ms │     no change │
│ QQuery 8     │    565.26ms │     556.95ms │     no change │
│ QQuery 9     │    575.83ms │     575.05ms │     no change │
│ QQuery 10    │    164.56ms │     178.23ms │  1.08x slower │
│ QQuery 11    │    177.20ms │     191.32ms │  1.08x slower │
│ QQuery 12    │    591.05ms │     569.92ms │     no change │
│ QQuery 13    │    861.06ms │     848.59ms │     no change │
│ QQuery 14    │    596.20ms │     580.73ms │     no change │
│ QQuery 15    │    554.96ms │     548.77ms │     no change │
│ QQuery 16    │   1175.08ms │    1146.07ms │     no change │
│ QQuery 17    │   1150.45ms │    1121.49ms │     no change │
│ QQuery 18    │   2634.75ms │    2494.07ms │ +1.06x faster │
│ QQuery 19    │     90.15ms │      89.24ms │     no change │
│ QQuery 20    │    620.15ms │     591.67ms │     no change │
│ QQuery 21    │    782.38ms │     703.15ms │ +1.11x faster │
│ QQuery 22    │   1927.94ms │    1404.35ms │ +1.37x faster │
│ QQuery 23    │   8104.11ms │    3610.76ms │ +2.24x faster │
│ QQuery 24    │    360.79ms │     330.55ms │ +1.09x faster │
│ QQuery 25    │    290.61ms │     252.54ms │ +1.15x faster │
│ QQuery 26    │    395.18ms │     362.72ms │ +1.09x faster │
│ QQuery 27    │    891.76ms │     959.39ms │  1.08x slower │
│ QQuery 28    │   4059.54ms │    4137.37ms │     no change │
│ QQuery 29    │    235.88ms │     228.99ms │     no change │
│ QQuery 30    │    564.22ms │     584.65ms │     no change │
│ QQuery 31    │    741.20ms │     757.87ms │     no change │
│ QQuery 32    │   2652.48ms │    2574.19ms │     no change │
│ QQuery 33    │   2373.71ms │    2327.10ms │     no change │
│ QQuery 34    │   2391.00ms │    2342.15ms │     no change │
│ QQuery 35    │    700.79ms │     694.51ms │     no change │
│ QQuery 36    │    151.51ms │     152.93ms │     no change │
│ QQuery 37    │    108.18ms │      86.03ms │ +1.26x faster │
│ QQuery 38    │    114.64ms │     106.22ms │ +1.08x faster │
│ QQuery 39    │    260.80ms │     239.13ms │ +1.09x faster │
│ QQuery 40    │     60.74ms │      73.29ms │  1.21x slower │
│ QQuery 41    │     58.75ms │      67.85ms │  1.15x slower │
│ QQuery 42    │     65.49ms │      68.11ms │     no change │
└──────────────┴─────────────┴──────────────┴───────────────┘
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━┓
┃ Benchmark Summary           ┃            ┃
┡━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━━━━┩
│ Total Time (no-pushdown)    │ 38344.79ms │
│ Total Time (new-pushdown)   │ 32800.50ms │
│ Average Time (no-pushdown)  │   891.74ms │
│ Average Time (new-pushdown) │   762.80ms │
│ Queries Faster              │         13 │
│ Queries Slower              │          5 │
│ Queries with No Change      │         25 │
└─────────────────────────────┴────────────┘
```

## Conclusion

Despite being simple in theory, filter pushdown in Parquet is non-trivial to implement.
It requires understanding both the Parquet format and reader implementation details. 
The challenge lies in efficiently navigating through the dynamics of decoding, filter evaluation, and memory management.

If you are interested in this level of optimization and want to help test, document and implement this type of optimization, come find us in the [DataFusion Community]. We would love to have you. 

[DataFusion Community]: https://datafusion.apache.org/contributor-guide/communication.html





