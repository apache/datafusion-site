---
layout: post
title: Apache DataFusion Ballista 56.0.0 Released
date: 2026-11-30
author: pmc
categories: [release]
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

<!--
Before publishing:
- TODO: set the date (front matter and file name) to the release date.
-->

[TOC]

We are pleased to announce version [56.0.0] of [Apache DataFusion Ballista]. Ballista is a distributed query
execution engine that enhances [Apache DataFusion] by enabling parallel execution of workloads across multiple
nodes.

[56.0.0]: https://github.com/apache/datafusion-ballista/blob/56.0.0/docs/source/changelog/56.0.0.md
[Apache DataFusion Ballista]: https://datafusion.apache.org/ballista/
[Apache DataFusion]: https://datafusion.apache.org

This release contains 259 commits from 27 contributors and is built on DataFusion 56.0.0. It builds on [55.0.0],
which made adaptive query execution (AQE) the default, and this cycle went into three things: making Ballista
faster, making AQE's decisions better, and making the scheduler and executors behave correctly when things go
wrong.

The highlights:

- **Faster**: Ballista now runs our 1 TB benchmark derived from TPC-H 2.2x faster than Apache Spark by default,
  up from 1.79x in 55.0.0, and 3.4x faster with a new, experimental pipelined execution mode.
- **Less memory**: on the most memory-intensive query in that benchmark, Ballista finished in less executor
  memory than Spark or Spark with Apache DataFusion Comet, and ran just as fast in 8 GiB as in 64 GiB.
- **Better adaptive plans**: AQE now sees distinct counts from shuffles, measures a join's output before
  broadcasting it, runs a repeated subquery once, and plans submitted physical plans too.
- **DataFrame caching**: `DataFrame::cache()` keeps a DataFrame's output on the cluster for later queries, and
  rebuilds it when an executor holding it is lost.
- **More robust**: graceful shutdown, a standalone result service, and a set of fixes that turn silent wrong
  results and hung jobs into correct results or clear errors.
- **Apache Iceberg (experimental)**: a new integration scans Iceberg tables.

[55.0.0]: /blog/2026/10/03/datafusion-ballista-55.0.0/

## Performance

We benchmarked Ballista against [Apache Spark] 4.1.3, and against Spark 4.1.3 with [Apache DataFusion Comet]
1.1.0, on TPC-H at scale factor 1000, with the data stored as Parquet on S3. All three ran on the same Kubernetes
cluster with 32 executors, each with 8 vCPU and 64 GiB of memory, and each query time is the mean of two runs
including the cold first run. The Ballista results were measured on `main` during the release cycle, at commit
[`d9872080`].

<img
src="/blog/images/datafusion-ballista-56.0.0/tpch_sf1000_total.svg"
width="100%"
class="img-fluid"
alt="Bar chart of total time for the 22 queries: Apache Spark 4.1.3 takes 898 seconds, Ballista staged (default) 405 seconds, 2.2x faster, and Ballista pipelined (experimental) 261 seconds, 3.4x faster."
/>

Ballista ran the 22 queries in 405.0 seconds, down from the 502.4 seconds we reported for 55.0.0 on the same
cluster. That is 2.2x faster than Spark's 898.2 seconds, and Ballista was faster on 20 of the 22 queries, with
the largest gaps on Q1 (4.9x), Q18 (3.8x) and Q17 (3.7x).

In the 55.0.0 announcement Comet was 1.10x faster than Ballista overall. Ballista is now 1.12x faster than
Comet's 455.1 seconds, though Comet still wins 13 of the 22 queries, and by more than 2x on Q14 and Q20. With the
experimental pipelined mode described below, Ballista ran the suite in 260.9 seconds: 3.4x faster than Spark and
1.7x faster than Comet, and faster than Spark on every query.

These are not tuned comparisons. Spark and Comet ran 16 tasks on each executor's 8 vCPU, while Ballista ran 8,
and Comet had an extra 32 GiB of off-heap memory per executor. The Spark and Comet results come from an earlier
run with separate scripts and their own phrasing of the queries, so they are not an exact like-for-like
comparison. The [benchmarking guide] has the full configuration, the per-query results, and columns for
[DataFusion Distributed] and Trino, and the [DataFusion Distributed comparison] is now generated from the same
published results. The scripts that ran the Ballista columns are now in the repository, in
[`benchmarks/cluster`], and can run all five engines on your own Kubernetes cluster.

