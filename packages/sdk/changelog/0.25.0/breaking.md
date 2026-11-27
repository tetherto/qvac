# 💥 Breaking Changes v0.25.0

## Prevent Parakeet TDT word loss

PR: [#5845](https://github.com/tetherto/qvac/pull/5845)

A Parakeet TDT push stream (`transcribeStream` on an offline TDT model such as Parakeet TDT v3) now decodes in 30-second windows by default, and an explicit `chunkMs` or `streamingChunkMs` below `30000` fails when the session starts. The size of the audio you write is independent of the decode window, so small PCM writes still work. First text arrives after one decode window plus the right lookahead, or when a shorter recording ends.

**BEFORE:**

```typescript
const session = await transcribeStream({
  modelId,
  parakeetStreamingConfig: { chunkMs: 5000 }
})
```

**AFTER:**

```typescript
// omit chunkMs, or set it to 30000
const session = await transcribeStream({
  modelId,
  parakeetStreamingConfig: {}
})
```

---

## Judge model fit on shared memory and report why a fit is unknown

PR: [#5860](https://github.com/tetherto/qvac/pull/5860)

**BEFORE:**

```typescript
const { verdict, models } = await assessModelFit({
  models: [{ modelSrc: QWEN3_8_27B_MULTIMODAL_UD_Q8_K_XL, modelConfig: { ctx_size: 8192 } }]
})
// verdict 'fits', models[0].status 'fits' on a 24 GB Mac:
// MTL0 and CPU rows each fit, 19.2 GiB needed of 17.7 GiB free in the host pool
```

**AFTER:**

```typescript
const { verdict, models } = await assessModelFit({
  models: [{ modelSrc: QWEN3_8_27B_MULTIMODAL_UD_Q8_K_XL, modelConfig: { ctx_size: 8192 } }]
})
// verdict 'does-not-fit', models[0].status 'does-not-fit', with models[0].reason naming the pool:
// the MTL0 and CPU rows share the host pool and take more than 90% of its free memory
```

---

## Remove the RAG API from the SDK and inference

PR: [#5874](https://github.com/tetherto/qvac/pull/5874)

**BEFORE:**

```typescript
import { ragIngest, ragSearch } from '@qvac/sdk'

await ragIngest({ modelId, workspace: 'docs', documents })
const hits = await ragSearch({ modelId, workspace: 'docs', query, topK: 5 })
```

**AFTER:**

```typescript
import Corestore from 'corestore'
import { createRag } from '@qvac/rag'

const corestore = new Corestore('./rag/docs') // one folder per workspace
const rag = createRag({ corestore, embeddings: port }) // port: see below
await rag.ready()
await rag.createNamespace({ name: 'docs', space: port.space }) // once
await rag.ingest({ namespace: 'docs', documents: [{ id: 'intro', text }] })
const hits = await rag.search({ scope: { namespace: 'docs' }, query, k: 5 })
await rag.close()
await corestore.close()
```

<details>
<summary>Embeddings port: the SDK or your own embedding function</summary>

```typescript
import { embed, embedBatch, loadModel, GTE_LARGE_FP16 } from '@qvac/sdk'
import type { EmbeddingsPort } from '@qvac/rag'

const modelId = await loadModel({ modelSrc: GTE_LARGE_FP16 })

const port: EmbeddingsPort = {
  // Describes the vectors; a namespace only accepts vectors from its space.
  space: {
    model: 'gte-large-fp16',
    revision: '1',
    dimensions: 1024,
    metric: 'cosine',
    normalized: false,
    documentEncoding: '',
    queryEncoding: '',
    preprocessing: 'none'
  },
  async embedDocuments(texts) {
    const { embedding } = await embedBatch({ modelId, inputs: texts })
    return Float32Array.from(embedding.flat())
  },
  async embedQuery(text) {
    const { embedding } = await embed({ modelId, text })
    return Float32Array.from(embedding)
  }
}
```

- The port is any object with `space`, `embedDocuments` and `embedQuery`: back it with another model, a remote API or your own code.
- Skip the port entirely by ingesting precomputed vectors and searching with `{ vector, spaceId }`.
- Change `space` whenever the vectors change (model, revision, pooling); a namespace rejects vectors from another space.

</details>

<details>
<summary>Corestore</summary>

- `@qvac/rag` stores everything in a [Corestore](https://github.com/holepunchto/corestore) you create and close; the SDK used to manage its own.
- A Corestore locks its folder, so keep one per storage folder and share it inside the process.
- Optional `createRag({ index: { dir } })` keeps TurboVec index snapshots for faster reopen on Bare.

</details>

<details>
<summary>Old function → <code>@qvac/rag</code> 0.11</summary>

| SDK                                        | `@qvac/rag`                                                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ragIngest`                                | `ingest({ namespace, documents: [{ id, text }] })`; `chunkOpts` → `createRag({ chunking })`; `onProgress` → `ingest(params, { onProgress, signal })` |
| `ragSaveEmbeddings`                        | `ingest` with `{ id, spaceId, chunks: [{ content, embedding }] }`; no port needed                                                                    |
| `ragChunk`                                 | `ingest` chunks text itself; for chunks only, use `rag-extract/chunk`                                                                                |
| `ragSearch`                                | `search({ scope: { namespace }, query, k })`, or `{ vector, spaceId }` instead of `query`                                                            |
| `ragDeleteEmbeddings`                      | `deleteDocuments({ namespace, documentIds })`                                                                                                        |
| `ragReindex`                               | not needed; the index follows every write and rebuilds itself                                                                                        |
| `ragCloseWorkspace`                        | `rag.close()`, then `corestore.close()`                                                                                                              |
| `ragListWorkspaces` / `ragDeleteWorkspace` | list or delete your Corestore folders                                                                                                                |

</details>

Removed with the functions:

- Types: `RagSearchResult`, `RagSaveEmbeddingsResult`, `RagReindexResult`, `RagEmbeddedDoc`, `RagDoc`, `RagWorkspaceInfo`, `RagCloseWorkspaceParams`, `RagDeleteWorkspaceParams`, `RagIngestStage`, `RagReindexStage` and `RagSaveStage`.
- Errors: `RAG_ERROR_CODES`, `RAGWorkspaceBusyError`, and the server error codes `RAG_SAVE_FAILED` (52800) through `RAG_WORKSPACE_BUSY` (52812).
- `cancel({ modelId, kind: 'rag' })`: `'rag'` is no longer a cancel kind.
- The `ragTurbovec` config key.
- The `rag:hyperdb` log namespace (`RAG_NAMESPACE` in `@qvac/inference`).
- `@qvac/inference` no longer depends on `@qvac/rag`. Install `@qvac/rag` yourself to keep using it.

The vector index API (`createVectorIndex`, `loadVectorIndex`) stays.

---

## Move the SDK onto the fabric 0.34 addon set

PRs: [#5880](https://github.com/tetherto/qvac/pull/5880), [#5942](https://github.com/tetherto/qvac/pull/5942), [#6024](https://github.com/tetherto/qvac/pull/6024)

0.24.0 shipped the fabric 0.28 addon set. Every addon now runs on `@qvac/fabric` `^0.34.0` and loads its backends from the shared fabric runtime, the speech addons included (`@qvac/asr-ggml`, `@qvac/tts-ggml`, `@qvac/audiogen-ggml`, `@qvac/bci-whispercpp`). Fabric minors are not ABI-compatible, and every addon in one process must resolve the same one, so upgrade the addons together. RPC is on protocol 119: a remote `@qvac/ggml-rpc-server` host must run 0.12.1 or newer to serve this client.

| Addon                       | 0.24.0    | 0.25.0    |
| --------------------------- | --------- | --------- |
| `@qvac/asr-ggml`            | `^0.12.0` | `^0.14.1` |
| `@qvac/audiogen-ggml`       | `^0.10.1` | `^0.12.1` |
| `@qvac/bci-whispercpp`      | `^0.15.0` | `^0.17.1` |
| `@qvac/classification-ggml` | `^0.36.0` | `^0.43.1` |
| `@qvac/diffusion-cpp`       | `^0.35.0` | `^0.38.0` |
| `@qvac/embed-llamacpp`      | `^0.56.0` | `^0.59.1` |
| `@qvac/ggml-rpc-server`     | `^0.9.0`  | `^0.12.1` |
| `@qvac/llm-llamacpp`        | `^0.70.0` | `^0.73.1` |
| `@qvac/ocr-ggml`            | `^0.33.0` | `^0.36.1` |
| `@qvac/translation-nmtcpp`  | `^0.25.0` | `^0.28.1` |
| `@qvac/tts-ggml`            | `^0.15.0` | `^0.17.2` |
| `@qvac/turbovec-ggml`       | `^0.5.0`  | `^0.8.1`  |
| `@qvac/vla-ggml`            | `^0.36.0` | `^0.39.1` |

Mobile apps pin the fabric platform packages to the same version, and an app that only uses speech needs them too.

**BEFORE:**

```json
{
  "@qvac/fabric-android-arm64": "0.28.0",
  "@qvac/fabric-ios": "0.28.0"
}
```

**AFTER:**

```json
{
  "@qvac/fabric-android-arm64": "0.34.0",
  "@qvac/fabric-ios": "0.34.0"
}
```

A model loaded with `parallel >= 2` and `ctx_size: 0` now gives each request a `parallel`-th of the auto-fitted context. An unset `ctx_size` uses the 1024-token default and splits as before. Set `ctx_size` to `parallel ×` the per-request size to keep the old size.

**BEFORE:**

```typescript
// parallel: 4 on a model trained on 32768 tokens: each request gets 32768
await loadModel({ modelSrc, modelType: 'llm', modelConfig: { parallel: 4, ctx_size: 0 } })
```

**AFTER:**

```typescript
// with ctx_size: 0 each request gets 8192; this keeps it at 32768
await loadModel({ modelSrc, modelType: 'llm', modelConfig: { parallel: 4, ctx_size: 4 * 32768 } })
```

Cache files saved with `parallel >= 2` by this version can't be restored by older ones. A MegaLoc load with an explicit OpenCL `backend` now fails, so omit `backend` or pick another device. `spec_type: 'draft-dflash'` now drafts 5 tokens per step instead of 3 when `spec_draft_n_max` is unset, as llama-server does since fabric 0.33. Set `spec_draft_n_max: 3` to keep the old default. `'draft-mtp'` still defaults to 3.

---

## Python and Kotlin clients

Hand-added from the published-version audit. The clients ship at the SDK's version and have no changelog of their own.

### Python client

The RAG request is removed with the SDK's RAG API (PR [#5874](https://github.com/tetherto/qvac/pull/5874)): the `rag` and `rag_with_progress` stubs, the `RagRequest` / `RagResponse` models and `RagWorkspaceBusyError` are gone. The package now needs `pydantic>=2.7` (was `>=2.6`).

**BEFORE:**

```python
from tetherto.qvac_sdk import RagRequest, rag

response = await rag(client.transport, RagRequest.model_validate({...}))
```

**AFTER:**

```python
# Embed with `embed` and search with `vector_index`; examples/rag_turbovec_ivf.py shows the whole flow.
from tetherto.qvac_sdk import EmbedRequest, VectorIndexRequest, embed, vector_index
```

### Kotlin client

`client.retrieval` and `QvacRetrieval` are removed with the SDK's RAG API (PR [#5874](https://github.com/tetherto/qvac/pull/5874)), together with the generated `RagRequest`, `RagResponse` and `RagProgressResponse` types.

**BEFORE:**

```kotlin
val response = client.retrieval.execute(request) // request: RagRequest
```

**AFTER:**

```kotlin
// Embed with the SDK and search with client.vectorIndex(...); examples/src/RagTurbovecIvf.kt shows the whole flow.
val found = client.vectorIndex(
    VectorIndexRequest.Search(VectorIndexRequestSearch(indexId = indexId, queries = listOf(queryVector), k = 5)),
) as VectorIndexResponse.Search
```

---
