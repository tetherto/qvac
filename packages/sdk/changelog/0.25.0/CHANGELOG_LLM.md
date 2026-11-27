# QVAC SDK v0.25.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.25.0

QVAC SDK 0.25.0 makes a shared runtime safer to hand to several callers: it reports the capability contracts it serves, limits a session to the permissions it was granted, and enforces deadlines on requests. It adds stereo depth, IVF search on vector indexes, Core ML paths for Stable Diffusion, Qwen3.5 and TranscribePsy EU, and new translation packs. The RAG API is removed in favor of the standalone `@qvac/rag` package, and every addon moves to the fabric 0.34 set. The Python and Kotlin clients ship at the same version and their changes are listed under their own headings.

## Breaking Changes

### The RAG API is removed

`ragChunk`, `ragIngest`, `ragSaveEmbeddings`, `ragSearch`, `ragDeleteEmbeddings`, `ragReindex`, `ragListWorkspaces`, `ragCloseWorkspace` and `ragDeleteWorkspace` are removed. Retrieval now lives in the standalone `@qvac/rag` package, which you install and drive yourself. The SDK no longer bundles it.

**Before:**

```typescript
import { ragIngest, ragSearch } from '@qvac/sdk'

await ragIngest({ modelId, workspace: 'docs', documents })
const hits = await ragSearch({ modelId, workspace: 'docs', query, topK: 5 })
```

**After:**

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

`@qvac/rag` takes its embeddings through a port: any object with `space`, `embedDocuments` and `embedQuery`. You can back it with `embed` and `embedBatch`, with a remote API, or skip it by ingesting vectors you computed yourself.

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

Each removed function has a counterpart in `@qvac/rag` 0.11:

