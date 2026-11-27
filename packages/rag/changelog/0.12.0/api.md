# 🔌 API Changes v0.12.0

## Harden @qvac/rag for host integrations and store float16 vectors

PR: [#5979](https://github.com/tetherto/qvac/pull/5979)

```typescript
const rag = createRag({
  corestore,
  index: { dir, provider, fs: fs.promises },
  onIndexFallback: (e) => log(e.namespace, e.reason)
})
await rag.indexStatus({ namespace: 'docs' }) // { mode: 'index', revision, snapshot } | { mode: 'scan', reason, error? } | { mode: 'unopened' }
await rag.createNamespace({ name: 'docs', space, vectorEncoding: 'f16' })
await rag.ingest({ namespace: 'docs', documents: [{ id: 'empty.bin', chunks: [] }] })
```

Added:

- `createRag` options `index.provider` (`IndexProvider`), `index.fs` (`SnapshotFileSystem`) and `onIndexFallback` (`IndexFallbackEvent`).
- `rag.indexStatus({ namespace })` returning `IndexStatus`.
- `createNamespace({ vectorEncoding })` with `VectorEncoding` = `'f32' | 'f16'`; `vectorEncoding` is also returned by `createNamespace` and `listNamespaces`.
- Documents with no chunks (`chunks: []`, or text that is empty or only whitespace).
- Error code `IMPORT_SOURCE_FAILED` (14031): an import `source` that throws, with the original error as `cause`.
- Exported types: `IndexProvider`, `IndexHandle`, `IndexSearchResult`, `SnapshotFileSystem`, `IndexStatus`, `IndexStatusParams`, `IndexFallbackEvent`, `IndexFallbackReason`, `VectorEncoding`.

---

## Resolve rag snapshot fs per runtime and report snapshot errors

PR: [#5996](https://github.com/tetherto/qvac/pull/5996)

```typescript
const rag = createRag({
  corestore,
  index: { dir }, // Node now snapshots through `fs` without passing index.fs
  onSnapshotError: ({ namespace, error }) => log.warn('rag snapshot', namespace, error)
})
```

Added:

- `createRag` option `onSnapshotError` (`SnapshotErrorEvent`): a namespace's snapshot can't be read or written. Searches keep using the index; reopening rebuilds it until a snapshot is written.
- `index.fs` defaults to `bare-fs` on Bare and `fs` on Node.
- Exported type: `SnapshotErrorEvent`.

---
