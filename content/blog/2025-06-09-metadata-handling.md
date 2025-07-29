---
layout: post
title: Field metadata and extension type support in user defined functions
date: 2025-06-09
author: Tim Saucer, Dewey Dunnington, Andrew Lamb
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
data about the input columns to functions and produce metadata in the function output.
This enables processing of extension types as well as a variety of other use cases.

[DataFusion 48.0.0]: https://datafusion.apache.org/blog/2025/07/16/datafusion-48.0.0/

## Why metadata handling is important

Data in Arrow record batches carry a `Schema` in addition to the Arrow arrays. Each
[Field] in this `Schema` contains a name, data type, nullability, and metadata. The
metadata is specified as a map of key-value pairs of strings.  In the new
implementation, during processing of all user defined functions we pass the input
field information.

<figure>
  <img src="/blog/images/metadata-handling/arrow_record_batch.png" alt="Relationship between a Record Batch, it's schema, and the underlying arrays. There is a one to one relationship between each Field in the Schema and Array entry in the Columns." width="100%" class="img-responsive">
  <figcaption>
    Relationship between a Record Batch, it's schema, and the underlying arrays. There is a one to one relationship between each Field in the Schema and Array entry in the Columns.
  </figcaption>
</figure>

It is often desirable to write a generic function for reuse. With the prior version of
user defined functions, we only had access to the `DataType` of the input columns. This
works well for some features that only rely on the types of data. Other use cases may
need additional information that describes the data.

For example, suppose I wish to write a function that takes in a UUID and returns a string
of the [variant] of the input field. We would want this function to be able to handle
all of the string types and also a binary encoded UUID. The arrow specification does not
contain a unsigned 128 bit value, it is common to encode a UUID as a fixed sized binary
array where each element is 16 bytes long. With the metadata handling in [DataFusion 48.0.0]
we can validate during planning that the input data not only has the correct underlying
data type, but that it also represents the right *kind* of data. The UUID example is a
common one, and it is included in the [canonical arrow extension types] that are now
supported in DataFusion.

Another common application of metadata handling is understanding encoding of a blob of data.
Suppose you have a column that contains image data. Most likely this data is stored as
an array of `u8` data. Without knowing a priori what the encoding of that blob of data is,
you cannot ensure you are using the correct methods for decoding it. You may work around
this by adding another column to your data source indicating the encoding, but this can be
wasteful for systems where the encoding never changes. Instead, you could use metadata to
specify the encoding for the entire column.

[field]: https://arrow.apache.org/docs/format/Glossary.html#term-field
[variant]: https://www.ietf.org/rfc/rfc9562.html#section-4.1
[canonical arrow extension types]: https://arrow.apache.org/docs/format/CanonicalExtensions.html

## How to use metadata in user defined functions

When working with metadata for user defined scalar functions, there are typically two
places in the function definition that require implementation.

- Computing the return field from the arguments
- Invocation

During planning, we will attempt to call the function `return_field_from_args()`. This will
provide a list of input fields to the function and return the output field. To evaluate
metadata on the input side, you can write a functions similar to this example:

```rust
fn return_field_from_args(
    &self,
    args: ReturnFieldArgs,
) -> datafusion::common::Result<FieldRef> {
    if args.arg_fields.len() != 1 {
        return exec_err!("Incorrect number of arguments for uuid_version");
    }

    let input_field = &args.arg_fields[0];
    if &DataType::FixedSizeBinary(16) == input_field.data_type() {
        let Ok(CanonicalExtensionType::Uuid(_)) = input_field.try_canonical_extension_type()
        else {
            return exec_err!("Input field must contain the UUID canonical extension type");
        };
    }

    Ok(Arc::new(Field::new(self.name(), DataType::UInt32, true)))
}
```

In this example, we take advantage of the fact that we already have support for extension
types that evaluate metadata. If you were attempting to check for metadata other than
extension type support, we could have instead written a snippet such as:

```rust
    if &DataType::FixedSizeBinary(16) == input_field.data_type() {
        let _ = input_field
            .metadata()
            .get("ARROW:extension:metadata")
            .ok_or(exec_datafusion_err!("Input field must contain the UUID canonical extension type"))?;
        };
    }
```

If you are writing a user defined function that will instead return metadata on output
you can add this directly into the `Field` that is the output of the `return_field_from_args`
call. In our above example, we could change the return line to:

```rust
    Ok(Arc::new(
        Field::new(self.name(), DataType::UInt32, true).with_metadata(
            [("my_key".to_string(), "my_value".to_string())]
                .into_iter()
                .collect(),
        ),
    ))
```

By checking the metadata during the planning process, we can identify errors early in
the query process. There are cases were we wish to have access to this metadata during
execution as well. The function `invoke_with_args` in the user defined function takes
the updated struct `ScalarFunctionArgs`. This now contains the input fields, which can
be used to check for metadata. For example, you can do the following:

```rust
fn invoke_with_args(&self, args: ScalarFunctionArgs) -> Result<ColumnarValue> {
    assert_eq!(args.arg_fields.len(), 1);
    let my_value = args.arg_fields[0]
        .metadata()
        .get("encoding_type");
    ...
```

In this snippet we have extracted an `Option<String>` from the input field metadata
which we can then use to determine which functions we might want to call. We could
then parse the returned value to determine what type of encoding to use when
evaluating the array in the arguments. Since `return_field_from_args` is not `&mut self`
this check could not be performed during the planning stage.

The description in this section applies to scalar user defined functions, but equivalent
support exists for aggregate and window functions.

## Extension types

TODO

https://github.com/timsaucer/datafusion_extension_type_examples

## Other uses for Metadata

HERE PUT THE RERUN EXAMPLE

## Working with literals

TODO

## Thanks to our sponsor

We would like to thank [Rerun.io] for sponsoring the development of this work. [Rerun.io]
is building a data visualization system for Physical AI and uses metadata to specify 
context about columns in Arrow record batches.

[Rerun.io]: https://rerun.io

## Conclusion

TODO