[Apache Spark]: https://spark.apache.org/
[Apache DataFusion Comet]: https://datafusion.apache.org/comet/
[benchmarking guide]: https://datafusion.apache.org/ballista/contributors-guide/benchmarking/index.html
[DataFusion Distributed]: https://github.com/datafusion-contrib/datafusion-distributed
[DataFusion Distributed comparison]: https://datafusion.apache.org/ballista/about/datafusion-distributed-comparison.html
[`benchmarks/cluster`]: https://github.com/apache/datafusion-ballista/tree/main/benchmarks/cluster
[`d9872080`]: https://github.com/apache/datafusion-ballista/commit/d98720804369917151052e1c280a1dae711817fb

### Where the time went

Most of the gain comes from moving and reading less data:

- **zstd shuffle compression by default.** Shuffles are usually bound by the bytes they move. For the
  `lineitem` columns that Q5 shuffles, zstd at level 1 stores about 8.2 bytes per row where LZ4 stored about 16,
  for a little more CPU. `ballista.shuffle.compression.codec` still accepts `lz4` and `none`.
- **One broadcast read per executor.** Every task of a broadcast hash join used to fetch and decode the build
  side on its own. In TPC-H SF100 Q2, a 16-task stage made 16,384 fetch requests and decoded the same table 16
  times. The first task on an executor now fetches it, and the other tasks share it.
- **Semi-join reduction.** DataFusion applies a selective filter on a small dimension table, such as a single
  `nation`, only at the join that names it. In Q7 that meant joining and shuffling 182 million `lineitem` rows
  before the filter dropped 92% of them. A new rule also semi-joins the filtered dimension below the joins in
  between, so the rows it would drop are removed before the shuffle.
- **Balanced scans.** DataFusion splits a scan's files into groups before any filter is applied, so when the data
  is clustered by the filtered column, as with date-partitioned directories, the files that survive pruning end
  up in a few groups and a few tasks do all the reading. The scheduler now prunes files from their statistics and
  spreads the remaining files evenly across tasks.
- **Smaller requests.** Partition locations list each executor once instead of copying its metadata into every
  location, scheduler connections no longer wait on Nagle's algorithm, remote shuffle fetches stream instead of
  buffering whole blocks, and object stores built for S3 are cached.

### Pipelined execution (experimental)

Ballista has always run a query stage by stage: each stage writes its output to shuffle files, and the next stage
starts when they are complete. That is robust and lets AQE replan between stages, but each stage boundary costs
time, which matters most for interactive queries.

56.0.0 adds an opt-in pipelined mode. The scheduler places every task of a job up front, and stages stream
record batches to each other over Arrow Flight instead of through shuffle files. Results stream to the client and
to Flight SQL as they are produced. Joins are planned by size, since there is no measured input to adapt to.

Pipelined execution is experimental. It is enabled per session with `ballista.execution.mode = pipelined` and
needs push-based scheduling. Pipelined jobs are planned statically, so AQE does not apply to them, and a failed
task fails the whole job rather than being retried. The default mode, now called `staged`, is unchanged. The
[pipelined execution guide] describes when to use it.

[pipelined execution guide]: https://datafusion.apache.org/ballista/user-guide/pipelined-execution.html

## Memory usage

Executor memory is what a cluster is sized for, and paid for: each executor reserves it for the whole job,
whether it uses it or not. So as well as how fast Ballista is, we wanted to know how little memory it needs.

We ran TPC-H Q18 at scale factor 1000 on a smaller cluster: two servers with 32 CPU cores and 125 GiB of memory
each, running 2 executors of 16 CPUs, with the data on local disk. Q18 aggregates all of `lineitem` by order key,
about 1.5 billion groups, and joins the result back to `orders`, `customer` and `lineitem`, which makes it the most
memory-intensive query in TPC-H. Each engine ran it at 64 GiB per executor and then at smaller and smaller sizes,
until the query no longer finished without an executor running out of memory. Spark and Comet were each run with
several divisions of executor memory between the heap, off-heap memory and overhead. Ballista ran with its
default settings.

