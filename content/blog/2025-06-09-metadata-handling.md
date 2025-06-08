---
layout: post
title: Metadata handling in user defined functions
date: 2025-06-09
author: Tim Saucer
categories: [core]
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
{% endcomment %}x
-->

[DataFusion 48.0.0] introduced a change in the interface for writing custom functions
which enables a variety of interesting improvements. Now users can access additional
data about the input columns to functions, such as their nullability and metadata. This
enables processing of extension types as well as a wide variety of other use cases.

TODO: UPDATE LINKS

[DataFusion 48.0.0]: https://github.com/apache/datafusion/tree/48.0.0-rc3

# Why metadata handling is important

Data in Arrow record batches carry a `Schema` in addition to the Arrow arrays. Each
[Field] in this `Schema` contains a name, data type, nullability, and metadata. The
metadata is specified as a map of key-value pairs of strings.  In the new
implementation, during processing of all user defined functions we pass the input
field information.

It is often desirable to write a generic function for reuse. With the prior version of
user defined functions, we only had access to the `DataType` of the input columns. This
works well for some features that only rely on the types of data. Other use cases may
need additional information that describes the data.

For example, suppose I write a function that computes the force of gravity on an object
based on it's mass. The general equation is `F = m * g` where `g = 9.8 m/s`. Suppose
our documentation for the function specifies the output will be in Newtons. This is only
valid if the input unit is in kilograms. With our metadata enhancement, we could update
this function to now evaluate the input units, perform any kind of required
transformation, and give consistent output every time. We could also have the function
return an error if an invalid input was given, such as providing an input where the
metadata says the units are in `meters` instead of a unit of mass.

One common application of metadata handling is understanding encoding of a blob of data.
Suppose you have a column that contains image data. You could use metadata to specify
the encoding of the image data so you could use the appropriate decoder.

[field]: https://arrow.apache.org/docs/format/Glossary.html#term-field

# How to use metadata in user defined functions

Using input metadata occurs in two different phases of a user defined function. Both during
the planning phase and execution, we have access to these field information. This allows
the user to determine the appropriate output fields during planning and to validate the
input. For other use cases, it may only be necessary to access these fields during execution.
We leave this open to the user.

For all types of user defined functions we now evaluate the output [Field] as well. You can
specify this to create your own metadata from your functions or to pass through metadata from
one or more of your inputs.

In addition to metadata the input field information carries nullability. With these you can
create more expressive nullability of your output data instead of having a single output.
For example, you could write a function to convert a string to uppercase. If we know the
input field is non-nullable, then we can set the output field to non-nullable as well.

# Extension types

TODO

# Working with literals

TODO

# Thanks to our sponsor

We would like to thank [Rerun.io] for sponsoring the development of this work. [Rerun.io]
is building a data visualization system for Physical AI and uses metadata to specify 
context about columns in Arrow record batches.

[Rerun.io]: https://rerun.io

# Conclusion

TODO
