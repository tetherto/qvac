# 🔌 API Changes v0.11.0

## Spread search hits across documents and add citation fields

PR: [#5809](https://github.com/tetherto/qvac/pull/5809)

```typescript
const hits = await rag.search({
  scope: { namespace: 'handbook' },
  query,
  k: 8,
  perDocument: 2,
  minScore: 0.4
})
// hits[0] → { documentId: 'manual', chunkId: 'manual:12', ordinal: 12, generation: 3, chunkCount: 40,
//             citation: { title: 'Manual', page: 7 }, score: 0.82, ... }
```

`SearchHit` gains `generation`, `chunkCount` and `citation`.

---

## Read and list documents, keep generations past deletes

PR: [#5843](https://github.com/tetherto/qvac/pull/5843)

```typescript
const page = await rag.readDocument({
  namespace: 'handbook',
  documentId: 'manual',
  generation: 3,
  fromOrdinal: 4,
  limit: 3
})
// → { generation: 3, chunkCount: 40, chunks: [{ chunkId, ordinal: 4, content }, ...], nextOrdinal: 7 }
const { documents, next } = await rag.listDocuments({ namespace: 'handbook', limit: 100 })
// documents[0] → { documentId: 'manual', generation: 3, chunkCount: 40, revision: 12, metadata: { title: 'Manual' } }
```

`scoped(scope)` handles gain `readDocument` and `listDocuments`. A page read with the first page's `generation` fails with `DOCUMENT_CHANGED` (14028) once the document is re-ingested or deleted.

---

## Export/import namespaces and list/drop namespaces in @qvac/rag

PR: [#5844](https://github.com/tetherto/qvac/pull/5844)

```typescript
const backup = rag.exportNamespace({ namespace: 'handbook' }) // AsyncIterable<Uint8Array>
const result = await other.importNamespace({ namespace: 'handbook', source: backup })
// → { documents: [{ id, generation, status: 'created' }], skipped: [], cancelled: false, revision }
await rag.listNamespaces() // [{ name, spaceId, space, index, revision, documentCount, chunkCount }]
await rag.dropNamespace({ name: 'handbook' }) // { name, documentCount, chunkCount }
```

New error codes: `IMPORT_INVALID` (14029) for a malformed stream, `IMPORT_LINEAGE_MISMATCH` (14030) when a non-empty target namespace has another lineage.

---
