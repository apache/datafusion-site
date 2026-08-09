---
layout: post
title: Apache DataFusion Ballista 54.1.0 Released
date: 2026-08-09
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

We are pleased to announce version [54.1.0] of [Apache DataFusion Ballista]. Ballista is a distributed query
execution engine that enhances [Apache DataFusion] by enabling parallel execution of workloads across multiple
nodes.

[54.1.0]: https://github.com/apache/datafusion-ballista/blob/54.1.0/docs/source/changelog/54.1.0.md
[Apache DataFusion Ballista]: https://datafusion.apache.org/ballista/
[Apache DataFusion]: https://datafusion.apache.org

This is a patch release, consisting of 10 commits from 3 contributors. It follows [54.0.0] and contains no
new features and no breaking changes — only an upgrade to DataFusion 54.1.0 and a set of bug fixes
backported from `main`. Users running 54.0.0 are encouraged to upgrade.

[54.0.0]: /blog/2026/07/12/datafusion-ballista-54.0.0/

## Upgrade to DataFusion 54.1.0

Ballista 54.1.0 is built on DataFusion 54.1.0, picking up the fixes in that patch release. No API changes
were required, so the [54.0.0 upgrade guide] still applies for anyone moving from an earlier release.

[54.0.0 upgrade guide]: https://datafusion.apache.org/ballista/upgrading/54.0.0.html

## Cluster stability fixes

Three fixes address problems that only appear in a real multi-node deployment:

- **Executor client pool enabled by default.** The executor's `client_ttl` defaulted to `0`, which disabled
  the gRPC client pool entirely. Without a pool, the shuffle-read path opened and discarded a TCP connection
  per fetch, so a single shuffle-heavy query could exhaust the host's ephemeral ports and fail with
  `AddrNotAvailable` — as would every query after it, until those sockets left `TIME_WAIT`. A single-executor
  cluster never showed this, because shuffle reads are served from local files. `client_ttl` now defaults to
  30 seconds, so the pool is on unless explicitly disabled.
- **Executor startup race.** The executor spawned its gRPC server and registered with the scheduler
  immediately afterwards, but the socket was not bound yet when the scheduler dialed back. Losing that race
  produced `ECONNREFUSED`, a failed registration, and an executor that died at startup. The listener is now
  bound before registration can run.
- **Executor shutdown.** The shutdown notification is now sent before the notifier is dropped, so a graceful
  shutdown is actually observed by the components waiting on it.

## Task retry and shuffle memory

- **Retryable IO errors on a join's build side.** A retryable IO error raised on a join's shared build side
  arrives at the failed-task classifier wrapped in `DataFusionError::Shared`, so a match on the outermost
  variant never saw the underlying `IoError` and the task was marked non-retryable. Classification now
  operates on the root error, regardless of wrapping.
- **Sort shuffle writer respects memory pool pressure.** The sort shuffle writer discarded the result of
  `try_grow` on its memory reservation, so a rejected grow produced no spill: the batch stayed buffered while
  the shared `MemoryPool` had not accounted for it, and other consumers saw memory as free that was not. A
  rejected grow is now treated as a spill trigger alongside the existing per-task budget.

## Planning correctness

- **`GROUP BY`-less aggregates are preserved** when the scheduler propagates empty stages, so a query whose
  input produces no rows still returns the correct single-row aggregate result rather than nothing.
- **`EmptyExec` partition counts survive stage serialization**, fixing plans whose partitioning changed as a
  stage was sent to an executor.
- **Task partitions are mapped through `UnionExec`** when restricting file scans, so each task scans the
  files it was assigned.
- **`SortMergeJoinExec` broadcast conversion is now disabled by default.** The static-planner optimization
  that broadcasts the small build side of a sort-merge join, added in 54.0.0, is opt-in in this release while
  outstanding issues are resolved.

## Thank You

Thanks to Andy Grove, Alexander Domenti, and goingforstudying-ctrl for the commits in this release, and to
everyone who contributed by filing issues, reviewing PRs, and providing feedback. Full details are in the
[changelog].

[changelog]: https://github.com/apache/datafusion-ballista/blob/54.1.0/docs/source/changelog/54.1.0.md
