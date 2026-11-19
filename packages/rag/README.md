# @qvac/rag

Embedded ingestion and retrieval for QVAC apps. `@qvac/rag` stores document chunks and their embeddings in HyperDB and answers scoped vector searches over them. It runs on Bare and Node, and does not depend on `@qvac/sdk` or `@qvac/inference`.

It ingests text, pre-chunked text or chunks with precomputed embeddings. Text is chunked with [`rag-extract/chunk`](https://github.com/tetherto/rag-extract) and embedded through an embeddings port you supply. Search uses a TurboVec index per namespace when `@qvac/turbovec-ggml` is installed, and an exact scan of HyperDB otherwise.

## Installation

```bash
npm install @qvac/rag corestore
```

On runtimes without Node-style `crypto` (browser, React Native), install a polyfill such as `crypto-browserify` that provides `createHash` and either `randomBytes` or `getRandomValues`. Randomness is needed to create a namespace and on the first write to a namespace created by 0.10.0 or earlier.

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

### `createRag({ corestore, embeddings?, chunking?, index? })`

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

`chunking` is `{ chunkSize?, chunkOverlap? }` in tokens, passed to `rag-extract/chunk` for text documents (defaults 256 and 50). `chunkOverlap` must be smaller than `chunkSize`.

`index` configures the vector index, used only when `@qvac/turbovec-ggml` loads:

- `dir`: directory for index snapshots. Without it, each namespace's index is built from HyperDB the first time it is searched after `ready()`, and kept in memory only.
- `snapshotEvery`: committed batches between snapshots, default 256. A snapshot is also written on `close()`.

The index is derived from HyperDB and never trusted on its own. On open it loads the snapshot if it matches the namespace's revision, replays the batches committed since if it is behind, and rebuilds from the stored chunks otherwise. Deleting the snapshot directory is always safe. `close()` waits for calls already in progress, then closes the RAG's HyperDB but leaves the Corestore open; calls made after it fail with `NOT_READY`. Call `ready()` before any other method.

### `createNamespace({ name, space, index? })`

Creates a namespace pinned to one embedding space and returns `{ name, spaceId, revision, index: { storage } }`. `spaceId` is a hash of every field of `space`, so two spaces with the same dimensions but a different model, encoding or metric never match. Calling it again with the same space returns the existing namespace; a different space fails with `NAMESPACE_EXISTS`.

`documentEncoding`, `queryEncoding` and `preprocessing` only identify the space; `@qvac/rag` never applies them. Add the document and query prefixes yourself before embedding, or in your embeddings port. Nothing checks that you did, and skipping them only makes results worse.

`computeSpaceId(space)` returns the same ID without touching storage.

`index.storage` sets how the namespace's index stores vectors and is fixed at creation; asking for a different one later fails with `NAMESPACE_EXISTS`.

| Storage                      | Dimensions                    | Notes                                                            |
| ---------------------------- | ----------------------------- | ---------------------------------------------------------------- |
| `q8` (default)               | any                           | 8-bit quantized                                                  |
| `f32`                        | any                           | full precision                                                   |
| `turbovec-q4`, `turbovec-q2` | divisible by 8, at most 1,024 | TurboVec 4- and 2-bit; embedding components must stay below 1e16 |

### `ingest({ namespace, documents }, { signal?, onProgress? }?)`

Each document is one of:

- **Text** `{ id, text, metadata? }`: chunked with `rag-extract/chunk` using the `chunking` options, so chunk IDs are `<id>:<index>` and each chunk carries `rag-extract`'s `metadataJson`. Text that is empty or only whitespace is rejected.
- **Pre-chunked** `{ id, metadata?, chunks: [{ id?, content, metadataJson? }] }`: segmentation and chunk IDs are kept exactly. A chunk list from `rag-extract` goes in as-is; its `tokenCount` is accepted and not stored.
- **Precomputed** `{ id, metadata?, spaceId?, chunks: [{ id?, content, metadataJson?, embedding, spaceId? }] }`: needs no port. Each chunk takes its own `spaceId` or the document's, and it must equal the namespace's; the embedding must have the space's dimensions. A `rag-extract` artifact's chunks go in as-is with `spaceId` on the document.

Within one document, either every chunk has an `embedding` or none does. Chunk IDs default to `<documentId>:<ordinal>`. Omit `metadataJson` rather than passing an empty string, which is rejected. Text and pre-chunked chunks are sent to the port in batches of 32.

- The whole call is validated, and text is chunked, before anything is written.
- Each document commits in its own HyperDB batch, in input order, as soon as all its chunks are embedded. If a later document fails, earlier ones stay committed.
- `signal` is checked between embedding batches and before each document's commit. An abort does not throw: committed documents stay, the rest are listed in `skipped`, and `cancelled` is `true`.
- `onProgress({ stage, done, total })` reports `chunk` (text documents chunked), `embed` (chunks embedded, once per batch) and `commit` (documents written or found unchanged).
- Ingesting an existing document ID replaces it: the new chunks get a new generation and the old chunks are deleted in the same batch.
- Re-ingesting a document whose content is unchanged writes nothing: no new generation and no revision bump, and its text is not sent to the port. Content is the chunk IDs, text and `metadataJson` after chunking, the precomputed vectors, the document `metadata` and the namespace's space. So new `chunking` options count as a change, while the `indexedAt` timestamp in `rag-extract`'s chunk metadata does not. An `indexedAt` key in any other chunk metadata is compared like every other field.
- There is no content deduplication. Identical text in two documents is stored and returned twice.

Returns `{ documents, skipped, cancelled, revision }`. Each entry in `documents` is `{ id, generation, chunkCount, status }`, where `status` is `created`, `replaced` (with `removedChunks`, the previous generation's chunk count) or `unchanged`.

### `deleteDocuments({ namespace, documentIds })`

Deletes the documents and their chunks in one batch. Unknown IDs are ignored. Returns `{ deleted, revision }`. A deleted document's last generation is kept, so ingesting the same ID later continues at the next generation: a `generation` read before the delete never matches the new document.

### `search({ scope, vector, spaceId, k, signal? })` / `search({ scope, query, k, signal? })`

A text `query` is embedded with the port's `embedQuery` and searched in the port's space, so it takes no `spaceId`. Returns up to `k` hits `{ namespace, documentId, chunkId, ordinal, generation, content, metadataJson?, documentMetadata?, score }`, best first. `metadataJson` is the chunk's and `documentMetadata` is the document's `metadata` from ingest. `generation` is the document version the chunk belongs to. `spaceId` is the space the query was embedded in; a different one fails with `EMBEDDING_SPACE_MISMATCH`, even when its dimensions match. The score is the dot product, or the cosine similarity for `cosine` spaces, computed from the stored float32 vectors either way. With the index, candidates come from TurboVec and are rescored exactly; a candidate HyperDB no longer maps to a current chunk is dropped. An aborted `signal` fails with `OPERATION_CANCELLED`; the scan checks it between batches, and a search waiting for an index to load or rebuild stops waiting, while the rebuild finishes for later searches. Equal scores rank in scope order for a `documentIds` list and in document ID order otherwise, with and without the index.

`scope` is `{ namespace, documentIds? }`. Only chunks inside the scope are read and ranked, so a restricted search fills its top `k` from allowed documents. Search fails closed:

- a missing `namespace` or any other key in `scope` fails with `INVALID_SCOPE`;
- a namespace that doesn't exist fails with `NAMESPACE_NOT_FOUND`;
- a document ID that isn't in the namespace fails with `DOCUMENT_OUT_OF_SCOPE`;
- `documentIds: []` returns no hits.

### `readDocument({ namespace, documentId, generation?, fromOrdinal?, limit? })`

Reads a document's chunks in ordinal order, one page at a time. Returns `{ namespace, documentId, generation, chunkCount, metadata?, chunks, nextOrdinal }`; each chunk is `{ chunkId, ordinal, content, metadataJson? }`, without its vector. `fromOrdinal` defaults to 0 and `limit` to 64 chunks, at most 1,024. `nextOrdinal` is the next page's `fromOrdinal`, or `null` after the last chunk.

Every page comes from one generation. Pass the first page's `generation` on later pages: if the document was re-ingested or deleted since, the read fails with `DOCUMENT_CHANGED` rather than mixing generations. Without `generation` the current one is read, and a document the namespace doesn't have fails with `DOCUMENT_OUT_OF_SCOPE`. To read around a hit, pass its `generation` and start a little before its `ordinal`:

```ts
await rag.readDocument({
  namespace,
  documentId: hit.documentId,
  generation: hit.generation,
  fromOrdinal: Math.max(0, hit.ordinal - 1),
  limit: 3
})
```

### `listDocuments({ namespace, after?, limit? })`

Lists a namespace's documents in document ID order. Returns `{ documents, next }`; each entry is `{ documentId, generation, chunkCount, revision, metadata? }`. `limit` defaults to 100, at most 1,024. Pass `next` as `after` for the following page; it is `null` on the last one. `revision` is the namespace revision that committed the document's current generation, so sorting by it gives ingest order, for example to drop the oldest documents. Documents written by 0.10 report 0.

### `exportNamespace({ namespace, documentIds? }, { signal? }?)`

Returns an `AsyncIterable<Uint8Array>` of the namespace in the `QVRAGX1` format: a header with the full embedding space, its `spaceId` and the namespace's lineage, then each document with its chunks (IDs, text, metadata and float32 vectors), then the delete records of deleted documents, then a trailer with counts. Native IDs, index snapshots and quantized vectors are not exported; the target builds its own index.

The stream reads one database snapshot, so commits made while it runs don't appear in it, and it yields one chunk at a time: memory stays flat whatever the namespace size, and a slow consumer slows the export. With `documentIds`, only those documents and their delete records are exported; IDs the namespace doesn't have are left out. Bad input throws at the call; an aborted `signal` fails the iteration with `OPERATION_CANCELLED`, and `close()` ends an open export with `NOT_READY`. A chunk or document that encodes to more than 64 MiB fails the iteration with `INVALID_INPUT`, since import would refuse it.

```ts
const out = fs.createWriteStream('handbook.qvragx')
for await (const bytes of rag.exportNamespace({ namespace: 'handbook' })) out.write(bytes)
```

### `importNamespace({ namespace, source, index? }, { signal?, onProgress? }?)`

Reads a `QVRAGX1` stream from `source` (any `AsyncIterable<Uint8Array>`) into `namespace`. A missing namespace is created with the export's space and lineage, and `index` sets its storage as in `createNamespace`. Returns `{ documents, skipped, cancelled, revision }`.

Before writing anything, the import checks that the header's space hashes to its `spaceId` (`IMPORT_INVALID` otherwise), that an existing namespace is in the same space (`EMBEDDING_SPACE_MISMATCH`), and that it has the same lineage (`IMPORT_LINEAGE_MISMATCH`). An empty namespace takes the export's lineage. Two namespaces with different lineages are never merged; to combine them, `ingest` the exported chunks with their vectors and `spaceId`, which gives them fresh generations.

Documents keep their exported generation and commit one at a time, like `ingest`. For each document:

| Target holds                               | Result                                        |
| ------------------------------------------ | --------------------------------------------- |
| nothing                                    | `created`                                     |
| an older generation                        | `replaced`                                    |
| the same generation and content            | `unchanged`                                   |
| the same generation, other content         | skipped, `conflict`; the target keeps its own |
| a newer generation                         | skipped, `superseded`                         |
| a delete of this generation or a later one | skipped, `deleted`                            |

A delete record removes the target's document unless the target holds a newer generation (`deleted` in `documents`, or skipped as `superseded`), and is kept, so importing an older export later can't bring the document back.

Each document is checked before it commits: contiguous ordinals, `dimensions × 4` vector bytes, finite components, and a content hash that matches its text, metadata and, when the source document was ingested with vectors, its vectors. A bad document, a stream cut short, a missing or wrong trailer, or a frame over 64 MiB fails with `IMPORT_INVALID`; documents committed before it stay, and a document is never committed in part. Memory holds one document's chunks at a time. An abort through `signal`, or `close()`, stops the import, even one waiting on a `source` that has stopped sending: it keeps what is committed and returns `cancelled: true`. Before the header is read there is nothing to keep, so it fails instead, with `OPERATION_CANCELLED` (`NOT_READY` for `close()`). The check before each commit runs once the write lock is held. `onProgress({ documents, deletes })` reports the documents and delete records read.

An export of a namespace that has since been dropped imports like any other: into a new or empty namespace it restores the documents with their lineage.

### `listNamespaces()`

Returns every namespace as `{ name, spaceId, space, index: { storage }, revision, documentCount, chunkCount }`, by name. The counts read one row per document.

### `dropNamespace({ name })`

Deletes the namespace with all its documents, chunks, delete records and index snapshot, in one batch, and returns `{ name, documentCount, chunkCount }`. Nothing comes back on reopen. `createNamespace` with the same name starts an empty namespace with a new lineage. An export taken before the drop can still be imported to restore it. The embedding space record stays for other namespaces. A namespace that doesn't exist fails with `NAMESPACE_NOT_FOUND`.

### `scoped(scope)`

Returns `{ search, readDocument, listDocuments }` bound to `scope`. The `scope` passed to its `search` is optional and is intersected with the bound one: it can narrow to fewer documents but never add a document or switch namespace. Its `search` takes the same `vector` and `spaceId`, or `query`, plus `k` and `signal`, as `search`. A handle never fails on document identity: an ID that the namespace does not have, whether it was never ingested or has since been deleted, is skipped, so a handle whose documents are gone returns no hits instead of an error. Only the shape of the scope can fail (`INVALID_SCOPE`), and a namespace that does not exist fails with `NAMESPACE_NOT_FOUND`.

Its `readDocument` and `listDocuments` take the same parameters without `namespace`. `readDocument` of a document outside the bound scope fails with `DOCUMENT_OUT_OF_SCOPE`, with the same message as a missing one, so a handle can't probe for documents it wasn't granted. `listDocuments` lists the whole namespace for a namespace-wide handle, and otherwise only the granted documents that still exist.

```ts
const reader = rag.scoped({ namespace: 'handbook', documentIds: ['leave-policy', 'travel'] })
await reader.search({ vector: queryVector, spaceId, k: 5, scope: { documentIds: ['travel'] } })
```

## Memory

Process RSS and search latency for one namespace of 100,000 chunks × 768 dimensions with `q8` storage, measured with `scripts/bench-index.ts` on an M-series Mac (k = 10, 50 searches):

| Open path                           | RSS after searches | Peak RSS     | Open + first search | Search p50 / p95 |
| ----------------------------------- | ------------------ | ------------ | ------------------- | ---------------- |
| Cold open from a snapshot           | ~290 MiB           | ~320 MiB     | 150–170 ms          | 21 / 26–29 ms    |
| Rebuild from HyperDB (no snapshot)  | 610–775 MiB        | 985–1020 MiB | 2.4–2.6 s           | 21–23 / 24–31 ms |
| Scan, without `@qvac/turbovec-ggml` | 725–770 MiB        | 775–785 MiB  | ~2.1 s              | 1.3 / 1.4–1.5 s  |

Budget about 1 GiB for the first open of a namespace without a snapshot and about 320 MiB once a snapshot exists. Pass `index.dir` so later opens load the snapshot.

Replacing a document leaves its old rows in the index until it is compacted, which happens once removed rows reach a quarter of the live ones. Re-ingesting all of 20,000 × 768 `q8` chunks with new vectors 20 times in one process ends at about 630 MiB RSS (710 MiB peak), against 1.3 GiB without compaction.

To reproduce:

```bash
npm run build
bare scripts/bench-index.ts ingest  /tmp/rag-bench --chunks 100000 --dims 768 --storage q8
bare scripts/bench-index.ts rebuild /tmp/rag-bench
bare scripts/bench-index.ts cold    /tmp/rag-bench
bare scripts/bench-index.ts scan    /tmp/rag-bench
bare scripts/bench-index.ts ingest  /tmp/rag-replace --chunks 20000 --dims 768 --storage q8
bare scripts/bench-index.ts replace /tmp/rag-replace --rounds 20
```

Each phase runs in its own process and prints its RSS, peak RSS and search latency as JSON.

Export and import of the same namespace, measured with `scripts/bench-transfer.ts` (no index directory):

| Chunks × 768 | Stream  | Export time / peak RSS / peak JS heap | Import time / peak RSS / peak JS heap |
| ------------ | ------- | ------------------------------------- | ------------------------------------- |
| 20,000       | 60 MiB  | 0.4 s / ~250 MiB / ~33 MiB            | 1.0 s / ~260 MiB / ~43 MiB            |
| 100,000      | 300 MiB | 1.7–2.0 s / 600–650 MiB / ~75 MiB     | 5.1–5.2 s / ~435 MiB / ~60 MiB        |

The stream itself holds one frame on export and one document on import; the JS heap stays far below the stream size. Most of the RSS is the database's read and write caches, as with the scan. Import peaks below the ~470 MiB that ingesting the same 100,000 chunks takes.

```bash
bare scripts/bench-index.ts ingest    /tmp/rag-bench --chunks 100000 --dims 768
bare scripts/bench-transfer.ts export /tmp/rag-bench
bare scripts/bench-transfer.ts import /tmp/rag-bench
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
bare scripts/bench-transfer.ts --help  # export/import time and RAM, not run in CI
```

## License

Apache-2.0
