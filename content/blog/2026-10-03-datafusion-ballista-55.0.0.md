---
layout: post
title: Apache DataFusion Ballista 55.0.0 Released
date: 2026-10-03
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

[TOC]

We are pleased to announce version [55.0.0] of [Apache DataFusion Ballista]. Ballista is a distributed query
execution engine that enhances [Apache DataFusion] by enabling parallel execution of workloads across multiple
nodes.

[55.0.0]: https://github.com/apache/datafusion-ballista/blob/55.0.0/docs/source/changelog/55.0.0.md
[Apache DataFusion Ballista]: https://datafusion.apache.org/ballista/
[Apache DataFusion]: https://datafusion.apache.org

This release contains 322 commits from 25 contributors. It builds on [54.1.0], upgrades to DataFusion 55.1.0,
and brings major improvements to adaptive planning, SQL connectivity, observability, distributed windows,
and resource management.

[54.1.0]: /blog/2026/08/09/datafusion-ballista-54.1.0/

## Adaptive Query Execution by default

Adaptive Query Execution (AQE), introduced experimentally in 53.0.0, is now enabled by default. The scheduler
replans between stages using statistics from completed work, allowing it to choose a join strategy with actual
row counts rather than estimates made before execution.

The adaptive planner received extensive correctness work in this release. All 99 TPC-DS queries now complete
and match single-process DataFusion in the project's AQE test suite. The planner also avoids a redundant
shuffle when join inputs already have the required partitioning and applies broadcast thresholds consistently
between the adaptive and static paths.

Two related defaults reduce per-stage overhead. The scheduler now packs multiple input partitions into each
task, up to the assigned executor's available vcores, and the broadcast join threshold increases from 10 MB
to 128 MB. The previous behavior remains available through configuration; see the [upgrade guide] for details.

[upgrade guide]: https://datafusion.apache.org/ballista/upgrading/55.0.0.html

## Performance compared with Spark and Comet

We benchmarked Ballista against [Apache Spark] 4.1.3, and against Spark 4.1.3 with [Apache DataFusion Comet]
1.1.0-rc2, on TPC-H at scale factor 1000, with the data stored as Parquet on S3. All three ran on the same Kubernetes
cluster with 32 executors, each with 8 vCPU and 64 GiB of memory, and each query time is the mean of two runs.

Ballista ran the 22 queries in 502.4 seconds in total, against 898.2 seconds for Spark and 455.1 seconds for
Spark with Comet. That makes Ballista 1.79x faster than Spark over the suite, and faster on 19 of the 22 queries,
with the largest gaps on Q1 (5.1x) and Q17 (3.9x). Comet is still 1.10x faster than Ballista overall, but
Ballista was faster on 7 queries, including Q8 (2.3x) and Q9 (1.6x).

The dataset is partitioned by date, and these numbers come from a benchmark runner that declares the partition
columns, so Ballista skips the partitions a date filter excludes, as Spark and Comet do. The runner in the
55.0.0 release did not, so Ballista read every file's footer and pruned only through Parquet statistics. With
that runner, the total was 571.6 seconds: Q6 took 4.7 seconds instead of 1.6, and Q14 8.9 seconds instead of
5.5.

These are not tuned comparisons. Spark and Comet ran 16 tasks on each executor's 8 vCPU, while Ballista ran 8,
and Comet had an extra 32 GiB of off-heap memory per executor. The [benchmarking guide] has the full
configuration, the per-query results, and a Trino column for reference.

[Apache Spark]: https://spark.apache.org/
[Apache DataFusion Comet]: https://datafusion.apache.org/comet/
[benchmarking guide]: https://datafusion.apache.org/ballista/contributors-guide/benchmarking.html

## Flight SQL and ADBC

The scheduler now has an [Arrow Flight SQL] frontend, allowing generic SQL clients to query a Ballista cluster
through the standard [ADBC] interface without using a Ballista-specific client library. The implementation
supports statements, prepared statements, and catalog metadata, and was validated end-to-end using the Python
Flight SQL ADBC driver and all 22 TPC-H queries.

