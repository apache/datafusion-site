---
layout: post
title: Apache DataFusion Comet 0.16.0 Release
date: 2026-05-07
author: pmc
categories: [subprojects]
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

The Apache DataFusion PMC is pleased to announce version 0.16.0 of the [Comet](https://datafusion.apache.org/comet/) subproject.

Comet is an accelerator for Apache Spark that translates Spark physical plans to DataFusion physical plans for
improved performance and efficiency without requiring any code changes.

This release covers approximately three weeks of development work and is the result of merging 115 PRs from 17
contributors. See the [change log] for more information.

[change log]: https://github.com/apache/datafusion-comet/blob/main/dev/changelog/0.16.0.md

## Expanded Spark 4 Support

Spark 4 is a major theme of this release. Comet now ships first-class support for both Spark 4.0.2 and
Spark 4.1.1, with dedicated Maven profiles, shim sources, and CI matrices for each.

- **Spark 4.1.1**: New `spark-4.1` Maven profile and shim sources, with Comet's PR test matrix and Spark SQL
  test suites enabled against Spark 4.1.1. The default Maven profile has been updated to Spark 4.1 / Scala 2.13
  to reflect that this is now the primary development target.
- **Shared 4.x shims**: Identical pieces of the Spark 4.0 and 4.1 shims have been consolidated into a shared
  `spark-4.x` source tree, reducing duplication as more 4.x minor versions land.
- **Spark 4.0 / JDK 21**: Added a Spark 4.0 / JDK 21 CI profile to validate Comet on the JDK most users are
  expected to deploy with Spark 4.

### Adapting to Spark 4 Behavior Changes

Spark 4 introduced a number of type, planner, and on-disk format changes relative to Spark 3.x. Several
correctness fixes this cycle bring Comet's behavior in line with these changes:

- **`Variant` type (new in Spark 4.0)**: Spark 4.0 added a new `Variant` data type for semi-structured
  data. Comet does not yet read the shredded Variant on-disk format natively, and delegates these scans
  to Spark.
- **String collation (new in Spark 4.0)**: Spark 4.0 added collation support for `StringType`. Comet's
  native operators do not yet implement non-default collations, so hash join and sort-merge join reject
  collated string join keys, and shuffle, sort, and aggregate fall back to Spark when keys carry a
  non-default collation.
- **Wider `TimestampNTZType` usage**: Spark 4 uses `TimestampNTZType` (timestamp without time zone) in
  more places than 3.x — for example, in expression return types and as the inferred type for some
  literal forms. Comet adds support this cycle for cast to and from `timestamp_ntz`, cast from string to
  `timestamp_ntz`, and `unix_timestamp` over `TimestampNTZType` inputs.
- **DSv2 scalar subquery pushdown ([SPARK-43402](https://issues.apache.org/jira/browse/SPARK-43402))**:
  Spark extended scalar subquery pushdown and reuse to V2 file scans. `CometNativeScanExec` now
  participates in this pushdown so DSv2 plans benefit from the same subquery reuse as Spark's own scan.
- **`to_json` and `array_compact` (Spark 4.0)**: Spark 4.0 adjusted output formatting and return-type
  metadata for these expressions; Comet now matches the new behavior.
- **BloomFilter V2 (new in Spark 4.1)**: Spark 4.1 introduced a new BloomFilter binary format with
  different bit-scattering. Comet now reads this format so that runtime filters produced by Spark 4.1
  remain usable in native execution.
- **Spark 4.1.1 analyzer refinements**: Spark 4.1.1 changed how struct projections handle the case where
  every requested child field is missing from the Parquet file, and how `allowDecimalPrecisionLoss`
  flows through the `DecimalPrecision` rule. Comet now preserves parent-struct nullness in the first
  case and the stored `allowDecimalPrecisionLoss` flag in the second.

Most of these behavior differences were caught because **Comet runs the full Apache Spark SQL test suite
against each supported Spark version** — 3.4.3, 3.5.8, 4.0.2, and 4.1.1 — as part of CI. Running Spark's
own correctness tests through Comet's native execution path is what surfaces semantic shifts like
`TimestampNTZType` propagation, ANSI-driven cast and overflow changes, BloomFilter V2 encoding, and the
4.1.1 analyzer rule changes, often before they show up in user workloads. As more Spark 4.x minor releases
land, this same harness is what gives us confidence that Comet keeps up.

### ANSI SQL Semantics

Spark 4 enables ANSI SQL semantics by default. ANSI mode changes how arithmetic overflow, invalid casts,
division by zero, and similar error conditions are handled, and Spark itself now treats this as the standard
configuration rather than an opt-in.

This is a critical area for any Spark accelerator: an engine that falls back to vanilla Spark whenever ANSI is
enabled effectively does not run on Spark 4 by default. **Comet implements ANSI semantics for the expressions
it supports natively**, including arithmetic overflow checks, ANSI cast behavior, and `try_*` variants.
Queries running with `spark.sql.ansi.enabled=true` continue to be accelerated rather than falling back.

See the [Comet Compatibility Guide] for details on which expressions have full ANSI coverage, and the
[ANSI mode tracking issue](https://github.com/apache/datafusion-comet/issues/313) for ongoing work to extend
coverage further.

[Comet Compatibility Guide]: https://datafusion.apache.org/comet/user-guide/latest/compatibility/index.html

## Dynamic Partition Pruning for Native Parquet Scans

Comet 0.15.0 introduced Dynamic Partition Pruning (DPP) for the native Iceberg reader. Comet 0.16.0 extends
DPP support across the rest of Comet's native scan paths, making it the default for the workloads most users
actually run.

- **Non-AQE DPP for native Parquet scans** ([#4011](https://github.com/apache/datafusion-comet/pull/4011)):
  DPP filters derived from broadcast subqueries are now honored by Comet's native Parquet scan, with broadcast
  exchanges reused across the DPP subquery and the join.
- **AQE DPP for native Parquet scans** ([#4112](https://github.com/apache/datafusion-comet/pull/4112)):
  When Adaptive Query Execution is enabled, broadcast reuse for DPP subqueries is wired through the AQE
  re-planning path so DPP pruning fires after AQE rewrites the plan.
- **AQE DPP broadcast reuse for native Iceberg scans** ([#4215](https://github.com/apache/datafusion-comet/pull/4215)):
  Brings the same AQE-aware broadcast reuse to the native Iceberg reader, completing DPP coverage across
  Comet's native scan implementations.

For star-schema-style workloads, DPP can substantially reduce I/O by pruning fact-table partitions based on
filters applied to dimension tables at runtime. With this release, those benefits apply uniformly whether the
underlying table is Parquet or Iceberg, and whether or not AQE is enabled.

A number of previously-skipped DPP tests have been re-enabled this cycle as the implementation matured,
including non-AQE DPP test cases and the `DynamicPartitionPruning` static-scan-metrics test.

## Other Key Features

### Hash Join Improvements

- **`BuildRight` + `LeftAnti`** ([#4073](https://github.com/apache/datafusion-comet/pull/4073)): Regular hash
  joins now support the `BuildRight` + `LeftAnti` combination, eliminating a common fallback path. Tests
  previously gated on `InjectRuntimeFilterSuite` issues have been re-enabled.

### Aggregation

- **`PartialMerge` aggregation mode** ([#4003](https://github.com/apache/datafusion-comet/pull/4003)): The
  `PartialMerge` mode is now executed natively, allowing more multi-stage aggregation plans to remain in
  Comet without falling back to Spark.
- **`collect_set`** ([#3954](https://github.com/apache/datafusion-comet/pull/3954)): Native support for the
  `collect_set` aggregate.

### New Expression Support

This release adds native support for the following Spark expressions:

- **Math**: `Pi`, `Cbrt`, `Acosh`, `Asinh`, `Atanh`, `ToDegrees`, `ToRadians`
- **Date/time**: `timestamp_seconds`, `unix_timestamp` with `TimestampNTZType`
- **String / URL**: `url_encode`, `url_decode`, `try_url_decode`, `str_to_map`
- **Array / map**: `arrays_zip`, `array_position`, `array_union`, `array_distinct`, `arrays_overlap`,
  `MapSort` (Spark 4.0)
- **Cast**: string to `timestamp_ntz`, cast to and from `timestamp_ntz`

`array_insert` and `array_compact` have been audited and promoted to `Compatible`.

### Object Storage

- **OpenDAL 0.56.0**: Picks up the latest OpenDAL release, including upstream object-store fixes.
- **Profile credential chain**: `ProfileCredentialsProvider` is now mapped to the AWS profile credential
  chain, matching the credential resolution behavior users expect.

### Native Scan Improvements

- **Parquet field ID matching**: The `native_datafusion` scan now supports field-ID-based column resolution,
  matching Spark's behavior for files written with field IDs.
- **Schema-mismatch errors**: `native_datafusion` now throws `SchemaColumnConvertNotSupportedException` on
  schema mismatch, allowing Spark's standard error handling to engage.
- **Stricter type validation**: The `native_datafusion` scan now detects incompatible decimal precision/scale
  and string/binary columns read as numeric, and delegates these reads to Spark.

### Metrics and Observability

- **Spark UI task output metrics**: Native execution now reports task output metrics through the standard
  Spark UI path.
- **Iceberg input metrics**: Task-level `bytesRead` is now reported for the Iceberg native scan, matching
  Comet's native Parquet scan.
- **Shuffle encode time**: Shuffle operations now track encode time as a separate metric, making it easier
  to attribute shuffle cost.

## Stability and Correctness

- **Substring with negative start index**: Fixed a Spark-incompatibility in `substring` for negative indices.
- **Strict floating-point comparison**: `RangePartitioning` now honors `strictFloatingPoint`, ensuring NaN
  and ±0.0 are partitioned consistently with Spark.
- **Broadcast / AQE coalescing**: Broadcast exchanges now bypass AQE partition coalescing, fixing plans that
  could otherwise be coalesced into invalid shapes.
- **JNI local frames**: JNI local frame management has been hardened with explicit error handling.
- **Shuffle fallback logic**: Shuffle fallback decisions have been improved, with a new config to gate
  conversion of Spark shuffle to Comet shuffle when the child plan is non-Comet, and a fix to avoid
  redundant columnar shuffle when both parent and child are non-Comet.

## Compatibility

Supported platforms include:

- **Spark 3.4.3** with Java 11/17 and Scala 2.12/2.13
- **Spark 3.5.8** with Java 11/17 and Scala 2.12/2.13
- **Spark 4.0.2** with Java 17 and Scala 2.13
- **Spark 4.1.1** with Java 17 and Scala 2.13

See the [Spark Version Compatibility] page for known limitations specific to each version.

[Spark Version Compatibility]: https://datafusion.apache.org/comet/user-guide/latest/compatibility/spark-versions.html

This release continues to build on **DataFusion 53.1** and **Arrow 58.1**.

## Get Started with Comet 0.16.0

Ready to try it out? Follow the [Comet 0.16.0 Installation Guide](https://datafusion.apache.org/comet/user-guide/0.16/installation.html)
to get up and running, then point Comet at your existing Spark workloads — including Spark 4 with ANSI mode
enabled — and see the speedup for yourself.
