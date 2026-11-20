# 🔌 API Changes v0.10.0

## Derive a TurboVec index for @qvac/rag namespaces

PR: [#5670](https://github.com/tetherto/qvac/pull/5670)

```typescript
const rag = createRag({ corestore, index: { dir: './rag-index', snapshotEvery: 256 } })
const { index } = await rag.createNamespace({
  name: 'docs',
  space,
  index: { storage: 'turbovec-q4' }
})
// index → { storage: 'turbovec-q4' }; default 'q8'
```

---

## Ingest text and pre-chunked documents through an embeddings port

PR: [#5671](https://github.com/tetherto/qvac/pull/5671)

```typescript
const rag = createRag({ corestore, embeddings: port })
await rag.ready()
await rag.createNamespace({ name: 'handbook', space: port.space })

const { documents, skipped, cancelled } = await rag.ingest(
  { namespace: 'handbook', documents: [{ id: 'leave-policy', text }] },
  { signal, onProgress: ({ stage, done, total }) => {} }
)
const hits = await rag.search({ scope: { namespace: 'handbook' }, query: 'leave days', k: 5 })
```

---

## Skip unchanged re-ingest and report replaced chunks in @qvac/rag

PR: [#5693](https://github.com/tetherto/qvac/pull/5693)

```typescript
const { documents } = await rag.ingest({ namespace: 'docs', documents: [{ id: 'a', text }] })
// [{ id: 'a', generation: 2, chunkCount: 3, status: 'replaced', removedChunks: 4 }]
// re-ingesting the same text → { id: 'a', generation: 2, chunkCount: 3, status: 'unchanged' }
```

---