| Removed                                    | `@qvac/rag`                                                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ragIngest`                                | `ingest({ namespace, documents: [{ id, text }] })`; `chunkOpts` moves to `createRag({ chunking })`, `onProgress` to `ingest(params, { onProgress })` |
| `ragSaveEmbeddings`                        | `ingest` with `{ id, spaceId, chunks: [{ content, embedding }] }`; no port needed                                                                    |
| `ragChunk`                                 | `ingest` chunks text itself; for chunks only, use `rag-extract/chunk`                                                                                |
| `ragSearch`                                | `search({ scope: { namespace }, query, k })`, or `{ vector, spaceId }` instead of `query`                                                            |
| `ragDeleteEmbeddings`                      | `deleteDocuments({ namespace, documentIds })`                                                                                                        |
| `ragReindex`                               | Not needed. The index follows every write and rebuilds itself                                                                                        |
| `ragCloseWorkspace`                        | `rag.close()`, then `corestore.close()`                                                                                                              |
| `ragListWorkspaces` / `ragDeleteWorkspace` | List or delete your Corestore folders                                                                                                                |

`@qvac/rag` stores its data in a Corestore that you create and close. A Corestore locks its folder, so keep one per storage folder and share it inside the process.

These are removed with the functions:

- The `Rag*` types, `RAG_ERROR_CODES`, `RAGWorkspaceBusyError`, and the error codes `RAG_SAVE_FAILED` (52800) through `RAG_WORKSPACE_BUSY` (52812).
- The `'rag'` cancel kind, the `ragTurbovec` config key, and the `rag:hyperdb` log namespace.

The vector index API (`createVectorIndex`, `loadVectorIndex`) stays.

### Every addon runs on fabric 0.34

0.24.0 shipped the fabric 0.28 addon set. This release moves every addon to `@qvac/fabric` `^0.34.0`. The speech addons (`@qvac/asr-ggml`, `@qvac/tts-ggml`, `@qvac/audiogen-ggml`, `@qvac/bci-whispercpp`) no longer ship their own ggml build and load their backends from the shared fabric runtime too. Every addon in one process must resolve the same fabric minor, so upgrade the addons together. RPC is on protocol 119: a remote `@qvac/ggml-rpc-server` host must run 0.12.1 or newer to serve this client.

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

Mobile apps pin the fabric platform packages to the same version, and an app that only uses speech now needs them as well.

**Before:**

```json
{
  "@qvac/fabric-android-arm64": "0.28.0",
  "@qvac/fabric-ios": "0.28.0"
}
```

**After:**

```json
{
  "@qvac/fabric-android-arm64": "0.34.0",
  "@qvac/fabric-ios": "0.34.0"
}
```

The new addon set changes four behaviors:

- A model loaded with `parallel >= 2` and `ctx_size: 0` gives each request a `parallel`-th of the auto-fitted context. An unset `ctx_size` uses the 1024-token default and splits as before. Set `ctx_size` to `parallel` times the per-request size to keep the old size.
- Cache files saved with `parallel >= 2` by this version cannot be restored by older versions.
- A MegaLoc load with an explicit OpenCL `backend` fails. Omit `backend` or pick another device.
- `spec_type: 'draft-dflash'` drafts 5 tokens per step instead of 3 when `spec_draft_n_max` is unset. Set `spec_draft_n_max: 3` to keep the old default. `'draft-mtp'` still defaults to 3.

**Before:**

```typescript
// parallel: 4 on a model trained on 32768 tokens: each request gets 32768
await loadModel({ modelSrc, modelType: 'llm', modelConfig: { parallel: 4, ctx_size: 0 } })
```

**After:**

```typescript
// with ctx_size: 0 each request gets 8192; this keeps it at 32768
await loadModel({ modelSrc, modelType: 'llm', modelConfig: { parallel: 4, ctx_size: 4 * 32768 } })
```

### Model fit is judged on shared memory

A model's `status` from `assessModelFit` now includes a shared-pool check. When its device rows share one memory pool, such as a Metal GPU or an integrated GPU plus the CPU, and together take more than 90% of that pool's free memory, the model is `does-not-fit` even when each device fits alone. A row alone in its pool, such as a discrete GPU, keeps the engine's answer. The load-time check uses the same rule, so `modelFitPolicy: 'refuse'` now refuses such a load.

**Before:**

```typescript
const { verdict, models } = await assessModelFit({
  models: [{ modelSrc: QWEN3_8_27B_MULTIMODAL_UD_Q8_K_XL, modelConfig: { ctx_size: 8192 } }]
})
// verdict 'fits', models[0].status 'fits' on a 24 GB Mac:
// MTL0 and CPU rows each fit, 19.2 GiB needed of 17.7 GiB free in the host pool
```

**After:**

```typescript
const { verdict, models } = await assessModelFit({
  models: [{ modelSrc: QWEN3_8_27B_MULTIMODAL_UD_Q8_K_XL, modelConfig: { ctx_size: 8192 } }]
})
// verdict 'does-not-fit', models[0].status 'does-not-fit', with models[0].reason naming the pool:
// the MTL0 and CPU rows share the host pool and take more than 90% of its free memory
```

### Parakeet TDT streams decode in 30-second windows

To stop words being lost between short decode windows, a Parakeet TDT push stream, such as `transcribeStream` on Parakeet TDT v3, now decodes in 30-second windows by default. An explicit `chunkMs` or `streamingChunkMs` below `30000` fails when the session starts. The size of the audio you write is independent of the decode window, so small PCM writes still work. First text arrives after one decode window plus the right lookahead, or when a shorter recording ends.

**Before:**

```typescript
const session = await transcribeStream({
  modelId,
  parakeetStreamingConfig: { chunkMs: 5000 }
})
```

**After:**

```typescript
// omit chunkMs, or set it to 30000
const session = await transcribeStream({
  modelId,
  parakeetStreamingConfig: {}
})
```

### Python client

The RAG request is removed with the SDK's RAG API: the `rag` and `rag_with_progress` stubs, the `RagRequest` and `RagResponse` models, and `RagWorkspaceBusyError` are gone. Embed with `embed` and search with `vector_index`; `examples/rag_turbovec_ivf.py` shows the whole flow. The package now needs `pydantic>=2.7`.

**Before:**

```python
from tetherto.qvac_sdk import RagRequest, rag

