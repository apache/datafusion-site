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

In this blog post, we will explore how to determine whether an ordering requirement[^1] of an operator is satisfied by its input data. This analysis is essential for order-based optimizations and is often more complex than one might initially think.

Some operators in the physical query plan require their input data to be ordered. The reasons for these requirements include:
- **More efficient implementation** (e.g., `SortMergeJoin`)
- **Low memory footprint** (e.g., `SortMergeJoin`, `Aggregation`, `Windowing`)
- **Hard requirements from the query itself** (e.g., `Window` operator with `ORDER BY` clause)

If an operator's ordering requirement is not satisfied by the input, a `Sort` operator (e.g., `SortExec` in the `DataFusion` framework) may be inserted to fulfill the requirement. If the requirement is already met, the plan can proceed without an additional `Sort` operator.

Correctly analyzing whether the ordering requirement is satisfied is critical. Failure to do so can lead to:
- **Incorrect query results** if a `Sort` operator is omitted.
- **Inefficient execution plans** if a `Sort` operator is unnecessarily added.

This post outlines the necessary properties of the table we must monitor for this analysis and illustrates the analysis process.


### Example Virtual Table

Let's define a virtual table to model the input data of an operator for analysis:

| a1 | a2 | c1 | c2 | b1 | b2 | a2_clone | b2_clone |
|----|----|----|----|----|----|----------|----------|
| 0  | 0  | 0  | 1  | 0  | 0  | 0        | 0        |
| 0  | 1  | 0  | 1  | 0  | 0  | 1        | 0        |
| 1  | 0  | 0  | 1  | 0  | 1  | 0        | 1        |
| 1  | 1  | 0  | 1  | 0  | 2  | 1        | 2        |
| 1  | 2  | 0  | 1  | 1  | 0  | 2        | 0        |
| 2  | 0  | 0  | 1  | 1  | 1  | 0        | 1        |
| 2  | 1  | 0  | 1  | 1  | 2  | 1        | 2        |

## Key Concepts for Analyzing Orderings
Before analyzing whether an ordering requirement is satisfied, we first need to define a few properties of the input data. These properties help guide the analysis process:

### 1. Constant Expressions
Constant expressions are those where each row in the expression has the same value across all rows. Although constant expressions may seem odd in a table, they can arise after operations like `Filter` or `Join`. In our example table, expressions `c1` and `c2` are constant.

For instance:
- Expression `c1` and `c2` are constant because every row in the table has the same value for these columns.

### 2. Equivalent Expression Groups
Equivalent expression groups are expressions that always hold the same value across rows. These expressions can be thought of as clones of each other and may arise from operations like `Filter`, `Join`, or `Projection`.

For example, in our table, the expressions `a2` and `a2_clone` form one equivalence group, and `b2` and `b2_clone` form another equivalence group.

### 3. Valid Orderings
Valid orderings are the orderings that the table already satisfies. However, there are many possible options for valid ordering. Some of the valid orderings for the table is as follows:
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

- Storing prefix of another valid ordering is redundant. If the table satisfies lexicographical ordering[^2]: `[a1 ASC, a2 ASC]`, it already satisfies ordering `[a1 ASC]` trivially. Hence, once we store `[a1 ASC, a2 ASC]` we do not need to store `[a1 ASC]` seperately.

