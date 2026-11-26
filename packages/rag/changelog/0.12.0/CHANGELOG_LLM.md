# QVAC RAG v0.12.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/rag/v/0.12.0

`@qvac/rag` 0.12.0 makes the package safer to embed in a host app. The vector index survives hosts that lock module loading, a fallback to the slower scan and a failed snapshot are now visible, Node hosts can plug in their own index, and namespaces can store vectors at half the size. Input and import checks are stricter, and closing in the wrong order no longer hangs. Data written by 0.11.0 opens without migration.

## Breaking Changes

### TurboVec 0.8

The optional `@qvac/turbovec-ggml` peer range moves from `^0.4.0 || ^0.5.0` to `^0.8.0`. Hosts that install the addon need version 0.8: the index now uses TurboVec's asynchronous API, and older synchronous releases make search fall back to the scan.

### Stricter Input

Input that 0.11.0 accepted now fails with `INVALID_INPUT` before anything is written: strings that aren't well-formed UTF-16 (for example half an emoji left by cutting a string), stored rows over 8 MiB, a `__proto__` key in `metadata`, a `signal` that isn't an `AbortSignal`, and generations above 2^32. A cut string used to be stored as U+FFFD, which broke its export, and two names that differed only in such characters became the same name.

```typescript
// 0.12.0: repair text cut mid-character before ingesting
await rag.ingest({ namespace, documents: [{ id: 'a', text: text.toWellFormed() }] })
```

### Exports and 0.11.0

An `f16` namespace exports a new format version that 0.11.0 can't read, and 0.11.0 also refuses an export that contains a document without chunks. All other exports from this version import into 0.11.0, and 0.11.0 exports import here.

## New APIs

### Index Status and Fallback Events

If the TurboVec index can't load or fails, search falls back to an exact scan of the database: same results, much slower. That fallback used to be silent. `indexStatus` now reports how a namespace is searched and why, and `onIndexFallback` is called when a namespace switches to the scan. `ready()` also loads the addon and `bare-fs` up front, so a host that blocks module loading after startup keeps its index.

```typescript
const rag = createRag({
  corestore,
  index: { dir: './rag-index' },
  onIndexFallback: ({ namespace, reason }) => log.warn('rag scanning', namespace, reason)
})
await rag.ready()

await rag.indexStatus({ namespace: 'docs' })
// → { mode: 'index', revision: 42, snapshot: 'ok' }
// → { mode: 'scan', reason: 'addon-missing' } on Node without a provider
```

### Bring Your Own Index

TurboVec's binding only loads under Bare, so on Node every search used to scan. `index.provider` lets a host supply the index implementation. Snapshots use `bare-fs` on Bare and `fs` on Node, and `index.fs` can replace either. A provider without filtered search still works: scoped searches fetch extra candidates and filter them.

```typescript
const rag = createRag({
  corestore,
  index: { dir: './rag-index', provider: { create: (dim, storage) => myIndex(dim, storage) } }
})
```

### Snapshot Error Events

A snapshot that can't be read or written used to fail silently, so every reopen rebuilt the index from the database. `onSnapshotError` is now called with the namespace and the error. Searches keep using the index, and `indexStatus` reports the same error.

```typescript
const rag = createRag({
  corestore,
  index: { dir: './rag-index' },
  onSnapshotError: ({ namespace, error }) => log.warn('rag snapshot', namespace, error)
})
```

### Float16 Vector Storage

`createNamespace` takes `vectorEncoding: 'f16'` to store vectors at 2 bytes per component instead of 4. For 10,400 chunks of 768 dimensions the store shrinks from 49.3 MB to 33.0 MB. Scores move by a few millionths and recall@10 against `f32` stays at 0.9975 or above. The default stays `f32`, and exports keep the namespace's encoding.

```typescript
await rag.createNamespace({ name: 'docs', space, vectorEncoding: 'f16' })
```

### Documents Without Chunks

A document can now have no chunks, for example a scanned PDF with no text that a host wants to record so it isn't fed again. It is listed and exported with a `chunkCount` of 0 and never returned by search. Text that is empty or only whitespace becomes such a document instead of failing.

```typescript
await rag.ingest({ namespace: 'docs', documents: [{ id: 'scan.pdf', chunks: [] }] })
```

## Bug Fixes

Closing the host's Corestore before the RAG used to leave a database lock held, so later writes and `close()` never returned. Writes now fail with `DB_OPERATION_FAILED` and `close()` always resolves. Leftover index snapshot files, from failed writes or a process killed mid-write, are now cleaned up.

Imports verify each document's and delete record's ID and generation, so a damaged export can no longer rename or delete the wrong document. A failed or cancelled import no longer leaves an empty namespace behind, a namespace emptied by deletes accepts imports again, and an ingest running during an import no longer fails with a false "dropped" error. A `source` that throws now fails with the new `IMPORT_SOURCE_FAILED` code.

The package builds without the `bare` CLI.
