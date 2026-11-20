# 💥 Breaking Changes v0.10.0

## Rebuild @qvac/rag core on HyperDB with scoped search

PR: [#5483](https://github.com/tetherto/qvac/pull/5483)

**BEFORE:**

```typescript
import { RAG, HyperDBAdapter } from '@qvac/rag'

const rag = new RAG({ dbAdapter: new HyperDBAdapter({ store }), embeddingFunction })
await rag.ready()
await rag.saveEmbeddings([{ id: 'a', content, embedding, embeddingModelId: 'm' }])
const results = await rag.search(query)
```

**AFTER:**

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

**Removed exports:** `RAG`, `HyperDBAdapter`, `TurboVecAdapter` (with its `TurboVecAdapterInput`, `TurboVecIndex`, `TurboVecIndexProvider`, `TurboVecIndexSearchResult` and `TurboVecIndexStorage` types), `BaseDBAdapter`, `LLMChunkAdapter`, `BaseChunkAdapter`, `BaseLlmAdapter`, `HttpLlmAdapter`, `QvacLlmAdapter`, and the zod schemas `embeddingInputSchema`, `singleEmbeddingSchema`, `batchEmbeddingSchema`, `docSchema`, `docsArraySchema`, `embeddedDocSchema` and `embeddedDocsArraySchema`. Answer generation (`infer()`) is gone; call your LLM with the search hits yourself.

**Removed error codes from `ERR_CODES`:** `ABSTRACT_CLASS`, `DB_ADAPTER_NOT_INITIALIZED`, `DB_ADAPTER_REQUIRED`, `CENTROIDS_INITIALIZATION_FAILURE`, `LLM_REQUIRED`, `EMBEDDING_FUNCTION_REQUIRED`, `NOT_IMPLEMENTED`, `INVALID_PARAMS`, `GENERATION_FAILED`, `CHUNKING_FAILED`, `INVALID_CHUNKER`, `EMBEDDING_MODEL_MISMATCH`. Their numbers are not reused.

**Storage:** 0.10.0 uses a new HyperDB schema and does not migrate data written by 0.9.x. Re-ingest into a fresh Corestore.

**Search scope:** every namespace is pinned to an embedding space. Chunks and vector queries must carry its `spaceId`, and `search` only looks inside the given `scope`.

---
