# QVAC RAG v0.11.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/rag/v/0.11.0

`@qvac/rag` 0.11.0 adds what an app needs around search: reading documents back, listing them, moving whole namespaces between stores, and keeping one long document from crowding out the rest of a result. Search hits now carry citation details. Data written by 0.10.0 opens without migration.

## Search Across Documents, With Citations

`perDocument` spreads the `k` hits across documents: every document's best hit is taken before any document gets a second one, and no document gets more than `perDocument`. When `scope.documentIds` lists at most `k` documents, each listed document that has chunks gets a hit. `minScore` drops weak hits first, so a result can hold fewer than `k`.

```typescript
const hits = await rag.search({
  scope: { namespace: 'handbook' },
  query,
  k: 8,
  perDocument: 2,
  minScore: 0.4
})
// hits[0] → { documentId: 'manual', ordinal: 12, generation: 3, chunkCount: 40,
//             citation: { title: 'Manual', page: 7 }, score: 0.82, ... }
```

Every hit now reports its document's `generation`, how many chunks that generation has, and a `citation` with `title`, `page`, `sourceUrl`, `sourcePath` and `mimeType` where the document metadata or the chunk's `rag-extract` metadata holds them.

## Read and List Documents

`readDocument` returns a document's chunks in order, a page at a time, so a hit can be expanded into its surrounding text. Passing the first page's `generation` on later pages makes the read fail with `DOCUMENT_CHANGED` if the document was re-ingested or deleted in between, instead of mixing two versions. `listDocuments` pages through a namespace in document ID order; each entry's `revision` gives ingest order.

```typescript
const page = await rag.readDocument({
  namespace: 'handbook',
  documentId: 'manual',
  fromOrdinal: 4,
  limit: 3
})
// → { generation: 3, chunkCount: 40, chunks: [{ chunkId, ordinal: 4, content }, ...], nextOrdinal: 7 }

const { documents, next } = await rag.listDocuments({ namespace: 'handbook', limit: 100 })
```

Scoped handles from `rag.scoped(scope)` gain both calls, limited to their scope. Deleting a document now keeps its last generation, so ingesting the same ID again continues the numbering instead of reusing it.

## Export, Import, List and Drop Namespaces

`exportNamespace` streams a namespace, or some of its documents, as bytes that `importNamespace` reads into another store, with no re-embedding. Imports keep generations and deletes, report what they skipped and why, and can be stopped with an `AbortSignal` or by closing the RAG. `listNamespaces` reports each namespace's space, index storage and counts, and `dropNamespace` deletes a namespace with its index snapshot.

```typescript
const backup = rag.exportNamespace({ namespace: 'handbook' }) // AsyncIterable<Uint8Array>
const result = await other.importNamespace({ namespace: 'handbook', source: backup })
// → { documents: [{ id, generation, status: 'created' }], skipped: [], cancelled: false, revision }

await rag.listNamespaces() // [{ name, spaceId, space, index, revision, documentCount, chunkCount }]
await rag.dropNamespace({ name: 'handbook' }) // { name, documentCount, chunkCount }
```

A namespace only imports into one from the same history: a malformed stream fails with `IMPORT_INVALID`, and a non-empty namespace with a different history fails with `IMPORT_LINEAGE_MISMATCH`.
