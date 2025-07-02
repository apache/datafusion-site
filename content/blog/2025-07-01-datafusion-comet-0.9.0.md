---
layout: post
title: Apache DataFusion Comet 0.9.0 Release
date: 2025-07-01
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

The Apache DataFusion PMC is pleased to announce version 0.9.0 of the [Comet](https://datafusion.apache.org/comet/) subproject.

Comet is an accelerator for Apache Spark that translates Spark physical plans to DataFusion physical plans for
improved performance and efficiency without requiring any code changes.

This release covers approximately ten weeks of development work and is the result of merging 139 PRs from 24
contributors. See the [change log] for more information.

[change log]: https://github.com/apache/datafusion-comet/blob/main/dev/changelog/0.9.0.md

## Release Highlights

### Complex Type Support in Parquet Scans

Comet now supports complex types (Structs, Maps, and Arrays) when reading Parquet files. This functionality is not
yet available when reading Parquet files from Apache Iceberg.

This functionality was only available in previous releases when manually specifying one of the new experimental
scan implementations. Comet now automatically chooses the best scan implementation based on the input schema, and no
longer requires manual configuration.

### Complex Type Processing Improvements

Numerous improvements have been made to complex type support to ensure Spark-compatible behavior when casting between
structs and accessing fields within deeply nested types.

### Shuffle Improvements

Comet now accelerates a broader range of shuffle operations, leading to more queries running fully natively. In
previous releases, some shuffle operations fell back to Spark to avoid some known bugs in Comet, and these bugs have
now been fixed.

### New Features

Comet 0.9.0 adds support for the following Spark expressions:

- ArrayDistinct
- ArrayMax
- ArrayRepeat
- ArrayUnion
- BitCount
- BitNot
- Expm1
- MapValues
- Signum
- ToPrettyString
- map[]

### Improved Spark SQL Test Coverage

Comet now passes 97% of the Spark SQL test suite, with more than 24,000 tests passing (based on testing against
Spark 3.5.6).

This release contains numerous bug fixes to achieve this coverage, including improved support for exchange reuse
when AQE is enabled. The remaining ignored tests are mostly related to metric differences or tests irrelevant to
Comet, such as tests for whole-stage code generation.

<style>
  table {
    border-collapse: collapse;
    width: 100%;
    font-family: sans-serif;
  }

  th, td {
    text-align: left;
    padding: 8px 12px;
  }

  th {
    background-color: #f2f2f2;
    font-weight: bold;
  }

  td {
    border-bottom: 1px solid #ddd;
  }

  tbody tr:last-child td {
    font-weight: bold;
    border-top: 2px solid #000;
  }
</style>

<table>
  <thead>
    <tr>
      <th>Module</th>
      <th>Passed</th>
      <th>Ignored</th>
      <th>Canceled</th>
      <th>Total</th>
    </tr>
  </thead>
  <tbody>
    <tr><td>catalyst</td><td>7,232</td><td>5</td><td>1</td><td>7,238</td></tr>
    <tr><td>core-1</td><td>9,186</td><td>246</td><td>6</td><td>9,438</td></tr>
    <tr><td>core-2</td><td>2,649</td><td>393</td><td>0</td><td>3,042</td></tr>
    <tr><td>core-3</td><td>1,757</td><td>136</td><td>16</td><td>1,909</td></tr>
    <tr><td>hive-1</td><td>2,174</td><td>14</td><td>4</td><td>2,192</td></tr>
    <tr><td>hive-2</td><td>19</td><td>1</td><td>4</td><td>24</td></tr>
    <tr><td>hive-3</td><td>1,058</td><td>11</td><td>4</td><td>1,073</td></tr>
    <tr><td><strong>Total</strong></td><td><strong>24,075</strong></td><td><strong>806</strong></td><td><strong>31</strong></td><td><strong>24,912</strong></td></tr>
  </tbody>
</table>

### Memory & Performance Tracing

Comet now provides a tracing feature for analyzing performance and off-heap versus on-heap memory usage. See the
[Comet Tracing Guide] for more information.

[Comet Tracing Guide]: https://datafusion.apache.org/comet/contributor-guide/tracing.html

<img
src="/blog/images/comet-0.9.0/tracing.png"
width="100%"
class="img-responsive"
alt="Comet Tracing"
/>

### Spark Compatibility

- Spark 3.4.3 with JDK 11 & 17, Scala 2.12 & 2.13
- Spark 3.5.4 through 3.5.6 with JDK 11 & 17, Scala 2.12 & 2.13
- Experimental support for Spark 4.0.0 with JDK 17, Scala 2.13

We are looking for help from the community to fully support Spark 4.0.0. See [EPIC: Support 4.0.0] for more information.

[EPIC: Support 4.0.0]: https://github.com/apache/datafusion-comet/issues/1637

Note that Java 8 support was removed from this release because Apache Arrow no longer supports it.

## Getting Involved

The Comet project welcomes new contributors. We use the same [Slack and Discord] channels as the main DataFusion
project and have a weekly [DataFusion video call].

[Slack and Discord]: https://datafusion.apache.org/contributor-guide/communication.html#slack-and-discord
[DataFusion video call]: https://docs.google.com/document/d/1NBpkIAuU7O9h8Br5CbFksDhX-L9TyO9wmGLPMe0Plc8/edit?usp=sharing

The easiest way to get involved is to test Comet with your current Spark jobs and file issues for any bugs or
performance regressions that you find. See the [Getting Started] guide for instructions on downloading and installing
Comet.

[Getting Started]: https://datafusion.apache.org/comet/user-guide/installation.html

There are also many [good first issues] waiting for contributions.

[good first issues]: https://github.com/apache/datafusion-comet/contribute
