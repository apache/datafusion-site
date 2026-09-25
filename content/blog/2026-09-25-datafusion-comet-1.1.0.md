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

This release covers roughly seven weeks of development since 1.0.0 and consists of 379 commits from 40
contributors. See the [change log] for the full list of changes.

[change log]: https://github.com/apache/datafusion-comet/blob/main/docs/source/changelog/1.1.0.md

Two themes dominate this release. The first is **native Iceberg writes**, an experimental feature that lets
Comet write Iceberg data files through iceberg-rust instead of iceberg-java. The second is a thorough rework of
**memory management**: Comet can now measure the native memory its pools never see, reports it on every
executor, and fixes several long-standing bugs in how its pools account for what they do see.

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

The native writer reads its input as Arrow batches from a Comet operator, so the write's input must itself
run in Comet. Writes fed by a local relation, such as `INSERT ... VALUES` or a DataFrame built from local data,
also need `spark.comet.exec.localTableScan.enabled=true`; without it they run through iceberg-java even with
both write flags on.

### Fidelity as a design constraint

The native writer has to produce the same outcome as iceberg-java, not merely a valid Iceberg table, and the
design leans hard in that direction.

Manifest metrics drive partition- and file-level pruning for every future reader of the table, so a
divergence there would outlive the write. Rather than trusting what the native writer reports, Comet
re-derives metrics on the JVM from each file's Parquet footer through iceberg-java's own
`ParquetUtil.footerMetrics` and `MetricsConfig.forTable`. Metrics modes, bound truncation, the inferred-column
cap, and list/map bounds suppression are therefore iceberg-java's code making iceberg-java's decisions. Parity
tests write the same rows through both writers and compare the committed value, null, and NaN counts and the
lower and upper bounds. The cost is one footer-sized ranged read per written file.

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

Beyond Comet's own suites, CI now runs Apache Iceberg's Spark test suites, for Iceberg 1.8.1 through 1.11.0,
with the native writer enabled in every Comet-configured session.

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
them. Most are cosmetic — footer key-value metadata, the root schema element name, `created_by`, absent page
CRCs and page-header statistics, `RLE_DICTIONARY` labeling, compressed page bytes — and none change what a
reader computes. Two are worth knowing about operationally:

- **File rolling lands on the same 1000-row grid as iceberg-java, but not necessarily on the same row.** Both
  writers re-check file size against `write.target-file-size-bytes` every 1000 rows, but they compare
  different size estimates, so nothing bounds how far apart their roll points are. Do not rely on file-layout
  parity between the two writers.
