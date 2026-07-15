---
layout: post
title: Apache DataFusion Ballista 54.0.0 Released
date: 2026-07-12
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

We are pleased to announce version [54.0.0] of [Apache DataFusion Ballista]. Ballista is a distributed query
execution engine that enhances [Apache DataFusion] by enabling parallel execution of workloads across multiple
nodes.

[54.0.0]: https://github.com/apache/datafusion-ballista/blob/54.0.0/docs/source/changelog/54.0.0.md
[Apache DataFusion Ballista]: https://datafusion.apache.org/ballista/
[Apache DataFusion]: https://datafusion.apache.org

This release consists of 171 commits from 11 contributors. It follows [53.0.0], and continues the same
themes: making Ballista predictable to operate, pushing forward on Adaptive Query Execution, and closing the
gap between a single-node DataFusion query and the same query running on a cluster.

[53.0.0]: /blog/2026/05/24/datafusion-ballista-53.0.0/

## Upgrade to DataFusion 54

Ballista 54.0.0 is built on [DataFusion 54.0.0], and both the core engine and the Python client have been
upgraded. As with every release, Ballista's version number tracks the DataFusion release it is built on.

[DataFusion 54.0.0]: https://datafusion.apache.org/blog/

A versioned [upgrade guide] is now published for 54.0.0, documenting the changes needed to move from the
previous release.

[upgrade guide]: https://datafusion.apache.org/ballista/upgrading/54.0.0.html

## Python client on PyPI

This is the first Ballista release to publish pre-built wheels to [PyPI], so the Python client can now be
installed without a Rust toolchain or a build from source:

```bash
pip install ballista==54.0.0
```

Wheels are available for macOS (Apple Silicon) and Linux (x86-64 and ARM64, glibc 2.39+), and the client
requires Python 3.10 or newer. It connects to a Ballista scheduler and exposes a DataFusion-style DataFrame
and SQL API:

```python
from ballista import BallistaSessionContext

ctx = BallistaSessionContext("df://localhost:50050")
df = ctx.sql("select * from t limit 5")
df.show()
```

An optional Jupyter integration is available via `pip install "ballista[jupyter]"`, adding SQL magics, HTML
table rendering, and execution-plan visualization. The Python client remains pre-alpha; see the [PyPI page]
for current limitations.

[PyPI]: https://pypi.org/project/ballista/
[PyPI page]: https://pypi.org/project/ballista/54.0.0/

## Adaptive Query Execution

Adaptive Query Execution (AQE) was introduced experimentally in 53.0.0, with the scheduler re-running the
DataFusion physical optimizer between stages using statistics from completed stages. This release built on it
substantially.

- **Broadcast join in AQE.** The join decision is now delayed until runtime statistics are available, and a
  broadcast join can be chosen adaptively when the build side turns out to be small enough. Empty-join
  handling was also added, short-circuiting joins where an input stage produced no rows.
- **Remote object store support.** Adaptive planning previously failed against remote object stores with a
  "No suitable object store found" error, and now works with them.
- **Session state improvements.** Session state creation for the AQE planner was reworked, and several
  DataFusion physical rules that were not idempotent were backported so that repeated optimization between
  stages behaves correctly.
- **Chaos-monkey testing.** A fault-injection test harness was added for Ballista execution, exercising the
  adaptive path under induced failures.