response = await rag(client.transport, RagRequest.model_validate({...}))
```

**After:**

```python
from tetherto.qvac_sdk import EmbedRequest, VectorIndexRequest, embed, vector_index
```

### Kotlin client

`client.retrieval` and `QvacRetrieval` are removed with the SDK's RAG API, together with the generated `RagRequest`, `RagResponse` and `RagProgressResponse` types. Embed with the SDK and search with `client.vectorIndex(...)`; `examples/src/RagTurbovecIvf.kt` shows the whole flow.

**Before:**

```kotlin
val response = client.retrieval.execute(request) // request: RagRequest
```

**After:**

```kotlin
val found = client.vectorIndex(
    VectorIndexRequest.Search(VectorIndexRequestSearch(indexId = indexId, queries = listOf(queryVector), k = 5)),
) as VectorIndexResponse.Search
```

## New APIs

### Capability contracts and runtime capabilities

`CAPABILITY_CONTRACTS` names the operations the runtime can serve as versioned contracts, such as `transcription` or `completion`. `getRuntimeCapabilities()`, on the client and on a session handle, lists the contracts the registered plugins provide, with the major version of each. It reads plugin registration only, so it loads no model. A consumer released separately from the runtime can check what it needs before it calls.

```typescript
import { CAPABILITY_CONTRACTS, getRuntimeCapabilities } from '@qvac/sdk'

const capabilities = await getRuntimeCapabilities()
// [{ id: 'transcription', version: 1, operations: ['transcribe'], partialOperations: ['transcribeStream'] }, ...]
const { id, version } = CAPABILITY_CONTRACTS.transcription
const ok = capabilities.some((c) => c.id === id && c.version === version)
```

`operations` lists what every provider of the contract implements, and `partialOperations` lists optional operations only some providers implement. A custom plugin declares its contracts with the new optional `provides` field; `CAPABILITY_CONTRACTS` is also exported from `@qvac/sdk/plugin-utils`. A contract QVAC does not define needs a dotted ID, such as `acme.diarization`, and its operation lists. A plugin without `provides` is not listed and is called as before.

### Capability grants for sessions

`openSession` takes an optional `grant`: a list of permissions, one per operation, named `<contract ID>/<operation>`, or `runtime/<operation>` for an operation the runtime serves itself. A harness can hand a session to a skill runner and limit it to, say, transcription. A session without a grant is unrestricted, as before, and an empty grant allows only operations that need no permission. The grant is fixed for the life of the session and is readable as `session.grant`.

```typescript
import { openSession, capabilityPermissions, CAPABILITY_CONTRACTS } from '@qvac/sdk'

const skills = openSession({
  name: 'skill-runner',
  grant: ['transcription/transcribe', ...capabilityPermissions(CAPABILITY_CONTRACTS.translation)]
})
await skills.transcribe({ modelId, audioChunk }) // allowed
await skills.transcribeStream({ modelId }) // CapabilityNotGrantedError
```

A grant that names a permission the runtime does not have fails the open with `SessionGrantInvalidError`. `capabilityPermissions()` lists every operation of a contract, and `RUNTIME_PERMISSION_OPERATIONS` lists the runtime's own. A permission carries no major version, and a contract that gains an optional operation does not widen an existing grant.

### Deadlines the runtime enforces

The worker can bound a request with `queueMs`, `idleMs`, `runMs` and, for a model load, `loadMs`. On a shared runtime this stops a stalled request from holding its model's slot while other sessions queue behind it. Nothing is bounded unless you set it. Set defaults in the config under `deadlines`, keyed by capability contract ID, and shorten them for one call with `rpcOptions.deadline`. A call can shorten a configured value and never lengthens it.

```typescript
const run = completion({
  modelId,
  history,
  stream: true,
  rpcOptions: { deadline: { queueMs: 10_000, idleMs: 90_000, runMs: 600_000 } }
})
// rejects with DeadlineExceededError { boundary: 'idle', timeoutMs: 90000, capability: 'completion' }
```

```json
{
  "deadlines": {
    "capabilities": {
      "default": { "queueMs": 120000, "idleMs": 60000 },
      "video-generation": { "idleMs": null }
    },
    "load": { "loadMs": 300000 }
  }
}
```

`DeadlineExceededError` (`DEADLINE_EXCEEDED`, 52425) names the boundary that passed: `queue`, `load`, `run` or `idle`. Downloads and vector index operations take no deadline.

### Stereo depth with BridgeDepth

The new `ggml-stereo-depth` model type runs BridgeDepth on a rectified left and right image pair. `estimateDisparity()` takes JPEG or PNG bytes, or packed RGB with `width`, `height` and `channels: 3`, and returns a row-major `Float32Array` disparity map at the input size. Each side must be 32 to 4096 pixels.

```typescript
import { loadModel, estimateDisparity, unloadModel } from '@qvac/sdk'

