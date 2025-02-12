---
layout: post
title: Apache DataFusion Ballista 43.0.0 Released
date: 2025-02-02
author: milenkovicm
categories: [release]
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

We are  pleased to announce version [43.0.0] of the [DataFusion Ballista]. Ballista allows existing [DataFusion] applications to be scaled out on a cluster for use cases that are not practical to run on a single node.

[43.0.0]: <https://github.com/apache/datafusion-ballista/blob/main/CHANGELOG.md#4300-2025-01-07>
[DataFusion Ballista]: https://datafusion.apache.org/ballista/
[DataFusion]: https://datafusion.apache.org

## Highlights of this release

### Seamless Integration with DataFusion

The primary objective of this release has been to achieve a more seamless integration with the DataFusion ecosystem and try to achieve the same level of flexibility as DataFusion.

In recent months, our development efforts have been directed toward providing a robust and extensible Ballista API. This new API empowers end-users to tailor Ballista's core functionality to their specific use cases. As a result, we have deprecated several experimental features from the Ballista core, allowing users to reintroduce them as custom extensions outside the core framework. This shift reduces the maintenance burden on Ballista's core maintainers and paves the way for optional features, such as [delta-rs] support, to be added externally when needed.

[delta-rs]: https://github.com/delta-io/delta-rs

The most significant enhancement in this release is the deprecation of `BallistaContext`, which has been superseded by the DataFusion `SessionContext`. This change enables DataFusion applications written in Rust to execute on a Ballista cluster with minimal modifications. Beyond simplifying migration and reducing maintenance overhead, this update introduces distributed write functionality to Ballista for the first time, significantly enhancing its capabilities.

```rust
use ballista::prelude::*;
use datafusion::prelude::*;

#[tokio::main]
async fn main() -> datafusion::error::Result<()> {

  // Instead of creating classic SessionContext
  // let ctx = SessionContext::new();
  
  // create DataFusion SessionContext with ballista standalone cluster started
  // let ctx = SessionContext::standalone().await;

  // create DataFusion SessionContext with ballista remote cluster started
  let ctx = SessionContext::remote("df://localhost:50050").await;

  // register the table
  ctx.register_csv("example", "tests/data/example.csv", CsvReadOptions::new()).await?;

  // create a plan to run a SQL query
  let df = ctx.sql("SELECT a, MIN(b) FROM example WHERE a <= b GROUP BY a LIMIT 100").await?;

  // execute and print results
  df.show().await?;
  Ok(())
}
```

Additionally, Ballista’s versioning scheme has been aligned with that of DataFusion, ensuring that Ballista's version number reflects the compatible DataFusion version.

At the moment there is a gap between DataFusion and Ballista, which we will try to bridge in the future.

### Removal of Experimental Features

Ballista had grown in scope to include several experimental features in various states of completeness. Some features have been removed from this release in an effort to strip Ballista back to its core and make it easier to maintain and extend.

Specifically, the caching subsystem, predefined object store registry, plugin subsystem, key-value stores for persistent scheduler state, and the UI have been removed.

### Performance & Scalability

Ballista has significantly leveraged the advancements made in the DataFusion project over the past year. Benchmark results demonstrate notable improvements in performance, highlighting the impact of these enhancements:

Per query comparison:

<img
src="/blog/images/datafusion-ballista-43.0.0/tpch_queries_compare.png"
width="100%"
class="img-responsive"
alt="Per query comparison"
/>

Relative speedup:

<img
src="/blog/images/datafusion-ballista-43.0.0/tpch_queries_speedup_rel.png"
width="100%"
class="img-responsive"
alt="Relative speedup graph"
/>

The overall speedup is 2.9x

<img
src="/blog/images/datafusion-ballista-43.0.0/tpch_allqueries.png"
width="50%"
class="img-responsive"
alt="Overall speedup"
/>

### New Logo

Ballista now has a new logo, which is visually similar to other DataFusion projects.  

<img
src="/blog/images/datafusion-ballista-43.0.0/ballista-logo.png"
width="50%"
class="img-responsive"
alt="New logo"
/>

## Roadmap

Moving forward, Ballista will adopt the same release cadence as DataFusion, providing synchronized updates across the ecosystem.
Currently, there is no established long-term roadmap for Ballista. A plan will be formulated in the coming months based on community feedback and the availability of additional maintainers.

In the short term, development efforts will concentrate on closing the feature gap between DataFusion and Ballista. Key priorities include implementing support for `INSERT INTO`, enabling table `URL` functionality, and achieving deeper integration with the Python ecosystem.
