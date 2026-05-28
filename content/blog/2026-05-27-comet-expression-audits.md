---
layout: post
title: "Auditing Every Spark Expression in DataFusion Comet: 12 PRs, 14 Issues, Four Spark Versions"
date: 2026-05-27
author: agrove
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

[Apache DataFusion Comet](https://datafusion.apache.org/comet/) is a high-performance accelerator for [Apache Spark](https://spark.apache.org/), built on top of [Apache DataFusion](https://datafusion.apache.org/). It transparently swaps Spark's JVM operators and expressions for native Rust implementations, with results streamed back through [Apache Arrow](https://arrow.apache.org/). When it works, it's invisible: the same SQL, the same answers, but faster.

The "same answers" part is where it gets interesting.

Spark has hundreds of built-in expressions. Each one is a tiny contract between Spark and the user about how a particular function behaves: what inputs it accepts, how it treats NULLs, whether it throws under ANSI mode, what `+0.0` versus `-0.0` means, how it formats a `BinaryType` value as a string. Comet has to replicate each of those contracts in Rust, and it has to do so for every supported Spark version — currently 3.4.3, 3.5.8, 4.0.1, and 4.1.1.

Over the past week, we ran a **systematic audit of every supported expression in Comet** against all four Spark versions. Twelve audit PRs landed, fourteen new tracking issues were filed for higher-risk findings, and one tooling-improvement PR tightened the audit process itself. This post describes what we did, what we learned, and what we changed about how Comet documents Spark compatibility going forward.

## Why audit at all?

A Comet expression has more moving parts than it looks like from the outside:

1. **The Spark side.** Each Spark version ships a `case class` (e.g. `Substring(str, pos, len)`) with `inputTypes`, `nullSafeEval`, codegen, and a thicket of edge cases around NULL, ANSI mode, overflow, timezone, collation, and so on.
2. **The Comet Scala serde.** This is the bridge that decides whether Comet can handle this particular expression instance, and if so, serializes it to a protobuf for the native side.
3. **The native Rust implementation.** Either a custom `spark_*` UDF in `datafusion-comet-spark-expr`, or a passthrough to a DataFusion or `datafusion-spark` function.
4. **The compatibility doc.** The auto-generated [compatibility guide](https://datafusion.apache.org/comet/user-guide/compatibility.html) tells users what is supported, what is incompatible, and what falls back to Spark.

All four pieces have to agree. Each Spark version can subtly change the contract under one of them. The audit's job is to walk every expression and check that they still do.

## The audit skill

We previously published an [`audit-comet-expression` skill](https://github.com/apache/datafusion-comet/blob/main/.claude/skills/audit-comet-expression/SKILL.md) for [Claude Code](https://claude.com/claude-code) — a structured checklist that, given an expression name, drives an LLM agent through the audit steps:

1. Clone the relevant Spark version tags (currently `v3.4.3`, `v3.5.8`, `v4.0.1`, `v4.1.1`).
2. Read the Spark `case class` in each version, diffing them and noting input types, NULL handling, ANSI behaviour, version-specific changes.
3. Read the Comet serde (`spark/src/main/scala/org/apache/comet/serde/`) and audit four interrelated methods that must stay aligned: `getSupportLevel`, `getIncompatibleReasons`, `getUnsupportedReasons`, and `convert`.
4. Read the Rust implementation and check for behavioural divergences (overflow, NULL propagation, type dispatch, ANSI mode).
5. Read existing tests and identify coverage gaps.
6. Produce a structured report: cross-version notes, Step 5 consistency issues, high-priority correctness findings, and suggested documentation bullets.

The skill enforces a particular discipline that we found important: **any finding the audit PR doesn't fix inline must be filed as a GitHub issue** before the PR is opened. Prose recommendations in a PR description die with the PR. A filed issue survives.

## The Step 5 consistency audit

The most common bug we found in Comet serdes isn't a wrong answer — it's a mismatch between the four parts of a serde that have to agree:

- `getSupportLevel(expr)` returns `Compatible`, `Incompatible(reason)`, or `Unsupported(reason)` at planning time.
- `getIncompatibleReasons()` enumerates every reason the support level could return as `Incompatible`. It feeds the auto-generated compatibility doc.
- `getUnsupportedReasons()` does the same for `Unsupported`.
- `convert(expr)` actually builds the proto.

When these drift apart, users see two kinds of confusion. They run `EXPLAIN` and get one reason; they open the compatibility guide and see a different one — or none at all. Or they enable `spark.comet.expr.allowIncompatible=true`, expecting the path to run, only to find it still falls back because `convert` does its own check internally.

Common antipatterns we corrected during the audit:

- **`Incompatible(None)` with a populated `getIncompatibleReasons()`.** The reason makes it to the docs but not to `EXPLAIN`. Users see "is not fully compatible with Spark" with no specifics. Found in `CometInitCap`, `CometRegExpReplace`, `CometArrayExcept`, `CometArrayJoin`. Fix: pipe the reason through `Incompatible(Some(reason))` via a shared `private val`.

- **Reason text duplicated across two places without a shared constant.** Found in `CometLength` (BinaryType reason), `CometRegExpReplace`, `CometGetJsonObject`, `CometStringLPad`/`RPad` (pad/str scalar restrictions). Fix: hoist to `private val` and reference from both.

- **Compatibility decisions inside `convert` instead of `getSupportLevel`.** When `convert` does `if (!conf.X) { withInfo(...); None }`, the dispatcher's `allowIncompatible` flag does nothing. Found in `CometCaseConversionBase` (lifted into a tracking issue: #4467). For literal-only restrictions (e.g. `CometSubstring`, `CometLeft`, `CometRight`), we lifted the check into `getSupportLevel` inline.

- **Side-effecting helpers.** `HashUtils.isSupportedType` called `withInfo(expr, ...)` from inside a recursive type check used by every hash serde, mixing planning logic with EXPLAIN side effects. We refactored it to return reasons as `Option[String]` and let each serde call it from `getSupportLevel`.

- **`Incompatible` masquerading as `Unsupported`.** `CometConcat` reported the non-string-input branch as `Incompatible` even though Comet had no native path for it — setting `allowIncompatible=true` wouldn't help, it would just push the failure to runtime. Relabelled to `Unsupported`.

These are the cheapest, highest-leverage fixes the audit produces. They're mechanical, fully test-covered, and they keep the documentation honest. Every audit PR carries at least a handful.

## What the cross-version diff actually looks like

The cross-version comparison was eye-opening in two ways: how much Spark **doesn't** change, and how concentrated the changes are when they happen.

Across nearly every category, the Spark 3.4.3 -> 3.5.8 step is a no-op. The 3.5.8 -> 4.0.1 step is dominated by two systematic refactors:

- The `NullIntolerant` marker trait was removed and replaced everywhere with an `override def nullIntolerant: Boolean = true`. This affects almost every leaf and unary expression but changes no runtime behaviour.
- `StringType` literals were generalised to `_: StringType` to accommodate collated strings. The `inputTypes` on string-touching expressions widened to `StringTypeWithCollation(supportsTrimCollation = true)`. Runtime behaviour for the default `UTF8_BINARY` collation is unchanged.

The 4.0.1 -> 4.1.1 step is even smaller for most expressions, with two notable additions:

- `TimeType` (HH:mm:ss) is a brand-new type. Most expressions don't touch it, but `Cast`, `Hash`, and a few datetime functions need new arms to handle it.
- A new `legacySplitTruncate` flag driven by `spark.sql.legacy.truncateForEmptyRegexSplit` reaches several split-based expressions (`StringSplit`, `StringToMap`). The non-legacy default matches Comet today; the legacy mode is a fresh divergence we now track.

So the practical upshot for Comet's audit: most expressions get a one-line "byte-for-byte identical to baseline" note for three of the four versions, with a one-sentence Spark-4.0-mostly bullet calling out the trait refactor and any collation widening. The exceptions are the headline ones — `Cast`, `RegExpReplace`, `Lower/Upper/InitCap`, `Hex/Unhex`, `StringToMap` — where 4.0 or 4.1 introduced behavioural change that Comet now has to reason about explicitly.

## Findings worth filing

Twelve audit PRs together filed fourteen new GitHub issues. A representative sample:

**Correctness divergences in float / decimal handling**

- [#4481](https://github.com/apache/datafusion-comet/issues/4481): `array_distinct`, `array_union`, and `array_except` do not canonicalize NaN and signed-zero the way Spark's `SQLOpenHashSet` does. `array_distinct(array(NaN, NaN))` returns one element in Spark, two in Comet.
- [#4482](https://github.com/apache/datafusion-comet/issues/4482): `array_max` and `array_min` use Arrow's `partial_cmp`-based ordering, which produces IEEE NaN semantics, not Spark's "NaN is greater than any non-NaN" rule.

**Spark 4.x features Comet hasn't caught up to**

- [#4477](https://github.com/apache/datafusion-comet/issues/4477): `str_to_map` does not honour Spark 4.1.1's `legacy.truncateForEmptyRegexSplit`.
- [#4465](https://github.com/apache/datafusion-comet/issues/4465): `decode` ignores Spark 4.0's `legacyCharsets` and `legacyErrorAction` flags, so invalid UTF-8 always becomes NULL rather than the replacement-character substitution Spark 3.x produced or the malformed-character error Spark 4.0 raises.
- [#4490](https://github.com/apache/datafusion-comet/issues/4490): `cast` has no explicit `TimeType` arm. The path falls back implicitly but never appears in the compatibility doc.

**Robustness and wiring gaps**

- [#4488](https://github.com/apache/datafusion-comet/issues/4488): `CAST(<binary> AS STRING)` uses `unsafe { String::from_utf8_unchecked }`. The result is byte-for-byte what Spark produces today, but the path is undefined behaviour in Rust for non-UTF8 inputs.
- [#4464](https://github.com/apache/datafusion-comet/issues/4464): `bit_length` and `octet_length` are wired as raw `CometScalarFunction` calls with no `BinaryType` guard. DataFusion's signature rejects Binary at execution time, so a query that should fall back cleanly instead surfaces a native execution error.
- [#4485](https://github.com/apache/datafusion-comet/issues/4485): `width_bucket` is wired through `CometExprShim` instead of a `CometExpressionSerde`, bypassing the support-level framework entirely. It works, but it's invisible to the compatibility doc and to per-expression configs.

**Feature gaps where the native path exists but the wiring doesn't use it**

- [#4471](https://github.com/apache/datafusion-comet/issues/4471): `concat` for `BinaryType` and `ArrayType` falls back to Spark even though DataFusion's `array_concat` could serve the array case.
- [#4472](https://github.com/apache/datafusion-comet/issues/4472): `size` for `MapType` falls back even though Arrow's MapArray carries a length per row.
- [#4491](https://github.com/apache/datafusion-comet/issues/4491): `CAST(<map> AS <map>)` falls back even though native `cast_map_to_map` exists.

**Pattern antipatterns**

- [#4467](https://github.com/apache/datafusion-comet/issues/4467): `CometCaseConversionBase` gates its compatibility check inside `convert()` instead of `getSupportLevel`, so `spark.comet.expr.allowIncompatible=true` has no effect on `lower` / `upper`.
- [#4484](https://github.com/apache/datafusion-comet/issues/4484): `try_mod` falls back because `CometRemainder` rejects `EvalMode.TRY`, even though every sibling arithmetic serde accepts it.

None of these are catastrophic. Most are corner cases. But each one is now a tracked, reproducible issue with a minimal example and a known cause — instead of a comment buried in a `withInfo` call somewhere.

## Going wide: parallel subagents per category

The full audit touched roughly 250 SQL function names across 19 categories. To stay tractable, we split the work category-by-category, then within each category dispatched multiple agents in parallel for groups of related expressions. Each subagent had a tight, single-purpose prompt:

> You are doing a read-only audit of Comet `<group>` serdes. Spark sources are at `/tmp/spark-v...`. Working directory is `<worktree>`. Return a structured report with cross-version notes, Step 5 consistency issues, high-priority findings, and suggested doc sub-bullets.

The main session then collected the structured reports, applied any agreed mechanical fixes inline, filed issues for the higher-risk findings, updated the support-doc with cross-referenced sub-bullets, and opened the PR.

Because each subagent worked from an isolated, named-prompt context — and because the skill enforces a fixed output format — the per-category PRs ended up structurally consistent. They all have the same shape:

```
## Support-doc audit notes
## Support-level consistency fixes (in <file>.scala)
## Tracking issues filed for follow-up
## Audit process
## How are these changes tested?
```

That consistency is the audit's main durable artefact. Six months from now, a reader can open `spark_expressions_support.md`, find the function they care about, and see a per-version note plus links to every open issue affecting it.

## What the skill itself learned

One audit-skill change shipped during this effort. The original skill text permitted leaving semantics-decision findings as "prose recommendations in the PR description and call it out for the reviewer." In practice, that prose dies with the PR. Several findings from the string-expressions audit (the first run of the new skill) had to be filed retroactively as #4462 through #4467 because the skill did not enforce filing an issue.

[PR #4468](https://github.com/apache/datafusion-comet/pull/4468) tightened the skill so that every high-priority finding either becomes an inline fix and test, or a filed GitHub issue with an ignored regression test, before the audit PR is opened. The PR also added Spark 4.1.1 to the version list so future audits diff against four versions instead of three.

The next time the skill runs against a category, both behaviours kick in automatically. There's no review burden to remember "make sure they filed issues" — it's built into the workflow.

## What's left

This audit covered every currently supported expression in the `spark_expressions_support.md` document. The categories without any supported expressions (`csv_funcs`, `generator_funcs`, `lambda_funcs`, `window_funcs`, `xml_funcs`, and the unsupported half of every other category) were not touched by this round because they have no Comet serdes to audit. They are tracked under the existing implementation epics.

The audit also intentionally **deferred** several classes of finding:

- **Test additions** for medium-risk uncovered axes (locale-sensitive case conversion, non-default collation, multi-byte UTF-8 edge cases). The skill calls these out in the PR bodies; they're follow-up work, not audit work.
- **Restructuring `CometCast`** to add `TimeType`, `MapType`, and collated-string arms. The issues are filed (#4490, #4491, #4489); the implementation is a separate stream.
- **Mechanical Step-5 fixes in `arithmetic.scala`.** Several `convert`-time `withInfo` calls could be lifted into `getSupportLevel`, but the file is unusually load-bearing and we wanted the audit PRs to stay low-risk. Documented in the math PR body.

## Try it yourself

If you're running Comet against Spark today and you care about a specific expression, the audit gives you a single place to look. The [Spark Expressions Support](https://datafusion.apache.org/comet/contributor-guide/spark_expressions_support.html) doc now records, per expression, what Spark does in each of the four supported versions, what Comet does, and what's filed against any divergence.

If you find something the audit missed, please file an issue against [`apache/datafusion-comet`](https://github.com/apache/datafusion-comet) — and consider running the [`audit-comet-expression` skill](https://github.com/apache/datafusion-comet/blob/main/.claude/skills/audit-comet-expression/SKILL.md) against it before you do. It will give you the cross-version analysis and the Step-5 consistency check for free.

If you're new to Comet, the easiest way to get started is to grab a recent release and run your existing Spark SQL workload against it. The compatibility guide will tell you what falls back; the audit-doc sub-bullets will tell you why.

Thank you to everyone who has contributed expression coverage, test infrastructure, and review feedback over the lifetime of the project. The audit takes a snapshot of where we are today; the next release will move the snapshot forward.
