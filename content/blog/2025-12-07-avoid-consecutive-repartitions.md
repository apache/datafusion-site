# **Noobs Guide To Databases**

_By Gene Bordegaray_, _Co-Authored by Nga Tran and Andrew Lamb_

Databases are some of the most complex yet interesting pieces of software. They are amazing pieces of abstraction: query engines optimize and execute complex plans, storage engines provide sophisticated infrastructure as the backbone of the system, while intricate file formats lay the groundwork for particular workloads. All of this is exposed by a user-friendly interface and query languages (typically a dialect of SQL).

Starting a journey learning about database internals can be daunting. With so many topics that are whole PhD degrees themselves, finding a place to start is difficult. In this blog post, I will share my early journey in the database world and a quick lesson on one of the first topics I dove into. If you are new to the space, this post will help you get your first foot into the database world, and if you are already a veteran, you may still learn something new.

![Image failed to load](/blog/images/database_system_diagram.png "Database System Components")

---

## **Who Am I?**

I am Gene Bordegaray, a recent computer science graduate from UCLA and software engineer at Datadog. Before starting my job, I had no real exposure to databases, only enough SQL knowledge to send CRUD requests and choose between a relational or no-SQL model in a systems design interview.

When I found out I would be on a team focusing on query engines and execution, I was excited but horrified. "Query engines?" From my experience, I typed SQL queries into pgAdmin and got responses without knowing the dark magic that happened under the hood.

With what seemed like an impossible task at hand, I began my favorite few months of learning.

---

## **Starting Out**

I am no expert in databases or any of their subsystems, but I am someone who recently began learning about them. My goal through this series of posts is to share lessons I’ve learned through my newbie journey to encourage others to explore the database world and share the amazing community and work being done on Datafusion.

### Build a Foundation

The first thing I did, which I highly recommend, was watch Andy Pavlo's [Intro To Database Systems course](https://15445.courses.cs.cmu.edu/fall2025/). This laid a great foundation for understanding how a database works from end to end at a high level. It touches on topics ranging from file formats to query optimization, and it was helpful to have a general context for the whole system before diving deep into a single sector.

### Narrow Your Scope

The next crucial step is to pick your niche and stick to it. Database systems are so vast that trying to tackle the whole beast at once is a lost cause. If you want to effectively contribute to this space, you need to deeply understand the system you are working on, and you will have much better luck narrowing your scope.

When learning about the entire database stack at a high level, note what parts stick out as particularly interesting. For me, this focus is on query engines, more specifically, the physical planner and optimizer.

### A "Slow" Start

The final piece of advice when starting, and I sound like a broken record, is to take your time to learn. This is not an easy sector of software to jump into; it will pay dividends to slow down, fully understand the system, and why it is designed the way it is.

When making your first contributions to an open-source project, start very small but go as deep as you can. Don't leave any stone unturned. I did this by looking for simpler issues, such as formatting or simple bug fixes, and stepping through the entire data flow that relates to the issue, noting what each component is responsible for.

This will give you familiarity with the codebase and using your tools, like your debugger and environment, with the project.

Now that we have some general knowledge of database internals, a niche or subsystem we want to dive deeper into, and the mindset for acquiring knowledge before contributing, let's start with our first core issue.

---

## **Intro to Datafusion**

As mentioned, the database subsystem I decided to explore was query engines. The query engine is responsible for interpreting, optimizing, and executing queries, aiming to do so as efficiently as possible.