AQE remains disabled by default and should still be considered experimental. Its current limitations are now
linked to their tracking issues, and the contributor guide has a new AQE section. Tracking work continues on
[issue #1359].

[issue #1359]: https://github.com/apache/datafusion-ballista/issues/1359

## Broadcast joins in the static planner

Alongside the adaptive path, the static (pre-execution) planner learned to broadcast small build sides:

- Small build sides are now broadcast via non-zero `CollectLeft` thresholds rather than always shuffling.
- The static planner can broadcast the small build side of a `SortMergeJoinExec`.

Both avoid unnecessary shuffles when one side of a join is small.

## Web rendering of the TUI

The Terminal User Interface that shipped in 53.0.0 now has a browser-based counterpart. It offers the same
views, all backed by the scheduler's REST API: executors, jobs, stages, tasks, plans, and metrics. This
release also brought a number of refinements to the UI:

- **Theming support**, including higher-contrast foreground colors for the dark theme.
- A **shimmer animation** for `Queued` and `Running` jobs.
- A **job configuration popup** and several **plan rendering formats** (logical, physical, and graph).
- **Failed job and failed task status** surfaced directly in the jobs view.

A nightly build of the Web TUI is deployed to nightlies.apache.org.

## Submitting a pre-built physical plan

The scheduler can now accept a pre-built physical plan directly via a new `submit_physical_plan` path. The
existing `submit_job` entry point is unchanged and non-breaking. A client can plan a query with DataFusion
and hand the finished physical plan to the cluster to execute, instead of submitting a logical plan for the
scheduler to plan. This is another step toward decoupling Ballista from any single client.

## Shuffle and executor improvements

Several changes landed in the shuffle subsystem and executor runtime:

- **Intermediate shuffle files are deleted on job success**, so completed jobs no longer leave shuffle data
  behind on disk.
- A **reduce-side in-flight governor** bounds shuffle fetch, limiting how much shuffle data an executor pulls
  concurrently so that shuffle-heavy plans don't overwhelm memory.
- **Read-side runtime state is shared across a session's tasks** on the executor, reducing per-task setup.
- **Partition pruning** skips irrelevant partitions during task execution.
- Executor task-execution errors and panics are now handled rather than crashing the executor, and task
  execution duration is logged in the "Finished task" message.

## REST API and observability

- A new **`/api/job/{job_id}/config`** endpoint exposes the session configuration a job was submitted with.
- **Failed tasks are surfaced** through both the REST API and the TUI.
- **Shuffle-read fetch metrics** were added, and per-operator metrics are now shown in the plan display.
  `ShuffleReaderExec` also displays its upstream stage id.

## Job lifecycle

When a job fails or is cancelled, the scheduler now **cancels the job's running stages and tasks** instead of
letting them run to completion. Combined with the shuffle-file cleanup above, this makes failure and
cancellation cleaner and less wasteful of cluster resources.

## Benchmarking and correctness

Benchmarking and testing became more rigorous in several ways:

- TPC-H benchmarks can now be run against **S3-compatible object storage**.
- A **TPC-H distributed plan-stability test suite** was added, with documented golden files and a
  regeneration process, so that changes to distributed planning are caught in review.
- CI now **verifies TPC-H query results against single-process DataFusion**, and runs TPC-H SF10 with AQE
  both off and on.

## Notable bug fixes

- **macOS Python wheel segfault.** mimalloc is now excluded from the Python wheel, fixing a segmentation
  fault on macOS.
- **Client session config overrides** (`datafusion.*`) are now honored during scheduler planning.
- An empty-projection serde ambiguity bug was fixed.

## What people are working on

Some of the open work most likely to land in upcoming releases:

- **Adaptive Query Execution** ([#1359]) — partition splitting for skewed shuffles, executor failure
  handling, and global LIMIT early-stop.
- **Cluster observability** ([#1426]) — exposing more runtime metrics through the REST API and producing
  per-stage flame graphs.
- **Colocated-join optimizer for hash-bucketed tables** ([#1677]) — Pinot-style optimization that avoids
  shuffles when both sides are pre-bucketed on the join key.
- **External remote shuffle services** ([#1539]) — investigating support for Apache Celeborn and Apache
  Uniffle as a shuffle backend.
- **Open table formats** ([#1241], [Iceberg #890]) — discussing a path to first-class support for Iceberg,
  Delta, and similar formats.

[#1359]: https://github.com/apache/datafusion-ballista/issues/1359
[#1426]: https://github.com/apache/datafusion-ballista/issues/1426
[#1677]: https://github.com/apache/datafusion-ballista/issues/1677
[#1539]: https://github.com/apache/datafusion-ballista/issues/1539
[#1241]: https://github.com/apache/datafusion-ballista/issues/1241
[Iceberg #890]: https://github.com/apache/datafusion-ballista/issues/890

A separate scaling effort is tracking the gap between Ballista on TPC-H at SF=100 (where it is competitive)
and SF=1000 ([#1596]), which is expected to surface bottlenecks in scheduler throughput, shuffle I/O, and
small-files handling.

[#1596]: https://github.com/apache/datafusion-ballista/issues/1596

## Roadmap

There is no formal long-term roadmap, but the rough direction continues to be:

1. **Close the gap between DataFusion and Ballista.** Anything that DataFusion can plan and execute on a
   single node should plan and execute on a Ballista cluster with the same APIs and the same SQL surface.
2. **Make Ballista boring to operate.** Predictable resource usage, good observability, sensible defaults,
   and robust error handling are higher priority than novel features.
3. **Land AQE.** A working adaptive planner unlocks optimizations that are difficult to express statically
   and is the foundation for tackling skew and dynamic partition coalescing.
4. **Improve scaling.** Identify and fix the bottlenecks that prevent Ballista from running large
   benchmarks like TPC-H at SF=1000.

Contributions in any of these areas are very welcome. Issues labeled [good first issue] are a good place
to start.

[good first issue]: https://github.com/apache/datafusion-ballista/issues?q=is%3Aopen+is%3Aissue+label%3A%22good+first+issue%22

## Thank You

This release is the result of work from 11 contributors. Thanks especially to Andy Grove, Martin Grigorov,
Marko Milenković, Bhargava Vadlamani, Jarro van Ginkel, Alexander Domenti, jgrim, Gunther Xing, and Jogesh A
Dinavahi, along with everyone who contributed by filing issues, reviewing PRs, and providing feedback. Full
details are in the [changelog].

Thanks also to the broader DataFusion community whose work Ballista builds on directly.

[changelog]: https://github.com/apache/datafusion-ballista/blob/54.0.0/docs/source/changelog/54.0.0.md
