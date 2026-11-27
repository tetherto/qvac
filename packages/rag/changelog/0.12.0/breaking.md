# 💥 Breaking Changes v0.12.0

## `@qvac/turbovec-ggml` peer range is now `^0.8.0`

PR: [#5942](https://github.com/tetherto/qvac/pull/5942)

**BEFORE:**

```json
{ "peerDependencies": { "@qvac/turbovec-ggml": "^0.4.0 || ^0.5.0" } }
```

**AFTER:**

```json
{ "peerDependencies": { "@qvac/turbovec-ggml": "^0.8.0" } }
```

Hosts that install the optional TurboVec addon need 0.8. Releases before 0.7 are synchronous and are not used: search scans, and `indexStatus` reports `addon-missing`.

## Stricter ingest and import input

PR: [#5979](https://github.com/tetherto/qvac/pull/5979)

Input that 0.11.0 accepted is now rejected before anything is written: with `INVALID_INPUT` when it is passed to a call such as `ingest`, and with `IMPORT_INVALID` when it is a record in an import stream. It covers:

- strings that aren't well-formed UTF-16 (a lone surrogate, such as half an emoji left by cutting a string) in names, IDs, text, chunk content, metadata and space fields;
- a stored row over 8 MiB (a chunk with its content, metadata and vector, or a document with its metadata);
- a `__proto__` key in `metadata`;
- a `signal` that isn't an `AbortSignal` (it needs `addEventListener` and `removeEventListener`; always `INVALID_INPUT`);
- a generation above 2^32, on ingest and import.

**BEFORE:**

```typescript
await rag.ingest({ namespace, documents: [{ id: 'a', text: '\uD83D cut emoji' }] })
// stored as U+FFFD; its export fails to import
```

**AFTER:**

```typescript
await rag.ingest({ namespace, documents: [{ id: 'a', text: '\uD83D cut emoji' }] })
// throws QvacErrorRAG INVALID_INPUT; repair with text.toWellFormed() first
```

## Exports that 0.11.0 can't import

PR: [#5979](https://github.com/tetherto/qvac/pull/5979)

An `f16` namespace exports format 2, and 0.11.0 refuses it. A format 1 export that contains a document without chunks also fails to import into 0.11.0. Every other export from this version imports into 0.11.0, and 0.11.0 exports still import here.