<img
src="/blog/images/datafusion-ballista-56.0.0/tpch_q18_memory_smallest.svg"
width="100%"
class="img-fluid"
alt="Bar chart of the smallest executor memory at which TPC-H Q18 finished: Ballista 8 GiB in 132 seconds; Spark between 12 and 18 GiB depending on configuration; Spark with Comet between 20 and 24 GiB."
/>

Ballista finished in 8 GiB per executor. Spark needed 12 GiB in its best configuration, with half of its memory
off-heap, and 18 GiB with all of it on the heap. Spark with [Comet 1.2.0] needed 20 GiB, with three quarters
off-heap.

<img
src="/blog/images/datafusion-ballista-56.0.0/tpch_q18_memory_time.svg"
width="100%"
class="img-fluid"
alt="Line chart of TPC-H Q18 time against executor memory. Ballista stays near 130 seconds from 64 GiB down to 8 GiB. Spark + Comet stays near 150 seconds down to 20 GiB. Spark rises from 330 seconds at 64 GiB to 387 seconds at 12 GiB."
/>

Ballista's time barely changed as its memory shrank: 133 seconds at 64 GiB and 132 seconds at 8 GiB. Since
55.0.0, executors size their memory pool from the container's limit by default and spill to disk under
pressure, so Ballista ran the query in whatever memory it was given. Spark slowed by 17% on the way to its
smallest size. Comet, at about 150 seconds, was faster than Spark at every size it completed but needed the most
memory. Every Comet failure was an executor exceeding its container's limit rather than an error from Comet's
memory pool, consistent with the native memory outside the pool that [Comet 1.1.0 began to measure].

