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
and brings major improvements to adaptive planning, SQL connectivity, observability, and distributed
execution.

[54.1.0]: /blog/2026/08/09/datafusion-ballista-54.1.0/

## Adaptive Query Execution by default

Adaptive Query Execution (AQE) is now enabled by default. Ballista can use runtime statistics from completed
stages to choose join strategies and remove redundant shuffles. Broadcast thresholds are now applied
consistently by both the adaptive and static planners, and join build sides can be staged before the scheduler
makes its final decision.

## Flight SQL and ADBC

The scheduler now provides an [Arrow Flight SQL] frontend, allowing applications and tools to connect through
the standard [ADBC] interface. Ballista also detects incompatible major versions between clients and the
scheduler and reports a clear error instead of attempting an unsafe connection.

[Arrow Flight SQL]: https://arrow.apache.org/docs/format/FlightSql.html
[ADBC]: https://arrow.apache.org/adbc/

## History and observability

A new history server reads per-job event logs written by the scheduler, making completed jobs available for
later inspection. The scheduler REST API is now documented with OpenAPI and serves its specification at
`/api/openapi.json`. Scheduler REST and gRPC responses also include the Ballista version.

## Distributed windows and range shuffles

Ballista 55.0.0 adds range-partitioning primitives and an ordering-preserving range shuffle. These support
parallel execution of `UNBOUNDED PRECEDING` window aggregates and avoid reading shuffle data outside a
consumer's assigned range.

## Runtime and shuffle improvements

Executors now use a bounded, automatically sized memory pool by default. Shuffle-heavy workloads benefit from
zero-copy remote block receives, one sort-shuffle file per task, reused partition-index buffers, and fewer
unnecessary sorts and encodings. The scheduler also shares file-statistics caches across sessions and keeps
executor heartbeats active while all vcores are busy.

## Thank You

Thank you to everyone who contributed code, reviews, bug reports, and feedback. See the [changelog] for the
complete list of changes and contributors.

[changelog]: https://github.com/apache/datafusion-ballista/blob/55.0.0/docs/source/changelog/55.0.0.md
