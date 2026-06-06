---
layout: post
title: The Arrow C Data Interface: Zero-Copy Between Rust and the JVM in DataFusion Comet
date: 2026-06-06
author: Amogh Ramesh
categories: [tutorial]
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

[TOC]

<!--
Intended audience: engineers who use Arrow-backed tools (pyarrow, Polars, DuckDB)
or work on query engines, and want to understand the contract that lets them
share columnar data across languages without copying.
Goal: explain the Arrow C Data Interface field by field, then prove it against a
real two-runtime boundary: DataFusion Comet's Rust <-> JVM handoff.
-->

This post explains the [Arrow C Data Interface]: a small, stable contract that lets two separately compiled programs share an Arrow array in memory without copying it and without linking a common library. We walk through it field by field on a single four-element column, and then prove it against a production system that exercises the hardest version of the problem: [Apache DataFusion Comet], which runs a native Rust query engine *inside* the Spark JVM and hands columnar batches across that boundary with no serialization on the hot path.

[Apache DataFusion Comet]: https://datafusion.apache.org/comet/
[Arrow C Data Interface]: https://arrow.apache.org/docs/format/CDataInterface.html

The interface is usually summarized as "both sides agree on the memory layout, so no copy is needed." That is true, but it is only half the story, and the easy half. Sharing memory across a language boundary raises two separate questions: *what is this data* (layout), and *who is responsible for freeing it* (ownership). Arrow's columnar format answers the first. The C Data Interface exists almost entirely to answer the second, and it answers it with a single function pointer that travels inside the struct. Those two questions are independent, and most explanations of zero-copy collapse them into one. We will keep them apart the whole way through; ownership is where the interface earns its keep.

## Background: Two Runtimes, One Address Space

Picture a Rust query engine that has just produced a column: ten million `int32` values, sitting in off-heap memory, already laid out in the exact Arrow format that the Spark JVM running beside it in the same process understands bit for bit. Now hand it over.

The obvious path serializes that column to Arrow IPC bytes, copies them across the JNI boundary (the Java Native Interface, where the JVM calls into native code), and deserializes them back into JVM-side vectors. You just paid to copy 40 MB of data that was already in the right shape, plus an allocation to hold the bytes and a deserialize pass to rebuild a layout you started with, and you pay it again on every batch.

The data never needed to move. Both sides already agree on the format down to the last validity bit. What they lack is an answer to the second of those two questions: layout is settled, but neither side yet knows who is responsible for freeing these bytes. That is the hard one. Across a foreign-function boundary, Rust's `Drop` cannot see the JVM and the JVM's garbage collector cannot see Rust's off-heap memory. Neither runtime's automatic memory management reaches into the other, so neither can decide on its own when the buffer is safe to free. Closing that gap is the entire reason this interface exists.

If you write Python rather than Rust, you have used this interface without knowing its name. When you hand a Polars frame to DuckDB and it queries it with no copy, or pass that same frame to pyarrow and it reads it in place, the two structs below are exactly what crossed between them, each consumer pulling the producer's columns through its `__arrow_c_array__`/`__arrow_c_stream__` exporter. The Spark↔Rust example we trace later is just the hardest version of the same handoff: two independent memory managers, two toolchains, one process.

## A Layout, Not a Library

You can hand a columnar array to a Rust binary you never compiled against, depending on nothing from the Arrow project, by copying about forty lines of struct definitions into your code.

That works because the contract between the two sides is an *ABI*, not an *API*. An API is source you compile and link against: to call into a library, that library has to be present, built, and version-matched. An ABI is smaller and stricter, a memory layout that two already-compiled binaries agree on. To speak it you need nothing but the struct definitions.

That is also why the interface is specified in C rather than C++. A C struct layout plus a function-pointer calling convention is stable across compilers and reachable from any language with an FFI; Python, Rust, Go, and Java-over-JNI can all read it, each through its own C translation step. C++ name mangling and vtable layout cannot be relied on the same way.

