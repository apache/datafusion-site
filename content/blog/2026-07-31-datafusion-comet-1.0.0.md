---
layout: post
title: Apache DataFusion Comet 1.0.0 Release
date: 2026-07-31
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

The Apache DataFusion PMC is pleased to announce version 1.0.0 of the [Comet](https://datafusion.apache.org/comet/) subproject.

Comet is an accelerator for Apache Spark that translates Spark physical plans to DataFusion physical plans for
improved performance and efficiency without requiring any code changes.

This release covers roughly six weeks of 
development since 0.17.0 and consists of 244 commits from 23 contributors. See the [change log] for more information.


[change log]: https://github.com/apache/datafusion-comet/blob/main/docs/source/changelog/1.0.0.md

## What 1.0 Means

The 1.0.0 release is the culmination of more than two year's work since the project was [donated] as an Apache DataFusion subproject in March, 2024, and is less about any single new feature than about the accumulated maturity of the project:

[donated]: https://datafusion.apache.org/blog/2024/03/06/comet-donation/

- **Broad Spark coverage.** Comet supports Apache Spark 3.4.3, 3.5.9, 4.0.4, and 4.1.3 out of the same
  codebase, with dedicated Maven profiles, shim sources, and CI matrices for each, plus an experimental
  Spark 4.2 profile for early evaluation. The
  [Spark version adoption and support-lifetime policy](https://github.com/apache/datafusion-comet/pull/4977)
  now states how long each Spark minor stays supported.
- **ANSI SQL by default.** Spark 4 enables ANSI semantics by default. Comet implements ANSI behavior for the
  expressions it supports natively, including arithmetic overflow checks, ANSI cast behavior, and `try_*`
  variants, so ANSI workloads keep accelerating rather than falling back.
- **A correctness harness, not just unit tests.** Comet runs the full Apache Spark SQL test suite through its
  native execution path against every supported Spark version. Running Spark's own correctness tests is what
  surfaces semantic shifts before they reach user workloads, and it is the foundation of the confidence behind
  a 1.0 release.
- **A stable release line going forward.** With 1.0, the project commits to semantic versioning. The
  [versioning policy](https://github.com/apache/datafusion-comet/pull/5056) spells out what that covers:
  because Comet is a plugin rather than a library, its configuration is its primary API surface, so
  `spark.comet.*` keys, an explicitly enumerated public Java and Scala API, and query results documented as
  Compatible are all part of the compatibility surface. Behavior changes in a minor release now require a
  `spark.comet.legacy.*` key that restores the previous behavior, and each release records its behavior changes
  in a user-facing upgrade guide. Correctness fixes are exempt from being treated as breaking changes. The very
  first deprecations under that policy are announced in this release (see
  [Deprecation Notice](#deprecation-notice) below).
- **Documented limitations.** Every open correctness issue is now surfaced in the generated compatibility guide
  ([#5085](https://github.com/apache/datafusion-comet/pull/5085)), down to the expression level, so you can see
  where Comet is known to diverge from Spark before you hit it in production rather than after. Notes for bugs
  that have since been fixed were removed in the same pass
  ([#5154](https://github.com/apache/datafusion-comet/pull/5154)).

The rest of this post covers what is new since 0.17.0.

## Native Expression Performance

A large share of this release is dedicated to making Comet's native scalar expressions faster. These kernels
run per-row or per-batch, so improvements here compound across every query that uses them:

- **`get_json_object`** ([#4907](https://github.com/apache/datafusion-comet/pull/4907)): roughly 4x faster.
- **`regexp_extract`** ([#4894](https://github.com/apache/datafusion-comet/pull/4894)) and **`parse_url`**
  ([#4893](https://github.com/apache/datafusion-comet/pull/4893)): optimized regex and URL parsing paths.
- **Casts**: a faster floating-point-to-decimal cast
  ([#4940](https://github.com/apache/datafusion-comet/pull/4940)), an optimized integer-to-integer cast
  ([#4920](https://github.com/apache/datafusion-comet/pull/4920)), shared no-overflow fast paths in
  `CheckOverflow` ([#4937](https://github.com/apache/datafusion-comet/pull/4937)) and
  `DecimalRescaleCheckOverflow` ([#4938](https://github.com/apache/datafusion-comet/pull/4938)), a ~40% faster
  `float64`-to-`utf8` cast ([#4918](https://github.com/apache/datafusion-comet/pull/4918)), an optimized
  `decimal128`-to-`utf8` cast ([#4924](https://github.com/apache/datafusion-comet/pull/4924)), string-to-date
  parsing up to 2x faster ([#4917](https://github.com/apache/datafusion-comet/pull/4917)),
  `parse_string_to_decimal` 30-40% faster ([#4916](https://github.com/apache/datafusion-comet/pull/4916)), and
  `cast_binary_to_string` up to 27x faster on binary-format styles
  ([#4912](https://github.com/apache/datafusion-comet/pull/4912)).
- **Decimal and date/time kernels**: `date_trunc` more than 2x faster
  ([#4915](https://github.com/apache/datafusion-comet/pull/4915)),
  `spark_ceil` 3x faster ([#4926](https://github.com/apache/datafusion-comet/pull/4926)), and a vectorized
  `spark_unscaled_value` 9x faster ([#4972](https://github.com/apache/datafusion-comet/pull/4972)).
- **String and array kernels**: `lpad` ([#4919](https://github.com/apache/datafusion-comet/pull/4919)),
  `unhex` ([#4876](https://github.com/apache/datafusion-comet/pull/4876)),
  `size` ([#4877](https://github.com/apache/datafusion-comet/pull/4877)),
  `arrays_overlap` ([#4906](https://github.com/apache/datafusion-comet/pull/4906)),
  `escape_string` ([#4902](https://github.com/apache/datafusion-comet/pull/4902)), and the
  `try_*` arithmetic kernel ([#4910](https://github.com/apache/datafusion-comet/pull/4910)).

To make this kind of work repeatable, the release also adds a
[scalar expression optimization guide](https://github.com/apache/datafusion-comet/pull/4933) documenting how
to benchmark a kernel, keep its output bit-identical to Spark, and gate changes on a no-regression check.

On the scan side, Parquet reads pick up several improvements: full Parquet metadata (including the page index)
is now cached via DataFusion's `CachedParquetFileReaderFactory`
([#4707](https://github.com/apache/datafusion-comet/pull/4707)), identity casts are unwrapped in the schema
adapter so Parquet statistics pruning can engage
([#4730](https://github.com/apache/datafusion-comet/pull/4730)), filter pushdown configuration has been
revised ([#4722](https://github.com/apache/datafusion-comet/pull/4722)), the native scan now passes a metadata
size hint so a single read usually captures the footer, matching the Iceberg path
([#4717](https://github.com/apache/datafusion-comet/pull/4717)), and the native Parquet scan seeds its reader
options from the session config so Parquet settings you already set take effect
([#5107](https://github.com/apache/datafusion-comet/pull/5107)).

Query planning and plan serialization also got cheaper. `QueryContext` SQL text is now interned into a per-plan
pool ([#5204](https://github.com/apache/datafusion-comet/pull/5204)), which makes serialized plans up to 20x
smaller on TPC-DS — every plan crosses the JNI boundary, so this shrinks per-query overhead across the board.
Plan-data injection is now an O(1) lookup by operator kind
([#4535](https://github.com/apache/datafusion-comet/pull/4535)) and no longer rebuilds operators it does not
touch ([#5220](https://github.com/apache/datafusion-comet/pull/5220)). Comet also makes far fewer timer calls
in the native execution loop ([#4739](https://github.com/apache/datafusion-comet/pull/4739)), and nested array
equality now uses Arrow's comparator ([#5176](https://github.com/apache/datafusion-comet/pull/5176)).

## Correctness

A 1.0 release is only as good as its results. This release fixes a broad set of divergences from Spark, most of
them found by running extensive AI-assisted audit sweeps of the code base, comparing Comet's expression implementations with all supported versions of Spark.

- **Casts**: casting a string to `boolean`, an integral type, `float`/`double`, or `decimal` now uses Spark's
  exact whitespace-trimming rules ([#5150](https://github.com/apache/datafusion-comet/pull/5150)). Comet's
  kernels had used four different trim sets, three of them wrong, so results diverged in both directions —
  returning null where Spark parses a value, and returning a value where Spark returns null. Casting
  `float`/`double` to `decimal` now rounds the shortest decimal string form as Spark does, rather than the
  binary value ([#5136](https://github.com/apache/datafusion-comet/pull/5136)), which matters for values such
  as `0.5153125` whose binary form sits just below the rounding tie the string form lands on; `NaN` and infinity
  now return null even in ANSI mode, matching Spark. Decimal promotion also uses the per-expression eval mode
  ([#5171](https://github.com/apache/datafusion-comet/pull/5171)).
- **ANSI error semantics**: the codegen dispatcher's null short-circuit no longer swallows errors Spark raises
  ([#5219](https://github.com/apache/datafusion-comet/pull/5219)) — Spark evaluates null-intolerant expressions
  per node and left to right, so short-circuiting on the union of input ordinals skipped subtrees Spark would
  have evaluated, losing their errors. Roughly 70 built-in expressions route through this dispatcher and ANSI is
  on by default in Spark 4, so this affected a wide surface. Also: `round` on a `Long` with a large negative
  scale now overflows instead of silently returning zero
  ([#5082](https://github.com/apache/datafusion-comet/pull/5082)), `Long.MinValue / -1` raises
  `ARITHMETIC_OVERFLOW` ([#5084](https://github.com/apache/datafusion-comet/pull/5084)), floating-point
  `x % 0.0` raises `REMAINDER_BY_ZERO` instead of returning `NaN`
  ([#5081](https://github.com/apache/datafusion-comet/pull/5081)), `make_decimal` honors its
  fail-on-error flag and throws `NUMERIC_VALUE_OUT_OF_RANGE` rather than returning null
  ([#5080](https://github.com/apache/datafusion-comet/pull/5080)), invalid calendar dates raise
  `CAST_INVALID_INPUT` ([#5014](https://github.com/apache/datafusion-comet/pull/5014)), and errors from nested
  casts now propagate ([#4675](https://github.com/apache/datafusion-comet/pull/4675)).
- **Wrong results**: `count` no longer returns zero when the native scan is disabled
  ([#4795](https://github.com/apache/datafusion-comet/pull/4795)), Spark's legacy `null IN ()` behavior is
  honored ([#5127](https://github.com/apache/datafusion-comet/pull/5127)), `pow` matches Java's `Math.pow` on
  the edge cases where C and Java disagree ([#5033](https://github.com/apache/datafusion-comet/pull/5033)),
  `percentile` matches Spark's interpolation precision
  ([#4792](https://github.com/apache/datafusion-comet/pull/4792)), `date_trunc` handles DST boundaries in
  non-UTC sessions and no longer produces schema mismatches through shuffle and sort
  ([#4761](https://github.com/apache/datafusion-comet/pull/4761)), `flatten` handles null sub-arrays
  ([#4822](https://github.com/apache/datafusion-comet/pull/4822)), `ArrayInsert` handles null source arrays
  ([#4726](https://github.com/apache/datafusion-comet/pull/4726)), and the `array_filter` / `array_compact`
  fast path is restricted to the lambda variable
  ([#4848](https://github.com/apache/datafusion-comet/pull/4848)).
- **Strings and encodings**: `CAST(binary AS string)` now decodes exactly as the JVM's
  `new String(bytes, UTF_8)` does, including the surrogate cases where Rust's lossy decoder diverges, instead
  of reinterpreting bytes unchecked ([#4763](https://github.com/apache/datafusion-comet/pull/4763)), and
  shuffle tolerates non-UTF-8 bytes rather than failing
  ([#4524](https://github.com/apache/datafusion-comet/pull/4524)).
- **Timestamps**: reading a Parquet timestamp-with-timezone column as `TimestampNTZ` is now rejected on Spark
  3.x, matching Spark's own refusal, instead of silently returning the UTC instant
  ([#4357](https://github.com/apache/datafusion-comet/pull/4357)).
- **Deep expression trees**: long chains of associative bitwise, `Add`, and `Multiply` operators are rebalanced
  so plans no longer hit protobuf's recursion limit
  ([#4588](https://github.com/apache/datafusion-comet/pull/4588)).
- **Native shuffle**: scalar subqueries used in partitioning expressions are now registered, fixing
  "Subquery N not found" failures ([#4869](https://github.com/apache/datafusion-comet/pull/4869)), and constant
  column vectors are materialized on Comet's serialize and export paths
  ([#4532](https://github.com/apache/datafusion-comet/pull/4532)).
- **Collations**: Comet falls back for predicates whose operands use non-default collations
  ([#4948](https://github.com/apache/datafusion-comet/pull/4948)), for Spark 4 datetime expressions under
  non-default collations ([#4693](https://github.com/apache/datafusion-comet/pull/4693)), and for
  `str_to_map` ([#4701](https://github.com/apache/datafusion-comet/pull/4701)).
- **Conservative fallbacks** where native behavior could not be made to match: decimal `SUM` / `AVG` over
  sliding window frames ([#4732](https://github.com/apache/datafusion-comet/pull/4732)),
  `FromUnixTime` with a non-default format ([#4847](https://github.com/apache/datafusion-comet/pull/4847)),
  `CreateArray` with struct-nullability-divergent children
  ([#4533](https://github.com/apache/datafusion-comet/pull/4533)), and native V1 scans on filesystem schemes
  that `object_store` does not support ([#4525](https://github.com/apache/datafusion-comet/pull/4525)).
- **Error reporting**: native Parquet read failures now surface as Spark's `FAILED_READ_FILE`
  ([#4536](https://github.com/apache/datafusion-comet/pull/4536)), and a DataFusion 54.1.0 Parquet page-index
  regression is worked around ([#5132](https://github.com/apache/datafusion-comet/pull/5132)).

## New Expression and Aggregate Support

This release expands the set of Spark expressions and aggregates that run natively:

- **Aggregates**: `approx_percentile` / `percentile_approx`
  ([#4801](https://github.com/apache/datafusion-comet/pull/4801)), exact `percentile` / `median`
  ([#4542](https://github.com/apache/datafusion-comet/pull/4542)),
  `approx_count_distinct` ([#4819](https://github.com/apache/datafusion-comet/pull/4819)), and native
  `collect_list` / `array_agg` ([#4720](https://github.com/apache/datafusion-comet/pull/4720)).
- **Grouping**: `grouping()` and `grouping_id()` indicator functions
  ([#4815](https://github.com/apache/datafusion-comet/pull/4815)).
- **Intervals**: interval types with `make_ym_interval` and `make_dt_interval`
  ([#4541](https://github.com/apache/datafusion-comet/pull/4541)),
  `CalendarIntervalType` support ([#4898](https://github.com/apache/datafusion-comet/pull/4898)),
  `multiply_dt_interval` via codegen dispatch
  ([#4900](https://github.com/apache/datafusion-comet/pull/4900)), and interval codegen dispatch for nested
  values and native shuffle ([#4976](https://github.com/apache/datafusion-comet/pull/4976)).
- **String**: `base64` ([#4778](https://github.com/apache/datafusion-comet/pull/4778)),
  `split_part` via `StringSplitSQL` ([#4592](https://github.com/apache/datafusion-comet/pull/4592)),
  native `levenshtein` ([#4105](https://github.com/apache/datafusion-comet/pull/4105)), and native
  `randstr` ([#5035](https://github.com/apache/datafusion-comet/pull/5035)) and `uuid`
  ([#5034](https://github.com/apache/datafusion-comet/pull/5034)), both bit-for-bit compatible with Spark for a
  given seed.
- **Array / map**: `array_prepend` ([#4716](https://github.com/apache/datafusion-comet/pull/4716)),
  the `shuffle()` array function ([#4797](https://github.com/apache/datafusion-comet/pull/4797)),
  `size()` for `MapType` ([#4580](https://github.com/apache/datafusion-comet/pull/4580)), `ElementAt` over
  `MapType` ([#4697](https://github.com/apache/datafusion-comet/pull/4697)), and removal of the constraint on
  arrays of nested elements ([#4714](https://github.com/apache/datafusion-comet/pull/4714)).
- **Date/time**: native `TimestampNTZ` inputs for `hour` / `minute` / `second`
  ([#4753](https://github.com/apache/datafusion-comet/pull/4753)) and
  `PreciseTimestampConversion` for native time-window grouping
  ([#4784](https://github.com/apache/datafusion-comet/pull/4784)).
- **Windows**: extended native window function support
  ([#4209](https://github.com/apache/datafusion-comet/pull/4209)) and Spark 4 decimal window average
  ([#4749](https://github.com/apache/datafusion-comet/pull/4749)).
- **Internal expressions**: native `empty2null`
  ([#4683](https://github.com/apache/datafusion-comet/pull/4683)), which appears in write paths, and the
  shuffle-side infrastructure for Spark's `TimeType`
  ([#4398](https://github.com/apache/datafusion-comet/pull/4398)).

## Native Sampling

Spark's `SampleExec` now runs natively when sampling without replacement
([#5110](https://github.com/apache/datafusion-comet/pull/5110)), covering `DataFrame.sample`, SQL
`TABLESAMPLE`, and `DataFrame.randomSplit`. The native operator ports Spark's `BernoulliCellSampler` on top of
`XorShiftRandom` and seeds per partition exactly as Spark does, so it selects the same rows for a given seed —
sampling stays reproducible whether or not Comet is enabled. Sampling with replacement still falls back to
Spark.

## Experimental PyArrow UDF Support

This release adds experimental support for accelerated PyArrow UDFs
([#4234](https://github.com/apache/datafusion-comet/pull/4234)), allowing PyArrow-based user-defined functions
to participate in native execution instead of forcing a fallback to Spark. When the feature is disabled, Comet
now hints at the native PyArrow UDF path in its fallback reasons
([#4892](https://github.com/apache/datafusion-comet/pull/4892)) so users know the option exists. This is an
early-stage feature and we welcome feedback from users experimenting with it.

## Iceberg

- **Iceberg 1.11 support** ([#4840](https://github.com/apache/datafusion-comet/pull/4840)): adds support for
  Iceberg 1.11, audits the existing Iceberg diffs, bumps the iceberg-rust dependency, and adds a
  `run-iceberg-tests` CI trigger.
- **Iceberg table format V3** ([#4991](https://github.com/apache/datafusion-comet/pull/4991)): native table
  decryption for V3 tables, with fallback to Spark for other V3 features. Follow-up
  [#5020](https://github.com/apache/datafusion-comet/pull/5020) applies the same diff changes across other
  Iceberg versions.
- **Metadata columns** ([#4752](https://github.com/apache/datafusion-comet/pull/4752)): the native Iceberg scan
  now supports the `_pos`, `_spec`, `_file`, and `_partition` metadata columns.
- **Delete-file correctness** ([#4760](https://github.com/apache/datafusion-comet/pull/4760)): the native scan
  now sizes Iceberg delete files correctly, avoiding dropped deletes.
- **Exchange-reuse correctness** ([#4812](https://github.com/apache/datafusion-comet/pull/4812)): fixed a case
  where Iceberg native scan exchange reuse with different pushed filters could produce wrong results.
- **Scan disambiguation** ([#5180](https://github.com/apache/datafusion-comet/pull/5180)): Iceberg scans that
  share a `metadata_location` are now told apart, rather than being conflated.
- **Native serde dedup** ([#4982](https://github.com/apache/datafusion-comet/pull/4982)): dedupes Iceberg
  residuals and delete files in the native scan serde, reducing planning overhead.

## Native Parquet I/O and Cloud

- **gzip Parquet writes** ([#4930](https://github.com/apache/datafusion-comet/pull/4930)): native Parquet
  writes now support gzip compression.
- **Azure authentication** ([#4783](https://github.com/apache/datafusion-comet/pull/4783)): the native
  Parquet scan now supports Azure authentication, complementing the existing S3 credential support.

## Execution and Fallback Improvements

- **Mixed partial/final aggregation** ([#4861](https://github.com/apache/datafusion-comet/pull/4861)):
  `sum` and non-decimal `avg` can now run with the partial and final aggregation stages split across Spark and
  Comet, keeping more aggregation plans partially native.
- **Stage-based fallback** ([#4519](https://github.com/apache/datafusion-comet/pull/4519)): a more granular
  fallback mechanism that operates at the stage level.
- **Codegen dispatch for opt-in serdes** ([#4728](https://github.com/apache/datafusion-comet/pull/4728)):
  expressions reported as `Unsupported` can now route through JVM codegen dispatch for opt-in serdes, and
  native opt-in expressions surface as compatible-by-default with a `COMET-INFO` plan hint
  ([#4721](https://github.com/apache/datafusion-comet/pull/4721)). Casts join this path
  ([#5079](https://github.com/apache/datafusion-comet/pull/5079)): an incompatible or unsupported cast now runs
  Spark's own generated code inside the Comet pipeline instead of pulling the whole operator back to Spark, so
  one awkward cast no longer de-accelerates a query. `sort_array` under strict floating-point mode
  ([#4637](https://github.com/apache/datafusion-comet/pull/4637)) and `concat` under non-`UTF8_BINARY`
  collations ([#4640](https://github.com/apache/datafusion-comet/pull/4640)) opt in the same way.
- **JVM columnar-to-row by default** ([#5114](https://github.com/apache/datafusion-comet/pull/5114)): isolated
  benchmarking showed the native columnar-to-row converter is roughly 3.7x slower per row than the JVM
  implementation at the default batch size — and up to 15.7x slower for small batches — because of a fixed
  per-batch JNI and FFI cost, with no end-to-end benefit in TPC-DS runs. It is now disabled by default.
- **Clearer fallback reasons**: unsupported scalar serde cases are reported in the support level
  ([#4745](https://github.com/apache/datafusion-comet/pull/4745)), mixed-execution fallback messages name the
  incompatible aggregate functions ([#4750](https://github.com/apache/datafusion-comet/pull/4750)), unsupported
  metadata column names appear in fallback reasons
  ([#4758](https://github.com/apache/datafusion-comet/pull/4758)), the compatibility guide URLs in fallback
  messages are corrected ([#4854](https://github.com/apache/datafusion-comet/pull/4854)), and the spurious
  "WriteFilesExec is not supported" message is suppressed
  ([#4928](https://github.com/apache/datafusion-comet/pull/4928)).
- **Expression coverage in extended explain** ([#5201](https://github.com/apache/datafusion-comet/pull/5201)):
  the extended explain summary previously reported operator coverage but said nothing about expressions. It now
  ends with a line such as `Comet accelerated 14 expressions (14 native, 1 codegen dispatch)`, so you can see
  how much of a plan's expression evaluation runs in native DataFusion kernels versus Spark's generated code
  inside the dispatcher. Operator counts also handle `ReusedSubquery` and `CometSubqueryBroadcast` correctly
  ([#5206](https://github.com/apache/datafusion-comet/pull/5206)).
- **Local scan nullability** ([#4843](https://github.com/apache/datafusion-comet/pull/4843)): local table scan
  child nullability is now widened to match the native kernels, fixing a class of nullability mismatches.
- **Config aliases** ([#4979](https://github.com/apache/datafusion-comet/pull/4979)): a `withAlternative`
  alias mechanism lets `CometConf` entries carry old names during renames without breaking existing
  configurations.
- **Runtime cleanup** ([#4734](https://github.com/apache/datafusion-comet/pull/4734)): the Tokio runtime is
  now released on driver and executor exit.
- **Quieter logs** ([#5155](https://github.com/apache/datafusion-comet/pull/5155)): logging levels on frequent
  call sites have been lowered so Comet no longer floods executor logs at default settings.
- **Contrib scan SPI** ([#4700](https://github.com/apache/datafusion-comet/pull/4700)): a core SPI for
  contrib leaf scans (`CometScanWithPlanData`), the first part of splitting the Delta integration into a
  contrib module.

## Shuffle Improvements

- **Native shuffle memory cap** ([#4989](https://github.com/apache/datafusion-comet/pull/4989)): a new
  `spark.comet.shuffle.maxBufferBytes` config caps native shuffle writer memory to bound worst-case usage.
- **Shuffle IPC schema encoding** ([#5006](https://github.com/apache/datafusion-comet/pull/5006)): the IPC
  schema is now encoded once per writer instead of per block, cutting per-batch shuffle overhead.
- **BatchCoalescer bypass** ([#5003](https://github.com/apache/datafusion-comet/pull/5003)): shuffle bypasses
  the `BatchCoalescer` for batches that are already appropriately sized.
- **Single-partition shuffle** ([#5004](https://github.com/apache/datafusion-comet/pull/5004)): a redundant
  concatenation layer has been removed from the single-partition path.

## Configuration Changes

Because configuration is Comet's primary API surface, 1.0 is the release where the naming gets cleaned up.
Every rename below registers the old key as an alias, so existing configurations keep working and log a
deprecation warning when an old key is read:

- **Unified shuffle prefix** ([#4986](https://github.com/apache/datafusion-comet/pull/4986)): shuffle configs
  were spread across four disjoint prefixes (`spark.comet.exec.shuffle.*`, `spark.comet.columnar.shuffle.*`,
  `spark.comet.native.shuffle.*`, `spark.comet.shuffle.*`). They now all live under `spark.comet.shuffle.*`,
  with `.jvm.` and `.native.` sub-namespaces matching the `spark.comet.shuffle.mode` value you already set.
- **Grouped explain configs** ([#5026](https://github.com/apache/datafusion-comet/pull/5026)): the orphan
  explain-related configs are collected under a single `spark.comet.explain.*` prefix, and the PyArrow UDF
  config is renamed to `pyarrowUDF` for consistency
  ([#5197](https://github.com/apache/datafusion-comet/pull/5197)).
- **`spark.comet.version`** ([#5049](https://github.com/apache/datafusion-comet/pull/5049)): the loaded Comet
  build version is now exposed as a runtime config, so you can confirm which Comet a cluster is actually
  running with `spark.conf.get` or `SET`.
- **Removed dead configs**: the Parquet parallel-IO knobs
  ([#4981](https://github.com/apache/datafusion-comet/pull/4981)),
  `spark.comet.use.lazyMaterialization` ([#4998](https://github.com/apache/datafusion-comet/pull/4998)), and
  `spark.comet.exceptionOnDatetimeRebase` ([#5221](https://github.com/apache/datafusion-comet/pull/5221)) had no
  remaining effect and were misleading anyone tuning against them.
- **Removed async columnar shuffle** ([#4985](https://github.com/apache/datafusion-comet/pull/4985)): the
  `spark.comet.columnar.shuffle.async.*` path was off by default and untested, and has been removed rather than
  carried into a stable release line.

## Documentation

The documentation received a substantial overhaul for 1.0:

- A [design refresh](https://github.com/apache/datafusion-comet/pull/4353) of the docs site, with versioned
  user guides gaining captioned sidebar sections
  ([#4699](https://github.com/apache/datafusion-comet/pull/4699)) and a set of accessibility and navigation
  fixes ([#4858](https://github.com/apache/datafusion-comet/pull/4858)).
- The supported-expressions page now shows how each expression is implemented — native, codegen dispatch, or
  hybrid ([#5028](https://github.com/apache/datafusion-comet/pull/5028)), generated from the planner itself
  rather than maintained by hand.
- An expanded [tuning guide](https://github.com/apache/datafusion-comet/pull/4908) covering the performance and
  memory configs that matter in practice, plus guidance on `spark.sql.files.maxPartitionBytes`
  ([#4931](https://github.com/apache/datafusion-comet/pull/4931)).
- An [updated roadmap](https://github.com/apache/datafusion-comet/pull/5064) for the post-1.0 work, and a new
  [blog posts and talks page](https://github.com/apache/datafusion-comet/pull/5043).

## Deprecation Notice

With the move to a stable 1.0 release line, Comet begins deprecating older platforms under semantic versioning
([#4857](https://github.com/apache/datafusion-comet/pull/4857)):

- **JDK 11** is deprecated and scheduled for removal in Comet 1.1.0.
- **Apache Spark 3.4** is deprecated and scheduled for removal in Comet 1.1.0.

Users on these platforms should plan to move to JDK 17+ and Spark 3.5 or later before upgrading to 1.1.0.

## Compatibility

Supported platforms include:

- **Spark 3.4.3** with Java 11/17 and Scala 2.12/2.13 (deprecated, removal in 1.1.0)
- **Spark 3.5.9** with Java 11/17 and Scala 2.12/2.13
- **Spark 4.0.4** with Java 17 and Scala 2.13
- **Spark 4.1.3** with Java 17/21 and Scala 2.13
- **Spark 4.2** with Java 17 and Scala 2.13 (experimental, for early evaluation only)

See the [Spark Version Compatibility] page for known limitations specific to each version.

[Spark Version Compatibility]: https://datafusion.apache.org/comet/user-guide/latest/compatibility/spark-versions.html

This release upgrades to **DataFusion 54.1** and **Arrow 58.4**.

## Get Started with Comet 1.0.0

Ready to try it out? Follow the [Comet 1.0.0 Installation Guide](https://datafusion.apache.org/comet/user-guide/1.0/installation.html)
to get up and running, then point Comet at your existing Spark workloads and see the speedup for yourself.
