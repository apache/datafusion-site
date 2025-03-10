---
layout: post
title: Using Ordering for Better Plans in Apache DataFusion
date: 2025-03-05
author: Mustafa Akur, Andrew Lamb
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
In this blog post, we explain when an ordering requirement of an operator is satisfied by its input data. This analysis is essential for order-based optimizations and is often more complex than one might initially think.
<blockquote style="border-left: 4px solid #007bff; padding: 10px; background-color: #f8f9fa;">
    <strong>Ordering Requirement</strong> for an operator describes how the input data to that operator must be sorted for the operator to compute the correct result. It is the job of the planner to make sure that these requirements are satisfied during execution (See DataFusion <a href="https://docs.rs/datafusion/latest/datafusion/physical_optimizer/enforce_sorting/struct.EnforceSorting.html" target="_blank">EnforceSorting</a> for an implementation of such rule).
</blockquote>

There are various use cases, where this type of analysis can be useful such as the following examples.
### Removing Unnecessary Sorts
Imagine a user wants to execute the following query:
```SQL
SELECT hostname, log_line 
FROM telemetry ORDER BY time ASC limit 10
```
If we don't know anything about the `telemetry` table, we need to sort it by `time ASC` and then retrieve the first 10 rows to get the correct result. However, if the table is already ordered by `time ASC`, we can simply retrieve the first 10 rows. This approach executes much faster and uses less memory compared to resorting the entire table, even when the [TopK] operator is used. 

[TopK]: https://docs.rs/datafusion/latest/datafusion/physical_plan/struct.TopK.html

In order to avoid the sort, the query optimizer must determine the data is already sorted. For simple queries the analysis is straightforward, but it gets complicated fast. For example, what if your data is sorted by `[hostname, time ASC]` and your query is
```sql
SELECT hostname, log_line 
FROM telemetry WHERE hostname = 'app.example.com' ORDER BY time ASC;
```
In this case, a sort still isn't needed,  but the analysis must  reason about the sortedness of the stream when it knows `hostname` has a single value.

