---
layout: post
title: Writing Agent Skills for an Open Source Project: Lessons from DataFusion Python
date: 2026-05-22
author: Tim Saucer (rerun.io)
categories: [tutorial]
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

If you maintain an open source project, a growing fraction of the people
using your library are not typing code directly anymore — they are asking an
agent to write it for them. That agent leans on whatever it picked up during
training, which is rarely the idiomatic style your project actually wants.
The result is code that runs but reads like a stranger wrote it, or code
that doesn't run at all because the agent guessed at an API that doesn't
exist. You can fix this from inside the repository, with a small number of
**agent skills** checked in alongside your code.

This post is about how we did exactly that in
[`datafusion-python`][repo]. The specifics — DataFrame APIs,
PyO3-wrapped Rust bindings, an analytics library written on top of Apache
Arrow — are particular to our project, but the techniques are not. The
question of *who* a skill is for and how that shapes its contents, the
question of *where* a skill should live in the repo so the right people
load it, the question of *how to keep it honest* as your API evolves, and
the question of *how to evaluate it* against a real workload all generalize
to almost any library complex enough that an agent will struggle with it.

Concretely, you will get out of this post:

- A pattern for splitting skills by audience — user-facing vs.
  contributor-facing — and why the split matters more than it sounds.
- A workflow for keeping skills in sync with a moving API by treating the
  skill itself as the maintenance tool.
- A method for grounding the user-facing skill against a corpus of known
  problems with known answers, run in a way that actually tests the skill
  instead of the agent's memory.
- A set of habits for evaluating and iterating on skills that apply to any
  project doing this work.

[repo]: https://datafusion.apache.org/python/

## What is an Agent Skill?

---

A skill is a Markdown file (conventionally `SKILL.md`) with YAML frontmatter
that tells an AI coding assistant when and how to use it. The file lives in
your repository, and any agent that supports the skill ecosystem
([Claude Code], [Cursor], [Codex], [Gemini CLI], [Aider], and many more)
will pull the skill in when the user is working on a relevant task.

A skill is not documentation for humans. It is a focused, dense piece of
prose written *for the model*, optimized for the moment the model is about
to generate code. That distinction matters: a good user guide is patient and
walks the reader through concepts; a good skill is opinionated and tells the
model the exact pattern to emit.

[Claude Code]: https://claude.com/claude-code
[Cursor]: https://cursor.com
[Codex]: https://openai.com/codex/
[Gemini CLI]: https://github.com/google-gemini/gemini-cli
[Aider]: https://aider.chat

## Two Audiences, Two Skills

---

The single most important decision we made was to split skills into **two
clearly separate audiences**.

**End users** of `datafusion-python` are people writing application code:
loading Parquet files, building DataFrame queries, computing aggregates,
calling window functions. They want the agent to produce idiomatic
`SessionContext` / `DataFrame` / `Expr` code that runs on their data.

**Developers** of `datafusion-python` are the maintainers of the library
itself: people adding bindings, syncing with upstream [Apache DataFusion],
auditing API coverage, and refining the Python ergonomics of the
PyO3-wrapped Rust code. They want the agent to help them find gaps in the
binding layer and apply the fixes.

These two audiences need almost disjoint guidance. A user does not need to
know that `python/datafusion/functions.py` wraps `crates/core/src/functions.rs`,
or how to grep `~/.cargo/registry` for the upstream `invoke_with_args()`
implementation. A maintainer does not need a SQL-to-DataFrame migration
table. Mixing the two produces a skill that is too long for both audiences
and unfocused for either.

The other reason to keep them separate is **load semantics**. Skills are
loaded into the model's context window. Every kilobyte of skill consumes
tokens the user could have spent on their actual code. When you publish a
skill, you should be deliberate about the audience that pays that cost.

### Where Each Skill Lives in the Repo

We landed on the following layout in `datafusion-python`:

```
skills/
  datafusion_python/
    SKILL.md          # user-facing skill (722 lines)

.ai/skills/
  check-upstream/
    SKILL.md          # developer skill: API parity audit
  make-pythonic/
    SKILL.md          # developer skill: ergonomic refactors
  audit-skill-md/
    SKILL.md          # developer skill: keep the user skill in sync
```

The user-facing skill lives at the top level under `skills/`, where the
skill-ecosystem tooling looks for it. This is what an end user installs.
The developer skills live under `.ai/skills/` — they are checked into the
repo so contributors who clone it get them automatically, but they are
**not** part of the public, installable skill surface.