And once the layout ships in an official Arrow release, it is frozen. In the spec's own words, *"the C ABI is frozen,"* and the structures *"should not change in any way – including adding new members."* Field order, field types, the whole shape: fixed. New `flags` and `format` *values* are still allowed, because they add no struct member; the frozen thing is the struct layout itself. That inverts how versioned libraries usually work, where a larger surface means more to maintain and break. A small surface is a stable surface.

<div class="text-center">
<img
  src="/blog/images/arrow-c-data-interface/polyglot-hub.png"
  width="80%"
  class="img-fluid"
  alt="One frozen ABI shared by many languages"/>
</div>

**Figure 1**: One frozen ABI, every language. The same two structs let pandas, Polars, DuckDB, Go, Rust, and the JVM share columnar memory in-process, with no shared library and no version pin.

## The Two Structs

The payload is two C structs, and the split between them is the concept in miniature. `ArrowSchema` answers *what are these columns*: it carries the type and metadata. `ArrowArray` answers *where are the bytes*: it carries `length`, `null_count`, and a `buffers` field pointing at the physical buffers.

The two are useless apart: the spec is explicit that an `ArrowArray` can only be interpreted once its type is already known. But that does not mean they always travel together. The schema can be sent *once, up front*, to describe many arrays of the same shape that follow. In arrow-rs the structs are `FFI_ArrowSchema` and `FFI_ArrowArray`, each documented as the *"ABI-compatible struct"* for its C counterpart, and Comet imports an array by handing both to `from_ffi(ffi_array, &ffi_schema)`.

One array carries the rest of this post, an `Int32` column, four logical values, one of them null:

```text
[1, 2, NULL, 4]
```

Every field, pointer, and offset from here on maps onto exactly this array. That `4` is the `int32` at index 3, and we will name the buffer it lives in, the bit that marks the null beside it, and the callback that frees the whole thing.

## Layer 1: ArrowSchema, the Type as a Format String

The schema answers *what is this*. It is a fixed C struct with nine fields, and the field order is the contract: at an ABI boundary there is no field-name negotiation, only byte offsets, so reordering a field or widening a type silently breaks every consumer compiled against the old layout.

```c
struct ArrowSchema {
  const char* format;
  const char* name;
  const char* metadata;
  int64_t flags;
  int64_t n_children;
  struct ArrowSchema** children;
  struct ArrowSchema* dictionary;
  void (*release)(struct ArrowSchema*);
  void* private_data;
};
```

Filled in against our `[1, 2, NULL, 4]` column:

- `format = "i"`: the entire type, an `int32`, encoded as a one-byte, null-terminated string. Richer types need longer format strings (`d:19,10` for a decimal, `tss:<tz>` for a timestamp), so the type is not always one byte.
- `name`: the optional field name; it may be `NULL`. The `format` string, not `name`, carries the type.
- `metadata = NULL`: with no metadata this field is `NULL`. It is a length-prefixed binary blob, not a C string, so a consumer detects its presence by testing the pointer.
- `flags = 2` (`ARROW_FLAG_NULLABLE`): an `int64` bitmask, so flags OR together. `NULLABLE` means nulls are *permitted*; it is a property of the type, independent of whether this batch's `null_count` happens to be zero.
- `n_children = 0`: a flat primitive has no sub-schemas, so `children` may be `NULL`.
- `dictionary = NULL`: non-`NULL` only for a dictionary-encoded column, where it points to the schema of the dictionary's value type.

Why a format string instead of a numeric type code? A numeric enum would force both sides to agree forever on which integer means `int32`. A UTF-8 string is language-neutral and open-ended: the type rides inside the struct, parameters ride in the same string (`decimal128(38,10)` is `"d:38,10"`, a fixed-size list is `"+w:N"`), and a new storage type can be expressed without touching the frozen layout. Genuinely new logical types go through Arrow's extension mechanism (storage type in `format`, extension info in `metadata`) rather than by minting new letters. The `+s` (struct) and `+l` (list) forms hint at how nesting composes, which we return to at the end.

