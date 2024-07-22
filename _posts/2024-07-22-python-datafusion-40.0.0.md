---
layout: post
title: "Apache DataFusion Python 40.0.0 Released, Significant usability updates"
date: "2024-07-22 00:00:00"
author: pmc
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

# Introduction

We are happy to announce that Python DataFusion 40.0.0 has been released. This release contains
significant updates to the user interface and documentation. We listened to the python user
community to create a more *pythonic* experience. If you have not used the python interface to
DataFusion before, this is an excellent time to give it a try!

# Background

Up until now, the python bindings to DataFusion have primarily exposed the underlying Rust
functionality using the excellent [pyo3](https://pyo3.rs/) package. This has been excellent for
early adopters to use DataFusion within their python projects, but some users have found it
difficult to work with for a few reasons.

1. Most of the functions had little or no documentation. Users often had to refer to the rust
documentation or code to learn how to use DataFusion. This alienated some python users.
2. Users could not take advantage of modern IDE features such as type hinting. These are valuable
tools for rapid testing and development.
3. Some of the interfaces felt “clunky” to users since some python concepts do not always map well
to their Rust counterparts.

# What's Changed

The most significant difference is that we now have wrapper functions and classes for most of the
user facing interface. These wrappers, written in Python, contain both documentation and type
annotations.

This documenation is now available on the [DataFusion in Python](https://datafusion.apache.org/python)
website. There you can browse the available functions and classes to see the breadth of available
functionality.

Modern IDEs use language servers such as
[Pylance](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-pylance) or
[Jedi](https://jedi.readthedocs.io/en/latest/) to perform analysis of python code, provide useful
hints, and identify usage errors. These are major tools in the python user community. With this
release, users can fully use these tools in their workflow.

<figure style="text-align: center;">
  <img 
    src="{{ site.baseurl }}/img/python-datafusion-40.0.0/vscode_hover_tooltip.png" 
    width="100%"
    class="img-responsive"
    alt="Fig 1: Enhanced tooltips in an IDE."
  >
  <figcaption>
   <b>Figure 1</b>: With the enhanced python wrappers, users can see helpful tool tips with
   type annotations directly in modern IDEs.
</figcaption>
</figure>

By having the type annotations, these IDEs can also identify quickly when a user has incorrectly
used a function's arguments as shown in Figure 2.

<figure style="text-align: center;">
  <img 
    src="{{ site.baseurl }}/img/python-datafusion-40.0.0/pylance_error_checking.png"
    width="100%"
    class="img-responsive"
    alt="Fig 2: Error checking in static analysis"
  >
  <figcaption>
   <b>Figure 2</b>: Modern Python language servers can perform static analysis and quickly find
   errors in the arguments to functions.
</figcaption>
</figure>

In addition to these wrapper libraries, we have enhancements to some of the functions to feel more
easy to use.

## Comparison Operators

When performing any kind of comparison operator, you can now use any python value that can be
coerced into a `Literal` as the right hand side of the comparison. This gives an ergonomic easy
to ready expression. For example, consider these few lines from one of the
[TPC-H examples](https://github.com/apache/datafusion-python/tree/main/examples/tpch) provided in
the DataFusion Python repository.

```python
df = (
    df_lineitem.filter(col("l_shipdate") >= lit(date))
    .filter(col("l_discount") >= lit(DISCOUNT) - lit(DELTA))
    .filter(col("l_discount") <= lit(DISCOUNT) + lit(DELTA))
    .filter(col("l_quantity") < lit(QUANTITY))
)
```

The above code mirrors closely how these filters would need to be applied in rust. With this new
release, the user can simplify these lines. Also shown in the example below is that `filter()`
now accepts a variable number of arguments and filters on all such arguments (boolean AND).

```python
df = df_lineitem.filter(
    col("l_shipdate") >= date,
    col("l_discount") >= DISCOUNT - DELTA,
    col("l_discount") <= DISCOUNT + DELTA,
    col("l_quantity") < QUANTITY,
)
```

## Select

It is very common for users to perform `DataFrame` selection where they simply want a column. For
this we have had the function `select_columns("a", "b")` or the user could perform
`select(col("a"), col("b"))`. In the new release, we accept either full expressions in `select()`
or strings. You can mix these as well.

Where before you may have to do an operation like

```python
df_subset = df.select(col("a"), col("b"), f.abs(col("c")).alias("abs_c"))
```

You can now simplify this to

```python
df_subset = df.select("a", "b", f.abs(col("c")).alias("abs_c"))
```

# Next Steps

While most of the user facing classes and functions have been exposed, there are a few that require
exposure. Namely the classes in `datafusion.object_store` and the logical plans used by
`datafusion.substrait`. The team is working on
[these issues](https://github.com/apache/datafusion-python/issues/767).

A nice to have feature on the [documentation site](https://datafusion.apache.org/python/index.html)
is to cross reference all function types. This is currently under investigation.

# Get Involved

The DataFusion Python team is an active and engaging community and we would love
to have you join us and help the project. 

Here are some ways to get involved:

* Learn more by visiting the [DataFusion Python project](https://datafusion.apache.org/python/index.html)
page.

* Try out the project and provide feedback, file issues, and contribute code.

[mailing list]: https://lists.apache.org/list.html?dev@datafusion.apache.org

