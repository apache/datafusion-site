---
layout: post
title: Apache DataFusion Comet 1.1.0 Release
date: 2026-09-25
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

The Apache DataFusion PMC is pleased to announce version 1.1.0 of the [Comet](https://datafusion.apache.org/comet/) subproject.

Comet is an accelerator for Apache Spark that translates Spark physical plans to DataFusion physical plans for
improved performance and efficiency without requiring any code changes.

This release covers roughly seven weeks of development since 1.0.0 and consists of 333 commits from 37
contributors. See the [change log] for the full list of changes.

[change log]: https://github.com/apache/datafusion-comet/blob/main/docs/source/changelog/1.1.0.md

## Native Iceberg Writes (Experimental)

Every Comet release up to now has accelerated the read side of an Iceberg workload while leaving writes
entirely to the JVM. 1.1.0 changes that: Comet can now write Iceberg data files natively, through
[iceberg-rust](https://github.com/apache/iceberg-rust), inside its existing native execution pipeline. The
feature is **experimental and disabled by default**, and the rest of this section explains both what it does
and the fairly strict conditions under which it will engage.

### The problem: one operator, no AQE

Spark writes an Iceberg table through a single physical operator that combines data-file writing with
metadata writing, committing, and catalog validation. Because that operator sits outside Spark's Adaptive
Query Execution, the sub-query feeding the write — the scans, projects, sorts, and exchanges producing the
rows — cannot be re-planned at runtime. It is also opaque to Comet's columnar rules, so the write itself was
never a candidate for native execution.

### Step one: split the write operator

The first half of the work splits that operator in two. With
`spark.comet.write.iceberg.splitOperator.enabled=true`, Comet rewrites eligible Iceberg writes into:

1. **`IcebergWrite`** — writes the data files on the executors and returns each task's serialized commit
   message. This operator, and the sub-query feeding it, run inside AQE.
2. **`IcebergCommit`** — collects the commit messages on the driver and performs the normal Iceberg commit,
   including commit-time validation, outside AQE, exactly once.

On its own this toggle changes nothing about who writes the bytes — data files are still written by
iceberg-java. What it buys is that the write's input becomes visible to AQE and to Comet's columnar rules,
and it creates the seam that the native writer plugs into.

The split plan covers `INSERT INTO` / DataFrame `append`, static and dynamic `INSERT OVERWRITE`, and
copy-on-write `DELETE` / `UPDATE` / `MERGE`, on every Spark version Comet supports. Merge-on-read delta
writes are not intercepted. When the rewrite is skipped — an unrecognized write class, a CTAS on Spark 3.4,
a write requiring Spark's commit coordinator — the write is planned exactly as if Comet were absent.

### Step two: write the Parquet files natively

With `spark.comet.iceberg.write.enabled=true`, the `IcebergWrite` operator's per-task Parquet write is
delegated to iceberg-rust. The JVM-side planner marshals everything the native writer needs into the
serialized plan: the write schema and partition spec as JSON, the data location, resolved Parquet writer
settings, the writer mode (unpartitioned, fanout, or clustered, mirroring `SparkWrite`'s own choice),
object-store configuration, and per-task IDs. On each task, iceberg-rust writes the Parquet files and returns
its `DataFile` metadata packed as a single in-memory Iceberg V2 data manifest.

Everything after that point is deliberately left to iceberg-java. The JVM decodes the manifest bytes with
Iceberg's own `ManifestFiles.read`, re-derives each file's manifest metrics from the written Parquet footer
using Iceberg's `MetricsConfig` logic, and wraps the result in the same `TaskCommit` message the JVM writer
would have produced. Snapshot assignment, manifest-list aggregation, commit validation, and retries are
untouched.

### Fidelity as a design constraint

The native writer has to produce the same outcome as iceberg-java, not merely a valid Iceberg table, and the
design leans hard in that direction.

Manifest metrics drive partition- and file-level pruning for every future reader of the table, so a
divergence there would outlive the write. Rather than trusting what the native writer reports, Comet
re-derives metrics on the JVM from each file's Parquet footer through iceberg-java's own
`ParquetUtil.footerMetrics` and `MetricsConfig.forTable`. Metrics modes, bound truncation, the inferred-column
cap, and list/map bounds suppression are therefore iceberg-java's code making iceberg-java's decisions, and
the parity suite compares committed manifests byte-for-byte against JVM-written ones. The cost is one
footer-sized ranged read per written file.

Eligibility detection is an allowlist, not a denylist. A write is eligible only when its entire effective
configuration matches a documented table of supported settings — and anything else, including any
write-affecting property added by a future Iceberg version, any value outside the supported set, or any
reflection failure while inspecting the write, falls back to iceberg-java with the reason reported in Comet's
extended `EXPLAIN` output. Encryption keys, object-storage layout, custom location providers, bloom filters,
and unvetted `parquet.*` properties all decline the native path. The plan feeding the write must also be
fully Comet-native, which for a partitioned table includes the hash distribution and local sort Iceberg
requests on its partition transforms — those stay native because the Iceberg system functions now have native
implementations (see below).

Eligibility is decided entirely at plan time, including the reflection surface: every iceberg-java class and
method the executor-side commit assembly needs is eagerly resolved on the driver, so an Iceberg release that
moves any of them declines the native path rather than failing tasks mid-write.

### Failures never commit partial results

The commit set is exactly the commit messages returned by successful tasks. A failed task contributes none
and deletes the data files it created, as iceberg-java's writer abort does; ownership of those files is
handed from the native side to a JVM task-failure listener at a well-defined point, so a failure on either
side of the boundary still cleans up. If the job fails, the driver-side commit operator aborts without
committing anything and deletes the completed tasks' files through the table `FileIO`. Task retries cannot
collide, because each attempt's task attempt id is embedded in its data file names. Anything a best-effort
deletion misses is invisible to readers, which resolve files through committed manifests only, and is
reclaimed by Iceberg's normal `remove_orphan_files` maintenance.

### Accepted divergences

A handful of differences between parquet-mr and parquet-rs are unconditional, and enabling the toggle accepts
them. They are almost entirely cosmetic — footer key-value metadata, the root schema element name,
`created_by`, absent page CRCs and page-header statistics, `RLE_DICTIONARY` labeling, compressed page bytes —
and none change what a reader computes. Two are worth knowing about operationally:

- **File rolling lands on the same 1000-row grid as iceberg-java, but not necessarily on the same row.** Both
  writers re-check file size against `write.target-file-size-bytes` every 1000 rows, but they compare
  different size estimates, so nothing bounds how far apart their roll points are. Do not rely on file-layout
  parity between the two writers.
- **Float and double partition directory names** are rendered with Rust's shortest representation rather than
  `Float.toString` (`f=1` where iceberg-java writes `f=1.0`). Distinct values still get distinct directories,
  and no reader parses these names. Iceberg deprecated float and double partitioning in 1.3.

The [Iceberg Writes guide] documents the full eligibility table and every accepted divergence. Please try it
on a non-production table and tell us what you find — feedback from real workloads is exactly what this
feature needs before it can lose the experimental label.

[Iceberg Writes guide]: https://datafusion.apache.org/comet/user-guide/latest/iceberg-writes.html

## More Iceberg Improvements

The read side gained several things in this release too:

- **Iceberg V3 deletion vectors** are now applied on native scans.
- **Iceberg system functions** — `bucket`, `truncate`, `years`, `months`, `days`, and `hours` — have native
  implementations. Besides being faster, this is what keeps a partitioned table's write plan fully native and
  therefore eligible for the native writer.
- **Scan planning metrics and scan time** are reported in the Spark UI for the native Iceberg scan.
- Fixes for tables partitioned by an unknown transform, complex null checks on native scans, and Iceberg
  system functions wrapped as `ApplyFunctionExpression`.

## Native Parquet Writes on Spark 4.0+

Separately from Iceberg, 1.1.0 hooks native Parquet writes into Spark's `WriteFilesExec` seam on Spark 4.0 and
later, behind `spark.comet.parquet.write.enabled`. This release also preserves Catalyst nullability and field
IDs in native Parquet writes.

## Remote Shuffle with Celeborn

Applications using Apache Celeborn can now use Comet's composite shuffle manager to run Comet's **native**
shuffle over Celeborn, rather than falling back to ordinary Spark/Celeborn shuffle for every exchange. This
landed as a series of changes adding an RSS partition writer, task-owned JNI callbacks, destination-aware
native shuffle execution, the map-side push lifecycle, a raw native shuffle reader, and native-only planning.

Native shuffle over Celeborn requires an explicit `spark.comet.shuffle.mode=native`; the default `auto` mode
retains ordinary Spark/Celeborn shuffle. It also requires a Celeborn client that provides a safe
push-completion API — released 0.6.0 and 0.7.0 clients do not, and those versions retain ordinary shuffle even
in native mode. Native RSS does not support `spark.io.encryption.enabled=true`. Celeborn is an optional
application dependency and is not bundled with Comet. See the [tuning guide] for the full set of
requirements and the frame-size and in-flight-bytes knobs.

[tuning guide]: https://datafusion.apache.org/comet/user-guide/latest/tuning.html

## Performance

### Shuffle

Several changes target shuffle, which dominates many TPC-DS-shaped workloads:

- A task now spills **every shuffle partition into one file** instead of one file per partition.
- **Zstd compression contexts and Arrow IPC contexts are reused** across shuffle blocks instead of being
  rebuilt per block.
- Shuffle blocks are **decoded against a cached schema** rather than re-parsing the schema per block, and
  expected schemas are cached for remote shuffle decoding.
- Per-partition scratch buffers are reused in the shuffle write path.
- `ArrowWriter` bulk-copies fixed-width columns.

### Planning and Execution

- **Native dynamic filter pushdown** from hash joins into Parquet scans.
- **Adaptive partial aggregation** is enabled for eligible native shuffle plans.
- **Parsed plan data is cached across the tasks of a stage**, avoiding repeated deserialization work.
- **Native Parquet scan I/O and read-amplification metrics** are exposed, alongside native aggregate spill and
  memory metrics.

### Expression Kernels

Ongoing kernel-level work continued across the expression library: `map_sort` is up to 3x faster for
multi-entry string maps and 18x faster on singleton normalization; the native map lookup behind `element_at`
and `GetMapValue` is vectorized; `collect_list` and `collect_set` gained a native `GroupsAccumulator`; user
regex patterns are compiled once per planned expression; `hour`/`minute`/`second` and `dayofweek`/`weekday`
skip calendar reconstruction; `posexplode` array expressions are evaluated once per batch; unnesting slices
the child rather than gathering it; and the nested-element list hash is batched for flat struct elements.

## Memory Observability

Two features make Comet's memory use easier to reason about: **native allocation accounting**, and **tracing
of Arrow memory held on the JVM side**. Together they close a long-standing gap where memory held by the
native engine and by Arrow buffers on the JVM was hard to attribute when diagnosing executor OOMs.

## Expanded Coverage

New expression and operator support in this release includes the `mode` aggregate, `max_by` / `min_by`, the
`regr_slope` / `regr_intercept` / `regr_r2` / `regr_sxx` / `regr_syy` / `regr_sxy` regression aggregates,
`WindowGroupLimitExec`, `explode_outer`, `make_interval`, a native `spark_sequence` kernel for integral
element types, a native `spark_unbase64` kernel, `_metadata` constant columns in the native Parquet scan,
nested types as native shuffle hash partitioning keys, `BinaryType` for sort-merge join, and Spark 4's
`EmptyRelationExec` as a native input. Several more expressions — `translate`, `to_csv`, `encode`, `lpad` /
`rpad`, `round` on float/double, `abs` on intervals, `timestampadd` / `timestampdiff`, `next_day` and
`levenshtein` on collated input, and unrecognized `StaticInvoke` / `Invoke` — are now routed through codegen
dispatch by default, and `rlike` runs natively by default for Java-equivalent literal patterns.

Spark 4 **Variant** support advanced as well, with Parquet storage adapted for Variant projection, Variant
arrays normalized at the native Parquet boundary, and `VariantType` identity carried through schema
serialization.

This release also adds **experimental native support for an in-memory cache**
(`spark.comet.exec.inMemoryCache.enabled`, disabled by default), support for **S3-compliant filesystems**, and
build gates for contrib **Delta** and **Lance** scans.

## Deprecations and Removals

- **JDK 11 support has been removed**, as announced in the 1.0.0 release. Comet 1.1.0 requires JDK 17 or
  later.
- **Apache Spark 3.4 remains deprecated.** Comet continues to build and publish Spark 3.4 binaries, but
  Spark's own SQL test suite no longer runs against Spark 3.4 on every change, so Spark 3.4-specific
  regressions are more likely to reach a release. We recommend moving to Spark 3.5 or later.

## Compatibility

Supported platforms include:

- **Spark 3.4.3** with Java 17 and Scala 2.12/2.13 (deprecated)
- **Spark 3.5.9** with Java 17 and Scala 2.12/2.13
- **Spark 4.0.4** with Java 17 and Scala 2.13
- **Spark 4.1.3** with Java 17/21 and Scala 2.13
- **Spark 4.2.0** with Java 17 and Scala 2.13 (experimental, for early evaluation only)

See the [Spark Version Compatibility] page for known limitations specific to each version.

[Spark Version Compatibility]: https://datafusion.apache.org/comet/user-guide/latest/compatibility/spark-versions.html

This release builds on **DataFusion 55.1** and **Arrow 59.2**.

## Get Started with Comet 1.1.0

Ready to try it out? Follow the [Comet 1.1.0 Installation Guide](https://datafusion.apache.org/comet/user-guide/1.1/installation.html)
to get up and running, then point Comet at your existing Spark workloads and see the speedup for yourself.