The last two fields, `release` and `private_data`, we leave sealed for now. Note only that `ArrowArray` ends with the *same* trailing pair: a release callback followed by `void* private_data`. Every node in this system is self-describing and self-releasing, the property Layer 3 builds on.

## Layer 2: ArrowArray, Where the Bytes Live

If `ArrowSchema` is the type, `ArrowArray` is where the bytes actually are. It has ten fields: `length`, `null_count`, `offset`, `n_buffers`, `n_children`, `buffers`, `children`, `dictionary`, `release`, `private_data`. For our column: `length = 4`, `null_count = 1`, `offset = 0`, `n_buffers = 2`, `n_children = 0`.

One detail surprises people: `null_count = -1` is legal. The spec says it *"MAY be -1 if not yet computed"*: not "negative one nulls," but "I haven't counted yet," a lazy sentinel the producer may leave for the consumer to resolve.

The field that holds the data is `buffers`, typed `const void**`: *"a C array of pointers to the start of each physical buffer backing this array,"* each one *"the physical start of a contiguous buffer."* These are raw pointers straight into the producer's memory. For a primitive `int32` column, `buffers[0]` is the validity bitmap and `buffers[1]` is the contiguous `int32` data. There is no serialized blob and no length-prefixed envelope; these pointers *are* the payload, and "reading the column" means dereferencing them where they already sit.

So read them. The validity bitmap byte for `[1, 2, NULL, 4]` is `0b00001011`. The convention is not what a systems engineer might guess: `1` means valid, and bits run least-significant-first, so bit 0 is index 0. Bits 0, 1, and 3 are set (those indices are valid), and the cleared bit 2 marks the `NULL`. In `buffers[1]`, four `int32`s sit end to end, and the `4` is the one at index 3. The null's slot still physically exists in that buffer; its four bytes are simply unspecified. Validity is tracked separately from data, which is exactly why the data pointer can be handed over untouched: nobody has to scrub or repack the null's bytes.

One thing the struct does not store: buffer sizes. There is no `buffers[1].len` anywhere. The producer's only obligation is that each buffer be *"large enough to represent length + offset values,"* and the consumer recomputes each length itself: validity is `ceil(length / 8)` = 1 byte; the values buffer is `length × 4` = 16 bytes; a variable-length buffer reads its size off the last offset entry, `offsets[length]`, which is why an offsets buffer has `length + 1` entries. The struct trusts both sides to share the format rules rather than restating them on the wire.

How many buffers a column has is a function of its type (`"i"` gives `[validity, values]`, `"u"` (utf8) gives `[validity, offsets, data]`), and that count is also materialized in `n_buffers`. A buffer pointer may be `NULL` only in two cases the spec calls out: the validity bitmap when `null_count` is 0, or any buffer whose size would be 0.

Finally, `offset` is the zero-copy slice: *"the number of items from the physical start of the buffers."* To hand someone rows 1000–1999 of a million-row column you copy nothing: you share the same `buffers` with `offset = 1000` and `length = 1000`. There is one sharp edge here, which we return to later: a non-zero offset does not always survive export across the FFI boundary.

The consumer can now *read* every column with no copies. But nothing so far says who may *free* the memory behind those pointers. Layout is solved; layout is necessary but not sufficient. That is the next layer.

<div class="text-center">
<img
  src="/blog/images/arrow-c-data-interface/two-structs-anatomy.png"
  width="80%"
  class="img-fluid"
  alt="ArrowSchema and ArrowArray side by side"/>
</div>

**Figure 2**: `ArrowSchema` and `ArrowArray` side by side, each field labelled with its C type, with our `[1, 2, NULL, 4]` column's concrete values along the bottom. The one exact correspondence is the identical `(release, private_data)` tail, boxed across both: the symmetry that makes every node self-describing and self-releasing.

## Layer 3: The Release Callback

