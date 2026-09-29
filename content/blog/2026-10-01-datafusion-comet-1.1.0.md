---
layout: post
title: Apache DataFusion Comet 1.1.0 Release
date: 2026-10-01
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

This release covers roughly seven weeks of development since 1.0.0: 398 commits from 40 contributors. See the
[change log] for the full list of changes.

[change log]: https://github.com/apache/datafusion-comet/blob/branch-1.1/docs/source/changelog/1.1.0.md

The highlights:

- **Native Iceberg writes** (experimental): Comet can write Iceberg data files with iceberg-rust instead of
  iceberg-java.
- **Memory management**: Comet now measures the native memory its pools don't track, logs it on every executor,
  and fixes several long-standing pool accounting bugs.
- **Native shuffle over Apache Celeborn**: Comet's side is in place, but it needs a Celeborn client API that no
  released Celeborn version provides yet.
- **Native Parquet writes on Spark 4.0+** (experimental), now built on Spark's own write path.

## Native Iceberg Writes (Experimental)

Until now, Comet accelerated Iceberg reads but left writes to the JVM. In 1.1.0, Comet can write Iceberg data
files natively using [iceberg-rust](https://github.com/apache/iceberg-rust). The feature is **experimental and
disabled by default**, and it only engages under fairly strict conditions.

### Splitting the write operator

Spark writes an Iceberg table with a single operator that writes the data files, writes the metadata, commits,
and validates against the catalog. Because file writing is bundled with the metadata and commit steps, there was
no separate piece for Comet to replace.

Setting `spark.comet.write.iceberg.splitOperator.enabled=true` splits eligible Iceberg writes into two operators:

1. **`IcebergWrite`** writes data files on the executors and returns each task's commit message.
2. **`IcebergCommit`** collects the commit messages on the driver and performs the normal Iceberg commit, once.

With only the split enabled, iceberg-java still writes the files; the native writer, described next, replaces
that step. The split covers `INSERT INTO` and DataFrame `append`, static and dynamic `INSERT OVERWRITE`, and
copy-on-write `DELETE`, `UPDATE`, and `MERGE`, on every supported Spark version. Merge-on-read writes are left
alone. When Comet can't split a write (an unrecognized write class, CTAS on Spark 3.4, or a write that needs
Spark's commit coordinator), it plans the write exactly as if Comet weren't there.

### Writing Parquet natively

The native writer requires the split. Also setting `spark.comet.iceberg.write.enabled=true` hands each task's
Parquet writing to iceberg-rust. The driver passes the native writer everything it needs: schema, partition spec,
data location, Parquet settings, writer mode, and object-store configuration. Each task writes its files and
returns their metadata as an in-memory Iceberg manifest.

From there, iceberg-java takes over again. The JVM reads the manifest, recomputes each file's metrics from its
Parquet footer, and builds the same commit message the JVM writer would have produced. Snapshots, manifest
lists, commit validation, and retries all work as before.

The native writer consumes Arrow batches from a Comet operator, so the query feeding the write must run in Comet
too. Writes from a local relation, such as `INSERT ... VALUES`, also need
`spark.comet.exec.localTableScan.enabled=true`.

To see which path a write took, check the physical plan: a native write shows `CometIcebergWrite` under
`IcebergCommit`, and a write that fell back shows `IcebergWrite`.

### Matching iceberg-java

The native writer aims to write the same table iceberg-java would, down to the metadata. Manifest metrics drive
pruning for every future reader, so rather than trust the native writer's numbers, Comet recomputes them with
iceberg-java's own code. Parity tests write the same rows through both writers and compare the committed counts
and bounds. The cost is one small footer read per file.

Eligibility is an allowlist. A write goes native only if its whole configuration matches the documented set of
supported settings. Anything else, including properties added by future Iceberg versions, falls back to
iceberg-java and reports why in Comet's extended `EXPLAIN` output. Encryption, object-storage layout, custom
location providers, bloom filters, and unrecognized `parquet.*` properties all fall back. For a partitioned
table, Iceberg asks Spark to cluster and sort rows by partition value, such as `bucket(16, id)` or `days(ts)`,
before writing. That step must also run natively, which it now can because Iceberg's system functions have
native implementations.

Comet decides all of this at planning time, including checking that every iceberg-java class it relies on is
where it expects. An Iceberg release that moves one falls back instead of failing tasks mid-write. CI also runs
Apache Iceberg's own Spark test suites, for Iceberg 1.8.1 through 1.11.0, with the native writer enabled.

### Failure handling

Only successful tasks' commit messages are committed. A failed task deletes the files it wrote, as iceberg-java
does, and a failed job commits nothing and deletes the completed tasks' files. Retries can't collide, because
each attempt's ID is part of its file names. Anything cleanup misses is invisible to readers and is removed by
Iceberg's normal `remove_orphan_files` maintenance.

### Known differences

Files written by parquet-rs, the Rust Parquet library iceberg-rust uses, differ from those written by
parquet-java (formerly parquet-mr), which iceberg-java uses. Enabling the feature accepts these differences.
Most are cosmetic, such as footer metadata, `created_by`, and page encoding labels. Two are worth knowing about:

- **Files won't split at the same points.** Both writers check file size every 1000 rows, but they estimate it
  differently, so they can roll over to a new file at different rows.
- **High-cardinality columns keep a dictionary page.** parquet-java drops dictionary encoding early when it isn't
  saving space, while parquet-rs keeps it up to `write.parquet.dict-size-bytes`. Results are the same, but
  selective reads of native-written files fetch more bytes
  ([#6114](https://github.com/apache/datafusion-comet/issues/6114)).

The [Iceberg Writes guide] lists every supported setting and every difference. Please try it on a non-production
table and tell us how it goes. Feedback from real workloads is what this feature needs before it loses the
experimental label.

Thanks to [@jordepic] for designing and implementing the split-operator plan, write detection, and the native
writer, and to [@andygrove] for the fidelity and failure-handling work, with contributions from
[@zhangfengcdt], [@snmvaughan], [@liupoyi-1031], and [@0lai0], and reviews from [@sunchao], [@comphead],
[@unikdahal], and [@mbutrovich]. Related PRs: [#4658], [#5298], [#5361], [#5663], [#5780].

[Iceberg Writes guide]: https://datafusion.apache.org/comet/user-guide/latest/iceberg-writes.html

## Memory Management

A recurring problem for Comet users has been executors killed by the cluster manager (on Kubernetes,
`ExecutorLostFailure` with exit code 137) even though Comet stayed within its memory pool. 1.1.0 explains why
this happens, lets you measure it, and fixes pool bugs that made it worse.

### Where the memory goes

Comet's native operators allocate from the Rust heap but charge their reservations against Spark's off-heap
pool, sized by `spark.memory.offHeap.size`. Operators only reserve memory for data they deliberately hold onto:
sort buffers, hash join build sides, aggregation state, and buffered shuffle partitions.

Plenty of memory is never reserved: working memory in expression kernels, decompression buffers, Parquet reader
state, object store buffers, JVM-side Arrow buffers, and allocator overhead. All of it has to fit in
`spark.executor.memoryOverhead`, and until now there was no way to see how much of it there was.

<img
src="/blog/images/comet-1.1.0/comet-executor-memory.svg"
width="100%"
class="img-fluid"
alt="The executor container holds the JVM heap, the off-heap memory pool, and the memory overhead. Spark and Comet share the off-heap pool, where Comet's sorts, joins, aggregations, and shuffles reserve memory. The memory overhead holds the JVM's own overhead plus Comet's native memory that the pool does not track."
/>

### Measuring used memory

Comet now wraps its native allocator in a counter that tracks every byte allocated and not yet freed. It only
observes and never rejects an allocation. Arrow buffers the JVM imports from native code are now tracked
separately, so they aren't counted twice.

Each executor uses the counter to log its native memory usage every 10 seconds while Comet runs:

```
Comet native memory usage: allocated 5412.3 MiB, reserved 3890.0 MiB (16 native plans, 8 memory pools)
```

`reserved` is what the pools track, and the container already has room for it. `allocated` is everything
Comet's native code holds. The difference is what has to fit in `spark.executor.memoryOverhead`, next to the
JVM's own non-heap memory. To size the overhead, run a representative workload, take the largest difference from
the log, add it to the overhead you had before Comet, and leave a margin. Setting
`spark.comet.memory.logInterval=1s` for that run makes it less likely to miss a short peak.

The executor also warns when its native memory looks larger than the container allows, and the
[tuning guide] walks through sizing with examples. One gotcha: setting `spark.executor.memoryOverhead`
_replaces_ the value Spark derives from `spark.executor.memoryOverheadFactor` instead of adding to it, so on a
large executor it can shrink the container. For large executors, raise the factor instead.

[tuning guide]: https://datafusion.apache.org/comet/user-guide/latest/tuning/memory.html

### Memory pool fixes

Comet's off-heap memory comes from one of two pools. `fair_unified`, the default, caps each operator at an even
share of the task's memory. `greedy_unified` gives memory to operators first come, first served. When Spark
grants an operator less memory than it asked for (a partial grant), the operator spills.

- **`fair_unified` limited a whole task to one operator's share.** Since 0.15.0, the pool compared all of a
  task's reservations against a single operator's share, and each new operator shrank the limit for the rest.
  Each operator now gets its own share, so tasks with several operators can use more memory before spilling.
- **A partial grant from Spark no longer panics the task.** DataFusion sometimes has to record memory that
  already exists, such as a spilled batch being read back, and both pools panicked when Spark granted less than
  they asked for. They now track the shortfall and repay it before returning memory to Spark.
- **Leaks on failure paths.** A plan that failed during setup or teardown could leak its task's memory pool, and
  a failed Arrow import leaked the vectors it had already imported.
- **Configuration units.** 1.0.0 misread three size settings, including `spark.memory.offHeap.size` written as
  a bare number. See [Upgrading to 1.1.0](#upgrading-to-110) for what changes.
- **Less log noise when spilling.** 1.0.0 logged a warning and a memory dump for every partial grant, so a
  spilling query could log hundreds. Partial grants now log at DEBUG, and the dump is gone because it could
  deadlock the task.
- **Metrics.** Native memory usage, spill, and aggregate memory metrics now appear in Spark's task metrics.

`spark.comet.exec.memoryPool.fraction` is deprecated. It was meant to leave room for untracked memory, but Spark
hands out the whole pool anyway, so it never did. Size `spark.executor.memoryOverhead` instead.

### On-heap mode

On-heap mode exists so that Spark's and Iceberg's test suites can run against Comet; production runs off-heap.
Its memory accounting didn't protect anything, because native memory isn't on the JVM heap, so 1.1.0 removes that
accounting, along with six of the nine pool types and several testing-only settings. Outside tests, Comet now requires
off-heap memory however it's enabled, including when `CometSparkSessionExtensions` is registered directly, and
disables itself with a warning otherwise.

Contributors can find more detail in the new [memory management guide].

Thanks to [@andygrove] for driving this work, [@peterxcli] for the memory pool lifecycle and shuffle spill
accounting fixes, [@ywskycn] for reporting native memory usage to Spark, [@1fanwang] for the Arrow import leak
fix, and [@sunchao] for the native aggregate spill and memory metrics, with reviews from [@sunchao],
[@comphead], and [@mbutrovich]. Related PRs: [#5934], [#6162], [#6048], [#6128], [#6205], [#6066], [#5494].

[memory management guide]: https://datafusion.apache.org/comet/contributor-guide/memory_management.html

## More Iceberg Improvements

- **V3 deletion vectors** are applied on native scans.
- **Iceberg system functions** (`bucket`, `truncate`, `years`, `months`, `days`, and `hours`) run natively.
- **Scan planning metrics and scan time** appear in the Spark UI for native Iceberg scans.
- **A wrong-results fix.** A filter such as `bucket(4, id) = 2` combined with another predicate was pushed to
  the native scan as `id = 2`, returning too few rows.
- Tables partitioned by an unknown transform can be read natively, and `IS NULL` / `IS NOT NULL` checks on list
  and map columns no longer force a fallback.

Thanks to [@mbutrovich] for deletion vector support, [@parthchandra] for the scan metrics, [@ErikBPF] for the
null-check fix, and [@andygrove] for the native system functions and residual fix, with reviews from
[@sunchao], [@rich7420], [@unikdahal], and [@jordepic]. Related PRs: [#5853], [#5638], [#6027], [#6154].

## Remote Shuffle with Celeborn

1.1.0 adds Comet's side of native shuffle over Apache Celeborn: map tasks push Comet's Arrow data straight to
Celeborn, and reducers read it back natively. In 1.0.0, Celeborn users always got ordinary Spark shuffle.

It does not run with a released Celeborn yet. Native shuffle needs Celeborn to report reliably when an in-flight
push has completed, and no released client does, including 0.7.0, the latest release. Those clients keep ordinary
shuffle even when native shuffle is requested. Once a Celeborn release provides that API, set
`spark.shuffle.manager` to `org.apache.spark.sql.comet.execution.shuffle.CometCelebornShuffleManager` and
`spark.comet.shuffle.mode=native`; the default `auto` mode keeps ordinary shuffle. Native shuffle over Celeborn
doesn't support `spark.io.encryption.enabled=true`, and Celeborn isn't bundled with Comet. The
[Celeborn tuning guide] has the full requirements.

Thanks to [@pingzh] for this work, with reviews from [@sunchao], [@ziting-openai], and [@andygrove]. Related
PRs: [#5473], [#5481], [#5513], [#5531], [#5537].

[Celeborn tuning guide]: https://datafusion.apache.org/comet/user-guide/latest/tuning/celeborn.html

## Native Parquet Writes on Spark 4.0+ (Experimental)

Native Parquet writes remain **experimental and disabled by default**, but on Spark 4.0+ they now build on
Spark's own write path.

In 1.0.0, a native write replaced Spark's entire write command, so Comet had to reimplement the commit protocol,
save modes, and job commit. On Spark 4.0+, Comet replaces only `WriteFilesExec`, the per-task write step that
Spark 4.0 made pluggable, and Spark handles the rest. That means:

- File names come from Spark's commit protocol, so committers that track individual files, like the S3A magic
  committer, work.
- Column names, nullability, and field IDs come from the target table, not the query.
- Bytes-written and rows-written metrics are correct on HDFS.

The writer handles non-partitioned, non-bucketed writes to local and HDFS paths, and skips writes that set
`spark.sql.files.maxRecordsPerFile`. To enable it, set `spark.comet.parquet.write.enabled=true` and
`spark.comet.operator.WriteFilesExec.allowIncompatible=true`. Spark 3.4 and 3.5 keep the old write path.

Thanks to [@andygrove] and [@sunchao] for this work, with reviews from [@comphead], [@peterxcli],
[@rich7420], and [@parthchandra]. Related PRs: [#5763], [#5369].

## S3 Credentials

Comet's native S3 access now works with more of the credential setups Spark supports:

- **Built-in credential provider adapters.** In 1.0.0, a native Parquet scan failed with
  `Unsupported credential provider` for classes Spark accepts but Comet didn't reimplement, such as
  `DefaultAWSCredentialsProviderChain`. Two new adapters fix this by setting
  `spark.hadoop.fs.s3a.comet.credential.provider.class`.
  `HadoopS3ACredentialProviderAdapter` (recommended) uses Hadoop S3A's own provider chain, so it supports
  everything S3A does, including web identity, assumed roles, and per-bucket settings.
  `AwsSdkCredentialProviderAdapter` wraps a specific AWS SDK provider class.
- **STS throttling protection on EKS with IRSA.** When many executors start at once, STS can throttle their
  credential requests. In 1.0.0, the native Iceberg path then fell back to the EKS node role, which usually can't
  read the bucket, and the job failed with `403` errors. Native Iceberg reads and writes now fetch web-identity
  credentials themselves, retry throttled requests with backoff, never fall back to the node role, and share one
  credential per executor. This happens automatically.
- **Per-location credentials.** A provider implementing `CometS3LocationScopedCredentialProvider` can return
  different credentials for different prefixes in the same bucket, such as `warehouse/sales` and
  `warehouse/finance`.
- **Custom S3-compatible schemes.** Vendor filesystems that front an S3-compatible store with their own URL
  scheme, such as `blob://`, can be read natively by listing the scheme in
  `spark.hadoop.fs.comet.s3Compliant.schemes`.

See the [S3 credential providers guide] for details.

[S3 credential providers guide]: https://datafusion.apache.org/comet/user-guide/latest/s3-credential-providers.html

Thanks to [@parthchandra] for the credential adapters and STS throttling protection, [@snmvaughan] for
per-location credentials, and [@comphead] for custom S3-compatible schemes, with reviews from [@sunchao] and
[@andygrove]. Related PRs: [#6023], [#6025], [#6031], [#5314].

## Performance

### Shuffle

- In 1.0.0, the native shuffle writer ran with a **1-byte write buffer** by default: its 1 MiB default was
  declared in MiB but passed to native code as bytes. It now gets the intended 1 MiB.
- **Round-robin repartitioning** assigns rows by position, as Spark does, instead of hashing every column of
  every row. That's much cheaper on wide nested schemas, and it spreads repeated values across reducers the way
  Spark does.
- A task **spills all of its shuffle partitions into one file** instead of one file each.
- **Zstd and Arrow IPC compression contexts are reused** across shuffle blocks.
- Shuffle blocks are **decoded against a cached schema** instead of re-parsing it for every block.
- Per-partition scratch buffers are reused, and `ArrowWriter` bulk-copies fixed-width columns.

Thanks to the contributors who drove this work, especially [@peterxcli], [@dwsmith1983], [@pingzh], and
[@andygrove], with reviews from [@sunchao] and [@mbutrovich].

### Planning and Execution

- **Native dynamic filter pushdown**: a hash join's build-side keys filter the probe-side Parquet scan at
  runtime, so the scan can skip data that can't match.
- **Adaptive partial aggregation** for eligible native shuffle plans: when grouping keys are nearly unique, the
  partial aggregate passes rows through instead of building a hash table that doesn't reduce them.
- **Parsed plan data is cached** across a stage's tasks.
- New **native Parquet scan I/O and read-amplification metrics**.

### Expressions

Many expression kernels got faster. In kernel microbenchmarks, `map_sort` is up to 3x faster on multi-entry string
maps and 18x faster on single-entry maps. The map lookup behind `element_at` and `GetMapValue` is vectorized,
`collect_list` and `collect_set` have a native `GroupsAccumulator`, and regex patterns are compiled once per
planned expression. Smaller gains cover date and time field extraction, `posexplode`, unnesting, nested hashing,
decimal overflow checks, `list_extract`, and approximate percentile merges.

## Expanded Coverage

New native support includes the `mode`, `max_by` / `min_by`, `listagg` / `string_agg` (Spark 4.0+), and
`regr_*` regression aggregates; `WindowGroupLimitExec`; `explode_outer`; `make_interval`; native
`sequence` for integral types and `unbase64`; `_metadata` constant columns in the native Parquet
scan; nested types as shuffle hash partitioning keys; `BinaryType` in sort-merge joins; and Spark 4's
`EmptyRelationExec`.

More expressions now use [codegen dispatch] by default, where Comet runs Spark's own generated code for an
expression inside the native pipeline, so the result matches Spark without falling back. They include
`translate`, `to_csv`, `encode`, `lpad` / `rpad`, `round` on floats, `abs` on intervals, `timestampadd` /
`timestampdiff`, `next_day` and `levenshtein` on collated input, and Spark expressions that call a Java or
Scala method directly. `rlike` runs natively by
default for literal patterns that behave the same as in Java.

[codegen dispatch]: https://datafusion.apache.org/blog/2026/06/20/datafusion-comet-0.17.0/

Spark 4 **Variant** support also improved: native Parquet scans can project Variant columns directly. Thanks to
[@peterxcli] for driving Variant support, with reviews from [@sunchao]. Related PRs: [#5868], [#5794].

There's also **experimental native support for the in-memory cache** (`spark.comet.exec.inMemoryCache.enabled`,
off by default).

## Previewing Comet Plans

The new `spark.comet.explain.planOnly.enabled` setting logs the plan Comet would have run to the driver log,
then lets Spark run the query as normal. It shows how much of a production workload Comet would accelerate, and
why anything falls back, without running any of it through Comet.

Thanks to [@andygrove] for this feature, with reviews from [@coderfender] and [@sunchao]. Related PRs:
[#5394].

## Correctness Fixes

1.1.0 fixes many cases where Comet returned different results from Spark, failed where Spark succeeds, or
accepted input that Spark rejects. Besides the Iceberg and memory fixes above, these are the ones most likely to
affect 1.0.0 users. The [change log] has the rest.

### Wrong results

- Decimal `SUM` returned NULL, or raised an overflow error under ANSI, when an intermediate sum overflowed
  but the final result fit ([#6041], [@dwsmith1983]).
- After a late shuffle fallback, `avg` could return NULL and `collect_list` / `collect_set` could produce
  mismatched buffers ([#5421], [@sunchao]).
- Exchange reuse could share one shuffle between plans that differ, such as `COUNT(*) + 1` and `COUNT(*) - 1`,
  semi and anti joins, or `explode` and `explode_outer` ([#5470], [@sunchao] and [#5828], [@ErikBPF]).
- Two ABFS containers in the same storage account shared a cached object store, so a read could return the
  other container's data ([#5053], [@peterxcli]).
- Dictionary-encoded values hashed differently from the same values decoded, and a null struct hashed its
  fields, which affected joins, aggregates and shuffle partitioning ([#5757] and [#5754], [@viirya]).
- Parquet field names containing non-ASCII characters that differ only in case read as NULL ([#5602],
  [@comphead]).
- `IN`, `InSet`, nested `=`, `arrays_overlap` and `array_position` now treat `-0.0` and `0.0`, and every NaN
  encoding, as Spark does ([#6073], [@mizulun], [#5235], [@divyankshah] and [#5472], [@sunchao]).
- Decimal to double and float casts were off by one unit in the last place for most `DECIMAL(38,18)` values
  ([#5684], [@peterxcli]).
- String to timestamp casts now follow Spark's parsing rules for short fields, time zones and signed years
  ([#5682] and [#5858], [@peterxcli]).

### Errors Spark raises that Comet did not

- Casts and expressions routed through codegen dispatch could skip ANSI errors raised inside a constant
  subexpression ([#5623], [@andygrove]).
- Rejected `TIMESTAMP_NTZ` casts returned NULL under ANSI instead of raising `CAST_INVALID_INPUT` ([#5752],
  [@peterxcli]).
- Out-of-range Parquet `TIMESTAMP_MILLIS` values, top-level or nested, silently wrapped ([#5177] and [#5740],
  [@peterxcli]).
- Nested Parquet struct, list and map fields now follow Spark's conversion rules instead of returning NULL on
  overflow or accepting values Spark rejects ([#5681], [@peterxcli]).

### Query failures and crashes

- `collect_list` and `collect_set` over nested arguments failed with "column types must match schema types"
  ([#5159], [@andygrove]).
- Native shuffle failed with a 2 GB task serialization error on jobs with very many partitions ([#5392],
  [@parthchandra]).
- A Scala UDF from a user jar failed with a `ClassCastException` ([#5282], [@andygrove]).
- `rpad` and `lpad` panicked on a NULL length ([#5680], [@peterxcli]).
- Structs with duplicate field names failed the task in native shuffle, and panicked in the native Parquet
  scan ([#5866], [@dwsmith1983] and [#5786], [@ErikBPF]).

### Hangs and resource use

- The JVM hung on exit when an application returned from `main` without calling `spark.stop()` ([#5748],
  [@zhangfengcdt]).
- The native scan busy-polled while waiting on S3 or HDFS reads, keeping one core per task at 100% ([#6219],
  [@mixermt] and [@andygrove]).
- One task could force-spill another task's shuffle buffers, and a failed shuffle write leaked its memory
  reservation ([#5493] and [#5461], [@peterxcli]).

## Upgrading to 1.1.0

A few changes in 1.1.0 can affect a deployment. The [Comet Upgrade Guide] has the details.

[Comet Upgrade Guide]: https://datafusion.apache.org/comet/user-guide/latest/migration-guide.html

### Platform

- **JDK 17 or later is required.** JDK 11 support was removed, as announced in 1.0.0.
- **Spark 3.4 is still deprecated.** Comet still publishes Spark 3.4 binaries, but Spark's SQL test suite runs
  against 3.4 only on demand, so 3.4-specific regressions are more likely. We recommend Spark 3.5 or later.

### Size settings now read correctly

1.0.0 misread three size settings, so jobs that set them may behave differently:

- **`spark.memory.offHeap.size` as a bare number of bytes** was read as MiB, which made `fair_unified`'s
  per-operator shares about a million times too large. With correct shares, operators can spill sooner, and an
  operator that can't spill can fail when it exceeds its share. Sizes with a unit, like `16g`, aren't affected.
  `spark.comet.exec.memoryPool=greedy_unified` restores the old behavior.
- **`spark.comet.maxTempDirectorySize` with a unit**, like `10g`, was ignored in favor of the 100 GB default.
  It's now enforced, so a query that spills past it fails.
- **`spark.comet.shuffle.native.writeBufferSize` with a unit** was treated as bytes, so `64m` meant 64 bytes. It
  now means what it says. These buffers use untracked native memory, so check large values against
  `spark.executor.memoryOverhead`.

Malformed values for `spark.comet.maxTempDirectorySize` and `spark.comet.explain.native.enabled` now fail the
query instead of falling back to the default.

### More memory before spilling

With the `fair_unified` fix, tasks with several operators can reserve more memory before spilling than in
0.15.0 through 1.0.0, especially on executors running few tasks at once. If you sized executors for one of those
releases, check the memory usage log for headroom.

### Conditions for enabling Comet

Comet requires Spark's off-heap memory. `CometPlugin` already enforced this, and 1.1.0 applies the same check
when `CometSparkSessionExtensions` is registered directly, disabling Comet with a warning. Both checks read
`spark.memory.offHeap.enabled` from the SparkContext, so set it when the application starts, not on a
`SparkSession.builder` after the context exists.

Comet also checks the shuffle manager that's actually running, not the session's `spark.shuffle.manager`. A
session that names `CometShuffleManager` after the context started with a different one now runs without Comet,
with a warning, instead of failing with a `ClassCastException`.

### Deprecated and removed settings

- **`spark.comet.exec.memoryPool.fraction`** is deprecated and will be removed in a future major release. It
  still works, and the driver warns when it's set.
- **Testing-only on-heap settings** were removed: `spark.comet.memoryOverhead`,
  `spark.comet.exec.onHeap.memoryPool`, and `spark.comet.shuffle.jvm.memoryFactor` (and its old name,
  `spark.comet.columnar.shuffle.memory.factor`). The [versioning policy] exempts testing settings, and Comet
  ignores them if they're still set.

[versioning policy]: https://datafusion.apache.org/comet/about/versioning_policy.html#testing-and-internal-configurations-are-exempt

## Compatibility

Supported platforms:

- **Spark 3.4.3** with Java 17 and Scala 2.12/2.13 (deprecated)
- **Spark 3.5.9** with Java 17 and Scala 2.12/2.13
- **Spark 4.0.4** with Java 17/21 and Scala 2.13
- **Spark 4.1.3** with Java 17/21 and Scala 2.13
- **Spark 4.2.0** with Java 17 and Scala 2.13 (experimental, for early evaluation only)

See the [Spark Version Compatibility] page for known limitations specific to each version.

[Spark Version Compatibility]: https://datafusion.apache.org/comet/user-guide/latest/compatibility/spark-versions.html

This release builds on **DataFusion 55.1** and **Arrow 59.2**.

## Get Started with Comet 1.1.0

Follow the [Comet 1.1.0 Installation Guide](https://datafusion.apache.org/comet/user-guide/1.1/installation.html)
to get up and running, then point Comet at your existing Spark workloads.

[@jordepic]: https://github.com/jordepic
[@andygrove]: https://github.com/andygrove
[@zhangfengcdt]: https://github.com/zhangfengcdt
[@snmvaughan]: https://github.com/snmvaughan
[@liupoyi-1031]: https://github.com/liupoyi-1031
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
[@viirya]: https://github.com/viirya
[@mizulun]: https://github.com/mizulun
[@divyankshah]: https://github.com/divyankshah
[@mixermt]: https://github.com/mixermt

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
[#5473]: https://github.com/apache/datafusion-comet/pull/5473
[#5481]: https://github.com/apache/datafusion-comet/pull/5481
[#5513]: https://github.com/apache/datafusion-comet/pull/5513
[#5531]: https://github.com/apache/datafusion-comet/pull/5531
[#5537]: https://github.com/apache/datafusion-comet/pull/5537
[#5763]: https://github.com/apache/datafusion-comet/pull/5763
[#5369]: https://github.com/apache/datafusion-comet/pull/5369
[#6023]: https://github.com/apache/datafusion-comet/pull/6023
[#6025]: https://github.com/apache/datafusion-comet/pull/6025
[#6031]: https://github.com/apache/datafusion-comet/pull/6031
[#5314]: https://github.com/apache/datafusion-comet/pull/5314
[#5868]: https://github.com/apache/datafusion-comet/pull/5868
[#5794]: https://github.com/apache/datafusion-comet/pull/5794
[#5394]: https://github.com/apache/datafusion-comet/pull/5394
[#6041]: https://github.com/apache/datafusion-comet/pull/6041
[#5421]: https://github.com/apache/datafusion-comet/pull/5421
[#5470]: https://github.com/apache/datafusion-comet/pull/5470
[#5828]: https://github.com/apache/datafusion-comet/pull/5828
[#5053]: https://github.com/apache/datafusion-comet/pull/5053
[#5757]: https://github.com/apache/datafusion-comet/pull/5757
[#5754]: https://github.com/apache/datafusion-comet/pull/5754
[#5602]: https://github.com/apache/datafusion-comet/pull/5602
[#6073]: https://github.com/apache/datafusion-comet/pull/6073
[#5235]: https://github.com/apache/datafusion-comet/pull/5235
[#5472]: https://github.com/apache/datafusion-comet/pull/5472
[#5684]: https://github.com/apache/datafusion-comet/pull/5684
[#5682]: https://github.com/apache/datafusion-comet/pull/5682
[#5858]: https://github.com/apache/datafusion-comet/pull/5858
[#5623]: https://github.com/apache/datafusion-comet/pull/5623
[#5752]: https://github.com/apache/datafusion-comet/pull/5752
[#5177]: https://github.com/apache/datafusion-comet/pull/5177
[#5740]: https://github.com/apache/datafusion-comet/pull/5740
[#5681]: https://github.com/apache/datafusion-comet/pull/5681
[#5159]: https://github.com/apache/datafusion-comet/pull/5159
[#5392]: https://github.com/apache/datafusion-comet/pull/5392
[#5282]: https://github.com/apache/datafusion-comet/pull/5282
[#5680]: https://github.com/apache/datafusion-comet/pull/5680
[#5866]: https://github.com/apache/datafusion-comet/pull/5866
[#5786]: https://github.com/apache/datafusion-comet/pull/5786
[#5748]: https://github.com/apache/datafusion-comet/pull/5748
[#6219]: https://github.com/apache/datafusion-comet/pull/6219
[#5493]: https://github.com/apache/datafusion-comet/pull/5493
[#5461]: https://github.com/apache/datafusion-comet/pull/5461