- Using all entries in an Equivalent Expression Group is redundant. If we know that ordering `[a1 ASC, a2 ASC]` is satisfied by the table, table also satisfies `[a1 ASC, a2_clone ASC]` since `a2` and `a2_clone` are copy of each other. Hence, it is enough to use just one expresssion (let's say first expression) in an Equivalent Expression Group during the construction of the the valid orderings.

- Constant expressions can be inserted into any place inside valid ordering with an arbitrary direction (`ASC`, `DESC`). Hence, If ordering `[a1 ASC, a2 ASC]` is valid, orderings: `[c1 ASC, a1 ASC, a2 ASC]`, `[c1 DESC, a1 ASC, a2 ASC]`, `[a1 ASC, c1 ASC, a2 ASC]`, .. are all also valid. This is clearly redundant. For this reason, it is better to not use any constant expression during existing ordering construction.

In summary,

- We should only use the longest lexicographical ordering as a valid ordering (shouldn't use any prefix of it)
- Ordering should contain only one expression from an equivalence group (a representative of the group).
- Existing ordering expressions shouldn't contain any constant expression.

Adhering to these principles, valid orderings are `[a1 ASC, a2 ASC]`, `[b1 ASC, b2 ASC]` in our table.

### Table Properties

| a1 | a2 | c1 | c2 | b1 | b2 | a2_clone | b2_clone |
|----|----|----|----|----|----|----------|----------|
| 0  | 0  | 0  | 1  | 0  | 0  | 0        | 0        |
| 0  | 1  | 0  | 1  | 0  | 0  | 1        | 0        |
| 1  | 0  | 0  | 1  | 0  | 1  | 0        | 1        |
| 1  | 1  | 0  | 1  | 0  | 2  | 1        | 2        |
| 1  | 2  | 0  | 1  | 1  | 0  | 2        | 0        |
| 2  | 0  | 0  | 1  | 1  | 1  | 0        | 1        |
| 2  | 1  | 0  | 1  | 1  | 2  | 1        | 2        |

For the table above, the following properties can be derived:
- **Constant Expressions** = `[c1, c2]`
- **Equivalent Expression Groups** = `[[a2, a2_clone], [b2, b2_clone]]`
- **Valid Orderings** = `[[a1 ASC, a2 ASC], [b1 ASC, b2 ASC]]`

### Algorithm for Analyzing Ordering Requirements

We can use following algorithm to check whether an ordering requirement is satisfied by a table:

1. **Prune constant expressions**: Remove any constant expressions from the ordering requirement.
2. **Normalize the requirement**: Replace each expression in the ordering requirement with the first entry from its equivalence group.
3. **De-duplicate expressions**: If an expression appears more than once, remove duplicates, keeping only the first occurrence.
4. **Match leading orderings**: Check whether the leading ordering requirement[^3] matches the leading valid orderings[^4]. If so:
    - Remove the leading ordering from the ordering requirement 
    - Remove the matching leading expression from the valid orderings. 
5. **Iterate through the remaining expressions**: Go back to step 4 until ordering requirement is empty or leading ordering requirement is not found among the leading valid orderings.

If at the end of the procedure above, ordering requirement is an empty list. We can conclude that the requirement is satisfied by the table.

Let’s see this algorithm in action with an example.

### Example Walkthrough

Let's check if the ordering requirement `[c1 DESC, a1 ASC, b1 ASC, a2_clone ASC, b2 ASC, c2 ASC, a2 DESC]` is satisfied by the table with properties:
- **Constant Expressions** = `[c1, c2]`
- **Equivalent Expressions Groups** = `[[a2, a2_clone], [b2, b2_clone]]`
- **Valid Orderings** = `[[a1 ASC, a2 ASC], [b1 ASC, b2 ASC]]`

1. **Prune constant expressions**:  
   Remove `c1` and `c2`. The requirement becomes:  
   `[a1 ASC, b1 ASC, a2_clone ASC, b2 ASC, a2 DESC]`.

2. **Normalize using equivalent groups**:  
   Replace `a2_clone` with `a2` and `b2_clone` with `b2`. The requirement becomes:  
   `[a1 ASC, b1 ASC, a2 ASC, b2 ASC, a2 DESC]`.

3. **De-duplicate expressions**:  
   Since `a2` appears twice, we simplify the requirement to:  
   `[a1 ASC, b1 ASC, a2 ASC, b2 ASC]` (We keep the first expression from the left side).

4. **Match leading orderings**:  
   - Check if leading ordering requirement `a1 ASC` can be found among the leading valid orderings: `a1 ASC, b1 ASC`. It can, so we remove `a1 ASC` from the ordering requirement and valid orderings.
5. **Iterate through the remaining expressions**:
Now, the problem is converted from 
*"whether the requirement: `[a1 ASC, b1 ASC, a2 ASC, b2 ASC]` is satisfied by valid orderings:  `[[a1 ASC, a2 ASC], [b1 ASC, b2 ASC]]`"*
into
*"whether the requirement: `[b1 ASC, a2 ASC, b2 ASC]` is satisfied by valid orderings:  `[[a2 ASC], [b1 ASC, b2 ASC]]`"*
We go back to step 4 until the ordering requirement list exhausted or until its length no longer decreases.

At the end of stages above, we end up with an empty ordering requirement list. Given this, we can conclude that the table satisfies the ordering requirement.

## Conclusion

In this post, we analyzed the conditions under which an ordering requirement is satisfied given the properties of a table. We introduced necessary concepts like constant expressions, equivalence groups, and valid orderings, and used these to check whether an ordering requirement could be met. This analysis plays a crucial role in generating efficient query plans and avoiding unnecessary or incorrect operations.

The `DataFusion` query engine uses this kind of analysis during its planning stage to ensure correct and efficient query execution. You can find the implementation of this analysis in the [DataFusion repository](https://github.com/apache/datafusion/tree/main/datafusion/physical-expr/src/equivalence).

[^1]: The ordering requirement refers to the condition that input data must be sorted in a certain way for a specific operator to function as intended.
[^2]: Lexicographic order is a way of ordering sequences (like strings, list of expressions) based on the order of their components, similar to how words are ordered in a dictionary. It compares each element of the sequences one by one, from left to right.
[^3]: Leading ordering requirement is the first ordering requiremnt in the list of lexicographical ordering requirement expression. As an example for the requirement: `[a1 ASC, b1 ASC, a2 ASC, b2 ASC]`, leading ordering requirement is: `a1 ASC`.
[^4]: Leading valid orderings are the first ordering for each valid ordering list in the table. As an example, for the valid orderings: `[[a1 ASC, a2 ASC], [b1 ASC, b2 ASC]]`, leading valid orderings will be: `a1 ASC, b1 ASC`. 