This is the half that makes everything in Layer 2 safe, and the spec states it in dense MUST/SHOULD prose. Look again at the last two fields of `ArrowArray` (and the identical pair on `ArrowSchema`): `void (*release)(struct ArrowArray*)` and `void* private_data`. The struct is not just data. It is a small object that carries its own destructor and its own hidden state, and `private_data` is the producer's bookkeeping, which the consumer must never read, write, or free.

The full lifecycle for our array runs like this. The **consumer** allocates the base `ArrowArray` struct (on the stack or heap) and hands the producer a pointer to it. The **producer** allocates everything the struct *points to* (the validity bitmap, the `int32` data, the pointer arrays, the format and name strings), fills in the fields, and installs `release` and `private_data`. arrow-rs exposes exactly this shape as `FFI_ArrowArray::empty()`: a released, empty shell the consumer owns and hands over to be populated. The consumer then borrows the pointers and reads in place. It frees nothing. The only cleanup move available to it is to call one function, once, when it is done: `array->release(array)`. The consumer drives that call because it is the only party that knows when it has stopped reading.

The producer-supplied `release` callback does three things, all MUSTs:

1. It walks all children **and the optional dictionary** and fires *their* release callbacks. The consumer is forbidden from touching those.
2. It frees the buffers and children it owns, then disposes its own `private_data`.
3. It sets the struct's own `release` pointer to `NULL`.

That `NULL` does two jobs at once. It is the "consumed, don't touch" sentinel *and* the "already released, don't double-free" guard. One pointer is a destructor when non-`NULL` and a released-flag when `NULL`: two states in eight bytes. Consumers should check `release == NULL` before reading a structure's data.

<div class="text-center">
<img
  src="/blog/images/arrow-c-data-interface/release-lifecycle.png"
  width="80%"
  class="img-fluid"
  alt="The release lifecycle: one call, fired once, on the root"/>
</div>

**Figure 3**: The consumer allocates the base struct (the shell) and the producer allocates everything it points to and installs the callback; the consumer then borrows, reads in place, and fires `root->release(root)` exactly once. The callback walks children and dictionary, frees what it owns, and `NULL`s its own `release`. Calling a child's release, reading after `NULL`, or never calling at all are the three forbidden moves.

The number-one mistake follows directly: call `release` exactly once, only on the **root**, never on a child or the dictionary. The root's release chains down the whole tree on its own; calling a child's yourself is a double-free, because the producer is the party responsible for the children. The natural instinct, to free each node you see as you walk the tree, is exactly wrong here. The protocol rules out three failure modes: double-free, use-after-release, and the leak you get by never calling `release` at all.

This is how you express RAII in raw C, portably, with no compiler or runtime enforcing it. Strictly it is a *manually fired* destructor (the consumer must call it exactly once), so you get RAII's determinism without its compiler-managed scoping. The destructor ships *inside the struct as data*, so any language with a C FFI can fire it. The self-pointer argument exists for one reason: so the callback can reach back through `private_data` to recover its bookkeeping.

That design enables a useful trick: moving. To "move" an array, you shallow-copy the struct to its new owner and mark the source released by setting its `release` to `NULL` *without* calling it. Our struct travels as a dumb byte copy; the source's `release` is never fired; the destination now owns the one live copy. No allocation, no buffer copy, exactly one live owner, and `release` still runs exactly once, at the destination. The spec requires the struct to be *trivially relocatable* for this to be safe: a bitwise copy moves the bytes to a new address but rewrites none of the pointers inside, so if any member pointed back into the struct's own storage, the copy would carry a stale address and its `release` would later reach into freed memory. Forbidding self-referential pointers is precisely what makes the move a dumb byte copy, the same property Rust relies on for its own moves.

You can watch this happen on Comet's import side. In `native/core/src/execution/utils.rs`, `from_spark` does `std::ptr::replace(array_ptr, FFI_ArrowArray::empty())`: it reads Spark's populated struct *out* (feeding it to `from_ffi` to build the `ArrayData`) and swaps a released empty shell into Spark's slot, leaving the source released without ever firing its callback. That is the spec's move, expressed as one pointer operation.

