---
layout: post
title: Custom types in DataFusion using Metadata
date: 2025-09-21
author: Tim Saucer(rerun.io), Dewey Dunnington(Wherobots), Andrew Lamb(InfluxData)
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

[TOC]

[DataFusion 48.0.0] introduced a change in the interface for writing custom functions
which enables a variety of interesting improvements. Now users can access metadata on
the input columns to functions and produce metadata in the output.

Metadata is specified as a map of key-value pairs of strings. This extra metadata is used
by Arrow implementations to support [extension types] and can also be used to add
use case-specific context to a column of values where the formality of an extension type
is not required. In previous versions of DataFusion field metadata was propagated through
certain operations (e.g., renaming or selecting a column) but was not accessible to others
(e.g., scalar, window, or aggregate function calls). In the new implementation, during
processing of all user defined functions we pass the input field information and allow
user defined function implementations to return field information to the caller.

[Extension types] are user defined data types where the data is stored using one of the
existing [Arrow data types] but the metadata specifies how we are to interpret the
stored data. The use of extension types was one of the primary motivations for adding
metadata to the function processing, but arbitrary metadata can be put on the input and
output fields. This allows for a range of other interesting use cases.

[DataFusion 48.0.0]: https://datafusion.apache.org/blog/2025/07/16/datafusion-48.0.0/
[extension types]: https://arrow.apache.org/docs/format/Columnar.html#format-metadata-extension-types
[Arrow data types]: https://arrow.apache.org/docs/format/Columnar.html#data-types

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
common one, and it is included in the [canonical extension types] that are now
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
[canonical extension types]: https://arrow.apache.org/docs/format/CanonicalExtensions.html

## How to use metadata in user defined functions

When working with metadata for [user defined scalar functions], there are typically two
places in the function definition that require implementation.

- Computing the return field from the arguments
- Invocation

During planning, we will attempt to call the function [return_field_from_args()]. This will
provide a list of input fields to the function and return the output field. To evaluate
metadata on the input side, you can write a functions similar to this example:

[user defined scalar functions]: https://docs.rs/datafusion/latest/datafusion/logical_expr/trait.ScalarUDFImpl.html
[return_field_from_args()]: https://docs.rs/datafusion/latest/datafusion/logical_expr/trait.ScalarUDFImpl.html#method.return_field_from_args

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

    let is_nullable = args.arg_fields[0].is_nullable();

    Ok(Arc::new(Field::new(self.name(), DataType::UInt32, is_nullable)))
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
        Field::new(self.name(), DataType::UInt32, is_nullable).with_metadata(
            [("my_key".to_string(), "my_value".to_string())]
                .into_iter()
                .collect(),
        ),
    ))