The `.ai/skills/` path is not a discovery convention agents look for on
their own, so we point at it explicitly from `AGENTS.md` at the repo
root. An agent dropped into the repository reads `AGENTS.md` first,
finds the pointer, and can then pull in the right developer skill for
the task it has been asked to do. If you adopt this layout, updating
`AGENTS.md` to advertise the directory is what makes the developer
skills actually reachable.

Following the `skills/<project-name>/SKILL.md` convention has one immediate
payoff: installation becomes a single command. A user can wire the skill
into their agent with:

```
npx skills add apache/datafusion-python
```

The tool reads the repo, finds the skill at the conventional path, and
installs only that subtree — no need to clone the whole project just to
get a Markdown file. If you publish your user-facing skill in this layout,
your users get the same one-line install for free.

### Developers Can (and Should) Use the User Skill Too

The separation is asymmetric. Maintainers absolutely benefit from loading
the user-facing skill alongside the developer skills — it tells them what
idiomatic usage *should* look like, which is exactly the standard they need
to hold new bindings to. But end users have no reason to load the developer
skills. Their context window is better spent on the user skill plus their
own code.

## Building the User-Facing Skill

---

The hard question, once you've decided to write a user-facing skill, is
*what goes in it*. A naive approach is to start from your existing user
guide and condense — but a user guide is organized for a human reading
top-to-bottom, and a skill needs to be organized for a model that is
about to emit a specific kind of code.

Two principles shaped how we approached the writing itself, and they
matter as much as the structure of the document:

**Have an agent write the skill — but feed it expert knowledge.**
Agents have a strong intuition for what *another agent* needs to see in
order to produce correct code. They know which conventions are
non-obvious, which API edges are surprising, which idioms a model would
fail to infer. Use that. The skill files in `datafusion-python` were
drafted by an agent, not hand-written.

The catch is that the agent does not know your project. It does not know
which abstractions your users actually touch, which patterns you consider
idiomatic, which historical mistakes the library has accumulated. That
knowledge lives in the maintainers' heads. The initial conversation
between the author and the drafting agent is therefore a **knowledge
capture exercise**: the author supplies the priorities and constraints,
the agent turns them into structured guidance. Every iteration that
follows is the same exercise on a smaller scale — every time the skill
fails in the field, the fix is more captured expertise.

**Debug the skill by replaying it.**
When you catch the skill producing a bad output, you do not have to
guess why. Hand the agent the version of the skill that was in use at
the time of the failure, paste in the original prompt, and ask it to
explain what guidance it was following and where the guidance was
silent. Pinning the skill to a specific commit during this analysis is
important — the skill you have today is not the skill the agent had
when it made the mistake. The agent is good at pointing at the exact
gap; once you know the gap, the fix usually writes itself.

With those two principles in place, we arrived at the contents of
`skills/datafusion_python/SKILL.md` through three passes, in this order:

**Pass 1: inventory the public surface.**
Before writing prose, list the abstractions a user actually touches. For
us that was four: `SessionContext` (the entry point), `DataFrame` (the
query builder), `Expr` (expression nodes), and `functions` (the built-in
library). This list is exactly the kind of thing the agent cannot derive
on its own — the project's public Python API is much larger than what a
typical user reaches for, and the difference is a maintainer judgment
call. We told the drafting agent which four surfaces mattered; it
organized the skill around them. Anything outside that list is either
internal or advanced enough that a user-facing skill should not be the
place to teach it. The inventory is the skill's skeleton — every later
edit hangs off one of these surfaces.

One useful input here is your existing **online user guide**. A
hand-written user guide has already done a version of this filtering for
you: the maintainer who wrote it chose what to introduce, what order to
introduce it in, and where to slow down and flag a footgun. We fed our
user guide to the drafting agent as a source of signal — both for
"which APIs are important enough to teach" and for "which pitfalls have
already burned real users." Many of the warnings in the final skill
trace back to a sentence somewhere in the user guide that says "be
careful with this."

Be deliberate about *which* docs you feed in, though. **Do not use
auto-generated API reference docs** for this pass. Generated docs cover
the entire public surface and therefore filter nothing — handing them to
the agent will produce a skill that tries to teach everything and
teaches nothing well. The user guide is useful precisely because a human
already pruned it.

