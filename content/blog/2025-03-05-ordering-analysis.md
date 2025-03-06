---
layout: post
title: Analysis of Ordering for Better Plans
date: 2025-03-05
author: Mustafa Akur
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

<!-- see https://github.com/apache/datafusion/issues/11631 for details -->

## Introduction

In this blog post, we will analyze how to determine whether an ordering requirement of an operator is satisfied by the existing ordering at its input. This analysis is pre-condition for order based optimizations and also much more complex than one thinks initially.

Some of the operators in the physical plan require its input data to be ordered. The reasons for these requirements might be:
- More efficient Implementation (`SortMergeJoin`)
- Implementation with low memory footprint (`SortMergeJoin`, `Aggregation`, `Windowing`)
- Hard Requirement coming from the query itself (`Window` operator with `ORDER BY` clause)
- ...

If the requirements for the operator is not satisfied we may insert a `Sort` operator (`SortExec` in `DataFusion` world) to satisfy the requirement. If the requirement is already satisfied, we can continue with the existing plan without any `Sort` operator.

If we don't insert a `Sort` operator to the plan where we should (because of incorrect analysis), the result produced by the query will be wrong. Alternatively, if we insert a `Sort` operator where we don't need to, the result generated will be correct but inefficient. Hence, it is critical to determine whether an ordering requirement by an operator is satisfied at its input. Doing this analysis wrongly or ineffectively might cause planner to generate invalid or sub-optimal plans.

As an example, consider `SortPreservingMerge: required_ordering: [<expr> <DIRECTION>, ..]` operator. This operator takes data from multiple input partitions, then merges these data into single partition according to specied ordering. For this operator to work as desired each of its input should satisfy the required ordering by the operator. Otherwise, resulting data will not have correct ordering.

If the `SortPreservingMerge: [a ASC]` operator merges 2 partitions. Each of its input should satisfy the ordering `[a ASC]`. If the data from first partition is as follows:

| a |
|---|
| 1 |
| 3 |
| 5 |


and data from second partition is as follows:

| a |
|---|
| 2 |
| 4 |
| 6 |

`SortPreservingMerge` operator will produce following data

| a |
|---|
| 1 |
| 2 |
| 3 |
| 4 |
| 5 |
| 6 |

by merging partitions at its input.

## Setting the Stage

Let's start by generating a virtual table to model the data at the input of an operator. We will use this table to analyze whether an ordering requirement is satisfied by it or not.

| a1 | a2 | c1 | c2 | b1 | b2 | a2_clone | b2_clone |
|----|----|----|----|----|----|----------|----------|
| 0  | 0  | 0  | 1  | 0  | 0  | 0        | 0        |
| 0  | 1  | 0  | 1  | 0  | 0  | 1        | 0        |
| 1  | 0  | 0  | 1  | 0  | 1  | 0        | 1        |
| 1  | 1  | 0  | 1  | 0  | 2  | 1        | 2        |
| 1  | 2  | 0  | 1  | 1  | 0  | 2        | 0        |
| 2  | 0  | 0  | 1  | 1  | 1  | 0        | 1        |
| 2  | 1  | 0  | 1  | 1  | 2  | 1        | 2        |

To be able to analyze whether an ordering is satisfied by a table or not we need to keep track of following properties for the table:
- Constant Expression
- Equivalent Expression Groups
- Existing orderings of the table

Let us continue with what each property means and what they keep track of in the table

### Constant Expressions
Constant expressions are the expressions where each row in the expression is same with another. (Although, constant expressions might seem weird for a table to have. These expressions can arise after `Filter`, `Join` operations). In our example table Expression: `c1` and Expression: `c2` have this property. We can store constants as following vector `[c1, c2]` for this table. 

