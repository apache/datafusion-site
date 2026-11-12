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
DRAFT. Before publishing:
- TODO: set the date (front matter and file name) to the release date.
- TODO: update the commit and contributor counts and the thank-you list from the 56.0.0 changelog.
  Counts below are for main at 333e2636a (2026-11-11): 189 commits from 20 authors.
- TODO: confirm the DataFusion version 56.0.0 ships with (main is on DataFusion 55).
- TODO: the memory usage page is in apache/datafusion-ballista#2855; update the link once it merges.
-->

[TOC]

We are pleased to announce version [56.0.0] of [Apache DataFusion Ballista]. Ballista is a distributed query
execution engine that enhances [Apache DataFusion] by enabling parallel execution of workloads across multiple
nodes.

[56.0.0]: https://github.com/apache/datafusion-ballista/blob/56.0.0/docs/source/changelog/56.0.0.md
[Apache DataFusion Ballista]: https://datafusion.apache.org/ballista/
[Apache DataFusion]: https://datafusion.apache.org

This release contains 189 commits from 20 contributors. It builds on [55.0.0], which made adaptive query
execution (AQE) the default, and this cycle went into three things: making Ballista faster, making AQE's
decisions better, and making the scheduler and executors behave correctly when things go wrong.

The highlights:

- **Faster**: Ballista now runs our 1 TB benchmark derived from TPC-H 2.2x faster than Apache Spark by default,
  up from 1.79x in 55.0.0, and 3.4x faster with a new, experimental pipelined execution mode.
- **Less memory**: on the most memory-intensive query in that benchmark, Ballista finished in less executor
  memory than Spark or Spark with Apache DataFusion Comet, and ran just as fast in 8 GiB as in 64 GiB.
- **Better adaptive plans**: AQE now sees distinct counts from shuffles, measures a join's output before
  broadcasting it, runs a repeated subquery once, and plans submitted physical plans too.
- **More robust**: graceful shutdown, a standalone result service, and a set of fixes that turn silent wrong
  results and hung jobs into correct results or clear errors.

[55.0.0]: /blog/2026/10/03/datafusion-ballista-55.0.0/

## Performance

We benchmarked Ballista against [Apache Spark] 4.1.3, and against Spark 4.1.3 with [Apache DataFusion Comet]
1.1.0, on TPC-H at scale factor 1000, with the data stored as Parquet on S3. All three ran on the same Kubernetes
cluster with 32 executors, each with 8 vCPU and 64 GiB of memory, and each query time is the mean of two runs
including the cold first run.

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
[DataFusion Distributed] and Trino. The scripts that ran the Ballista columns are now in the repository, in
[`benchmarks/cluster`], and can run all five engines on your own Kubernetes cluster.

[Apache Spark]: https://spark.apache.org/
[Apache DataFusion Comet]: https://datafusion.apache.org/comet/
[benchmarking guide]: https://datafusion.apache.org/ballista/contributors-guide/benchmarking/index.html
[DataFusion Distributed]: https://github.com/datafusion-contrib/datafusion-distributed
[`benchmarks/cluster`]: https://github.com/apache/datafusion-ballista/tree/main/benchmarks/cluster

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
or more failed with `Too many open files`.

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
- **Extension rules.** Projects that embed the scheduler can add their own rules to adaptive planning.

The release also lays the groundwork for distributed runtime filters: executors can now build Bloom, IN-list,
and min/max summaries of a join's build side and apply them to the probe side. Placing these filters in query
plans will follow in a future release.

### Correctness

Much of the AQE work in this cycle was making replanning safe. A stage cancelled by a replan is now retired and
its late tasks discarded, a stage that is rolled back discards its partial outputs before it runs again, a
failed stage transition no longer drops the stage from the graph, and intermediate shuffle files are freed when
an adaptive job succeeds. Aggregates above joins whose strategy is still undecided keep their partial and final
phases, and semi joins with volatile expressions are no longer moved.

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
- Pull-based executors no longer take on more partitions than they have vcores.

The TPC-H SF10 and TPC-DS SF1 suites now run against every code change before it merges, through a merge
queue, in addition to the high-availability chaos tests added in 55.0.0.

## Python

The Python client has been rebuilt on DataFusion Python's foreign function interface. `BallistaSessionContext`
now returns a standard `datafusion.SessionContext` with a Ballista query planner installed, so every operation
that executes a plan, including `collect`, `to_pandas`, `write_parquet` and `EXPLAIN ANALYZE`, runs on the cluster
without a wrapper in between. Python UDFs are supported, as is S3, and a pure-Python client is available as the
`python-client` extra for environments where the native client does not fit.

## Other changes

- `DataFrame::cache()` materializes a DataFrame on the cluster, and later queries read it back.
- `DESCRIBE` works on Ballista tables.
- `ComposedLogicalExtensionCodec` combines logical extension codecs, so a project can use several.
- The `spark-compat` feature has been removed.
- S3 credentials no longer appear in debug and trace logs.

## Upgrading

The wire format between the scheduler and executors has changed (protocol version 4), so they must be upgraded
together. The Python client's API changed as described above, and several scheduler and executor APIs gained
fields. The [upgrade guide] lists every change and what to do about it.

[upgrade guide]: https://datafusion.apache.org/ballista/upgrading/56.0.0.html

## Thank You

<!-- TODO: regenerate from the 56.0.0 changelog at release. -->

Thank you to all 20 contributors, including Andy Grove, Marko Milenković, Ville Brofeldt, Richard Durkee, Noah
Kusaba, Samuel James, Akshay Chitneni, and everyone who contributed code, reviews, bug reports, and feedback.
See the [changelog] for the complete list of changes and contributors.

[changelog]: https://github.com/apache/datafusion-ballista/blob/56.0.0/docs/source/changelog/56.0.0.md