**Pass 2: write the happy path for each surface.**
For each abstraction on the list, write the minimum code an idiomatic
user would write: how to load data, how to project columns, how to
filter, how to aggregate, how to join, how to call a window function.
The goal is not exhaustiveness; it is to give the model a *template* it
can pattern-match against. If your project has a strong opinion about
the right way to do something (we prefer plain column-name strings over
`col("name")` in projections, for example), this is where the opinion
goes.

**Pass 3 — the long one: encode every mistake the agent makes.**
This is where most of the actual value of the skill comes from, and it
is where you cannot shortcut. Use the draft from passes 1 and 2 in a
real agent session. Have the agent write code against your library.
Watch what it gets wrong. Every wrong thing is a candidate skill edit.

In our case, two distinct categories of guidance fell out of this loop.

The first is **outright pitfalls** — places where the natural agent
guess produces code that is incorrect or silently wrong:

- `&` / `|` / `~` for boolean composition, not Python's `and` / `or` /
  `not`. Using the keyword forms looks syntactically fine and even runs,
  but it does not compose `Expr` objects the way the user intended.
- Case sensitivity: `select("Name")` lowercases the identifier; embed
  inner double quotes (`select('"MyCol"')`) for case-preserved lookup.
  Without the inner quotes, the lookup fails with `No field named mycol`.

Both of these were already called out in our online user guide as
footguns. Pass 1 surfaced them from the docs, which is exactly the kind
of payoff the user-guide step is meant to produce — the maintainer who
wrote the guide had already done the work of cataloguing them.

The second category is **idiomatic vs. non-idiomatic style**. These are
not bugs; the agent's first guess produces code that runs and returns
the right answer. But it does not read like code a maintainer would
write, and over time it diverges from the patterns the rest of the
project uses:

- `col("a") > 10` rather than `col("a") > lit(10)` — raw Python values
  on the right-hand side of an operator are auto-wrapped into literals.
- Plain column names as strings in `select()`, `sort()`, `aggregate()` —
  reach for `col(...)` only when the projection needs an expression.
- `HAVING` is the `filter=` keyword on the aggregate function, not a
  post-aggregation `filter()` call.
- Semi/anti joins instead of `EXISTS` / `NOT EXISTS` correlated
  subqueries.

These idiomatic rules are not in the user guide as a flat list — they
are scattered across docstrings, examples, and the implicit knowledge of
the maintainers. They show up in the skill because we watched an agent
write the non-idiomatic version and then went and wrote the rule down.
The contents of this list are not a property of `datafusion-python`;
they are a property of *what agents guess when they haven't seen your
library before*, and the only way to discover it is to put the skill in
front of a fresh agent and watch.

A useful trick during pass 3: when the agent does get something right
in a non-obvious way, ask it *why*. If the answer references something
that is not in your draft skill — a docstring it found, a public docs
page, a pattern from a similar library — that is a hint that the skill
is silent on something it should cover. Codify the reasoning, don't
rely on the agent finding it again next time.

The next two sections describe two different things we did after the
initial draft: a one-time grounding exercise against the TPC-H corpus
to validate the skill end-to-end, and a set of developer-side skills
that flag user-skill drift whenever the API moves.

## Grounding the Skill: TPC-H as a One-Time Validation

---