Flight SQL is opt-in: it requires the `flight-sql` build feature and the scheduler's `--flight-sql` flag. This
keeps existing deployments unchanged while making it possible to connect BI tools and other Flight SQL clients
to Ballista through a standard protocol.

[Arrow Flight SQL]: https://arrow.apache.org/docs/format/FlightSql.html
[ADBC]: https://arrow.apache.org/adbc/

## Event logs and history server

The scheduler normally removes completed jobs from memory after a retention interval, and an in-memory history
is lost when the scheduler restarts. Ballista 55.0.0 can instead write a durable event log for each job when the
scheduler is started with `--event-log-dir`.

The new `ballista-history-server` indexes those logs and serves the same job, stage, configuration, plan, and
metrics REST endpoints as a live scheduler. The existing TUI can therefore browse completed jobs even when the
original scheduler is no longer running. Logs are read on demand so retaining detailed histories does not
require keeping every job plan and task metric in memory.

The REST API is now documented with OpenAPI and exposes its specification at `/api/openapi.json`. REST and gRPC
responses also report the Ballista version, making it easier for clients and operators to identify the cluster
they are connected to.

## Distributed windows and range shuffles

Ballista's execution model can now assign a slice of several input partitions to one task, instead of requiring
one scheduler task per partition. This reduces planning, serialization, and dispatch overhead and provides the
foundation for range-partitioned algorithms.

Building on that model, 55.0.0 adds ordered and unordered range repartition operators, quantile sketches, and
an ordering-preserving range shuffle. Range readers only fetch the bytes that overlap their assigned ranges,
reducing unnecessary network and disk I/O.

The first optimization to use this machinery parallelizes `UNBOUNDED PRECEDING` window aggregates that do not
have a `PARTITION BY` clause. This optimization remains experimental and is disabled by default behind
`ballista.planner.parallel_window.enabled`; it currently targets a single ascending, fixed-width ordering key.

## Safer memory defaults

Executors now use a bounded `FairSpillPool` by default instead of an unbounded memory pool. Unless explicitly
configured, the pool is sized to 70% of the detected host or container memory limit and divided across the
executor's vcores. Spillable operators can now write to disk under pressure rather than growing until the
operating system or container runtime kills the executor.

Operators should ensure that the executor work directory has enough scratch space for spills. Set
`--memory-pool-fraction` to tune the automatically selected limit, supply an exact `--memory-pool-size`, or use
`--memory-pool-size 0` to restore the previous unbounded behavior.

## Shuffle and scheduler efficiency

The hash shuffle writer, which had already been superseded by sort shuffle, has been removed. Shuffle-heavy
workloads benefit from zero-copy remote block receives, one sort-shuffle file per task, reused partition-index
buffers, skipped IPC validation on sort-shuffle read paths, and removal of an unnecessary read-side sort.

Scheduler overhead is also lower: session configuration is encoded once rather than for every task, file
statistics can be shared across sessions, and small unfiltered scans can execute inline instead of creating a
separate stage. Executors continue heartbeating while all vcores are busy, and several failure paths now return
vcores, preserve stages for retry, or fail the job promptly rather than leaving it running indefinitely.

## Compatibility and operations

Ballista 55.0.0 adds a protocol version and Kubernetes health probes. Clients now receive a clear error when
their major version differs from the scheduler's, and the maximum gRPC message size is configurable
consistently across clients, schedulers, and executors. Configuration APIs were also simplified and normalized,
with deprecations for older method names.

The release adds first-generation column statistics at the task and stage levels, including null counts. This
information lays the groundwork for more informed broadcast and adaptive planning decisions in future releases.

## Thank You

Thank you to all 25 contributors, including Andy Grove, Brent Gardner, Noah Kusaba, Daniël Heres, Marko
Milenković, Akshay Chitneni, Ville Brofeldt, and everyone who contributed code, reviews, bug reports, and
feedback. See the [changelog] for the complete list of changes and contributors.

[changelog]: https://github.com/apache/datafusion-ballista/blob/55.0.0/docs/source/changelog/55.0.0.md