const modelId = await loadModel({
  modelSrc: '/models/bridgedepth-vits-f32.gguf',
  modelType: 'ggml-stereo-depth'
})

const { width, height, disparity, stats } = await estimateDisparity({
  modelId,
  left: fs.readFileSync('left.png'),
  right: fs.readFileSync('right.png')
})

// depth (m) = focalPx * baselineMeters / disparity
const centre = disparity[(height >> 1) * width + (width >> 1)]
await unloadModel({ modelId })
```

The plugin is exported as `@qvac/sdk/ggml-stereo-depth/plugin` (`PLUGIN_STEREO_DEPTH`) and is part of the default plugin set. `cancel({ modelId, kind: 'stereoDepth' })` drops a queued request and discards a running one's result.

### IVF search on vector indexes

A vector index search scores every stored vector, so latency grows with the index. `setIvf()` groups the entries into lists, and `search()` then scans only the lists nearest each query. It trades some recall for speed: a higher `nProbe` misses fewer true neighbors and costs more.

```typescript
import { createVectorIndex, VectorIndexStorage } from '@qvac/sdk'

await using index = await createVectorIndex({ dim: 768, storage: VectorIndexStorage.TURBOVEC_Q4 })
await index.add({ ids, vectors })

await index.setIvf({ nLists: 64, nProbe: 8 })
console.log(index.ivf) // { nLists: 64, nProbe: 8, built: true }

const hits = await index.search({ query, k: 10 })
const wider = await index.search({ query, k: 10, nProbe: 32 }) // per-call override

await index.setIvf(null) // back to a full scan
```

An add or a remove sets `ivf.built` to `false`, and searches scan every vector until the next `setIvf()`. Snapshots do not save the setting, so IVF is off on every new or loaded index.

### Why a model fit is unknown

Each model result from `assessModelFit` now carries a `reason` when its status is `unknown`, and when it is `does-not-fit` because devices sharing one pool overflow it. A load the engine cannot assess, such as a companion file on its own, throws `MODEL_FIT_REJECTED` (52213).

```typescript
const result = await assessModelFit({
  models: [
    { modelSrc: TTS_EN_SUPERTONIC_Q8_0, modelConfig: { ttsEngine: 'supertonic', language: 'en' } }
  ]
})
result.models[0].reason // 'the engine fitter could not size this load'

try {
  await assessModelFit({ models: [{ modelSrc: MMPROJ_QWEN3_8_27B_MULTIMODAL_F16 }] })
} catch (error) {
  error.code // 52213, MODEL_FIT_REJECTED
}
```

### Ordered content parts replace history attachments

`attachments` on a history message is deprecated. Attachments are sent before the text, so the model cannot tell which image the text refers to. Ordered `content` parts keep each image where you place it. Requests that use `attachments` still work and log one deprecation warning.

```typescript
// Deprecated: every image is sent before the text
{ role: 'user', content: 'Compare these.', attachments: [{ path: a }, { path: b }] }