```

By checking the metadata during the planning process, we can identify errors early in
the query process. There are cases were we wish to have access to this metadata during
execution as well. The function [invoke_with_args] in the user defined function takes
the updated struct [ScalarFunctionArgs]. This now contains the input fields, which can
be used to check for metadata. For example, you can do the following:

[invoke_with_args]: https://docs.rs/datafusion/latest/datafusion/logical_expr/trait.ScalarUDFImpl.html#tymethod.invoke_with_args
[ScalarFunctionArgs]: https://docs.rs/datafusion/latest/datafusion/logical_expr/struct.ScalarFunctionArgs.html

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

Extension types are one of the primary motivations for this  enhancement in
[Datafusion 48.0.0]. The official Rust implementation of Apache Arrow, [arrow-rs],
already contains support for the [canonical extension types]. This support includes
helper functions such as `try_canonical_extension_type()` in the earlier example.

For a concrete example of how extension types can be used in DataFusion functions,
there is an [example repository] that demonstrates using UUIDs. The UUID extension
type specifies that the data are stored as a Fixed Size Binary of length 16. In the
DataFusion core functions, we have the ability to generate string representations of
UUIDs that match the version 4 specification. These are helpful, but a user may
wish to do additional work with UUIDs where having them in the dense representation
is preferable. Alternatively, the user may already have data with the binary encoding
and we want to extract values such as the version, timestamp, or string
representation.

In the example repository we have created three user defined functions: `UuidVersion`,
`StringToUuid`, and `UuidToString`. Each of these implements `ScalarUDFImpl` and can
be used thusly:

```rust
async fn main() -> Result<()> {
    let ctx = create_context()?;

    // get a DataFrame from the context
    let mut df = ctx.table("t").await?;

    // Create the string UUIDs
    df = df.select(vec![uuid().alias("string_uuid")])?;

    // Convert string UUIDs to canonical extension UUIDs
    let string_to_uuid = ScalarUDF::new_from_impl(StringToUuid::default());
    df = df.with_column("uuid", string_to_uuid.call(vec![col("string_uuid")]))?;

    // Extract version number from canonical extension UUIDs
    let version = ScalarUDF::new_from_impl(UuidVersion::default());
    df = df.with_column("version", version.call(vec![col("uuid")]))?;

    // Convert back to a string
    let uuid_to_string = ScalarUDF::new_from_impl(UuidToString::default());
    df = df.with_column("string_round_trip", uuid_to_string.call(vec![col("uuid")]))?;
    
    df.show().await?;
    
    Ok(())
}
```

The [example repository] also contains a crate that demonstrates how to expose these
UDFs to [datafusion-python]. This requires version 48.0.0 or later.

[example repository]: https://github.com/timsaucer/datafusion_extension_type_examples
[arrow-rs]: https://github.com/apache/arrow-rs
[datafusion-python]: https://datafusion.apache.org/python/

## Other use cases

The metadata attached to the fields can be used to store *any* user data in key/value
pairs. Some of the other use cases that have been identified include:

- Creating output for downstream systems. One user of DataFusion produces
  [data visualizations] that are dependant upon metadata in record batch fields. By
  enabling metadata on output of user defined functions, we can now produce batches
  that are directly consumable by these systems.
- Describe the relationships between columns of data. You can store data about how
  one column of data relates to another and use these during function evaluation. For
  example, in robotics it is common to use [transforms] to describe how to convert
  from one coordinate system to another. It can be convenient to send the function
  all of the columns that contain transform information and then allow the function
  to determine which columns to use based on the metadata. This allows for
  encapsulation of the transform logic within the user function.
- Storing logical types of the data model. [InfluxDB] uses field metadata to specify
  which columns are used for tags, times, and fields.

Based on the experience of the authors, we recommend caution when using metadata
for use cases other than type extension. One issue that can arises is that as columns
are used to compute new fields, some functions may pass through the metadata and the
semantic meaning may change. For example, suppose you decided to use metadata to
store some kind of statistics for the entire stream of record batches. Then you pass
that column through a filter that removes many rows of data. Your statistics
metadata may now be invalid, even though it was passed through the filter.

Similarly, if you use metadata to form relations between one column and another and
the naming of the columns has changed at some point in your workflow, then the metadata
may indicate an incorrect column of data it is referring to. This can be mitigated by
not relying on column naming but rather adding additional metadata to all columns of
interest.

[data visualizations]: https://rerun.io/blog/column-chunks
[transforms]: https://wiki.ros.org/tf2
[InfluxDB]: https://docs.influxdata.com/influxdb/v1/concepts/schema_and_data_layout/

## Acknowledgements

We would like to thank [Rerun.io] for sponsoring the development of this work. [Rerun.io]
is building a data visualization system for Physical AI and uses metadata to specify 
context about columns in Arrow record batches.

[Rerun.io]: https://rerun.io

## Conclusion

The enhancements to the metadata handling in [DataFusion 48.0.0] are a significant step
forward in the ability to handle more interesting types of data. We can validate the input
data matches not only the data types but also the intent of the data to be processed. We
can enable complex operations on binary data because we understand the encoding used. We
can also use metadata to create new and interesting user defined data types.    

## Get Involved

The DataFusion team is an active and engaging community and we would love to have you join
us and help the project.

Here are some ways to get involved:

* Learn more by visiting the [DataFusion] project page.
* Try out the project and provide feedback, file issues, and contribute code.
* Work on a [good first issue].
* Reach out to us via the [communication doc].

[DataFusion]: https://datafusion.apache.org/index.html
[good first issue]: https://github.com/apache/datafusion/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22
[communication doc]: https://datafusion.apache.org/contributor-guide/communication.html
