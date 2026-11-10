# @qvac/rag

Embedded ingestion and retrieval for QVAC apps. `@qvac/rag` stores document chunks and their embeddings in HyperDB and answers scoped vector searches over them. It runs on Bare and Node, and does not depend on `@qvac/sdk` or `@qvac/inference`.

This release accepts chunks with precomputed embeddings. Search uses a TurboVec index per namespace when `@qvac/turbovec-ggml` is installed, and an exact scan of HyperDB otherwise. Text chunking and an embeddings port are not in this release yet.

## Installation

```bash
npm install @qvac/rag corestore
```

On runtimes without a Node-style `crypto.createHash` (browser, React Native), install a compatible polyfill such as `crypto-browserify`.

For indexed search on Bare, also install the optional peer:

```bash
npm install @qvac/turbovec-ggml
```

## Usage

```ts
import Corestore from 'corestore'
import { createRag } from '@qvac/rag'

const rag = createRag({
  corestore: new Corestore('./rag-storage'),
  index: { dir: './rag-index' }
})
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

See [`examples/quickstart.ts`](examples/quickstart.ts) for a runnable version.

## API

### `createRag({ corestore, index? })`

Creates a RAG instance on a caller-owned Corestore.

`index` configures the vector index, used only when `@qvac/turbovec-ggml` loads:

- `dir`: directory for index snapshots. Without it, each namespace's index is built from HyperDB the first time it is searched after `ready()`, and kept in memory only.
- `snapshotEvery`: committed batches between snapshots, default 256. A snapshot is also written on `close()`.

The index is derived from HyperDB and never trusted on its own. On open it loads the snapshot if it matches the namespace's revision, replays the batches committed since if it is behind, and rebuilds from the stored chunks otherwise. Deleting the snapshot directory is always safe. `close()` waits for calls already in progress, then closes the RAG's HyperDB but leaves the Corestore open; calls made after it fail with `NOT_READY`. Call `ready()` before any other method.

### `createNamespace({ name, space, index? })`

Creates a namespace pinned to one embedding space and returns `{ name, spaceId, revision, index: { storage } }`. `spaceId` is a hash of every field of `space`, so two spaces with the same dimensions but a different model, encoding or metric never match. Calling it again with the same space returns the existing namespace; a different space fails with `NAMESPACE_EXISTS`.

`documentEncoding`, `queryEncoding` and `preprocessing` only identify the space; `@qvac/rag` never applies them. Add the document and query prefixes yourself before embedding. Nothing checks that you did, and skipping them only makes results worse.

`computeSpaceId(space)` returns the same ID without touching storage.

`index.storage` sets how the namespace's index stores vectors and is fixed at creation; asking for a different one later fails with `NAMESPACE_EXISTS`.

| Storage                      | Dimensions                    | Notes                                                            |
| ---------------------------- | ----------------------------- | ---------------------------------------------------------------- |
| `q8` (default)               | any                           | 8-bit quantized                                                  |
| `f32`                        | any                           | full precision                                                   |
| `turbovec-q4`, `turbovec-q2` | divisible by 8, at most 1,024 | TurboVec 4- and 2-bit; embedding components must stay below 1e16 |

### `ingest({ namespace, documents })`

Each document is `{ id, metadata?, chunks }`, and each chunk is `{ id?, content, metadataJson?, embedding, spaceId }`. A chunk's `spaceId` must equal the namespace's, and its embedding must have the space's dimensions. Chunk IDs default to `<documentId>:<ordinal>`. Omit `metadataJson` rather than passing an empty string, which is rejected.

- The whole call is validated before anything is written.
- Each document commits in its own HyperDB batch. If a later document fails, earlier ones stay committed.
- Ingesting an existing document ID replaces it: the new chunks get a new generation and the old chunks are deleted in the same batch.
- There is no content deduplication. Identical text in two documents is stored and returned twice.

Returns `{ documents: [{ id, generation, chunkCount }], revision }`.

### `deleteDocuments({ namespace, documentIds })`

Deletes the documents and their chunks in one batch. Unknown IDs are ignored. Returns `{ deleted, revision }`.

### `search({ scope, vector, spaceId, k, signal? })`

Returns up to `k` hits `{ namespace, documentId, chunkId, ordinal, content, metadataJson?, documentMetadata?, score }`, best first. `metadataJson` is the chunk's and `documentMetadata` is the document's `metadata` from ingest. `spaceId` is the space the query was embedded in; a different one fails with `EMBEDDING_SPACE_MISMATCH`, even when its dimensions match. The score is the dot product, or the cosine similarity for `cosine` spaces, computed from the stored float32 vectors either way. With the index, candidates come from TurboVec and are rescored exactly; a candidate HyperDB no longer maps to a current chunk is dropped. An aborted `signal` fails with `OPERATION_CANCELLED`; the scan checks it between batches, and a search waiting for an index to load or rebuild stops waiting, while the rebuild finishes for later searches. Equal scores rank in scope order for a `documentIds` list and in document ID order otherwise, with and without the index.

`scope` is `{ namespace, documentIds? }`. Only chunks inside the scope are read and ranked, so a restricted search fills its top `k` from allowed documents. Search fails closed:

- a missing `namespace` or any other key in `scope` fails with `INVALID_SCOPE`;
- a namespace that doesn't exist fails with `NAMESPACE_NOT_FOUND`;
- a document ID that isn't in the namespace fails with `DOCUMENT_OUT_OF_SCOPE`;
- `documentIds: []` returns no hits.

### `scoped(scope)`

Returns `{ search }` bound to `scope`. The `scope` passed to its `search` is optional and is intersected with the bound one: it can narrow to fewer documents but never add a document or switch namespace. Its `search` takes the same `vector`, `spaceId`, `k` and `signal` as `search`. A handle never fails on document identity: an ID that the namespace does not have, whether it was never ingested or has since been deleted, is skipped, so a handle whose documents are gone returns no hits instead of an error. Only the shape of the scope can fail (`INVALID_SCOPE`), and a namespace that does not exist fails with `NAMESPACE_NOT_FOUND`.

```ts
const reader = rag.scoped({ namespace: 'handbook', documentIds: ['leave-policy', 'travel'] })
await reader.search({ vector: queryVector, spaceId, k: 5, scope: { documentIds: ['travel'] } })
```

## Errors

Every error is a `QvacErrorRAG` with a code from `ERR_CODES`, importable from `@qvac/rag` or `@qvac/rag/errors`. Corestore and HyperDB failures, including `ready()` on storage another process holds, surface as `DB_OPERATION_FAILED` with the original error as `cause`. An index that can't be built or searched is never an error: that namespace's searches scan until the RAG is reopened.

## Development

```bash
npm run build:hyperdb-spec   # regenerate src/db/hyperspec after a schema change
npm run typecheck
npm run lint
npm run test:unit                      # index tests need @qvac/turbovec-ggml to load
bare scripts/bench-index.ts --help     # index RAM and open-time benchmark, not run in CI
```

## License

Apache-2.0