This is one query on one cluster, and each size ran once, so a size close to an engine's limit could go either
way on another run. Below 8 GiB, Ballista executors ran out of memory and were restarted. At 6 GiB the query
still finished, at about a third of its usual speed, but at 5 GiB and below it stopped making progress instead of
failing ([#2856]). The [memory usage page] has every run and how to reproduce them.

[Comet 1.2.0]: /blog/2026/11/02/datafusion-comet-1.2.0/
[Comet 1.1.0 began to measure]: /blog/2026/10/01/datafusion-comet-1.1.0/
[memory usage page]: https://datafusion.apache.org/ballista/contributors-guide/benchmarking/memory.html
[#2856]: https://github.com/apache/datafusion-ballista/issues/2856

Executors are also easier to size and debug. They report their memory use in heartbeats and log how much memory
they have allocated, including memory the pool does not track, and when a task runs out of memory, the error
names the operators holding the most memory. Spill files now go to the executor's work directory, whose free
space sets the spill limit by default. Executors also raise their open file limit at startup: a task holds a
file for each shuffle partition it reads or writes, and with the common limit of 1024, TPC-H at 128 partitions
or more failed with `Too many open files`. The executor can now also be built with jemalloc as its allocator
(the `jemalloc` feature) instead of mimalloc.

## Adaptive query execution

AQE, the default since 55.0.0, replans a query between stages using statistics from the stages that have
completed. This release gives it better statistics and lets it do more with them.

### Better statistics, safer broadcasts

A shuffle used to carry row counts and sizes but no distinct counts, so after a shuffle DataFusion estimated an
inner join at the size of its smaller input. For a join on a foreign key that can be wrong by the join's whole
fan-out. In Q21 at SF1000, a join estimated at 399,809 rows produced 151,688,609, AQE broadcast it, and the job
failed.

Two changes fix this. Shuffle writers now sketch the distinct count of each partitioning key with HyperLogLog
(`ballista.shuffle.collect_distinct_counts`), so AQE estimates joins after a shuffle from distinct counts as
well as row counts. And when a join's build side is itself an unexecuted join whose size is only an estimate,
AQE now runs it as its own stage and measures it before deciding to broadcast it
(`ballista.optimizer.stage_build_side`).

### Doing less work

- **Exchange reuse.** When a query reads the same subplan more than once, such as a common table expression
  joined to itself or Q15's revenue view, AQE now runs its stage once and lets every reader share the output
  (`ballista.planner.reuse_exchange.enabled`, on by default).
- **Physical plans through AQE.** Clients that build their own physical plans and submit them directly, for
  example with their own operators between DataFusion repartitions, used to get the static planner. They now go
  through AQE, like SQL and DataFrame queries.
- **Coalescing to one partition.** With `ballista.planner.coalesce.enabled`, a stage whose whole input fits in
  one target-sized partition is now coalesced all the way down to a single task, as Spark does for final
  aggregates, small joins and the sorts below an `ORDER BY`.
- **Skew joins (opt-in).** With `ballista.planner.skew_join.enabled`, AQE splits a skewed partition of a
  partitioned join into smaller tasks and replicates the matching partition of the other side, so one hot key
  no longer serializes the join on a single task.
- **Extension rules.** Projects that embed the scheduler can add their own rules to adaptive planning, and
  can tell the coalesce rule that their own operators accept a changed partition count, so stages that run
  them get partition coalescing too.

### Runtime filters (opt-in)

With `ballista.planner.runtime_filter.enabled`, AQE builds Bloom, IN-list and min/max summaries of the build side
of inner and semi hash joins and applies them to the probe side, so rows that cannot match are dropped as the
probe side is scanned. Probe stages never wait for a filter: a stage uses the filters whose builds are complete
when it starts, and runs without them otherwise. Broadcast joins can use them too, and `EXPLAIN ANALYZE` shows
how many rows each filter pruned.

### Correctness

Much of the AQE work in this cycle was making replanning safe. A stage cancelled by a replan is now retired and
its late tasks discarded, a stage that is rolled back discards its partial outputs before it runs again, a
failed stage transition no longer drops the stage from the graph, and intermediate shuffle files are freed when
an adaptive job succeeds. Aggregates above joins whose strategy is still undecided keep their partial and final
phases, and semi joins with volatile expressions are no longer moved. An AQE job that loses the output of a
stage that has already finished now fails, instead of hanging; rerunning that stage is still to come ([#1986]).

[#1986]: https://github.com/apache/datafusion-ballista/issues/1986

## Caching DataFrames

`DataFrame::cache()` now works on a cluster. Once `ballista.cache.noop` is set to `false`, the first query on a
cached DataFrame runs the cached part as a job of its own and keeps its output on the executors, and later
queries in the same session read that output instead of computing it again:

```rust
ctx.sql("SET ballista.cache.noop = false").await?;
let cached = ctx.table("t").await?.filter(col("x").gt(lit(5)))?.cache().await?;
cached.clone().count().await?; // builds the cache, then reads it
cached.collect().await?;       // reads it
```

The cache is built in staged mode, and queries over it run in the session's mode, so a pipelined session can
read a cache with streaming queries. Cached data lives on the executors, so the scheduler also recovers it. If a
query loses part of a cache it reads, because the executor holding it is lost or a fetch from it fails, the stage
reading it rolls back, the cache is rebuilt, and the query carries on from there. Queries planned by AQE, and
pipelined queries once their tasks have started, cannot resume yet, and fail instead with an error that says to
retry, and the retry rebuilds the cache. A session's caches are dropped when the session is removed, and an
operator can turn caching off for the whole cluster with the scheduler's `--disable-dataframe-cache` flag.

Cached data is not evicted yet, so cache only what you reuse. The [tuning guide] has a full example in both
execution modes, and the [DataFrame cache design] describes how it works.

[tuning guide]: https://datafusion.apache.org/ballista/user-guide/tuning-guide.html#caching-dataframes
[DataFrame cache design]: https://datafusion.apache.org/ballista/contributors-guide/dataframe-cache.html

## Robustness and operations

### Shutting down cleanly

The scheduler, executors and the Docker images now handle `SIGTERM`, so `docker stop` and Kubernetes pod
termination reach Ballista instead of waiting out the grace period. Executors finish their running tasks before
they exit. The scheduler stops accepting new jobs, over gRPC and Flight SQL alike, lets its active jobs finish,
and then drains its connections, all within `--graceful-shutdown-timeout-seconds`.

### A standalone result service

Clients that cannot reach the executors, as is common on Kubernetes, used to fetch results through a proxy
embedded in the scheduler, where every result byte competed with planning and scheduling. The new
`ballista-result-service` is a stateless Arrow Flight service that forwards each fetch to the executor holding
the partition, and can be scaled on its own behind a load balancer. The embedded proxy is deprecated and will
be removed in 57.0.0.

### Errors instead of wrong answers

Several plans could previously return wrong results with no error. They now either return correct results or
fail clearly:

- A range repartition in a submitted physical plan was dropped, so a distributed global sort returned partitions
  that were sorted but overlapping. It is now planned as a shuffle.
- When a stage is split between tasks, a leaf operator the scheduler did not know how to restrict to a task's
  partitions ran all of them, so some partitions were returned twice and others not at all. The scheduler now
  fails the job, and projects with custom operators can teach it how to restrict them.
- A task whose status update carried metrics the scheduler could not merge had its status dropped, and under
  pull scheduling, tasks that did not fit in one poll response never ran and the job hung. Both are fixed, and an
  unreadable shuffle block is now reported as a fetch failure so the stage that wrote it reruns.
- Nested-loop joins that emit their build rows, such as `LEFT` and `FULL` joins, emitted them once per task when
  their probe side was split between tasks. They now run as a single task.
- In a stage split between tasks, a `UNION ALL` branch that merges its input, such as one with a `LIMIT`, was run
  by every task. Such a branch now gets a stage of its own.
- Pull-based executors no longer take on more partitions than they have vcores.
- Jobs whose rollback fails after an executor is lost now fail instead of hanging.

The TPC-H SF10 and TPC-DS SF1 suites now run against every code change before it merges, through a merge
queue, in addition to the high-availability chaos tests added in 55.0.0.

## Python

The Python bindings for 56.0.0 will be released separately, after this release. In them, the Python client has
been rebuilt on DataFusion Python's foreign function interface. `BallistaSessionContext` now returns a standard
`datafusion.SessionContext` with a Ballista query planner installed, so every operation that executes a plan,
including `collect`, `to_pandas`, `write_parquet` and `EXPLAIN ANALYZE`, runs on the cluster without a wrapper in
between. Python UDFs are supported, as is S3, and a pure-Python client is available as the
`python-client` extra for environments where the native client does not fit.

## Apache Iceberg (experimental)

The new `ballista-iceberg` crate, in `integrations/iceberg`, lets Ballista scan [Apache Iceberg] tables. On top of
[iceberg-datafusion], it adds the codecs that send Iceberg tables and scans between the client, the scheduler and
the executors, pins each table to one version for the whole query, and mounts Iceberg catalogs on the scheduler
for Flight SQL clients. It is not published to crates.io yet, because it depends on unreleased revisions of
iceberg-rust; see the [Iceberg guide] to build it.

[Apache Iceberg]: https://iceberg.apache.org/
[iceberg-datafusion]: https://github.com/apache/datafusion-iceberg
[Iceberg guide]: https://datafusion.apache.org/ballista/user-guide/iceberg.html

## Other changes

- Hash shuffles can place rows by a partition id that the client computes, so Ballista can match data that is
  already partitioned by another function, such as Spark's Murmur3 hash for bucketed tables.
- `DESCRIBE` works on Ballista tables.
- `ComposedLogicalExtensionCodec` combines logical extension codecs, so a project can use several.
- The `spark-compat` feature has been removed.
- S3 credentials no longer appear in debug and trace logs.

## Upgrading

Ballista 56.0.0 uses DataFusion 56.0.0 and Arrow 60. The wire format between the scheduler and executors has
changed (protocol version 4), so they must be upgraded together. Several scheduler and executor APIs gained
fields, and the scheduler's embedded Flight proxy is deprecated and will be removed in 57.0.0. The Python client's
API changes described above, and the deprecation of its `cluster_config` argument, arrive with the 56.0.0 Python
bindings. The [upgrade guide] lists every change and what to do about it.

[upgrade guide]: https://datafusion.apache.org/ballista/upgrading/56.0.0.html

## Thank You

Thank you to everyone who contributed to this release, including Andy Grove, Marko Milenković, Noah Kusaba, Ville
Brofeldt, Akshay Chitneni, Richard Durkee, Vikrant Mehta, Bharadwaj Pendyala, Samuel James, Xuanyi Li, Ethan
Woodbury, and everyone who contributed code, reviews, bug reports, and feedback. See the [changelog] for the complete list of changes and contributors.

[changelog]: https://github.com/apache/datafusion-ballista/blob/56.0.0/docs/source/changelog/56.0.0.md