## A Real Boundary: Comet Hands the JVM a Batch

Everything above can be demonstrated with a C producer talking to itself, which is what the spec does, and it is also why the spec never proves the thing that matters. The interface is well documented for the single-runtime case: the official Apache Arrow blog post *"Introducing the Apache Arrow C Data Interface"* (2020) explains the release callback, and Will Ayd's *"Leveraging the Arrow C Data Interface"* (2024) walks the consumer side. What neither shows is the contract surviving a real two-runtime boundary: two memory managers, in one process, traced through production source. DataFusion Comet is that boundary. It runs Spark operators in a native Rust/DataFusion engine living inside the same JVM process as Spark, and when native execution finishes a batch the JVM has to read it with no serialization on the hot path.

Watch what actually crosses JNI: not column data, but two arrays of 64-bit addresses and a row count. The native entry point is declared `executePlan(..., array_addrs: JLongArray, schema_addrs: JLongArray) -> jlong`, where the returned `jlong` is the row count (or `-1` for end-of-stream). Only the addresses of the per-column carrier structs travel: eight bytes of pointer per column per struct. The buffers, the megabytes, never move.

Who allocates those carriers looks like it flips by direction, but the rule is uniform: the *consumer* always allocates the base struct. On this native-to-JVM output path the consumer is the JVM, so the JVM allocates the empty shells. `NativeUtil.allocateArrowStructs` calls `ArrowSchema.allocateNew` and `ArrowArray.allocateNew` once per column and passes their `memoryAddress()` down; Rust receives addresses to empty structs it must fill.

Filling them is the export step, and it is the Layer 3 move executed against a real foreign struct. Comet's `prepare_output` walks the columns and, on the common path, calls `array_ref.to_data().move_to_spark(array_addrs[i], schema_addrs[i])`, handing over both the array and the schema address because the producer must populate both structs. The core of `move_to_spark` is two writes, one per struct, but it first checks pointer alignment, because the JVM-allocated slot is not guaranteed to meet Rust's alignment, and a plain `ptr::write` to a misaligned pointer is undefined behavior:

```rust
// move_to_spark picks write vs write_unaligned on pointer alignment;
// the aligned branch is shown.
unsafe {
    std::ptr::write(array_ptr, FFI_ArrowArray::new(self));
    std::ptr::write(schema_ptr, FFI_ArrowSchema::try_from(self.data_type())?);
}
```

That branch is the engineering point. The C ABI only *recommends* buffer alignment, so a JVM-allocated slot is not *guaranteed* to satisfy `align_of`; rather than assume it does, the code checks each slot and falls back to `std::ptr::write_unaligned` if it is misaligned, taking the plain, faster `std::ptr::write` on the expected aligned path (`native/core/src/execution/utils.rs:64–97`).

`FFI_ArrowArray::new` clones the `Arc`-backed buffers into `private_data` and installs the release callback on a fresh struct; the `ptr::write` then places that struct into the JVM-allocated slot. No buffer bytes are copied: the values and offsets are referenced by pointer (`Arc`-cloned, no `memcpy`) and stay exactly where DataFusion allocated them in off-heap memory.

The import half is the proof. The JVM's `ArrowImporter.importVector` reconstructs an Arrow `ValueVector` over those *same* native buffers, with no deserialize step, and `CometVector.getVector` wraps it. Consumption stays copy-free too: `CometPlainVector` caches the native address once in its constructor via `vector.getDataBuffer().memoryAddress()`, then reads every scalar by raw pointer arithmetic through `sun.misc.Unsafe`. `getInt` is literally `Platform.getInt(null, valueBufferAddress + rowId * 4L)`, the same `base + i * itemsize` arithmetic you do implicitly every time you index a NumPy array. The `4` at index 3 of our running array is read straight off the address Rust wrote: no JVM object, no copy.

