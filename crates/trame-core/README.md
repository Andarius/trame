# Trame core spike

Ports `page-markdown.ts`, `page-merge.ts`, and `todo-marks.ts` without changing their TypeScript callers.

The native `rust-core` binary reads one JSON request per line from stdin or a filename argument and writes one JSON result per line. Wasm exports `evaluate(input)` with the same JSON contract. Requests use `{ "op": "functionName", "args": [...] }`; markdown parsing optionally accepts `ids` for deterministic differential checks. Otherwise parsing creates UUID v4 identifiers through `/dev/urandom` on native Linux and `crypto.randomUUID()` on Wasm.

`todayMark` takes local year, month, and day components; `stampTodoMarks` takes an explicit day. The host supplies its clock and timezone. Inputs otherwise follow the existing TypeScript function signatures. Dynamic keys for `removeMark` and `writeMark` must compile with Rust's regex syntax; current callers use fixed literal mark names.

Native builds reproduce the object semantics the TypeScript core was written against (Deno's default), including a disabled `Object.prototype.__proto__` getter returning undefined. Wasm builds reproduce browser object semantics, where that getter returns the prototype. This affects synthetic `__proto__` marks; every original fixture and copied page is checked independently on both targets.

