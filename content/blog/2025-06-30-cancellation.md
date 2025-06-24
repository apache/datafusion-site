---
layout: post
title: Query Cancellation
date: 2025-06-30
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
In this post, we'll review how Rust's `async` model works, how DataFusion uses that model for CPU intensive tasks, and how this is used to cancel queries.
Then we'll review some cases where queries could not be cancelled in DataFusion and what the community did to resolve the problem.

### Understanding Rust's Async Model

DataFusion, somewhat unconventionally, [uses the Rust async system and the Tokio task scheduler](https://docs.rs/datafusion/latest/datafusion/#thread-scheduling-cpu--io-thread-pools-and-tokio-runtimes) for CPU intensive processing.
To really understand the cancellation problem you first need to be somewhat familiar with Rust's asynchronous programming model which is a bit different from what you might be used to from other ecosystems.
Let's go over the basics again as a refresher.
If you're familiar with the ins and outs of `Future` and `async` you can skip this section.

#### Futures Are Inert

Rust's asynchronous programming model is built around the [`Future<T>`](https://doc.rust-lang.org/std/future/trait.Future.html) trait.
In contrast to, for instance, Javascript's [`Promise`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise) or Java's [`Future`](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/Future.html) a Rust `Future` does not necessarily represent an actively running asynchronous job.
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
Since all the state management is compiler generated and hidden from sight, async code tends to be easier to write initially, more readable afterward, and all the while maintains the same underlying mechanics.

The `await` keyword complements this by letting you pause execution until a `Future` completes.
When you `.await` a `Future`, you're essentially telling the compiler to generate code that:
1. Polls the `Future` with the current (implicit) asynchronous context
2. If `poll` returns `Poll::Pending`, save the state of the `Future` so that it can resume at this point and return `Poll::Pending`
3. If it returns `Poll::Ready(value)`, continue execution with that value

#### From Futures to Streams

The [`futures`](https://docs.rs/futures/latest/futures/) crate extends the `Future` model with a trait named [`Stream`](https://docs.rs/futures/latest/futures/prelude/trait.Stream.html).
`Stream<Item = T>` represents a sequence of values that are each produced asynchronously rather than just a single value.
It's the asynchronous equivalent of `Iterator<Item = T>`.

The `Stream` trait has one method named `poll_next` that returns:
- `Poll::Pending` when the next value isn't ready yet, just like a `Future` would
- `Poll::Ready(Some(value))` when a new value is available
- `Poll::Ready(None)` when the stream is exhausted

### How DataFusion Executes Queries

In DataFusion, the short version of how queries are executed is as follows (you can find more in-depth coverage of this in the [DataFusion documentation](https://docs.rs/datafusion/latest/datafusion/#streaming-execution):

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

Similarly, when you try to abort a task by calling [`JoinHandle::abort()`](https://docs.rs/tokio/latest/tokio/task/struct.JoinHandle.html#method.abort), the Tokio runtime can't immediately force it to stop.
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
When you press Ctrl+C, the `signal::ctrl_c()` `Future` should complete.
Given that DataFusion uses the Rust async machinery, the [stream is cancelled ](https://docs.rs/datafusion/latest/datafusion/physical_plan/trait.ExecutionPlan.html#cancellation--aborting-execution) when it is dropped as it is inert by itself and nothing will be able to call `poll_next` again.

But there's a catch: `select!` still follows cooperative scheduling rules.
It polls each `Future` in sequence, and if the first one (our query) gets stuck in a long computation, it never gets around to polling the cancellation signal.

Imagine a query that needs to calculate something intensive, like sorting billions of rows.
Unless the sorting Stream is written with care (which the one in DataFusion is now), the `poll_next` call may take a couple of minutes or even longer without returning.
During this time, Tokio can't check if you've pressed Ctrl+C, and the query continues running despite your cancellation request.

## A Closer Look at Blocking Operators

Let's peel back a layer of the onion and look at what's happening in a blocking `poll_next` implementation.
Here's a drastically simplified version of a `COUNT(*)` aggregation - something you might use in a query like `SELECT COUNT(*) FROM table`:

```rust
struct BlockingStream {
   // the inner stream that is wrapped
    stream: SendableRecordBatchStream,
    count: usize,
    finished: bool,
}

impl Stream for BlockingStream {
    type Item = Result<RecordBatch>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.finished {
            // return None if we're finished
            return Poll::Ready(None);
        }

        loop {
            // poll the wrapped stream
            match ready!(self.stream.poll_next_unpin(cx)) {
                // increment the counter if we got a batch
                Some(Ok(batch)) => self.count += batch.num_rows(),
                // on end-of-stream, create a record batch for the counter
                None => {
                    self.finished = true;
                    return Poll::Ready(Some(Ok(create_record_batch(self.count))));
                }
                // pass on any errors verbatim
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

In that case, the processing loop will keep running without returning `Poll::Pending` and thus without ever yielding control back to Tokio's scheduler.
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

This would be a simple solution for this example operator.
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
Back in 2020, Tokio 0.2.14 introduced a per-task operation budget.
Rather than having individual counters littered throughout the code, the runtime manages a per task counter which is decremented by Tokio resources.
When the counter hits zero, all resources start returning `Pending`.
The task will then yield, after which the Tokio runtime resets the counter. This process is illustrated in Figure 1 and 2 below.


<img
src="/blog/images/task-cancellation/tokio_budget_plan.png"
width="300px"
class="img-responsive"
alt="Diagram showing a [lan with a task, AggregateExec, MergeStream and Two sources."
/>

**Figure 1**: Example query plan for aggregating a sorted stream from two
sources. Each source reads a stream of `RecordBatch`es, which are then merged
into a single Stream by the `MergeStream` operator which is
then aggregated by the `AggregateExec` operator.

<img
src="/blog/images/task-cancellation/tokio_budget.png"
width="787px"
class="img-responsive"
alt="Sequence diagram showing how the tokio task budget is used and reset."
/>

**Figure 2**: Tokio task budget system, assuming the task budget is set to 1. 
The first iteration of the loop consumes the budget, and returns `Ready`. The
second iteration has no budget remaining, so returns `Pending` and yields
control back to the Tokio runtime. The runtime then resets the budget and calls
`poll_next` again.

As it turns out DataFusion was already using this mechanism implicitly.
Every exchange-like operator internally makes use of a Tokio multiple producer, single consumer `Channel`.
When calling `Receiver::recv` for one of these channels, a unit of Tokio task budget is consumed.
As a consequence, query plans that made use of exchange-like operators were
already mostly cancelable, and the bug only showed up when running parts of plans
without such operators, such as when only a single core was available.

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

### Acknowledgments

Thank you to [Datadobi] for sponsoring the development of this feature and to
the DataFusion community contributors including [Qi Zhu] and [Mehmet Ozan
Kabak].


[Datadobi]: https://datadobi.com/
[Qi Zhu]: https://github.com/zhuqi-lucas
[Mehmet Ozan Kabak]: https://github.com/ozankabak

### About DataFusion

[Apache DataFusion] is an extensible query engine and database toolkit, written
in Rust, that uses [Apache Arrow] as its in-memory format. DataFusion and
similar technology are part of the next generation “Deconstructed Database”
architectures, where new systems are built on a foundation of fast, modular
components, rather than as a single tightly integrated system.

The [DataFusion community] is always looking for new contributors to help
improve the project. If you are interested in learning more about how query
execution works, help document or improve the DataFusion codebase, or just try
it out, we would love for you to join us.


[Apache Arrow]: https://arrow.apache.org/
[Apache DataFusion]: https://datafusion.apache.org/
[DataFusion community]: https://datafusion.apache.org/contributor-guide/communication.html