<div class="text-center">
<img
  src="/blog/images/arrow-c-data-interface/comet-rust-jvm-handoff.png"
  width="80%"
  class="img-fluid"
  alt="A batch crosses JNI: pointers move, megabytes do not"/>
</div>

**Figure 4**: The native→JVM output path. The JVM allocates empty C carriers and passes their addresses down; Rust's `move_to_spark` writes the `FFI_ArrowArray` and installs the release callback; the JVM imports a vector over the same off-heap buffers and reads scalars by raw pointer. Exactly one JNI call carries `long[] addresses + row count`; the buffers never cross. A red note flags the three honest copies that live off this hot path: the FFI-unsafe full copy and dictionary materialize on input, and the non-zero-offset `take()` on output.

Release closes the loop, driven by the consumer exactly as Layer 3 demands. Closing the `CometVector` closes the underlying `ValueVector`, which fires the producer-installed release callback and frees the native buffers: the JVM, as the consumer, deciding when reading is done. And `CometExecIterator` does this *eagerly*: both `next()` and `hasNext()` close the still-open prior batch before moving on, *"to guarantee safety at the native side before we overwrite the buffer memory shared across batches."* That is the real correctness detail underneath shared-memory zero-copy: native may reuse the same buffer for the next batch, so the consumer must release the old view before the producer reclaims the bytes. The protocol is the only thing keeping a use-after-free out of the query engine.

## Where Zero-Copy Stops

That headline result, ten million rows handed over by writing pointers, applies to exactly one path: the plain-array, native→JVM output just traced. Run the boundary the other way and Comet is more cautious. On input it usually copies the buffers outright (`copy_array`), because it cannot trust the JVM not to overwrite them: *"the contents may be overwritten on the JVM side in the future."*

Only when Spark sets an `arrow_ffi_safe` flag (an explicit promise not to mutate or reuse those buffers) does Comet relax, bumping a reference count instead of copying (`Arc::clone`, another owner of the same bytes). The rule is simple: **no promise, full copy; promise, refcount bump.** That is the ownership axis biting back. If you cannot trust the producer not to mutate or free underneath you, the only safe move is to copy.