// Ordered parts: each image stays where the text refers to it
{
  role: 'user',
  content: [
    { type: 'text', text: 'Compare ' },
    { type: 'media', path: a },
    { type: 'text', text: ' with ' },
    { type: 'media', path: b }
  ]
}
```

### Language models: Core ML FFN and new speculative decoding types

Qwen3.5 can run part of each prompt-processing FFN through a Core ML sidecar on macOS and iOS, with decode on Metal. The first load exports and compiles the sidecar.

```typescript
const modelId = await loadModel({
  modelSrc: QWEN3_5_2B_MULTIMODAL_Q4_K_M,
  modelType: 'llm',
  modelConfig: {
    'coreml-ffn': true,
    'coreml-ffn-cache': '/path/to/app/cache/coreml-ffn', // optional
    'coreml-ffn-split': '3072x1' // optional override of the automatic split
  }
})
```

`spec_type` accepts `'draft-dspark'`, and `'auto'` to read the type from the draft model. Both need a `draftModelSrc`, and so does `'draft-dflash'`; a load without one is now rejected before the model downloads.

```typescript
const modelId = await loadModel({
  modelSrc: DEEPSEEK_V4_1_552B_A16B_MULTIMODAL_Q4_K_M_SHARD,
  modelType: 'llm',
  modelConfig: {
    spec_type: 'draft-dspark', // or 'auto'
    draftModelSrc: DEEPSEEK_V4_1_552B_A16B_DSPARK_Q8_0
  }
})
```

### Image and video generation

Stable Diffusion 1.x and 2.x, SDXS included, can run the UNet and the tiny-autoencoder decoder on Core ML on macOS and iOS. `taesdModelSrc` works on every platform.

```typescript
const modelId = await loadModel({
  modelSrc: SD_V2_1_1B_Q8_0,
  modelType: 'diffusion',
  modelConfig: {
    prediction: 'eps', // the SD 2.1-base sidecar predicts epsilon
    coremlUnetModelSrc: '/models/sd21base_unet_p6.mlmodelc',
    taesdModelSrc: '/models/taesd.safetensors',
    coremlTaeDecoderModelSrc: '/models/taesd_decoder.mlmodelc'
  }
})
```

The diffusion addon now picks faster settings for supported model and GPU pairs on its own. `performance_profile: 'off'` keeps the baseline settings. The three `performance_max_*` limits declare the largest video output and must be set together.

```typescript
const modelId = await loadModel({
  modelSrc: LTX_2_3_22B_Q5_K_M,
  modelType: 'diffusion',
  modelConfig: {
    mode: 'video',
    // ...LTX-2 companion sources
    performance_profile: 'auto', // the default
    performance_max_width: 512,
    performance_max_height: 320,
    performance_max_frames: 97
  }
})
```

### Translation: TranslatePsy-AfriNano and -EuroNano

The multilingual Bergamot packs TranslatePsy-AfriNano and TranslatePsy-EuroNano load without workarounds. The vocabulary is found beside the model, the Amharic, Hausa, Igbo, Lingala, Somali, Swahili, Yoruba and Zulu language codes are accepted, and the `##<TO>` target tag an English-to-X pack needs is added for you.

```typescript
import { loadModel, translate } from '@qvac/sdk'

// Local Hugging Face download: vocab.spm is found beside the model, ##SW is added for you.
const modelId = await loadModel({
  modelSrc: '/models/TranslatePsy-AfriNano/en-xx/Base/intgemm/model.intgemm.alphas.bin',
  modelType: 'nmt',
  modelConfig: { engine: 'Bergamot', from: 'en', to: 'sw' }
})

// A renamed or bundled copy of an en-xx pack: opt in explicitly.
await loadModel({
  modelSrc: '/app/assets/afri-en/model.intgemm.alphas.bin',
  modelType: 'nmt',
  modelConfig: { engine: 'Bergamot', from: 'en', to: 'yo', targetTag: true }
})
```

### Transcription: TranscribePsy EU on Core ML