A draft skill needs to be tested against something more demanding than the
ad-hoc prompts the author used while writing it. We needed a way to confirm
that the skill, once handed to a fresh agent, actually produced code that
*ran* and returned *correct answers* on real workloads — not just on the
five-line examples the author already had in mind. The plan, laid out in
[issue #1394], was a one-time end-to-end validation pass against the
**[TPC-H benchmark suite][tpch]**, with the discoveries folded back into
the skill itself.

[tpch]: https://www.tpc.org/tpch/

[issue #1394]: https://github.com/apache/datafusion-python/issues/1394

TPC-H is attractive for this purpose because:

1. The benchmark ships **plain-English problem statements** for each of the
   22 queries.
2. The benchmark ships **reference answers** for scale factor 1 (the
   `answers_sf1/` directory in `examples/tpch/`), so any candidate
   implementation can be checked for correctness automatically.
3. The queries cover a wide cross-section of the API: aggregates, joins,
   window functions, set operations, date arithmetic, subqueries, and so
   on.

### What Makes a Good Corpus

Most projects do not have a TPC-H equivalent sitting on the shelf. The
useful thing to extract from our experience is the shape of the corpus,
not the specific benchmark. Three properties matter:

1. **A text description of what to build, in the language of the
   problem.** Not pseudocode, not an API call sketch — a natural-language
   statement of *what the user wants to compute*, the way a real user
   would phrase it. The skill is what should bridge the gap from English
   to your library's API. If the corpus already names your APIs, you are
   no longer testing the skill.
2. **A check that runs automatically.** Without that, you cannot iterate.
   The check can be a reference answer to diff against (TPC-H's
   approach), a property test, a snapshot, or even another agent acting
   as a judge — whatever lets you say *correct* or *not correct* without
   a human in the loop for each pass.
3. **Coverage of the surface the skill is supposed to teach.** A corpus
   that hits only one or two abstractions will only validate one or two
   sections of the skill. Spread across the public API you actually want
   users to use.

If you do not have a benchmark like TPC-H, the easiest place to start is
**your own repository's examples**. Pick the existing example files, write
a plain-English description of what each one is meant to do, and see if a
fresh agent can reproduce the example from the description alone, using
only your skill and docs. Any divergence — wrong code, non-idiomatic
code, hallucinated APIs — is a hole in the skill. The example files are
already your ground truth; you just need to rewrite their *inputs* in a
form that does not give the answer away.

It helps to frame the whole exercise as **test-driven development for
documentation**. The test is: given nothing but a well-written problem
statement, can a fresh agent produce correct, idiomatic code using only
your skill? When the answer is no, the skill is the thing that has to
change. Each pass is a regression test on the prose.

### The Evaluation Loop

The corpus is structured so the agent gets the *problem*, not the SQL:

```
examples/tpch/
  q01_pricing_summary_report.py   # docstring contains the English problem statement
  q02_minimum_cost_supplier.py
  ...
  answers_sf1/
    q1.tbl                        # reference answers (the ground truth)
    q2.tbl
    ...
  _tests.py                       # diff candidate output against q*.tbl
```

We had the agent write each query as idiomatic DataFrame code, then ran the
test harness in `_tests.py` to diff its output against the reference
answers. When the agent's code disagreed with the ground truth, that was
either a bug in the generated code, a bug in the skill, or — occasionally
— a documented behavioral difference in DataFusion that needed a comment in
the example. The loop kept running until the agent could produce correct
output for all 22 queries.

### Forbidding Shortcuts

The interesting wrinkle was making the evaluation *actually evaluate the
skill*, not the agent's ability to find a cached answer somewhere. TPC-H
has been around since the 1990s; reference SQL implementations are all over
the public web, and there are existing Python solutions in the repository's
own git history. If the agent leaned on any of those, the test would prove
nothing.

We addressed this in three ways:

1. **Restart the session frequently.** Each evaluation pass was run in a
   fresh agent session, with no memory of prior solutions and no inferred
   context from earlier turns. Prior conversation is leakage — the agent
   might "remember" the right answer instead of deriving it from the skill.

2. **Explicitly forbid the shortcuts in the prompt.** The agent was told:
   no looking at any existing Python solutions in the repo, no SQL-based
   solutions (whether in the repo, on the web, or in your training data),
   and no prior memories. Only the docstrings, the skill, and the published
   `datafusion-python` user documentation are fair game.

3. **Forbid the agent from correcting its initial guess.** The first
   pass — the one before the agent has run its code, seen an error, and
   debugged — is the one that actually exercises the skill. Once the
   agent gets to iterate, its general debugging ability starts to
   compensate for whatever the skill failed to teach, and the
   evaluation stops measuring the skill at all. We wanted the failures.

The second rule is worth dwelling on. There is a real temptation, when
an agent is stuck, to let it "peek" at a known-good answer just to make
progress. Don't. The whole point of the TPC-H corpus is to surface the
places where the skill is silent or wrong, and an agent that has already
seen the answer will paper over exactly those gaps.

### Human Review of the Generated Code

Once the agent could produce *correct* output for a query, the work was
only half done. Correctness is not the same as idiomatic. We then went
through each of the 22 generated scripts by hand and worked with the agent
to refactor them into the style the skill is supposed to teach: plain
column names where possible, `filter=` on aggregates instead of
post-aggregation filters, semi/anti joins instead of `EXISTS`, and so on.

Every time we caught the agent reaching for a non-idiomatic pattern, we
asked the same question: *did the skill teach this, or did the agent
infer it?* When the answer was "inferred," that was a gap in the skill, and
we updated `SKILL.md` to close it.

## The Developer Skills

---

The user skill exists to teach agents how to write good user code. The
developer skills, in `.ai/skills/`, exist to help maintainers keep the
project itself in good shape.

We ended up with three of them. The number was not planned up front;
each skill was written in response to a recurring chore that a
maintainer kept doing by hand and getting wrong in the same ways every
time. Once a task has a predictable shape and a checklist that a careful
person would follow, it is a candidate for a skill — and the act of
writing the skill forces you to make the checklist explicit.

The three correspond to the three places maintenance drift shows up in a
binding project like ours:

- **`check-upstream`** — *the public API of the wrapped library moved
  and we didn't keep up.* Run after every upstream sync to find
  functions, methods, and types that exist in the Rust DataFusion
  library but were never exposed in Python.
- **`make-pythonic`** — *the binding works, but it doesn't feel like
  Python.* Audit function signatures for places where a user has to
  write `lit(",")` or `lit(2)` when the natural Python form would be
  `","` or `2`, and apply the fix.
- **`audit-skill-md`** — *the user-facing skill has drifted from the
  API it documents.* After new APIs are added or old ones renamed, this
  skill walks the public surface and flags every place where
  `SKILL.md` is now stale.

In practice the same person — whoever is driving the upstream sync —
will often invoke all three in sequence as part of the same chore. The
[upstream-sync runbook] in the repo walks through exactly that: bump
the dependency, then run `check-upstream`, then optionally
`make-pythonic` on anything newly exposed, then `audit-skill-md` to
catch any user-skill drift the new APIs introduced. They are still kept
as three separate skills rather than one mega-skill because each has a
distinct trigger, a distinct success criterion, and a distinct kind of
output (issues, signature edits, doc edits). Bundling them would
collapse those into a single sprawling prompt and make it harder to
tell whether the current step has actually finished.

[upstream-sync runbook]: https://github.com/apache/datafusion-python/blob/main/dev/release/upstream-sync.md

The rest of this section walks through each one in turn — how it
works, what we learned writing it, and (for `check-upstream` and
`make-pythonic`) how the first runs immediately surfaced gaps in the
skill itself that became the next round of edits.

### `check-upstream`: Find Missing Bindings

`datafusion-python` is a thin Python binding over the Rust [Apache
DataFusion] library. Every release of upstream DataFusion adds new
functions, methods, and types, and one of the most common forms of
maintenance drift is *failing to expose those additions in Python*. The
project would happily ship a release where, for example, `array_transform`
was available in DataFusion but missing from `datafusion.functions`.

The [`check-upstream`][check-upstream] skill is a structured audit. The
agent walks the upstream surface — scalar functions, aggregate functions,
window functions, DataFrame methods, SessionContext methods, FFI types —
compares each against the Python API, and emits a report of what's
missing.

We added the skill in [PR #1460] and immediately used it to generate twelve
GitHub issues ([#1448][i1448] – [#1459][i1459]), one per gap. That batch
of issues is what made the skill useful: each one was a concrete,
verifiable claim that some upstream feature wasn't exposed.

[Apache DataFusion]: https://datafusion.apache.org
[check-upstream]: https://github.com/apache/datafusion-python/blob/main/.ai/skills/check-upstream/SKILL.md
[PR #1460]: https://github.com/apache/datafusion-python/pull/1460
[i1448]: https://github.com/apache/datafusion-python/issues/1448
[i1459]: https://github.com/apache/datafusion-python/issues/1459

It was also the first place we hit the **iterative-update pattern** that
became core to how we maintain these skills.

### Skills Are Software: They Need a Feedback Loop

When we ran `check-upstream` for the first time and started working through
the twelve generated issues, several of them were wrong in subtle ways.
Some reported a function as missing when it was actually present under an
alias. Some missed the fact that the Python layer can implement an
"upstream" function by calling a different underlying Rust binding — the
agent had assumed a 1:1 correspondence between Rust `#[pyfunction]`
declarations and Python coverage. Some missed the distinction between
"this entire major release added a function" and "this patch release fixed
bugs only, so nothing to find" — the agent stopped looking after seeing a
quiet changelog.

We did not throw away the issues. We walked through them one by one and,
for each false positive, asked: *what would the skill have to say for the
agent to not make this mistake?* Then we changed the skill.

Three of those updates are worth quoting because they capture the kind of
guidance an agent will not infer on its own:

> **The Python API is the source of truth for coverage.** A function is
> considered "exposed" if it exists in the Python API, even if there is no
> corresponding entry in the Rust bindings. Many upstream functions are
> aliases ... do NOT report a function as missing if it appears in the
> Python `__all__` list and has a working implementation.

> **Audit the total upstream surface, not the delta since the last pin.**
> Gaps accumulate across syncs. A patch-release bump with a "bug fixes
> only" changelog does not mean there is nothing to find — pre-existing
> gaps from earlier majors still need to be surfaced.

The third addition was a table of **compile-signal triggers**: patterns
that show up when you fix the compile errors during an upstream bump,
mapped to the class of binding gap they imply. For example: a new
`Expr::*` variant added to a non-exhaustive `match` means a new family of
lambda or higher-order scalar functions has appeared upstream; a new
`ScalarValue::*` variant means new array functions that produce or consume
the type. We learned each of these the hard way by missing them during a
sync, then encoded them so the next sync wouldn't.

The point is not the specific rules. The point is the *mechanism*: every
time the skill gets something wrong in the real world, that wrongness
gets converted into a rule the skill emits next time.

### `make-pythonic`: Fix the Ergonomics

The second developer skill, [`make-pythonic`][make-pythonic], improves the
Python API's ergonomics. Many functions historically required explicit
`lit()` wrapping for arguments that are contextually always literal: you
had to write `split_part(col("a"), lit(","), lit(2))` when the natural
Python form was `split_part(col("a"), ",", 2)`. The skill audits each
function in `python/datafusion/functions.py`, categorizes its arguments,
and updates type hints and coercion logic to accept native Python types
where it is safe to do so.

[make-pythonic]: https://github.com/apache/datafusion-python/blob/main/.ai/skills/make-pythonic/SKILL.md

We landed it in [PR #1484] alongside the actual ergonomic improvements it
generated — 47 functions across date/time, string, regex, math, and array
families.

[PR #1484]: https://github.com/apache/datafusion-python/pull/1484

That PR is also useful as a case study for *how to design a skill in the
first place*, because it includes the [full transcript][chat-export] of
the conversation in which the skill was built. A few findings from that
transcript are worth pulling out:

[chat-export]: https://github.com/user-attachments/files/26608305/chat-export-2026-04-09.md

**1. The skill grew out of a conversation, not a spec.**
The first prompt was a paragraph describing the problem in plain language:
"there are places where inputting multiple types of data as function
arguments should just work as opposed to the Rust versions." The agent
explored the codebase, identified ten concrete examples of non-Pythonic
signatures, and drafted the skill. Subsequent prompts (*"how do you tell
if upstream only accepts a literal?"*) pulled in the **second signal** —
inspecting the Rust `invoke_with_args()` and `Signature::coercible()`
implementations — which became a section in the skill.

**2. Designing and testing happen in separate sessions.**
After the skill was drafted, the author explicitly exited the session and
started a fresh one to test it. The reason is the same one that drove the
fresh-session rule in the TPC-H evaluation: the skill has to be evaluated
on what *it* contains, not on what the agent and the author worked out
together in the design conversation. Prior context is contamination.

**3. The first test run found a real bug — in the skill, not the code.**
The initial draft put `date_part`'s `part` argument into **Category B**
(native type only) because the upstream Rust enforces a non-null scalar
`Utf8`. The test suite immediately failed: an existing test passed
`lit("month")`, and `lit()` produces an `Expr`. The fix was not to change
the test — it was to relax the category. `date_part` moved to **Category
A** (`Expr | str`), and the skill grew a note that "literal-only at the
Rust layer" is not the same as "rejects an `Expr` at the Python layer." A
real test that exercises the change is what surfaced this; the skill
alone would not have.

**4. Reviewing the agent's work found gaps the skill didn't cover.**
After the first commit landed, a single follow-up question — *"were
there any functions that were aliases to the functions you updated that
should likewise have their signatures changed?"* — surfaced two missed
functions: `instr` and `position`, both aliases of `strpos`. The skill
had been silent on aliases. We fixed the two signatures *and* added a
new Step 3 ("Update Alias Type Hints") to the skill, so the next person
to run it wouldn't have to ask the same question.

This is the same pattern as the `check-upstream` story: an issue surfaces
in review, gets converted into a rule, the rule lives in the skill.

### `audit-skill-md`: Keep the User Skill Up to Date

The third developer skill closes the loop. The user skill at
`skills/datafusion_python/SKILL.md` documents the public Python API —
which means every time the public Python API changes, the user skill is
at risk of becoming stale. New functions need to be documented. Renamed
or removed APIs need to be scrubbed. Examples that used to be idiomatic
may have drifted as the library added better patterns.

[`audit-skill-md`][audit-skill-md] is the skill that audits the *other*
skill. It walks the public surface of `SessionContext`, `DataFrame`,
`Expr`, and `functions`, cross-references each against the contents of
`SKILL.md`, and flags drift. It is meant to be run right after the
`check-upstream` step of an upstream sync: once any new APIs are exposed,
this skill makes sure they get documented.

[audit-skill-md]: https://github.com/apache/datafusion-python/blob/main/.ai/skills/audit-skill-md/SKILL.md

The three developer skills form a small pipeline:

```
upstream DataFusion release
        │
        ▼
  check-upstream  ──►  issues filed for missing bindings
        │
        ▼
   bindings landed
        │
        ▼
  make-pythonic   ──►  ergonomic cleanups on the new surface
        │
        ▼
  audit-skill-md  ──►  user skill updated to teach the new surface
```

Each step has a skill; each skill produces concrete artifacts (issues,
PRs, doc edits); and each step's output is the next step's input.

## Lessons That Generalize

---

If you take one thing from the DataFusion Python experience, take this:
**a skill is software, and like all software it needs a feedback loop.**
The first version of a skill is always wrong. It is wrong in ways you will
not predict by re-reading it; you will only discover the gaps by running
it and watching what the agent does. The skill becomes good only by being
edited every time you catch it failing.

Some more specific lessons:

- **Pick your audience before you write a line.** A skill for users and a
  skill for maintainers are different documents. If you can't decide who
  it's for, you'll write something that helps neither.
- **Pay attention to where the file lives.** Public skills go where the
  skill ecosystem expects to find them, in a small subtree the tooling
  can fetch without pulling the whole repo. Internal skills live wherever
  is convenient for contributors.
- **Find a corpus that's adversarial to your own training data.** TPC-H
  worked for us because it has English problem statements, machine-checkable
  answers, and a thousand SQL implementations on the public web that we
  explicitly tell the agent to ignore. The "ignore" rule is what makes the
  evaluation honest.
- **Use fresh sessions for evaluation.** Prior conversation is leakage.
  If the agent already knows the answer from designing the skill with
  you, it can't tell you whether the skill itself works.
- **Treat every bad output as a skill update.** When you find the agent
  doing the wrong thing — in CI, in code review, in a generated issue —
  the question to ask is not "how do I fix this PR?" It is "what would
  the skill have to say so the next run doesn't make this mistake?"

The skills in `datafusion-python` are not finished, and they will
not be finished. Each upstream sync surfaces new gaps. Each review of
agent-generated code surfaces new pitfalls to encode. Each new abstraction
the project adds is one more thing the user skill needs to teach. That is
fine — the feedback loop *is* the work. The skills you ship today are the
starting point for the skills you'll ship next quarter.

If you maintain an open source project of any complexity and your users
are starting to ask agents to use it, this is a pattern worth stealing.
Start with one skill for the people who use your library. Add another for
the people who maintain it. Find a corpus you can use to test the first
one. Then keep editing.

## Acknowledgements

---

Thanks to [@alamb], [@kevinjqliu], [@ntjohnson1], and [@xudong963] for
their contributions and discussion on the skills and the PRs and issues
referenced in this post.

The skills themselves were drafted in collaboration with Claude, in the
spirit described above — agents are well suited to writing for other
agents, provided a maintainer is there to supply the project-specific
knowledge they cannot infer.

[@alamb]: https://github.com/alamb
[@kevinjqliu]: https://github.com/kevinjqliu
[@ntjohnson1]: https://github.com/ntjohnson1
[@xudong963]: https://github.com/xudong963

## Get Involved

The DataFusion team is an active and engaging community and we would love
to have you join us and help the project.

Here are some ways to get involved:

* Learn more by visiting the [DataFusion] project page.
* Try out the project and provide feedback, file issues, and contribute code.
* Work on a [good first issue].
* Reach out to us via the [communication doc].

[DataFusion]: https://datafusion.apache.org/index.html
[good first issue]: https://github.com/apache/datafusion-python/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22
[communication doc]: https://datafusion.apache.org/contributor-guide/communication.html