### Equivalent Expression Groups
Equivalent Expression Groups are expressions that have same value with each other. These expressions can be thought as cloned version of one another. Similar to constant expressions, these expressions may arise after `Filter`, `Join`, `Projection` operations. In our example table, Expressions: `a2`, `a2_clone` and `b2`, `b2_clone` constructs 2 equivalance groups, where each group contains 2 expressions. (A group may contain more than 2 entry also). For our table, we can store equivalent expressions groups as nested vector: `[[a2, a2_clone], [b2, b2_clone]]` where inner vector consists of the expressions inside the equivalent group.

### Existing orderings of the table
Existing Orderings are the valid orderings that table satisfies. However, there are many possible options for valid ordering. Let's enlist some of them
`[a1 ASC, a2 ASC]`,
`[a1 ASC]`,
`[a1 ASC, a2_clone ASC]`,
`[a1 ASC, a2 ASC, c1 ASC]`,
`[a1 ASC, a2 ASC, c1 DESC]`,
`[a1 ASC, c1 ASC, a2 ASC]`,
`[a1 ASC, c1 DESC, a2 ASC]`,
.
.
.
As can be seen from the above valid orderings. Storing all of the valid orderings is wasteful, and contains lots of redundancy. Some of the problems are:

- Storing prefix of another valid ordering is redundant. If the table satisfies lexicographical ordering `[a1 ASC, a2 ASC]`, it already satisfies ordering `[a1 ASC]` trivially. Hence, once we store `[a1 ASC, a2 ASC]` we do not need to store `[a1 ASC]` seperately.