On macOS and iOS, `PARAKEET_TRANSCRIBEPSY_250M_EU_Q8_0` now stages its published Core ML bundles beside the GGUF. The new `decoderUsedCoreml` stat reports whether the run decoded on Core ML, and `ASR_BACKEND_IDS` gains `WebGPU` (5).

```typescript
import { loadModel, transcribe, PARAKEET_TRANSCRIBEPSY_250M_EU_Q8_0 } from '@qvac/sdk'

const modelId = await loadModel({
  modelSrc: PARAKEET_TRANSCRIBEPSY_250M_EU_Q8_0,
  modelType: 'parakeet-transcription',
  modelConfig: { language: 'auto' }
})

const call = transcribe({ modelId, audioChunk: '/path/to/recording.wav' })
const stats = await call.stats
stats?.encoderUsedCoreml // 1 when this run encoded on Core ML
stats?.decoderUsedCoreml // 1 when every transcription decoded on the Core ML decoder
```

### Python client

The Python client gains runtime capabilities, session grants and deadlines. `with_deadline()` wraps a transport, so every wrapper and generated stub works through it unchanged.

```python
from tetherto.qvac_sdk import (
    CapabilityId,
    GetRuntimeCapabilitiesRequest,
    completion,
    get_runtime_capabilities,
    with_deadline,
)

# Capability contracts the runtime provides
response = await get_runtime_capabilities(client.transport, GetRuntimeCapabilitiesRequest())
provided = {(c.id, c.version) for c in response.capabilities}
ok = (CapabilityId.transcription.value, 1) in provided

# A session limited to the listed permissions
session = await client.open_session("skill-runner", grant=["transcription/transcribe"])
session.grant  # ("transcription/transcribe",); None when unrestricted

# Deadlines the runtime enforces
bounded = with_deadline(client.transport, queue_ms=10_000, idle_ms=90_000)
run = completion(bounded, model_id=model_id, history=history)
```

The new errors are `DeadlineExceededError`, `CapabilityNotGrantedError` and `SessionGrantInvalidError`. IVF search is the `setIvf` operation of the `vector_index` request:

```python
ivf_set = await vector_index(
    client.transport,
    VectorIndexRequest.model_validate(
        {
            "type": "vectorIndex",
            "operation": "setIvf",
            "indexId": index_id,
            "ivf": {"nLists": 4, "nProbe": 1},
        }
    ),
)
ivf_set.root.ivf  # n_lists, n_probe, built
```

### Kotlin client

The Kotlin client gains the same three features, and each request type that registers work takes a `deadline`.

```kotlin
import io.tether.qvac.sdk.declares
import io.tether.qvac.sdk.generated.schema.CapabilityId
import io.tether.qvac.sdk.openSession
import io.tether.qvac.sdk.system

// Capability contracts the runtime provides
val capabilities = client.system.runtimeCapabilities()
val ok = capabilities.declares(CapabilityId.TRANSCRIPTION, 1L)

// A session limited to the listed permissions
val session = client.openSession(name = "skill-runner", grant = listOf("transcription/transcribe"))
session.grant // null when unrestricted

// Deadlines the runtime enforces
val request = CompletionStreamRequest(
    modelId = modelId,
    history = history,
    deadline = RequestDeadline(queueMs = 10_000, idleMs = 90_000),
)

// IVF search on a vector index
val ivfSet = client.vectorIndex(
    VectorIndexRequest.SetIvf(
        VectorIndexRequestSetIvf(indexId = indexId, ivf = VectorIndexIvfSettings(nLists = 4, nProbe = 1)),
    ),
) as VectorIndexResponse.SetIvf
```

`QvacAttachment`, `QvacMessage.attachments` and `QvacMessage.user(content, attachments)` are deprecated in favor of ordered parts, and `QvacCapability.STEREO_DEPTH` is added to the runtime profile.

```kotlin
QvacMessage.user(
    listOf(
        QvacContentPart.Text("Compare "),
        QvacContentPart.Media(a),
        QvacContentPart.Text(" with "),
        QvacContentPart.Media(b),
    ),
)
```

