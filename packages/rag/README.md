# @qvac/rag

Embedded ingestion and retrieval for QVAC apps. `@qvac/rag` stores document chunks and their embeddings in HyperDB and answers scoped vector searches over them. It runs on Bare and Node, and does not depend on `@qvac/sdk` or `@qvac/inference`.

It ingests text, pre-chunked text or chunks with precomputed embeddings, and searches them with an exact scan. Text is chunked with [`rag-extract/chunk`](https://github.com/tetherto/rag-extract) and embedded through an embeddings port you supply. A TurboVec index is not in this release yet.

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
  spaceId,
  k: 5
})

await rag.close()
```

With an embeddings port, ingest and search take text instead of vectors:

```ts
const rag = createRag({ corestore, embeddings: port }) // port.space is the namespace's space

await rag.ingest(
  { namespace: 'handbook', documents: [{ id: 'leave-policy', text: policyText }] },
  { signal, onProgress: ({ stage, done, total }) => console.log(stage, done, total) }
)
const hits = await rag.search({
  scope: { namespace: 'handbook' },
  query: 'How many leave days?',
  k: 5
})
```

See [`examples/quickstart.ts`](examples/quickstart.ts) for a runnable version.

## API

### `createRag({ corestore, embeddings?, chunking? })`

Creates a RAG instance on a caller-owned Corestore. `embeddings` is an `EmbeddingsPort`, needed only for text and pre-chunked ingest and for text query search:

```ts
interface EmbeddingsPort {
  space: EmbeddingSpace
  // One row per text, row-major, each with `space.dimensions` values.
  embedDocuments(texts: string[], options?: { signal?: AbortSignal }): Promise<Float32Array>
  embedQuery(text: string, options?: { signal?: AbortSignal }): Promise<Float32Array>
}
```

The port must be in the namespace's space: `computeSpaceId(port.space)` has to equal the namespace's `spaceId`, or text ingest and text search fail with `EMBEDDING_SPACE_MISMATCH` before anything is embedded. Without a port they fail with `DEPENDENCY_REQUIRED`. A port that throws surfaces as `EMBEDDING_FAILED`, and one that returns the wrong number of values as `EMBEDDING_DIMENSION_MISMATCH`.

`chunking` is `{ chunkSize?, chunkOverlap? }` in tokens, passed to `rag-extract/chunk` for text documents (defaults 256 and 50). `chunkOverlap` must be smaller than `chunkSize`. `close()` waits for calls already in progress, then closes the RAG's HyperDB but leaves the Corestore open; calls made after it fail with `NOT_READY`. Call `ready()` before any other method.

### `createNamespace({ name, space })`

Creates a namespace pinned to one embedding space and returns `{ name, spaceId, revision }`. `spaceId` is a hash of every field of `space`, so two spaces with the same dimensions but a different model, encoding or metric never match. Calling it again with the same space returns the existing namespace; a different space fails with `NAMESPACE_EXISTS`.

`documentEncoding`, `queryEncoding` and `preprocessing` only identify the space; `@qvac/rag` never applies them. Add the document and query prefixes yourself before embedding, or in your embeddings port. Nothing checks that you did, and skipping them only makes results worse.

`computeSpaceId(space)` returns the same ID without touching storage.

### `ingest({ namespace, documents }, { signal?, onProgress? }?)`

Each document is one of:

- **Text** `{ id, text, metadata? }`: chunked with `rag-extract/chunk` using the `chunking` options, so chunk IDs are `<id>:<index>` and each chunk carries `rag-extract`'s `metadataJson`. Text that is empty or only whitespace is rejected.
- **Pre-chunked** `{ id, metadata?, chunks: [{ id?, content, metadataJson? }] }`: segmentation and chunk IDs are kept exactly. A chunk list from `rag-extract` goes in as-is; its `tokenCount` is accepted and not stored.
- **Precomputed** `{ id, metadata?, spaceId?, chunks: [{ id?, content, metadataJson?, embedding, spaceId? }] }`: needs no port. Each chunk takes its own `spaceId` or the document's, and it must equal the namespace's; the embedding must have the space's dimensions. A `rag-extract` artifact's chunks go in as-is with `spaceId` on the document.

Within one document, either every chunk has an `embedding` or none does. Chunk IDs default to `<documentId>:<ordinal>`. Omit `metadataJson` rather than passing an empty string, which is rejected. Text and pre-chunked chunks are sent to the port in batches of 32.

- The whole call is validated, and text is chunked, before anything is written.
- Each document commits in its own HyperDB batch, in input order, as soon as all its chunks are embedded. If a later document fails, earlier ones stay committed.
- `signal` is checked between embedding batches and before each document's commit. An abort does not throw: committed documents stay, the rest are listed in `skipped`, and `cancelled` is `true`.
- `onProgress({ stage, done, total })` reports `chunk` (text documents chunked), `embed` (chunks embedded, once per batch) and `commit` (documents written).
- Ingesting an existing document ID replaces it: the new chunks get a new generation and the old chunks are deleted in the same batch.
- There is no content deduplication. Identical text in two documents is stored and returned twice.

Returns `{ documents: [{ id, generation, chunkCount }], skipped, cancelled, revision }`.

### `deleteDocuments({ namespace, documentIds })`

Deletes the documents and their chunks in one batch. Unknown IDs are ignored. Returns `{ deleted, revision }`.

### `search({ scope, vector, spaceId, k, signal? })` / `search({ scope, query, k, signal? })`

A text `query` is embedded with the port's `embedQuery` and searched in the port's space, so it takes no `spaceId`. Returns up to `k` hits `{ namespace, documentId, chunkId, ordinal, content, metadataJson?, documentMetadata?, score }`, best first. `metadataJson` is the chunk's and `documentMetadata` is the document's `metadata` from ingest. `spaceId` is the space the query was embedded in; a different one fails with `EMBEDDING_SPACE_MISMATCH`, even when its dimensions match. The score is the dot product, or the cosine similarity for `cosine` spaces. An aborted `signal` stops the scan between batches with `OPERATION_CANCELLED`.

`scope` is `{ namespace, documentIds? }`. Only chunks inside the scope are read and ranked, so a restricted search fills its top `k` from allowed documents. Search fails closed:

- a missing `namespace` or any other key in `scope` fails with `INVALID_SCOPE`;
- a namespace that doesn't exist fails with `NAMESPACE_NOT_FOUND`;
- a document ID that isn't in the namespace fails with `DOCUMENT_OUT_OF_SCOPE`;
- `documentIds: []` returns no hits.

### `scoped(scope)`

Returns `{ search }` bound to `scope`. The `scope` passed to its `search` is optional and is intersected with the bound one: it can narrow to fewer documents but never add a document or switch namespace. Its `search` takes the same `vector` and `spaceId`, or `query`, plus `k` and `signal`, as `search`. A handle never fails on document identity: an ID that the namespace does not have, whether it was never ingested or has since been deleted, is skipped, so a handle whose documents are gone returns no hits instead of an error. Only the shape of the scope can fail (`INVALID_SCOPE`), and a namespace that does not exist fails with `NAMESPACE_NOT_FOUND`.

```ts
const reader = rag.scoped({ namespace: 'handbook', documentIds: ['leave-policy', 'travel'] })
await reader.search({ vector: queryVector, spaceId, k: 5, scope: { documentIds: ['travel'] } })
```

## Errors

Every error is a `QvacErrorRAG` with a code from `ERR_CODES`, importable from `@qvac/rag` or `@qvac/rag/errors`. Corestore and HyperDB failures, including `ready()` on storage another process holds, surface as `DB_OPERATION_FAILED` with the original error as `cause`.

## Development

```bash
npm run build:hyperdb-spec   # regenerate src/db/hyperspec after a schema change
npm run typecheck
npm run lint
npm run test:unit
```

## License

Apache-2.0