- Using all entries in an EquivalenceGroup is redundant. If we know that ordering `[a1 ASC, a2 ASC]` is satisfied by the table, table also satisfies `[a1 ASC, a2_clone ASC]` since `a2` and `a2_clone` are copy of each other. Hence, it is enough to use just one expresssion (let's say first expression) in an equivalence group during the construction of the the valid orderings.

- Constant expressions can be inserted into any place inside valid ordering with arbitrary direction (`ASC`, `DESC`). Hence, If ordering `[a1 ASC, a2 ASC]` is valid, orderings: `[c1 ASC, a1 ASC, a2 ASC]`, `[c1 DESC, a1 ASC, a2 ASC]`, `[a1 ASC, c1 ASC, a2 ASC]`, .. are all also valid. This is clearly redundant. For this reason, it is better to not use any constant expression during existing ordering construction.

In summary,

- We should only use the longest lexicographical ordering as a valid ordering (shouldn't use any prefix of it)
- Ordering should contain only one expression from an equivalence group.
- Existing ordering expressions shouldn't contain any constant expression.

Adhering to these principles, valid orderings are `[a1 ASC, a2 ASC]`, `[b1 ASC, b2 ASC]` for the virtual table above.

Following above procedure, table has following properties:

- Constant Expressions = `[c1, c2]`
- Equivalent Expression Groups = `[[a2, a2_clone], [b2, b2_clone]]`
- Valid Orderings = `[[a1 ASC, a2 ASC], [b1 ASC, b2 ASC]]` (where `a2` is used from the Equivalence Group = `[a2, a2_clone]` and `b2` is used from the Equivalence Group = `[b2, b2_clone]`).

## Analysis

Once we contruct `Constant Expressions`, `Equivalent Expressions Groups` and `Valid Orderings` for the table we can analyze whether an ordering requirement is satisfied by the table or not using these properties.

Algorithm for doing so is as follows

1. Prune out constant expressions from the ordering requirement.

2. Normalize ordering requirement using `Equivalent Expression Groups` (e.g. replace expressions in the `Equivalent Expression Group` with the first entry in the corresponding `Equivalent Expression Group`). By this way we guarantee that expressions match with representation inside the `Valid Orderings`.

3. De-duplicate expressions in the ordering requirement where first entry is used among duplicated entries.

4. Iterate over the resulting expression to check whether current expression matches with any of the leading orderings (e.g. first ordering in a lexicographical ordering) among the existing orderings. If so, remove the leading ordering from corresponding Valid Ordering and continue iteration. If not, stop iteration.

5. If iteration completes without early exit, ordering is satisfied by existing properties. Otherwise it is not.

To see algorithm in place, let's look at a concrete example:

Let's check whether the ordering requirement `[c1 DESC, a1 ASC, b1 ASC, a2_clone ASC, b2 ASC, c2 ASC, a2 DESC]` is satisfied by the example table above where 
- `Constant Expression`s are `[c1, c2]`, 
- `Equivalent Expressions Group`s are `[[a2, a2_clone], [b2, b2_clone]]`
- `Valid Orderings` are `[[a1 ASC, a2 ASC], [b1 ASC, b2 ASC]]`.

After pruning out constant expressions ordering requirement `[c1 DESC, a1 ASC, b1 ASC, a2_clone ASC, b2 ASC, c2 ASC, a2 ASC]` reduces into `[a1 ASC, b1 ASC, a2_clone ASC, b2 ASC, a2 DESC]` (e.g. expressions `c1` and 'c2' are removed).

After normalization, where we replace expression: `a2_clone` with the expression: `a2` and expression: `b2_clone` with the expression: `b2`. Ordering requirement turns into `[a1 ASC, b1 ASC, a2 ASC, b2 ASC, a2 DESC]`.

After de-duplicating expressions where first encountered entry is kept, requirement turns into `[a1 ASC, b1 ASC, a2 ASC, b2 ASC]`. Please note that during de-duplication as long as expression match we remove the matching expressions except the first one independent of the direction of the requirement. As an example, requirement `[a1 ASC, b1 ASC, a1 DESC]` and `[a1 ASC, b1 ASC, a1 ASC]` both simplifies to `[a1 ASC, b1 ASC]`. 

After above stages, problem is reduced to whether `Valid Orderings`:  `[[a1 ASC, a2 ASC], [b1 ASC, b2 ASC]]` satisfies the ordering requirement `[a1 ASC, b1 ASC, a2 ASC, b2 ASC]`.

To determine if this is the case, first check whether `a1 ASC` (e.g. first entry in the ordering requirement: `[a1 ASC, b1 ASC, a2 ASC, b2 ASC]`) is among the leading orderings of the `Valid Ordering`s available. 
In our case, leading orderings are `a1 ASC` and `b1 ASC`. Hence `a1 ASC` is among valid orderings, we can remove `a1 ASC` from the `Valid Ordering`: `[a1 ASC, a2 ASC]` and also the ordering requirement `[a1 ASC, b1 ASC, a2 ASC, b2 ASC]`.

After the stage above, problem is reduced to whether `Valid Ordering`s `[[a2 ASC], [b1 ASC, b2 ASC]]` satisfies the ordering requirement `[b1 ASC, a2 ASC, b2 ASC]`.

We repeat the step 4 again until either 
- exhausing the ordering requirement list
- or cannot find the first ordering requirement expression among the leading expressions.

At the end of this procedure, we will end up with the ordering requirement: `[]`.
Since we end up with an empty requirement, we conclude that indeed ordering requirement `[c1 DESC, a1 ASC, b1 ASC, a2_clone ASC, b2 ASC, c2 ASC, a2 DESC]` is satisfied by the table with the properties:
`Constant Expression`s: `[c1, c2]`,
`Equivalent Expression Group`s: `[[a2, a2_clone], [b2, b2_clone]]`
`Valid Ordering`s: `[[a1 ASC, a2 ASC], [b1 ASC, b2 ASC]]`


## Concluding

In this blog post, we analyzed the conditions when an ordering requirement is satisfied given the properties of a table. First, we introduced necessary and handy properties to be able to solve this problem. This analysis is an important pre-condition for the sort based optimizations. With this analysis, we can generate efficient, memory and streaming friendly plans. Doing this analysis prematurely can cause planner to generate wrong or sub-optimal plans. `Datafusion` uses this analysis during planning stage to generate correct, and more performant plans. Implementation of this analysis in `Datafusion` can be found under following [module](https://github.com/apache/datafusion/tree/main/datafusion/physical-expr/src/equivalence)