- **High-cardinality columns keep a dictionary page.** parquet-mr abandons dictionary encoding for a column
  chunk early when the dictionary is not saving space; parquet-rs keeps it until the dictionary reaches
  `write.parquet.dict-size-bytes` and then switches to plain encoding. Results are identical, but a selective
  read of a native-written file fetches that dictionary page for every column chunk it touches
  ([#6114](https://github.com/apache/datafusion-comet/issues/6114)).

The [Iceberg Writes guide] documents the full eligibility table and every accepted divergence. Please try it
on a non-production table and tell us what you find — feedback from real workloads is exactly what this
feature needs before it can lose the experimental label.

Thanks to [@jordepic] for designing and implementing the split-operator plan, write detection, and the native
writer, and to [@andygrove] for the fidelity and failure-handling work, with contributions from
[@zhangfengcdt], [@snmvaughan], and [@0lai0], and reviews from [@sunchao], [@comphead], [@unikdahal], and
[@mbutrovich]. Related PRs: [#4658], [#5298], [#5361], [#5663], [#5780].

[Iceberg Writes guide]: https://datafusion.apache.org/comet/user-guide/latest/iceberg-writes.html

## Memory Management

A recurring operational problem for Comet users has been executors killed by the cluster manager
(on Kubernetes, `ExecutorLostFailure` with exit code 137) even though Comet stayed within its configured memory
pool. 1.1.0 explains why that happens, gives every executor a way to measure it, and fixes the pool bugs that
made it worse.

### Reserved memory is a lower bound

Comet's native operators allocate from the Rust heap, but every reservation they make is charged against
Spark's off-heap pool, sized by `spark.memory.offHeap.size`. The pool only tracks memory that an operator
explicitly reserves, which in practice means the batches an operator deliberately accumulates: the sort
buffer, the build side of a hash join, hash aggregation state, and the shuffle writer's buffered partitions.

A great deal of allocation never goes through a reservation: per-batch working memory in expression kernels
and Arrow builders, decompression buffers, Parquet reader structures, object store request buffers, the async
runtime, Arrow buffers allocated on the JVM side, and allocator overhead such as fragmentation and retained
pages. Reserved memory is therefore a lower bound on what Comet really uses, and that untracked remainder has
to fit in `spark.executor.memoryOverhead`. Until now there was no way to see how large it was, so sizing the
overhead meant guessing.

### Measuring the gap: native allocation accounting

1.1.0 wraps Comet's global allocator — jemalloc, mimalloc, or the system allocator, whichever the build selects —
in an accounting layer that maintains a single process-wide count of native bytes allocated and not yet freed.
It is observability only: it never rejects an allocation and never touches the memory pool. Per-thread deltas
are batched and flushed into the shared counter every 64 KiB, so the common path is a thread-local add rather
than an atomic operation.

The accounting layer is always on. It makes a single thread-local access per allocation and free, and costs
about 2% on TPC-H SF100 Q21, an allocation-heavy query. Further reduction is tracked in
[#6213](https://github.com/apache/datafusion-comet/issues/6213).

The JVM side got the same treatment. Arrow buffers that Comet imports from native code are now held in a
dedicated child allocator, so tracing can separate Arrow memory the JVM allocated itself from native memory
that is merely referenced from the JVM and already counted by the accounting layer.

### An executor memory log for sizing overhead

With the allocation count available, each executor now logs its native memory usage at INFO level, one line
every 10 seconds for the whole executor while Comet native plans run:

```
Comet native memory usage: allocated 5412.3 MiB, reserved 3890.0 MiB (16 native plans, 8 memory pools)
```

`reserved` is what Comet's pools track, and it already has room in the container because it is charged
against `spark.memory.offHeap.size`. `allocated` is everything Comet's native code holds. The difference is the
untracked native memory that has to fit in `spark.executor.memoryOverhead`, alongside the JVM's own non-heap
memory. To size the overhead, run a representative workload, find the line with the largest difference, add it
to the overhead the executors had before Comet was enabled, and add a margin. The interval is controlled by
`spark.comet.memory.logInterval`, and setting it to `1s` for a sizing run makes a short-lived peak less likely
to fall between samples.

The executor also logs a warning when its native memory looks larger than its container allows, and the
[tuning guide] walks through the sizing procedure with worked examples for small and large executors. One
detail there is worth repeating: setting `spark.executor.memoryOverhead` _replaces_ the value Spark derives from
`spark.executor.memoryOverheadFactor` rather than adding to it, so on a large executor a fixed value can shrink
the container. For large executors, raising the factor is usually the better choice.

[tuning guide]: https://datafusion.apache.org/comet/user-guide/latest/tuning.html#memory-tuning

In 1.0.0, the driver plugin tried to raise `spark.executor.memoryOverhead` on the user's behalf, but that
adjustment could not reach the container on most supported Spark versions and has been removed. The driver now
warns when neither `spark.executor.memoryOverhead` nor `spark.executor.memoryOverheadFactor` is set, except in
local mode.

### Memory pool fixes

Several bugs in the pools themselves are fixed in this release:

- **`fair_unified` capped a whole task at one consumer's share.** Since Comet 0.15.0, the pool compared the
  task's total reservations against `pool_size / num_consumers`, so every operator in a task shared what should
  have been one operator's allowance, and each new consumer tightened the limit on the ones already running.
  Each consumer is now checked against its own share, with sibling reservations from one operator charged to
  that operator's share, and the pool total is still bounded by the pool size. Tasks with several operators can
  now reserve more memory before spilling than they could in 0.15.0 through 1.0.0 — see the upgrade notes below.
- **A partial grant from Spark no longer panics the task.** DataFusion's `MemoryPool::grow` must always succeed,
  because it is called for memory that already exists, such as a spilled batch that a sort-merge join reads
  back. Both Comet pools implemented it as `try_grow().unwrap()`. They now record the ungranted part as
  overcommit and repay it before releasing anything back to Spark, so Spark is never handed back more than it
  granted.
- **Leaks on failure paths.** The per-task shared memory pool is now reference-counted and removes itself from
  the registry when the last plan using it is dropped, so a plan that fails during setup or teardown no longer
  leaks its pool. A failed Arrow vector import now releases the vectors already imported for that batch.
- **Configuration units.** `spark.memory.offHeap.size` was read as MiB when given as a bare number, where Spark
  reads bytes, and `spark.comet.maxTempDirectorySize` silently fell back to its default when given a unit.
  Every config that native code reads is now resolved on the JVM before crossing JNI.
- **Metrics.** Native memory usage is now reported to Spark, and native aggregate spill and memory metrics,
  native child spill metrics in shuffle tasks, and native operator spill metrics in non-shuffle stages all appear
  in Spark's task metrics.

`spark.comet.exec.memoryPool.fraction` is now deprecated. It was meant to leave room in the off-heap pool for
untracked memory, but Spark hands out the whole pool regardless, so it never did. Size
`spark.executor.memoryOverhead` for that memory instead.

### A simpler on-heap mode

On-heap mode exists so that Spark's own SQL test suite and the Iceberg suites can run against Comet without
changing Spark's memory configuration; production deployments run off-heap. The accounting it performed did not
protect anything, because native memory is not on the JVM heap and there is no Spark pool it can honestly be
charged to. 1.1.0 removes it: on-heap mode now uses an unbounded pool, which removes six of the nine memory pool
types along with several testing-only configuration keys. Comet also no longer runs in on-heap mode unless
`spark.comet.exec.onHeap.enabled` is set, including when `CometSparkSessionExtensions` is registered directly
rather than through the plugin.

For contributors, a new [memory management guide] describes where Comet allocates memory, which allocations
are tracked, and the allocator hazards to watch for when adding operators.

Thanks to [@andygrove] for driving this work, [@peterxcli] for the memory pool lifecycle and shuffle spill
accounting fixes, [@ywskycn] for reporting native memory usage to Spark, [@1fanwang] for the Arrow import leak
fix, and [@sunchao] for the native aggregate spill and memory metrics, with reviews from [@sunchao],
[@comphead], and [@mbutrovich]. Related PRs: [#5934], [#6162], [#6048], [#6128], [#6205], [#6066], [#5494].

[memory management guide]: https://datafusion.apache.org/comet/contributor-guide/memory_management.html

## More Iceberg Improvements

The read side gained several things in this release too:

- **Iceberg V3 deletion vectors** are now applied on native scans.
- **Iceberg system functions** — `bucket`, `truncate`, `years`, `months`, `days`, and `hours` — have native
  implementations. Besides being faster, this is what keeps a partitioned table's write plan fully native and
  therefore eligible for the native writer.
- **Scan planning metrics and scan time** are reported in the Spark UI for the native Iceberg scan.
- **A wrong-results fix for transform residuals.** A residual such as `bucket(4, id) = 2` combined with another
  predicate under `AND`, `OR`, or `NOT` was pushed to the native scan as `id = 2`, returning too few rows. Such
  residuals are no longer pushed down.
- Tables partitioned by an unknown transform can now be read natively, and `IS NULL` / `IS NOT NULL` checks on
  list and map columns no longer force the scan back to Spark.

Thanks to [@mbutrovich] for deletion vector support, [@parthchandra] for the scan metrics, [@ErikBPF] for the
null-check fix, and [@andygrove] for the native system functions and residual fix, with reviews from
[@sunchao], [@rich7420], [@unikdahal], and [@jordepic]. Related PRs: [#5853], [#5638], [#6027], [#6154].

## Native Parquet Writes on Spark 4.0+

Separately from Iceberg, 1.1.0 hooks native Parquet writes into Spark's `WriteFilesExec` seam on Spark 4.0 and
later, behind `spark.comet.parquet.write.enabled`. This release also preserves Catalyst nullability and field
IDs in native Parquet writes.

Thanks to [@andygrove] and [@sunchao] for this work, with reviews from [@comphead], [@peterxcli],
[@rich7420], and [@parthchandra]. Related PRs: [#5763], [#5369].

## Remote Shuffle with Celeborn

Applications using Apache Celeborn can now use Comet's composite shuffle manager to run Comet's **native**
shuffle over Celeborn, where 1.0.0 retained ordinary Spark/Celeborn shuffle for every exchange. Map-side
tasks push Comet's Arrow frames directly to Celeborn, and the reduce side reads them back through a native
shuffle reader.

Native shuffle over Celeborn requires an explicit `spark.comet.shuffle.mode=native`; the default `auto` mode
retains ordinary Spark/Celeborn shuffle. It also requires a Celeborn client that provides a safe
push-completion API — released 0.6.0 and 0.7.0 clients do not, and those versions retain ordinary shuffle even
in native mode. Native RSS does not support `spark.io.encryption.enabled=true`. Celeborn is an optional
application dependency and is not bundled with Comet. See the [Celeborn section of the tuning guide] for the
full set of requirements and the frame-size and in-flight-bytes knobs.

Thanks to [@pingzh] for this work, with reviews from [@sunchao], [@ziting-openai], and [@andygrove]. Related
PRs: [#5473], [#5481], [#5513], [#5531], [#5537].

[Celeborn section of the tuning guide]: https://datafusion.apache.org/comet/user-guide/latest/tuning.html

## Performance

### Shuffle

Several changes target shuffle, which dominates many TPC-DS-shaped workloads:

- In 1.0.0, the native shuffle writer ran with a **1-byte write buffer** by default, because its 1 MiB
  default was declared in MiB but sent to native code as a byte count. It now uses the intended 1 MiB.
- **Round-robin repartitioning** is now positional, placing rows by row ordinal the way Spark does, instead of
  hashing every column of every row. Besides being much cheaper on wide nested schemas, this spreads a column of
  repeated values across reducers as Spark's round robin does.
- A task now spills **every shuffle partition into one file** instead of one file per partition.
- **Zstd compression contexts and Arrow IPC contexts are reused** across shuffle blocks instead of being
  rebuilt per block.
- Shuffle blocks are **decoded against a cached schema** rather than re-parsing the schema per block, and
  expected schemas are cached for remote shuffle decoding.
- Per-partition scratch buffers are reused in the shuffle write path, and `ArrowWriter` bulk-copies fixed-width
  columns.

Thanks to the contributors who drove this work, especially [@peterxcli], [@dwsmith1983], [@pingzh], and
[@andygrove], with reviews from [@sunchao] and [@mbutrovich].

### Planning and Execution

- **Native dynamic filter pushdown** from hash joins into Parquet scans.
- **Adaptive partial aggregation** is enabled for eligible native shuffle plans.
- **Parsed plan data is cached across the tasks of a stage**, avoiding repeated deserialization work.
- **Native Parquet scan I/O and read-amplification metrics** are exposed.

### Expression Kernels

Ongoing kernel-level work continued across the expression library: `map_sort` is up to 3x faster for
multi-entry string maps and 18x faster on singleton normalization; the native map lookup behind `element_at`
and `GetMapValue` is vectorized; `collect_list` and `collect_set` gained a native `GroupsAccumulator`; user
regex patterns are compiled once per planned expression; `hour`/`minute`/`second` and `dayofweek`/`weekday`
skip calendar reconstruction; `posexplode` array expressions are evaluated once per batch; unnesting slices
the child rather than gathering it; and the nested-element list hash is batched for flat struct elements.

## Expanded Coverage

New expression and operator support in this release includes the `mode` aggregate, `max_by` / `min_by`,
`listagg` / `string_agg` on Spark 4.0+, the `regr_slope` / `regr_intercept` / `regr_r2` / `regr_sxx` /
`regr_syy` / `regr_sxy` regression aggregates, `WindowGroupLimitExec`, `explode_outer`, `make_interval`, a
native `spark_sequence` kernel for integral element types, a native `spark_unbase64` kernel, `_metadata`
constant columns in the native Parquet scan, nested types as native shuffle hash partitioning keys,
`BinaryType` for sort-merge join, and Spark 4's `EmptyRelationExec` as a native input. Several more
expressions — `translate`, `to_csv`, `encode`, `lpad` / `rpad`, `round` on float/double, `abs` on intervals,
`timestampadd` / `timestampdiff`, `next_day` and `levenshtein` on collated input, and unrecognized
`StaticInvoke` / `Invoke` — are now routed through codegen dispatch by default, and `rlike` runs natively by
default for Java-equivalent literal patterns.

Spark 4 **Variant** support advanced as well: native Parquet scans can now project Variant columns directly,
with Parquet storage adapted for Variant projection, Variant arrays normalized at the native Parquet boundary,
and `VariantType` identity carried through schema serialization.

Thanks to [@peterxcli] for driving Variant support, with reviews from [@sunchao]. Related PRs: [#5868],
[#5794].

This release also adds **experimental native support for an in-memory cache**
(`spark.comet.exec.inMemoryCache.enabled`, disabled by default), support for **S3-compliant filesystems**, and
build gates for contrib **Delta** and **Lance** scans.

## Previewing Comet Plans

A new `spark.comet.explain.planOnly.enabled` setting builds the plan Comet would have executed, logs it to the
driver log, and then lets Spark run the query unchanged. This makes it possible to see how much of a production
workload Comet would accelerate, and why anything falls back, without running any of it through Comet.

Thanks to [@andygrove] for this feature, with reviews from [@coderfender] and [@sunchao]. Related PRs:
[#5394].

## Upgrading to 1.1.0

A few changes in this release are worth checking before upgrading:

- **JDK 11 support has been removed**, as announced in the 1.0.0 release. Comet 1.1.0 requires JDK 17 or
  later.
- **Apache Spark 3.4 remains deprecated.** Comet continues to build and publish Spark 3.4 binaries, but
  Spark's own SQL test suite no longer runs against Spark 3.4 on every change, so Spark 3.4-specific
  regressions are more likely to reach a release. We recommend moving to Spark 3.5 or later.
- **Tasks can reserve more memory before spilling** with the `fair_unified` pool, because of the fix described
  above. The difference is largest on executors that run few tasks at once. If you sized executor memory against
  0.15.0 through 1.0.0, use the new memory usage log to check that executors still have enough headroom.
- **`spark.comet.exec.memoryPool.fraction` is deprecated** and will be removed in a future release.
- **A bare-number `spark.memory.offHeap.size`** is now read as bytes, as Spark reads it, rather than as MiB.
- **Testing-only on-heap configuration keys have been removed**, including `spark.comet.memoryOverhead` and
  `spark.comet.exec.onHeap.memoryPool`. These are in the `testing` category, which the
  [versioning policy] exempts.

[versioning policy]: https://datafusion.apache.org/comet/about/versioning_policy.html

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

[@jordepic]: https://github.com/jordepic
[@andygrove]: https://github.com/andygrove
[@zhangfengcdt]: https://github.com/zhangfengcdt
[@snmvaughan]: https://github.com/snmvaughan
[@0lai0]: https://github.com/0lai0
[@sunchao]: https://github.com/sunchao
[@comphead]: https://github.com/comphead
[@unikdahal]: https://github.com/unikdahal
[@mbutrovich]: https://github.com/mbutrovich
[@peterxcli]: https://github.com/peterxcli
[@ywskycn]: https://github.com/ywskycn
[@1fanwang]: https://github.com/1fanwang
[@parthchandra]: https://github.com/parthchandra
[@ErikBPF]: https://github.com/ErikBPF
[@rich7420]: https://github.com/rich7420
[@pingzh]: https://github.com/pingzh
[@ziting-openai]: https://github.com/ziting-openai
[@dwsmith1983]: https://github.com/dwsmith1983
[@coderfender]: https://github.com/coderfender

[#4658]: https://github.com/apache/datafusion-comet/pull/4658
[#5298]: https://github.com/apache/datafusion-comet/pull/5298
[#5361]: https://github.com/apache/datafusion-comet/pull/5361
[#5663]: https://github.com/apache/datafusion-comet/pull/5663
[#5780]: https://github.com/apache/datafusion-comet/pull/5780
[#5934]: https://github.com/apache/datafusion-comet/pull/5934
[#6162]: https://github.com/apache/datafusion-comet/pull/6162
[#6048]: https://github.com/apache/datafusion-comet/pull/6048
[#6128]: https://github.com/apache/datafusion-comet/pull/6128
[#6205]: https://github.com/apache/datafusion-comet/pull/6205
[#6066]: https://github.com/apache/datafusion-comet/pull/6066
[#5494]: https://github.com/apache/datafusion-comet/pull/5494
[#5853]: https://github.com/apache/datafusion-comet/pull/5853
[#5638]: https://github.com/apache/datafusion-comet/pull/5638
[#6027]: https://github.com/apache/datafusion-comet/pull/6027
[#6154]: https://github.com/apache/datafusion-comet/pull/6154
[#5763]: https://github.com/apache/datafusion-comet/pull/5763
[#5369]: https://github.com/apache/datafusion-comet/pull/5369
[#5473]: https://github.com/apache/datafusion-comet/pull/5473
[#5481]: https://github.com/apache/datafusion-comet/pull/5481
[#5513]: https://github.com/apache/datafusion-comet/pull/5513
[#5531]: https://github.com/apache/datafusion-comet/pull/5531
[#5537]: https://github.com/apache/datafusion-comet/pull/5537
[#5868]: https://github.com/apache/datafusion-comet/pull/5868
[#5794]: https://github.com/apache/datafusion-comet/pull/5794
[#5394]: https://github.com/apache/datafusion-comet/pull/5394