## Features

- **Malformed tool calls are recovered.** Tool-call arguments are repaired against the tool's schema before validation: an object sent as a JSON string, a wrapped `arguments` key, and scalar or enum values that only differ in form. Bare `<function=NAME>` blocks for declared tools are recovered in the hermes and qwen35 dialects. A call followed by more prose, in dialects whose template ends the turn at a call, is shown as text and not run.
- **Vector index calls can be cancelled.** `cancel({ requestId })` or a session close now removes a queued vector index call and stops a running search. A mutation that has started runs to the end. A cancelled call rejects with `InferenceCancelledError`.
- **More models are sized by `assessModelFit`.** MobileNet classification, MegaLoc image embeddings and BridgeDepth now return a verdict instead of `unknown`. A relative model path is resolved before it is sized, and a downloaded catalog model is sized from its files.

## Bug Fixes

- `unloadModel({ clearStorage: true })` on a sharded model loaded from a local path removed the whole folder. It now removes only the model's own files.
- On Windows, a sharded HTTP model URL with `..\` segments in a shard name could be written outside the model cache. Such a name is now refused with `PathTraversalError` before any request.
- A KV cache file the addon cannot load used to fail every completion on that key. The file is now removed so the next request starts cold, and an oversized file raises `ContextOverflowError`.
- Large base64 fields, such as a 512x512 VLA camera image, could fail validation or throw a `RangeError`. Base64 is now checked in one pass with no size limit from the regex engine.
- A cached registry model that fails its size or checksum check is downloaded again, and the reason is now logged as a warning that names the file.
- The registry client printed its log to the console regardless of `loggerConsoleOutput`. It now prints only when that setting is on.
- When the worker failed before it signalled ready, `WorkerStartupError` said only that it failed. Its message now includes the worker's own error.
- The model fit check now passes `image-max-megapixels` to the language model fitter, so the fit request carries the same image limit as the load.
- `npm install @qvac/sdk` could fail with `ERESOLVE` after `bare-stow-target-react-native@0.3.1` was published, because that version needs a newer `bare-stow` than the SDK pins. The SDK now pins `bare-stow-target-react-native` to `0.3.0`.

## Model Changes

### Added

**Language models**

- `BOTPSY_0_8B_TOOL_CALLING_BF16`
- `BOTPSY_0_8B_TOOL_CALLING_Q4_K_M`
- `BOTPSY_0_8B_TOOL_CALLING_Q8_0`
- `DEEPSEEK_V4_1_552B_A16B_MULTIMODAL_Q4_K_M_SHARD`
- `MMPROJ_DEEPSEEK_V4_1_552B_A16B_MULTIMODAL_F16`
- `DEEPSEEK_V4_1_552B_A16B_DSPARK_Q8_0` (DSpark draft model)
- `QVAC_QWEN3_5_9B_TOOL_CALLING_Q4_K_M`
- `INKLING2_MINI_26B_A3B_MULTIMODAL_UD_Q4_K_M`
- `MMPROJ_INKLING2_MINI_26B_A3B_MULTIMODAL_F16`
- `INKLING2_MINI_26B_A3B_DSPARK_Q8_0` (DSpark draft model)
- `INKLING2_MINI_26B_A3B_DFLASH2_Q8_0` (DFlash2 draft model)
- `TERNARY_BONSAI_2_5_27B_MULTIMODAL_Q2_0` (pairs with the existing `MMPROJ_TERNARY_BONSAI_2_27B_MULTIMODAL_Q8_0`)
- `TERNARY_BONSAI_2_5_27B_MTP_Q2_0` (external MTP head)

**Image generation**

- `MOSS_IMAGE_SFT_5B_BF16`
- `MOSS_IMAGE_SFT_TOKENIZER`
- `MOSS_IMAGE_VAE`
- `TAESD_VAE`
- `TAESDXL_VAE`

Constants for models QVAC trains now start with `QVAC_`. No existing constant was renamed or removed.