My team was in full-swing of adopting restructuring how query execution would work in our organization. The team decided we would use [Apache Datafusion](https://datafusion.apache.org/) at the heart of our system, chosen for its blazing fast execution time for analytical workloads and vast extendability. Datafusion is written in Rust and builds on top of [Apache Arrow](https://arrow.apache.org/) (another great project). This columnar memory format enables it to efficiently process large volumes of data in memory.

This project offered a perfect environment for my first steps into databases: clear, production-ready Rust programming, a manageable codebase, high performance for a specific use case, and a welcoming community.

### Parallel Execution in Datafusion

Before discussing this issue, it is essential to understand how Datafusion handles parallel execution.

Datafusion implements a vectorized [Volcano Model](https://dl.acm.org/doi/10.1145/93605.98720), similar to other state of the art engines such as clickhouse. The Volcano Model is built on the idea that each operation is abstracted into an operator, and a DAG can represent an entire query. Each operator implements a next() function that returns a batch of tuples or a NULL marker if no data is available.

![Image failed to load](/blog/images/volcano_model_diagram.png "Vectorized Volcano Model Example")

Datafusion achieves multi-core parallelism through the use of “exchange operators.” Individual operators are implemented to use a single CPU core, and the RepartitionExec operator is responsible for distributing work across multiple processors.

### What is Repartitioning?

Partitioning is a "divide-and-conquer" approach to executing a query. Each partition is a subset of the data that is being processed. Repartitioning is an operation that redistributes data across different partitions to balance workloads, reduce data skew, and increase parallelism. Two repartitioning methods are used in Datafusion: round-robin and hash.

#### **Round-Robin Repartitioning**

Round-robin repartitioning is the simplest partitioning strategy. Incoming data is processed in batches (chunks of rows), and these batches are distributed across partitions cyclically or sequentially, with each new batch assigned to the next available partition.

Round-robin repartitioning is useful when the data grouping isn’t known or when aiming for an even distribution across partitions. Because it simply assigns batches in order without inspecting their contents, it is a low-overhead way to increase parallelism for downstream operations.

![Image failed to load](/blog/images/round_robin_repartitioning.png "Round-Robin Repartitioning")

#### **Hash Repartitioning**

Hash repartitioning distributes data based on a hash function applied to one or more columns, called the \*partitioning key\*. Rows with the same hash value are placed in the same partition.

Hash repartitioning is useful when working with grouped data. Imagine you have a database containing information on company sales, and you are looking to find the total revenue each store produced. Hash repartitioning would make this query much more efficient. Rather than iterating over the data on a single thread and keeping a running sum for each store, it would be better to hash repartition on the store column and have multiple threads calculate individual store sales.

![Image failed to load](/blog/images/hash_repartitioning.png "Hash Repartitioning")

Note, the benefit of hash opposed to round-robin partitioning in this scenario. Hash repartitioning consolidates all rows with the same store value in distinct partitions. Because of this property we can compute the complete results for each store in parallel and merge them to get the final outcome. This parallel processing wouldn’t be possible with only round-robin partitioning as the same store value may be spread across multiple partitions, making the aggregation results partial and unable to merge to produce a final outcome.

![Image failed to load](/blog/images/hash_repartitioning_example.png "Hash Repartitioning Example")

---

## **The Issue: Consecutive Repartitions**

Datafusion contributors pointed out that consecutive repartition operators were being added to query plans, making them less efficient and more confusing to read ([link to issue](https://github.com/apache/datafusion/issues/18341)). This issue had stood for over a year, with some attempts to resolve it, but they fell short.

For some queries that required repartitioning, the plan would look along the lines of:

```sql
SELECT a, SUM(b) FROM data.parquet GROUP BY a;
```

![Image failed to load](/blog/images/basic_before_query_plan.png "Consecutive Repartition Query Plan")

---

## **Why Don’t We Want Consecutive Repartitions?**

Repartitions would appear back-to-back in query plans, specifically a round-robin followed by a hash repartition.

Why is this such a big deal? Well, repartitions do not process the data; their purpose is to redistribute it in ways that enable more efficient computation for other operators. Having consecutive repartitions is counterintuitive because we are redistributing data, then immediately redistributing it again, making the first repartition pointless. While this didn’t create extreme overhead for queries, since round-robin repartitioning does not copy data, just pointers to batches, the behavior was unclear and incorrect.

![Image failed to load](/blog/images/in_depth_query_plan_before.png "Consecutive Repartition Query Plan With Data")

Optimally the plan should do one of two things:

1. If there is enough data to justify round-robin repartitioning, split the repartitions across a "worker" operator that leverages the redistributed data.
2. Otherwise, don't use any round-robin repartition and keep the hash repartition only in the middle of the two-stage aggregation.

![Image failed to load](/blog/images/optimal_query_plans.png "Optimal Query Plans")

As shown in the diagram above, in the CSV plan, the round-robin repartition takes place before the partial aggregation. This increases parallelism for this processing, which will yield great performance benefits in larger datasets.

---

## **Identifying the Bug**

With an understanding of what the problem is, it is finally time to dive into isolating and identifying the bug.

### No Code\!

Before looking at any code, we can narrow the scope of where we should be looking. I found that tightening the boundaries of what you are looking for before reading any code is critical for being effective in large, complex codebases. If you are searching for a needle in a haystack, you will spend hours sifting through irrelevant code.

We can use what we know and provide tools to pinpoint where our search should begin. So far, we know the bug only exists where repartitioning is needed. Let's see how else we can pinpoint our search.

From previous tickets, I was aware that Datafusion offered the EXPLAIN VERBOSE keywords. When put before a query, the CLI prints the logical and physical plan at each step of planning and optimization. Running this query:

```sql
EXPLAIN VERBOSE SELECT a, SUM(b) FROM data.parquet GROUP BY a;
```

we find a critical piece of information.

**Physical Plan Before EnforceDistribution:**

```
1.OutputRequirementExec: order_by=[], dist_by=Unspecified
2.--AggregateExec: mode=FinalPartitioned, gby=[a@0 as a], aggr=[sum(parquet_data.b)]
3.----AggregateExec: mode=Partial, gby=[a@0 as a], aggr=[sum(parquet_data.b)]
4.------DataSourceExec:
                file_groups={1 group: [[...]]}
                projection=[a, b]
                file_type=parquet
```

**Physical Plan After EnforceDistribution:**

```
1.OutputRequirementExec: order_by=[], dist_by=Unspecified
2.--AggregateExec: mode=FinalPartitioned, gby=[a@0 as a], aggr=[sum(parquet_data.b)]
3.----RepartitionExec: partitioning=Hash([a@0], 16), input_partitions=16
4.------RepartitionExec: partitioning=RoundRobinBatch(16), input_partitions=1
5.--------AggregateExec: mode=Partial, gby=[a@0 as a], aggr=[sum(parquet_data.b)]
6.----------DataSourceExec:
                file_groups={1 group: [[...]]}
                projection=[a, b]
                file_type=parquet
```

We have found the exact rule, [EnforceDistribution](https://github.com/apache/datafusion/blob/944f7f2f2739a9d82ac66c330ea32a9c7479ee8b/datafusion/physical-optimizer/src/enforce_distribution.rs#L66-L184), that is responsible for introducing the bug before reading a single line of code\! For experienced maintainers of Datafusion, they would've known where to look before starting, but for a newbie, this is great information.

### The Root Cause

With a single rule to read, isolating the issue is much simpler. The EnforceDistribution rule takes a physical query plan as input, iterates over each child analyzing its requirements, and decides where adding repartition nodes is beneficial.

A great place to start looking is before any repartitions are inserted, and where the program decides if adding a repartition above/below an operator is useful. With the help of handy function header comments, it was easy to identify that this is done in the [get_repartition_requirement_status](https://github.com/apache/datafusion/blob/944f7f2f2739a9d82ac66c330ea32a9c7479ee8b/datafusion/physical-optimizer/src/enforce_distribution.rs#L1108) function. Here, Datafusion sets four fields indicating how the operator would benefit from repartitioning:

1. **The operator's distribution requirement**: what type of partitioning does it need from its children (hash, single, or unknown)?
2. **If round-robin is theoretically beneficial:** does the operator benefit from parallelism?
3. **If our data indicates round-robin to be beneficial**: do we have enough data to justify the overhead of repartitioning?
4. **If hash repartitioning is necessary**: is the parent an operator that requires all column values to be in the same partition, like an aggregate, and are we already hash-partitioned correctly?

Ok, great\! We understand the different components Datafusion uses to indicate if repartitioning is beneficial. Now all that's left to do is see how repartitions are inserted.

This logic takes place in the main loop of this rule. I find it helpful to draw algorithms like these into logic trees; this tends to make things much more straightforward and approachable:

![Image failed to load](/blog/images/logic_tree_before.png "Incorrect Logic Tree")

Boom\! This is the root of our problem: we are inserting a round-robin repartition, then still inserting a hash repartition afterwards. This means that if an operator indicates it would benefit from both round-robin and hash repartitioning, consecutive repartitions will occur.

---

## **The Fix**

The logic shown before is, of course, incorrect, and the conditions for adding hash and round-robin repartitioning should be mutually exclusive since an operator will never benefit from shuffling data twice.

Well, what is the correct logic?

Based on our lesson on hash repartitioning and the indicators Datafusion uses to determine when repartitioning can benefit an operator, the fix is easy. In the sub-tree where an operator's parent requires hash partitioning:

- If we are already hashed correctly, don't do anything. If we insert a round-robin, we will break out the partitioning.
- If a hash is required, just insert a hash repartition.

The new logic tree looks like this:

![Image failed to load](/blog/images/logic_tree_after.png "Correct Logic Tree")

All that deep digging paid off, one condition (see [the final PR](https://github.com/apache/datafusion/pull/18521) for full details)\!

**Condition before:**

```rust
 if add_roundrobin {
```

**Condition after:**

```rust
if add_roundrobin && !hash_necessary {
```

---

## **Results**

This eliminated every consecutive repartition in the Datafusion test suite and benchmarks, reducing overhead, making plans clearer, and enabling further optimizations.

Plans became simpler:

**Before:**

```

1.ProjectionExec: expr=[env@0 as env, count(Int64(1))@1 as count(*)]
2.--AggregateExec: mode=FinalPartitioned, gby=[env@0 as env], aggr=[count(Int64(1))]
3.----CoalesceBatchesExec: target_batch_size=8192
4.------RepartitionExec: partitioning=Hash([env@0], 4), input_partitions=4
5.--------RepartitionExec: partitioning=RoundRobinBatch(4), input_partitions=1
6.----------AggregateExec: mode=Partial, gby=[env@0 as env], aggr=[count(Int64(1))]
7.------------DataSourceExec:
              file_groups={1 group: [[..]}
              projection=[env]
              file_type=parquet

```

**After:**

```
1.ProjectionExec: expr=[env@0 as env, count(Int64(1))@1 as count(*)]
2.--AggregateExec: mode=FinalPartitioned, gby=[env@0 as env], aggr=[count(Int64(1))]
3.----CoalesceBatchesExec: target_batch_size=8192
4.------RepartitionExec: partitioning=Hash([env@0], 4), input_partitions=1
5.--------AggregateExec: mode=Partial, gby=[env@0 as env], aggr=[count(Int64(1))]
6.----------DataSourceExec:
                file_groups={1 group: [[WORKSPACE_ROOT/datafusion/sqllogictest/test_files/scratch/aggregate_repartition/dim.parquet]]}
                projection=[env]
                file_type=parquet
```

For the benchmarking standard, TPCH, speedups were small but consistent:

**TPCH Benchmark**

![Image failed to load](/blog/images/tpch_benchmark.png "TPCH Bnechmark Reults")

**TPCH10 Benchmark**

![Image failed to load](/blog/images/tpch10_benchmark.png "TPCH10 Benchmark Results")

And there it is, our first core contribution for a database system.

From this experience there are two main points I would like to emphasize:

The first is to deeply understand the system you are working on. It is not only fun to figure these things out, but it also pays off in the long run when having surface-level knowledge won't cut it.

The second, which is complimentary to the first, is to narrow down the scope of your work when starting your journey into databases. Find a project that you are interested in and provides an environment that enhances your early learning process. I have found that Apache Datafusion and its community has been an amazing first step and plan to continue learning about query engines here.

I hope you gained something from my experience and have fun learning about databases.

---

## **Acknowledgements**

Thank you to Nga Tran for continuous mentorship and guidance, the Datafusion community, specifically Andrew Lamb, for lending support throughout my work, and Datadog for providing the opportunity to work on such interesting systems.
