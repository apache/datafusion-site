---
layout: post
title: Apache DataFusion Comet 0.3.0 Release
date: 2024-09-27
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

The Apache DataFusion PMC is pleased to announce version 0.3.0 of the [Comet](https://datafusion.apache.org/comet/) subproject.

Comet is an accelerator for Apache Spark that translates Spark physical plans to DataFusion physical plans for
improved performance and efficiency without requiring any code changes.

Comet runs on commodity hardware and aims to provide 100% compatibility with Apache Spark. Any operators or
expressions that are not fully compatible will fall back to Spark unless explicitly enabled by the user. Refer
to the [compatibility guide] for more information.

[compatibility guide]: https://datafusion.apache.org/comet/user-guide/compatibility.html

This release covers approximately four weeks of development work and is the result of merging 57 PRs from 12 
contributors. See the [change log] for more information.

[change log]: https://github.com/apache/datafusion-comet/blob/main/dev/changelog/0.3.0.md

## Release Highlights

### Binary Releases

Comet jar files are now published to Maven central for amd64 and arm64 architectures (Linux only).

Files can be found at https://central.sonatype.com/search?q=org.apache.datafusion

- Spark versions 3.3, 3.4, and 3.5 are supported.
- Scala versions 2.12 and 2.13 are supported.
 
### New Features

The following expressions are now supported natively:
 
- `DateAdd`
- `DateSub`
- `ElementAt`
- `GetArrayElement`
- `ToJson`

### Performance & Stability

- Upgraded to DataFusion 42.0.0
- Reduced memory overhead due to some memory leaks being fixed
- Comet will now fall back to Spark for queries that use DPP, to avoid performance regressions because Comet does 
  not have native support for DPP yet
- Improved performance when converting Spark columnar data to Arrow format
- Faster decimal sum and avg functions 

### Documentation Updates

- Improved documentation for deploying Comet with Kubernetes and Helm in the [Comet Kubernetes Guide]
- More detailed architectural overview of Comet scan and execution in the [Comet Plugin Overview] in the contributor guide

[Comet Kubernetes Guide]: https://datafusion.apache.org/comet/user-guide/kubernetes.html
[Comet Plugin Overview]: https://datafusion.apache.org/comet/contributor-guide/plugin_overview.html

## Getting Involved

The Comet project welcomes new contributors. We use the same [Slack and Discord] channels as the main DataFusion
project.

[Slack and Discord]: https://datafusion.apache.org/contributor-guide/communication.html#slack-and-discord

The easiest way to get involved is to test Comet with your current Spark jobs and file issues for any bugs or
performance regressions that you find. See the [Getting Started] guide for instructions on downloading and installing
Comet.

[Getting Started]: https://datafusion.apache.org/comet/user-guide/installation.html

There are also many [good first issues] waiting for contributions.

[good first issues]: https://github.com/apache/datafusion-comet/contribute
