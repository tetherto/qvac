# QVAC RAG v0.10.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/rag/v/0.10.0

`@qvac/rag` 0.10.0 is a rewrite. The package is now a small embedded store for document chunks and their embeddings, built on HyperDB, with search that only ever looks inside the scope you grant it. It can chunk and embed text through an embeddings port you supply, keeps an optional TurboVec index per namespace, and skips documents whose content has not changed. It runs on Bare and Node.

## Breaking Changes

The `RAG` class and its adapter system are replaced by a `createRag()` factory. Storage, chunking and LLM answer generation are no longer bundled together: `@qvac/rag` stores and searches, and you call your LLM with the hits yourself.

Before:

```typescript
import { RAG, HyperDBAdapter } from '@qvac/rag'

const rag = new RAG({ dbAdapter: new HyperDBAdapter({ store }), embeddingFunction })
await rag.ready()
await rag.saveEmbeddings([{ id: 'a', content, embedding, embeddingModelId: 'm' }])
const results = await rag.search(query)
```

After:

```typescript
import { createRag } from '@qvac/rag'

const rag = createRag({ corestore: store })
await rag.ready()
const { spaceId } = await rag.createNamespace({ name: 'docs', space })
await rag.ingest({
  namespace: 'docs',
  documents: [{ id: 'a', chunks: [{ content, embedding, spaceId }] }]
})
const hits = await rag.search({ scope: { namespace: 'docs' }, vector, spaceId, k: 5 })
```

Every namespace is pinned to one embedding space, identified by a `spaceId` hash of the model, dimensions, metric and encodings. Precomputed chunks and vector queries must carry that `spaceId`, so vectors from different models never mix. Search reads only the namespace and document IDs in its `scope`, and fails closed on a missing namespace, an unknown scope key or a document outside the namespace. `rag.scoped(scope)` returns a search handle that can narrow its scope but never widen it.

The following exports are removed: `RAG`, `HyperDBAdapter`, `TurboVecAdapter` and its types, `BaseDBAdapter`, `LLMChunkAdapter`, `BaseChunkAdapter`, `BaseLlmAdapter`, `HttpLlmAdapter`, `QvacLlmAdapter`, and the embedding and document zod schemas. `ERR_CODES` drops the codes those classes used (`LLM_REQUIRED`, `GENERATION_FAILED`, `CHUNKING_FAILED` and others); their numbers are not reused.

0.10.0 uses a new HyperDB schema and does not migrate data written by 0.9.x. Re-ingest your documents into a fresh Corestore.

## Text Ingest Through an Embeddings Port

Pass an embeddings port to `createRag()` and `ingest()` accepts plain text or pre-chunked text as well as precomputed vectors. Text is chunked with `rag-extract`, embedded in batches, and committed one document at a time. Ingest reports progress, can be cancelled with an `AbortSignal` without losing the documents already committed, and `search()` accepts a text `query`.

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

## Indexed Search With TurboVec

On Bare, when the optional peer `@qvac/turbovec-ggml` is installed and loads, each namespace gets a TurboVec index derived from HyperDB, and candidates are rescored exactly against the stored vectors. Pass `index.dir` to keep snapshots between runs, and pick `q8` (default), `f32`, `turbovec-q4` or `turbovec-q2` storage per namespace. On Node, or without the peer, search falls back to an exact scan.

```typescript
const rag = createRag({ corestore, index: { dir: './rag-index', snapshotEvery: 256 } })
const { index } = await rag.createNamespace({
  name: 'docs',
  space,
  index: { storage: 'turbovec-q4' }
})
```

The README lists measured memory use: about 320 MiB to open a 100,000-chunk namespace from a snapshot, and about 1 GiB the first time it is built without one.

## Unchanged Documents Are Skipped on Re-ingest

Re-ingesting a document whose content has not changed writes nothing and does not call the embeddings port. Each ingested document now reports a `status` of `created`, `replaced` (with the number of chunks removed) or `unchanged`.

```typescript
const { documents } = await rag.ingest({ namespace: 'docs', documents: [{ id: 'a', text }] })
// [{ id: 'a', generation: 2, chunkCount: 3, status: 'replaced', removedChunks: 4 }]
```

## Bug Fixes

`@qvac/rag` can now be imported on Node.js as well as Bare.
