---
layout: post
title: Query Cancellation
date: 2025-06-27
author: Pepijn Van Eeckhoudt
categories: [features]
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


## The Challenge of Cancelling Long-Running Queries

Have you ever tried to cancel a query that just wouldn't stop?
In this post, we'll take a look at why that can happen in DataFusion and what the community did to resolve the problem in depth.

### Understanding Rust's Async Model

To really understand the cancellation problem you need to be somewhat familiar with Rust's asynchronous programming model.
This is a bit different than what you might be used to from other ecosystems.
Let's go over the basics again as a refresher.
If you're familiar with the ins and outs of `Future` and `async` you can skip this section.

#### Futures Are Inert

Rust's asynchronous programming model is built around the `Future<T>` trait.
In contrast to, for instance, Javascript's `Promise` or Java's `Future` a Rust `Future` does not necessarily represent an actively running asynchronous job.
Instead, a `Future<T>` represents a lazy calculation that only makes progress when explicitly polled.
If nothing tells a `Future` to try and make progress explicitly, it is [an inert object](https://doc.rust-lang.org/std/future/trait.Future.html#runtime-characteristics).

You ask a `Future<T>`to advance its calculation as much as possible by calling the `poll` method.
The `Future` responds with either:
- `Poll::Pending` if it needs to wait for something (like I/O) before it can continue
- `Poll::Ready<T>` when it has completed and produced a value

When a `Future` returns `Pending`, it saves its internal state so it can pick up where it left off the next time you poll it.
This state management is what makes Rust's `Future`s memory-efficient and composable.
It also needs to set up the necessary signaling so that the caller gets notified when it should try to call `poll` again.
This avoids having to call `poll` in a busy-waiting loop.

Rust's `async` keyword provides syntactic sugar over this model.
When you write an `async` function or block, the compiler transforms it into an implementation of the `Future` trait for you.
Since all the state management is compiler generated and hidden from sight, async code tends to be more readable while maintaining the same underlying mechanics.

The `await` keyword complements this by letting you pause execution until a `Future` completes.
When you `.await` a `Future`, you're essentially telling the compiler to poll that `Future` until it's ready before program execution continues with the statement after the await.

#### From Futures to Streams

The ``Future`s` crate extends the `Future` model with the `Stream` trait.
Streams represent a sequence of values produced asynchronously rather than just a single value.
The `Stream` trait has one method named `poll_next` that returns:
- `Poll::Pending` when the next value isn't ready yet, just like a `Future` would
- `Poll::Ready(Some(value))` when a new value is available
- `Poll::Ready(None)` when the stream is exhausted

### How DataFusion Executes Queries

In DataFusion, queries are executed as follows:

1. First the query is compiled into a tree of `ExecutionPlan` nodes
2. `ExecutionPlan::execute` is called on the root of the tree. This method returns a `SendableRecordBatchStream` (a pinned `Box<dyn Stream<RecordBatch>>`)
3. `Stream::poll_next` is called in a loop to get the results

The stream we get in step 2 is actually the root of a tree of streams that mostly mirrors the execution plan tree.
Each stream tree node processes the record batches it gets from its children.
The leaves of the tree produce record batches themselves.

Query execution progresses each time you call `poll_next` on the root stream.
This call typically cascades down the tree, with each node calling `poll_next` on its children to get the data it needs to process.

Here's where the first signs of problems start to show up: some operations (like aggregations, sorts, or certain join phases) need to process a lot of data before producing any output.
When `poll_next` encounters one of these operations, it might need to perform a substantial amount of work before it can return a record batch.

### Tokio and Cooperative Scheduling

We need to make a small detour now via Tokio's scheduler before we can get to the query cancellation problem.
DataFusion makes use of the [Tokio asynchronous runtime](https://tokio.rs), which uses a [cooperative scheduling model](https://docs.rs/tokio/latest/tokio/task/index.html#what-are-tasks).
This is fundamentally different from preemptive scheduling that you might be used to:

- In preemptive scheduling, the system can interrupt a task at any time to run something else
- In cooperative scheduling, tasks must voluntarily yield control back to the scheduler

This distinction is crucial for understanding our cancellation problem.
When a Tokio task is running, it can't be forcibly interrupted - it must cooperate by periodically yielding control.

Similarly, when you try to abort a task by calling `JoinHandle::abort()`, the Tokio runtime can't immediately force it to stop.
You're just telling Tokio: "When this task next yields control, don't resume it."
If the task never yields, it can't be aborted.

### The Cancellation Problem

With all the necessary background in place, now let's look at how the DataFusion CLI tries to run and cancel a query.
The code below paraphrases what the CLI actually does:

```rust
fn exec_query() {
    let runtime: tokio::runtime::Runtime = ...;
    let stream: SendableRecordBatchStream = ...;

    runtime.block_on(async {
        tokio::select! {
            next_batch = stream.next() => ...
            _ = signal::ctrl_c() => ...,
        }
    })
}
```

First the CLI sets up a Tokio runtime instance.
It then reads the query you want to execute from standard input or file and turns it into a stream.
Then it calls `next` on stream which is an `async` wrapper for `poll_next`.
It passes this to the `select!` macro along with a ctrl-C handler.

The `select!` macro is supposed to race these two `Future`s and complete when either one finishes.
When you press Ctrl+C, the `signal::ctrl_c()` `Future` should complete, allowing the query to be cancelled.

But there's a catch: `select!` still follows cooperative scheduling rules.
It polls each `Future` in sequence, and if the first one (our query) gets stuck in a long computation, it never gets around to polling the cancellation signal.

Imagine a query that needs to calculate something intensive, like sorting billions of rows.
The `poll_next` call a couple of minutes or even longer without returning.
During this time, Tokio can't check if you've pressed Ctrl+C, and the query continues running despite your cancellation request.

## A Closer Look at Blocking Operators

Let's peel back a layer of the onion and look at what's happening in a blocking `poll_next` implementation.
Here's a drastically simplified version of a `COUNT(*)` aggregation - something you might use in a query like `SELECT COUNT(*) FROM table`:

```rust
struct BlockingStream {
    stream: SendableRecordBatchStream,
    count: usize,
    finished: bool,
}

impl Stream for BlockingStream {
    type Item = Result<RecordBatch>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.finished {
            return Poll::Ready(None);
        }

        loop {
            match ready!(self.stream.poll_next_unpin(cx)) {
                Some(Ok(batch)) => self.count += batch.num_rows(),
                None => {
                    self.finished = true;
                    return Poll::Ready(Some(Ok(create_record_batch(self.count))));
                }
                Some(Err(e)) => return Poll::Ready(Some(Err(e))),
            }
        }
    }
}
```

How does this code work? Let's break it down step by step:

1. **Initial check**: We first check if we've already finished processing. If so, we return `Ready(None)` to signal the end of our stream:
   ```rust
   if self.finished {
       return Poll::Ready(None);
   }
   ```

2. **Processing loop**: If we're not done yet, we enter a loop to process incoming batches from our input stream:
   ```rust
   loop {
       match ready!(self.stream.poll_next_unpin(cx)) {
           // Handle different cases...
       }
   }
   ```
   The `ready!` macro checks if the input stream returned `Pending` and if so, immediately returns `Pending` from our function as well.

3. **Processing data**: For each batch we receive, we simply add its row count to our running total:
   ```rust
   Some(Ok(batch)) => self.count += batch.num_rows(),
   ```

4. **End of input**: When the child stream is exhausted (returns `None`), we calculate our final result and convert it into a record batch (omitted for brevity):
   ```rust
   None => {
       self.finished = true;
       return Poll::Ready(Some(Ok(create_record_batch(self.count))));
   }
   ```

5. **Error handling**: If we encounter an error, we pass it along immediately:
   ```rust
   Some(Err(e)) => return Poll::Ready(Some(Err(e))),
   ```

This code looks perfectly reasonable at first glance.
But there's a subtle issue lurking here: what happens if the input stream consistently returns `Ready` and never returns `Pending`?

In that case, the processing loop will keep running without ever yielding control back to Tokio's scheduler.
This means we could be stuck in a single `poll_next` call for quite some time - exactly the scenario that prevents query cancellation from working!

## Unblocking Operators

Now let's look at how we can ensure we return `Pending` every now and then.

### Independent Cooperative Operators

One simple way to achieve this is using a loop counter.
We do the exact same thing as before, but on each loop iteration we decrement our counter.
If the counter hits zero we return `Pending`.
This ensures we iterate at most 128 times before yielding.

```rust
struct CountingSourceStream {
   counter: usize
}

impl Stream for CountingSourceStream {
    type Item = Result<RecordBatch>;
   
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.counter >= 128 {
            self.counter = 0;
            cx.waker().wake_by_ref();
            return Poll::Pending;
        }

        self.counter += 1;
        let batch = ...;
        Ready(Some(Ok(batch)))
    }
}
```

This would be a simple solution for this source operator.
If our simple aggregation operator consumes this stream it will receive a `Pending` periodically causing it to yield.
Could it be that simple?

Unfortunately, no.
Let's look at what happens when we start combining operators in more complex configurations?
Suppose we create a plan like this.

```
          Merge       
      ┌─────┴─────┐   
    Filter  CountingSource
      │               
CountingSource            
```

Each source is producing a pending every 128 batches.
The filter is the standard DataFusion filter, with a filter expression that drops a batch every 50 record batches.
Merge is a simple combining operator the uses ``Future`s::stream::select` to combine two stream.

When we set this in motion, the merge operator will poll the left and right branch in a round-robin fashion.
The sources will each emit `Pending` every 128 batches, but the filter dropping batches makes it so that these arrive out-of-phase at the merge operator.
As a consequence the merge operator will always have the opportunity of polling the other stream when one of the two returns `Pending`.
The output stream of merge is again an always ready stream.
If we pass this to our aggregating operator we're right back where we started.

### Coordinated Cooperation

Wouldn't it be great if we could get all the operators to coordinate amongst each other?
When one of them determines that it's time to yield, all the other operators agree and start returning `Pending` as well.
That way our task would be coaxed towards yielding even if it tried to poll many different operators.

Luckily the [developers of Tokio ran into the exact same problem](https://tokio.rs/blog/2020-04-preemption) described above when network servers were under heavy load and came up with a solution.
Back in 2020 already, Tokio 0.2.14 introduced a per-task operation budget.
Rather than having individual counters littered throughout the code, the runtime manages a per task counter which is decremented by Tokio resources.
When the counter hits zero, all resources start returning `Pending`.
The task will then yield, after which the Tokio runtime resets the counter.

As it turns out DataFusion was already using this mechanism implicitly.
Every exchange-like operator internally makes use of a Tokio multiple producer, single consumer `Channel`.
When calling `Receiver::recv` for one of these channels, a unit of Tokio task budget is consumed.
As a consequence, query plans that made use of exchange-like operators were already mostly cancelable.

### Depleting The Budget

Let's revisit our original counting stream and adapt it to use Tokio's budget system.

```rust
struct BudgetSourceStream {
}

impl Stream for BudgetSourceStream {
    type Item = Result<RecordBatch>;
   
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let coop = ready!(tokio::task::coop::poll_proceed(cx));
        let batch: Poll<Option<Self::Item>> = ...;
        if batch.is_ready() {
            coop.made_progress();
        }
        batch
    }
}
```

The stream now goes through the following steps:

1. **Try to consume budget**: the first thing the operator does is use `poll_proceed` to try to consume a unit of budget.
   If the budget is depleted, this function will return `Pending`.
   Otherwise, we consumed one budget unit and we can continue.
   ```rust
   let coop = ready!(tokio::task::coop::poll_proceed(cx));
   ```
2. **Try to do some work**: next we try to produce a record batch.
   That might not be possible if we're reading from some asynchronous resource that's not ready.
   ```rust
   let batch: Poll<Option<Self::Item>> = ...;
   ```
3. **Commit the budget consumption**: finally, if we did produce a batch, we need to tell Tokio that we were able to make progress.
   That's done by calling the `made_progress` method on the value `poll_proceed` returned.
   ```rust
   if batch.is_ready() {
      coop.made_progress();
   }
   ```

You might be wondering why that `made_progress` construct is necessary.
This clever constructs actually makes it easier to manage the budget.
The value returned by `poll_proceed` will actually restore the budget to its original value when it is dropped.
It does so unless `made_progress` is called.
This ensures that if we exit early from our `poll_next` implementation by returning `Pending`, that the budget we had consumed becomes available again.
The task that invoked `poll_next` can then use that budget again to try to make some other `Stream` (or any resource for that matter) make progress.

### Making It Automatic

The next version of DataFusion integrates the Tokio task budget based fix in all built-in source operators.
This ensures that going forward, most queries will automatically be cancelable.

On top of that a new `ExecutionPlan` property was introduced that indicates if an operator participates in cooperative scheduling or not.
A new 'EnsureCooperative' optimizer rule can inspect query plans and insert wrapper `CooperativeExec` nodes as needed to ensure custom source operators also participate.

These two changes combined already make it very unlikely you'll encounter another query that refuses to stop.
For those situations where the automatic mechanisms are still not sufficient though there's a third addition in the form of the `datafusion::physical_plan::coop` module.
This new module provides utility functions that make it easy to adopt cooperative scheduling in your custom operators as well.  