Two exceptions ride on top of that rule. Dictionary-encoded columns are always unpacked into their decoded values (a copy), never aliased, even on the safe path. And on output, any column with a non-zero `offset` is rebuilt by the `take` kernel into a fresh offset-0 array, because the FFI representation has a known bug with sliced arrays ([issue #2051](https://github.com/apache/datafusion-comet/issues/2051)); the code marks it a cold path and asserts the result lands at offset 0. The cheap offset-slice trick from Layer 2 has a sharp edge right at the boundary.

There is one more wrinkle pure C-to-C users never hit. On import, Rust calls `align_buffers()`, because the spec only *recommends* buffer alignment and buffers the JVM allocated can land under what Rust's kernels expect. Same ABI, different allocator, real consequence.

<div class="text-center">
<img
  src="/blog/images/arrow-c-data-interface/layout-ownership-matrix.png"
  width="80%"
  class="img-fluid"
  alt="Layout versus ownership"/>
</div>

**Figure 5**: Zero-copy needs both: a shared layout (necessary) and agreement on ownership (sufficient). Miss the second and you fall back to a defensive copy; miss the first and you fall back to full serialization.

Step back and the lesson is the two axes we separated at the start. Zero-copy of the *data* is guaranteed by shared layout: both sides agree on the columnar bytes, so a pointer suffices. Whether you actually *get* zero-copy depends on the ownership protocol: can both sides agree on who owns the memory and who promises not to mutate it. Layout is necessary; ownership is what makes it sufficient. Most explanations conflate the two and oversell "zero-copy" as if the matching memory format were the whole story. It is the easy half.

## Why the Design Holds

Nesting falls out of the design rather than being bolted on. The `children` array lets the same two structs compose: a struct column is a parent `ArrowArray` whose children are its fields; a list is a parent over one child plus a `[validity, offsets]` pair; the `dictionary` field handles categorical data. That recursion is exactly why the consumer invokes only *one* release, the root's, to clean an arbitrarily deep array with no leaks and no double-frees. The spec is blunt: a consumer *"MUST call a base structure's release callback ... but they MUST not call any of its children's release callbacks (including the optional dictionary)."* Every node ends with the same `(release, private_data)` pair, so each is self-describing; but it is the producer's root callback that walks the tree.

That same economy ties the contract shut. The companion `ArrowArrayStream`, which yields a sequence of arrays, reuses the released-structure convention as a second signal: when `get_next` succeeds but hands back an array whose `release` is already `NULL`, that *is* end-of-stream. The one bit that prevents a double-free also signals "no more data."

This frozen pair of roughly twelve-line C structs (about twenty fields between them, each carrying its own destructor as data) is why pandas, Polars, DuckDB, Go, Spark-via-Comet, and a dozen languages share columnar data in-process at memory-bandwidth speed instead of paying a serialization tax at every boundary.

There is one place not to reach for it: it is same-process, in-memory, and pointer-based. The moment your data has to cross a process, a socket, or a machine, those pointers mean nothing on the far side, and you want the serialized path: Arrow IPC or Flight. That is exactly what Comet keeps for shuffle and spill: reduce-side reads go through a native `NativeBatchDecoderIterator`, spill writes go through the Rust `ShuffleBlockWriter` (an Arrow IPC `StreamWriter`), and the Scala side wraps an `ArrowStreamReader` for broadcast and columnar-to-row decoding. Because each frozen C struct carries its own destructor as data, any language with a C FFI can free what another language allocated, which is the whole trick, and the reason a serialization tax can become a pointer handoff.

## Get Involved

DataFusion is not a project built or driven by a single person, company, or
foundation. Our community of users and contributors works together to build a
shared technology that none of us could have built alone.

If you are interested in joining us, we would love to have you. You can try out
DataFusion or Comet on your own data and let us know how it goes, or contribute
suggestions, documentation, bug reports, or a PR. A list of open issues suitable
for beginners is [here], and you can find out how to reach us on the
[communication doc].

[here]: https://github.com/apache/datafusion/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22
[communication doc]: https://datafusion.apache.org/contributor-guide/communication.html

## Further Reading

---

- [Arrow C Data Interface specification](https://arrow.apache.org/docs/format/CDataInterface.html)
- [Arrow Columnar Format specification](https://arrow.apache.org/docs/format/Columnar.html)
- [Introducing the Apache Arrow C Data Interface](https://arrow.apache.org/blog/2020/05/03/introducing-arrow-c-data-interface/) (Apache Arrow, 2020)
- [Leveraging the Arrow C Data Interface](https://willayd.com/leveraging-the-arrow-c-data-interface.html) (Will Ayd, 2024)
- [DataFusion Comet](https://datafusion.apache.org/comet/): the Spark accelerator traced above

---

*Sources verified against `apache/datafusion-comet` @ `e79183ee` and arrow-rs 58.3.0; the functions cited inline (`move_to_spark`, `from_spark`, `prepare_output`, `executePlan`) live in `native/core/src/execution/{utils.rs, jni_api.rs}`, and the alignment branch is `utils.rs:64–97`. Spec quotations are from the Arrow C Data Interface and Arrow Columnar Format specifications.*

## About DataFusion

[Apache DataFusion] is an extensible query engine, written in [Rust], that uses [Apache Arrow] as its in-memory format. DataFusion is used by developers to create new, fast, data-centric systems such as databases, dataframe libraries, machine learning, and streaming applications. [Apache DataFusion Comet][comet] is a subproject that accelerates Apache Spark by offloading execution to DataFusion's native engine.

[Apache DataFusion]: https://datafusion.apache.org/
[Rust]: https://www.rust-lang.org/
[Apache Arrow]: https://arrow.apache.org/
[comet]: https://datafusion.apache.org/comet/

DataFusion's core thesis is that, as a community, together we can build much more advanced technology than any of us could build alone.