### Optimized Operator Implementations
As another use case, some operators can utilize the ordering information to change its underlying algorithm to execute more efficiently. Consider the following query:
```SQL
SELECT COUNT(log_line) 
FROM telemetry GROUP BY hostname;
```
Most analytic systems, including DataFusion, by default implement such a query using a hash table keyed on values of `hostname` to store the counts. However, if the `telemetry` table is sorted by `hostname`,  there are much more efficient algorithms for grouping on `hostname` values than hashing every value and storing it in memory. However, the more efficient algorithm can only be used when the input is sorted correctly. To see this in practice, check out the [source](https://github.com/apache/datafusion/tree/main/datafusion/physical-plan/src/aggregates/order) for ordered variant of the `Aggregation` in `DataFusion`.

### Streaming-Friendly Execution

Stream processing aims to produce results immediately as they become available, ensuring minimal latency for real-time workloads. However, some operators need to consume all input data before producing any output. Consider the `Sort` operation: before it can start generating output, the algorithm must first process all input data. As a result, data flow halts whenever such an operator is encountered until all input is consumed. When a physical query plan contains such an operator (`Sort`, `CrossJoin`, ..), we refer to this as pipeline breaking, meaning the query cannot be executed in a streaming fashion.

For a query to be executed in a streaming fashion, we need to satisfy 2 conditions:

**Logically Streamable**  
It should be possible to generate what user wants in streaming fashion. Consider following query:

```SQL
SELECT SUM(amount)  
FROM orders  
```
Here, the user wants to compute the sum of all amounts in the orders table. By nature, this query requires scanning the entire table to generate a result, making it impossible to execute in a streaming fashion.

**Streaming Aware Planner**  
Being logically streamable does not guarantee that a query will execute in a streaming fashion. SQL is a declarative language, meaning it specifies 'WHAT' user wants. It is up to the planner, 'HOW' to generate the result. In most cases, there are many ways to compute the correct result for a given query. The query planner is responsible for choosing "a way" (ideally the best<sup id="optimal1">[*](#optimal)</sup> one) among the all alternatives to generate what user asks for. If a plan contains a pipeline-breaking operator, the execution will not be streaming—even if the query is logically streamable. To generate truly streaming plans from logically streamable queries, the planner must carefully analyze the existing orderings in the source tables to ensure that the final plan does not contain any pipeline-breaking operators.


## Analysis
Let's start by creating an example table that we will refer throughout the post. This table models the input data of an operator for the analysis:

### Example Virtual Table

<style>
  table {
    border-collapse: collapse;
    width: 80%;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  th, td {
    padding: 12px 16px;
    text-align: left;
    border-bottom: 1px solid #e0e0e0;
  }
  th {
    background-color: #f9f9f9;
    font-weight: 600;
  }
  tr:hover {
    background-color: #f1f1f1;
  }
</style>

<table>
  <tr>
    <th>amount</th> <th>price</th> <th>hostname</th><th>currency</th><th>time_bin</th> <th>time</th> <th>price_cloned</th> <th>time_cloned</th>
  </tr>
  <tr>
    <td>12</td> <td>25</td> <td>app.example.com</td> <td>USD</td> <td>08:00:00</td> <td>08:01:30</td> <td>25</td> <td>08:01:30</td>
  </tr>
  <tr>
    <td>12</td> <td>26</td> <td>app.example.com</td> <td>USD</td> <td>08:00:00</td> <td>08:11:30</td> <td>26</td> <td>08:11:30</td>
  </tr>
  <tr>
    <td>15</td> <td>30</td> <td>app.example.com</td> <td>USD</td> <td>08:00:00</td> <td>08:41:30</td> <td>30</td> <td>08:41:30</td>
  </tr>
  <tr>
    <td>15</td> <td>32</td> <td>app.example.com</td> <td>USD</td> <td>08:00:00</td> <td>08:55:15</td> <td>32</td> <td>08:55:15</td>
  </tr>
  <tr>
    <td>15</td> <td>35</td> <td>app.example.com</td> <td>USD</td> <td>09:00:00</td> <td>09:10:23</td> <td>35</td> <td>09:10:23</td>
  </tr>
  <tr>
    <td>20</td> <td>18</td> <td>app.example.com</td> <td>USD</td> <td>09:00:00</td> <td>09:20:33</td> <td>18</td> <td>09:20:33</td>
  </tr>
  <tr>
    <td>20</td> <td>22</td> <td>app.example.com</td> <td>USD</td> <td>09:00:00</td> <td>09:40:15</td> <td>22</td> <td>09:40:15</td>
  </tr>
</table>

<br>

<blockquote style="border-left: 4px solid #007bff; padding: 10px; background-color: #f8f9fa;">
<strong>How can a table have multiple orderings?:</strong> At first glance, it may seem counterintuitive for a table to have more than one valid ordering. However, during query execution, such scenarios can arise.

For example, consider the following query:
```sql
SELECT time, date_bin('1 hour', time, '1970-01-01') as time_bin  
FROM table;
```
If we know that the table is ordered by <code>time ASC</code>, we can infer that <code>time_bin ASC</code> is also a valid ordering. This is because the <code>date_bin</code> function is monotonic, meaning it preserves the order of its input.

DataFusion leverages these functional dependencies to infer new orderings as data flows through different query operators. For details on the implementation, see the <a href="https://github.com/apache/datafusion/blob/main/datafusion/common/src/functional_dependencies.rs", target="_blank">source</a> code.
</blockquote>

By inspection, you can see this table is sorted by the `amount` column, but It is also sorted by `time` and `time_bin` as well as the compound `(time_bin, amount)` and many other variations. While this example is an extreme case, many real world data have multiple sort orders. 

A naive approach for analyzing whether the ordering requirement of an operator is satisfied by its input would be:  

  - Store all the valid ordering expressions that the tables satisfies  
  - Check whether the ordering requirement by the operator is among valid orderings.  

This naive algorithm works and correct. However, listing all valid orderings can be quite lengthy and is of exponential complexity as the number of orderings grows. For the example table, here is a (small) subset of the valid orderings:

`[amount ASC]`  
`[amount ASC, price ASC]`  
`[amount ASC, price_cloned ASC]`  
`[hostname ASC, amount ASC, price_cloned ASC]`  
`[amount ASC, hostname ASC,  price_cloned ASC]`  
`[amount ASC, price_cloned ASC, hostname ASC]`  
.  
.  
.  

As can be seen from the listing above. Storing all of the valid orderings is wasteful, and contains significant redundancy. Here are some observations, suggesting we can do much better:


- Storing a prefix of another valid ordering is redundant. If the table satisfies the lexicographic ordering<sup id="fn1">[1](#footnote1)</sup>: `[amount ASC, price ASC]`, it already satisfies ordering `[amount ASC]` trivially. Hence, once we store `[amount ASC, price ASC]` storing `[amount ASC]` is rdundant.

- Using all columns that are equal to each other in the listings is redundant. If we know the table is ordered by `[amount ASC, price ASC]` , it is also ordered by `[amount ASC, price_cloned ASC]` since `price` and `price_cloned` are copy of each other. It is enough to use just one expression among the expressions that exact copy of each other.

- Constant expressions can be inserted anywhere in a valid ordering with an arbitrary direction (e.g. `ASC`, `DESC`). Hence, if the table is ordered by `[amount ASC, price ASC]`, it is also ordered by: <br>
   `[hostname ASC, amount ASC, price ASC]`,  
   `[hostname DESC, amount ASC, price ASC]`,  
   `[amount ASC, hostname ASC, price ASC]`,  
   .  
   .    

This is clearly redundant. For this reason, it is better to avoid explicitly encoding constant expressions in valid sort orders.

In summary,

- We should store only the longest lexicographic ordering (shouldn't use any prefix of it)
- Using expressions that are exact copies of each other is redundant.
- Ordering expressions shouldn't contain any constant expression.


## Key Concepts for Analyzing Orderings
To solve the shortcomings above, DataFusion needs to track of following properties for the table:

- Constant Expresssions  
- Equivalent Expression Groups (will be explained shortly)
- Succinct Valid Orderings (will be explained shortly)

<blockquote style="border-left: 4px solid #007bff; padding: 10px; background-color: #f8f9fa;">
    <strong>Note:</strong> These propeties are implemented in the <code>EquivalenceProperties</code> structure in <code>DataFusion</code>, please see the <a href="https://github.com/apache/datafusion/blob/f47ea73b87eec4af044f9b9923baf042682615b2/datafusion/physical-expr/src/equivalence/properties/mod.rs#L134" target="_blank">source</a> for more details<br>
</blockquote>

These properties allow us to analyze whether the ordering requirement is satisfied by the data already.

### 1. Constant Expressions
Constant expressions are those where each row in the expression has the same value across all rows. Although constant expressions may seem odd in a table, they arise after operations like `Filter` or `Join`. 

For instance in the example table:

- Columns `hostname` and `currency` are constant because every row in the table has the same value ('app.example.com' for 'hostname', and 'USD' for 'currency') for these columns.

<blockquote style="border-left: 4px solid #007bff; padding: 10px; background-color: #f8f9fa;">
    <strong>Note:</strong> Constant expressions can arise during query execution. For example, in following query:<br>
    <code>SELECT hostname FROM logs</code><br><code>WHERE hostname='app.example.com'</code> <br>
    after filtering is done, for subsequent operators 'hostname' column will be constant.
</blockquote>

### 2. Equivalent Expression Groups
Equivalent expression groups are expressions that always hold the same value across rows. These expressions can be thought of as clones of each other and may arise from operations like `Filter`, `Join`, or `Projection`.

In the example table, the expressions `price` and `price_cloned` form one equivalence group, and `time` and `time_cloned` form another equivalence group.

<blockquote style="border-left: 4px solid #007bff; padding: 10px; background-color: #f8f9fa;">
    <strong>Note:</strong> Equivalent expression groups can arise during the query execution. For example, in the following query:<br>
    <code>SELECT time, time as time_cloned FROM logs</code> <br>
    after the projection is done, for subsequent operators 'time' and 'time_cloned' will form an equivalence group. As another example, in the following query:<br>
    <code>SELECT employees.id, employees.name, departments.department_name</code>
<code>FROM employees</code>
<code>JOIN departments ON employees.department_id = departments.id;</code> <br>
after joining, 'employees.department_id' and 'departments.id' will form an equivalence group.
</blockquote>

### 3. Succint Encoding of Valid Orderings
Valid orderings are the orderings that the table already satisfies. However, naively listing them requires exponential space as the number of columns grows as discussed before. Instead, we list all valid orderings after following constraints are applied:

-  Do not use any constant expressions in the valid ordering construction
-  Use only one entry (by convention the first entry) in the equivalent expression group.
-  Lexicographic ordering shouldn't contain any leading ordering<sup id="fn2">[2](#footnote2)</sup>except the first position <sup id="fn3">[3](#footnote3)</sup>.
-  Do not use any prefix of a valid lexicographic ordering<sup id="fn4">[4](#footnote4)</sup>.

After applying the first and second constraint, example table simplifies to 

<style>
  table {
    border-collapse: collapse;
    width: 80%;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  th, td {
    padding: 12px 16px;
    text-align: left;
    border-bottom: 1px solid #e0e0e0;
  }
  th {
    background-color: #f9f9f9;
    font-weight: 600;
  }
  tr:hover {
    background-color: #f1f1f1;
  }
</style>

<table>
  <tr>
    <th>amount</th> <th>price</th><th>time_bin</th> <th>time</th>
  </tr>
  <tr>
    <td>12</td> <td>25</td><td>08:00:00</td> <td>08:01:30</td>
  </tr>
  <tr>
    <td>12</td> <td>26</td><td>08:00:00</td> <td>08:11:30</td> 
  </tr>
  <tr>
    <td>15</td> <td>30</td><td>08:00:00</td> <td>08:41:30</td>
  </tr>
  <tr>
    <td>15</td> <td>32</td><td>08:00:00</td> <td>08:55:15</td>
  </tr>
  <tr>
    <td>15</td> <td>35</td><td>09:00:00</td> <td>09:10:23</td> 
  </tr>
  <tr>
    <td>20</td> <td>18</td><td>09:00:00</td> <td>09:20:33</td>
  </tr>
  <tr>
    <td>20</td> <td>22</td><td>09:00:00</td> <td>09:40:15</td>
  </tr>
</table>
<br>
Following third and fourth constraints for the simplified table, the succinct valid orderings are:<br>
`[amount ASC, price ASC]`,   
`[time_bin ASC]`,  
`[time ASC]`  

### Table Properties  

In summary, for the example table, the following properties correctly describe the sort properties:

- **Constant Expressions** = `hostname, currency`  
- **Equivalent Expression Groups** = `[price, price_cloned], [time, time_cloned]`  
- **Valid Orderings** = `[amount ASC, price ASC], [time_bin ASC], [time ASC]`  

### Algorithm for Analyzing Ordering Requirements

After deriving these properties for the data, following algorithm can be used to check whether an ordering requirement is satisfied by the table:

1. **Prune constant expressions**: Remove any constant expressions from the ordering requirement.
2. **Normalize the requirement**: Replace each expression in the ordering requirement with the first entry from its equivalence group.
3. **De-duplicate expressions**: If an expression appears more than once, remove duplicates, keeping only the first occurrence.
4. **Match leading orderings**: Check whether the leading ordering requirement<sup id="fn5">[5](#footnote5)</sup> matches the leading valid orderings<sup id="fn6">[6](#footnote6)</sup> of table. If so:
    - Remove the leading ordering requirement from the ordering requirement 
    - Remove the matching leading valid ordering from the valid orderings of table. 
5. **Iterate through the remaining expressions**: Go back to step 4 until ordering requirement is empty or leading ordering requirement is not found among the leading valid orderings of table.

If, at the end of the procedure above, the ordering requirement is an empty list, we can conclude that the requirement is satisfied by the table.

### Example Walkthrough

Let's say the user provided a query such as the following
```sql
SELECT * FROM table
ORDER BY hostname DESC, amount ASC, time_bin ASC, price_cloned ASC, time ASC, currency ASC, price DESC;
```
And the input has the same properties explained above

- **Constant Expressions** = `hostname, currency`
- **Equivalent Expressions Groups** = `[price, price_cloned], [time, time_cloned]`
- **Succinct Valid Orderings** = `[amount ASC, price ASC], [time_bin ASC], [time ASC]`

In order to remove a sort, the optimizer must check if the ordering requirement `[hostname DESC, amount ASC, time_bin ASC, price_cloned ASC, time ASC, currency ASC, price DESC]` is satisfied by the properties.

### Algorithm Steps

1. **Prune constant expressions**:  
   Remove `hostname` and `currency` from the requirement. The requirement becomes:  
   `[amount ASC, time_bin ASC, price_cloned ASC, time ASC, price DESC]`.

2. **Normalize using equivalent groups**:  
   Replace `price_cloned` with `price` and `time_cloned` with `time`. The requirement becomes:  
   `[amount ASC, time_bin ASC, price ASC, time ASC, price DESC]`.

3. **De-duplicate expressions**:  
   Since `price` appears twice, we simplify the requirement to:  
   `[amount ASC, time_bin ASC, price ASC, time ASC]` (keeping the first occurrence from the left side).

4. **Match leading orderings**:  
  Check if leading ordering requirement `amount ASC` is among the leading valid orderings: `amount ASC, time_bin ASC, time ASC`. Since this is the case, we remove `amount ASC` from both the ordering requirement and the valid orderings of the table.
5. **Iterate through the remaining expressions**:
Now, the problem is converted from<br>
*"whether the requirement: `[amount ASC, time_bin ASC, price ASC, time ASC]` is satisfied by valid orderings:  `[amount ASC, price ASC], [time_bin ASC], [time ASC]`"*<br>
into<br>
*"whether the requirement: `[time_bin ASC, price ASC, time ASC]` is satisfied by valid orderings:  `[price ASC], [time_bin ASC], [time ASC]`"*<br>
We go back to step 4 until the ordering requirement list is exhausted or its length no longer decreases.

At the end of stages above, we end up with an empty ordering requirement list. Given this, we can conclude that the table satisfies the ordering requirement and thus no sort is required. 

## Conclusion

In this post, we described the conditions under which an ordering requirement is satisfied based on the properties of a table. We introduced key concepts such as constant expressions, equivalence groups, and valid orderings, and used them to determine whether a given ordering requirement are satisfied by an input table.

This analysis plays a crucial role in:

- Choosing more efficient algorithm variants
- Generating streaming-friendly plans

The `DataFusion` query engine employs this analysis (and many more) during its planning stage to ensure correct and efficient query execution. We [welcome you] to come and join the project.

[welcome you]: https://datafusion.apache.org/contributor-guide/index.html

## Appendix

<!--
<p id="footnote1"><sup>[1]</sup>The ordering requirement refers to the condition that input data must be sorted in a certain way for a specific operator to function as intended.</p>
-->
<p id="footnote1"><sup>[1]</sup>Lexicographic order is a way of ordering sequences (like strings, list of expressions) based on the order of their components, similar to how words are ordered in a dictionary. It compares each element of the sequences one by one, from left to right.</p>
<p id="footnote2"><sup>[2]</sup>Leading ordering is the first ordering in a lexicographic ordering list. As an example, for the ordering: <code>[amount ASC, price ASC]</code>, leading ordering will be: <code>amount ASC</code>. </p>
<p id="footnote3"><sup>[3]</sup>This means that, if we know that <code>[amount ASC]</code> and <code>[time ASC]</code> are both valid orderings for the table. We shouldn't enlist <code>[amount ASC, time ASC]</code> or <code>[time ASC, amount ASC]</code></p> as valid orderings. These orderings can be deduced if we know that table satisfies the ordering <code>[amount ASC]</code> and <code>[time ASC]</code>.
<p id="footnote4"><sup>[4]</sup>This means that, if ordering <code>[amount ASC, price ASC]</code> is a valid ordering for the table. We shouldn't enlist <code>[amount ASC]</code> as valid ordering. Validity of it can be deduced from the ordering: <code>[amount ASC, price ASC]</code>
<p id="footnote5"><sup>[5]</sup>Leading ordering requirement is the first ordering requirement in the list of lexicographic ordering requirement expression. As an example for the requirement: <code>[amount ASC, time_bin ASC, prices ASC, time ASC]</code>, leading ordering requirement is: <code>amount ASC</code>.</p>
<p id="footnote6"><sup>[6]</sup>Leading valid orderings are the first ordering for each valid ordering list in the table. As an example, for the valid orderings: <code>[amount ASC, prices ASC], [time_bin ASC], [time ASC]</code>, leading valid orderings will be: <code>amount ASC, time_bin ASC, time ASC</code>. </p>
<p id="optimal"><sup>*</sup>Optimal depends on the use case, <code>DataFusion</code> has many various flags to communicate what user thinks the optimum plan is (e.g. streamable, fastest, lowest memory, etc.). See <a href="https://datafusion.apache.org/user-guide/configs.html" target="_blank">configurations</a> for detail.</p>
