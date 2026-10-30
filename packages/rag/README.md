# @qvac/rag

Embedded ingestion and retrieval for QVAC apps. `@qvac/rag` stores document chunks and their embeddings in HyperDB and answers scoped vector searches over them. It runs on Bare and Node, and does not depend on `@qvac/sdk` or `@qvac/inference`.

This release accepts chunks with precomputed embeddings and searches them with an exact scan. Text chunking, an embeddings port and a TurboVec index are not in this release yet.

## Installation

```bash
npm install @qvac/rag corestore
```

On runtimes without a Node-style `crypto.createHash` (browser, React Native), install a compatible polyfill such as `crypto-browserify`.

## Usage

```ts
import Corestore from 'corestore'
import { createRag } from '@qvac/rag'

const rag = createRag({ corestore: new Corestore('./rag-storage') })
await rag.ready()

const { spaceId } = await rag.createNamespace({
  name: 'handbook',
  space: {
    model: 'embeddinggemma-300m',
    revision: 'q8_0',
    dimensions: 768,
    metric: 'cosine',
    normalized: true,
    documentEncoding: 'title: none | text: ',
    queryEncoding: 'task: search result | query: ',
    preprocessing: 'none'
  }
})

await rag.ingest({
  namespace: 'handbook',
  documents: [
    {
      id: 'leave-policy',
      metadata: { title: 'Leave policy' },
      chunks: [{ content: 'Employees get 25 days…', embedding: vector, spaceId }]
    }
  ]
})

const hits = await rag.search({
  scope: { namespace: 'handbook', documentIds: ['leave-policy'] },
  vector: queryVector,
  k: 5
})

await rag.close()
```

See [`examples/quickstart.ts`](examples/quickstart.ts) for a runnable version.

## API

### `createRag({ corestore })`

Creates a RAG instance on a caller-owned Corestore. `close()` closes the RAG's HyperDB but leaves the Corestore open. Call `ready()` before any other method.

### `createNamespace({ name, space })`

Creates a namespace pinned to one embedding space and returns `{ name, spaceId, revision }`. `spaceId` is a hash of every field of `space`, so two spaces with the same dimensions but a different model, encoding or metric never match. Calling it again with the same space returns the existing namespace; a different space fails with `NAMESPACE_EXISTS`.

`computeSpaceId(space)` returns the same ID without touching storage.

### `ingest({ namespace, documents })`

Each document is `{ id, metadata?, chunks }`, and each chunk is `{ id?, content, metadataJson?, embedding, spaceId }`. A chunk's `spaceId` must equal the namespace's, and its embedding must have the space's dimensions. Chunk IDs default to `<documentId>:<ordinal>`.

- The whole call is validated before anything is written.
- Each document commits in its own HyperDB batch. If a later document fails, earlier ones stay committed.
- Ingesting an existing document ID replaces it: the new chunks get a new generation and the old chunks are deleted in the same batch.
- There is no content deduplication. Identical text in two documents is stored and returned twice.

Returns `{ documents: [{ id, generation, chunkCount }], revision }`.

### `deleteDocuments({ namespace, documentIds })`

Deletes the documents and their chunks in one batch. Unknown IDs are ignored. Returns `{ deleted, revision }`.

### `search({ scope, vector, k })`

Returns up to `k` hits `{ namespace, documentId, chunkId, ordinal, content, metadataJson?, score }`, best first. The score is the dot product, or the cosine similarity for `cosine` spaces.

`scope` is `{ namespace, documentIds? }`. Only chunks inside the scope are read and ranked, so a restricted search fills its top `k` from allowed documents. Search fails closed:

- a missing `namespace` or any other key in `scope` fails with `INVALID_SCOPE`;
- a namespace that doesn't exist fails with `NAMESPACE_NOT_FOUND`;
- a document ID that isn't in the namespace fails with `DOCUMENT_OUT_OF_SCOPE`;
- `documentIds: []` returns no hits.

### `scoped(scope)`

Returns `{ search }` bound to `scope`. The `scope` passed to its `search` is optional and is intersected with the bound one: it can narrow to fewer documents but never add a document or switch namespace. A handle never fails on document identity: an ID that the namespace does not have, whether it was never ingested or has since been deleted, is skipped, so a handle whose documents are gone returns no hits instead of an error. Only the shape of the scope can fail (`INVALID_SCOPE`), and a namespace that does not exist fails with `NAMESPACE_NOT_FOUND`.

```ts
const reader = rag.scoped({ namespace: 'handbook', documentIds: ['leave-policy', 'travel'] })
await reader.search({ vector: queryVector, k: 5, scope: { documentIds: ['travel'] } })
```

## Errors

Every error is a `QvacErrorRAG` with a code from `ERR_CODES`, importable from `@qvac/rag` or `@qvac/rag/errors`.

## Development

```bash
npm run build:hyperdb-spec   # regenerate src/db/hyperspec after a schema change
npm run typecheck
npm run lint
npm run test:unit
```

## License

Apache-2.0
