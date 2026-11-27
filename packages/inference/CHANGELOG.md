# Changelog

## [0.25.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/inference/v/0.25.0

QVAC Inference 0.25.0 is the engine `@qvac/sdk@0.25.0` depends on. The runtime now reports the capability contracts it serves, limits a session to the permissions it was granted, and enforces deadlines on requests. It adds stereo depth, IVF search on vector indexes, Core ML paths for Stable Diffusion, Qwen3.5 and TranscribePsy EU, and new translation packs. The RAG API is removed in favor of the standalone `@qvac/rag` package, and every addon moves to the fabric 0.33 set.

## Breaking Changes

### The RAG API is removed

`ragChunk`, `ragIngest`, `ragSaveEmbeddings`, `ragSearch`, `ragDeleteEmbeddings`, `ragReindex`, `ragListWorkspaces`, `ragCloseWorkspace` and `ragDeleteWorkspace` are removed. Retrieval now lives in the standalone `@qvac/rag` package, which you install and drive yourself. `@qvac/inference` no longer depends on it.

**Before:**

```typescript
import { ragIngest, ragSearch } from '@qvac/inference'

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
import { embed, embedBatch, loadModel, GTE_LARGE_FP16 } from '@qvac/inference'
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
- The `'rag'` cancel kind, the `ragTurbovec` config key, and the `rag:hyperdb` log namespace (`RAG_NAMESPACE`).

The vector index API (`createVectorIndex`, `loadVectorIndex`) stays.

### Every addon runs on fabric 0.33

0.24.0 shipped the fabric 0.28 addon set. This release moves every addon to `@qvac/fabric` `^0.33.0`. The speech addons (`@qvac/asr-ggml`, `@qvac/tts-ggml`, `@qvac/audiogen-ggml`, `@qvac/bci-whispercpp`) no longer ship their own ggml build and load their backends from the shared fabric runtime too. Every addon in one process must resolve the same fabric minor, so upgrade the addons together.

| Addon                       | 0.24.0    | 0.25.0    |
| --------------------------- | --------- | --------- |
| `@qvac/asr-ggml`            | `^0.12.0` | `^0.14.0` |
| `@qvac/audiogen-ggml`       | `^0.10.1` | `^0.12.0` |
| `@qvac/bci-whispercpp`      | `^0.15.0` | `^0.17.0` |
| `@qvac/classification-ggml` | `^0.36.0` | `^0.43.0` |
| `@qvac/diffusion-cpp`       | `^0.35.0` | `^0.38.0` |
| `@qvac/embed-llamacpp`      | `^0.56.0` | `^0.59.0` |
| `@qvac/ggml-rpc-server`     | `^0.9.0`  | `^0.12.0` |
| `@qvac/llm-llamacpp`        | `^0.70.0` | `^0.73.0` |
| `@qvac/ocr-ggml`            | `^0.33.0` | `^0.36.0` |
| `@qvac/translation-nmtcpp`  | `^0.25.0` | `^0.28.0` |
| `@qvac/tts-ggml`            | `^0.15.0` | `^0.17.0` |
| `@qvac/turbovec-ggml`       | `^0.5.0`  | `^0.8.0`  |
| `@qvac/vla-ggml`            | `^0.36.0` | `^0.39.0` |

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
  "@qvac/fabric-android-arm64": "0.33.0",
  "@qvac/fabric-ios": "0.33.0"
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

## New APIs

### Capability contracts and runtime capabilities

`CAPABILITY_CONTRACTS` names the operations the runtime can serve as versioned contracts, such as `transcription` or `completion`. `getRuntimeCapabilities()` lists the contracts the registered plugins provide, with the major version of each. It reads plugin registration only, so it loads no model. A consumer released separately from the runtime can check what it needs before it calls.

```typescript
import { CAPABILITY_CONTRACTS, getRuntimeCapabilities } from '@qvac/inference'

const capabilities = await getRuntimeCapabilities()
// [{ id: 'transcription', version: 1, operations: ['transcribe'], partialOperations: ['transcribeStream'] }, ...]
const { id, version } = CAPABILITY_CONTRACTS.transcription
const ok = capabilities.some((c) => c.id === id && c.version === version)
```

`operations` lists what every provider of the contract implements, and `partialOperations` lists optional operations only some providers implement. A custom plugin declares its contracts with the new optional `provides` field. A contract QVAC does not define needs a dotted ID, such as `acme.diarization`, and its operation lists. A plugin without `provides` is not listed and is called as before.

### Capability grants for sessions

The `openSession` request takes an optional `grant`: a list of permissions, one per operation, named `<contract ID>/<operation>`, or `runtime/<operation>` for an operation the runtime serves itself. A session without a grant is unrestricted, as before. An empty grant allows only operations that need no permission. A grant that names a permission the runtime does not have fails the open with `SessionGrantInvalidError`, and a call outside the grant fails with `CapabilityNotGrantedError`.

```typescript
import {
  capabilityPermissions,
  CAPABILITY_CONTRACTS,
  RUNTIME_PERMISSION_OPERATIONS
} from '@qvac/inference'

// One permission per operation of a contract
const grant = [
  'transcription/transcribe',
  ...capabilityPermissions(CAPABILITY_CONTRACTS.translation)
]
```

A permission carries no major version, and a contract that gains an optional operation does not widen an existing grant.

### Deadlines the runtime enforces

The runtime can bound a request with `queueMs`, `idleMs`, `runMs` and, for a model load, `loadMs`. Nothing is bounded unless you set it. Set defaults in the config under `deadlines`, keyed by capability contract ID, and shorten them for one request with the request's `deadline` field. A request can shorten a configured value and never lengthens it.

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

On expiry the request fails with `DeadlineExceededError` (`DEADLINE_EXCEEDED`, 52425), whose `boundary` is `queue`, `load`, `run` or `idle`. Downloads and vector index operations take no deadline.

### Stereo depth with BridgeDepth

The new `ggml-stereo-depth` model type runs BridgeDepth on a rectified left and right image pair. `estimateDisparity()` takes JPEG or PNG bytes, or packed RGB with `width`, `height` and `channels: 3`, and returns a row-major `Float32Array` disparity map at the input size. Each side must be 32 to 4096 pixels.

```typescript
import { loadModel, estimateDisparity, unloadModel } from '@qvac/inference'

const modelId = await loadModel({
  modelSrc: '/models/bridgedepth-vits-f32.gguf',
  modelType: 'ggml-stereo-depth'
})

const { width, height, disparity, stats } = await estimateDisparity({
  modelId,
  left: leftPng, // JPEG or PNG bytes
  right: rightPng
})

// depth (m) = focalPx * baselineMeters / disparity
const centre = disparity[(height >> 1) * width + (width >> 1)]
await unloadModel({ modelId })
```

The plugin is exported as `@qvac/inference/ggml-stereo-depth/plugin` (`PLUGIN_STEREO_DEPTH`). `cancel({ modelId, kind: 'stereoDepth' })` drops a queued request and discards a running one's result.

### IVF search on vector indexes

A vector index search scores every stored vector, so latency grows with the index. `setIvf()` groups the entries into lists, and `search()` then scans only the lists nearest each query. It trades some recall for speed: a higher `nProbe` misses fewer true neighbors and costs more.

```typescript
import { createVectorIndex, VectorIndexStorage } from '@qvac/inference'

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
import { loadModel, translate } from '@qvac/inference'

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
import { loadModel, transcribeStream, PARAKEET_TRANSCRIBEPSY_250M_EU_Q8_0 } from '@qvac/inference'

const modelId = await loadModel({
  modelSrc: PARAKEET_TRANSCRIBEPSY_250M_EU_Q8_0,
  modelType: 'parakeet-transcription',
  modelConfig: { language: 'auto' }
})

const session = await transcribeStream({ modelId })
session.write(audio) // a Uint8Array of audio
session.end()
for await (const text of session) console.log(text)

const stats = await session.stats
stats?.encoderUsedCoreml // 1 when this run encoded on Core ML
stats?.decoderUsedCoreml // 1 when every transcription decoded on the Core ML decoder
```

`getModelCacheLayout` from `@qvac/inference/model-cache-layout` takes an optional `darwinMajor`, which selects the bundles the device's OS can load.

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
- The model fit check now passes `image-max-megapixels` to the language model fitter, so the fit request carries the same image limit as the load.

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

## [0.24.2]

📦 **NPM:** https://www.npmjs.com/package/@qvac/inference/v/0.24.2

Use 0.24.2 in place of 0.24.1. `@qvac/inference@0.24.1` was published without its built files (`dist`), so it installs but cannot be loaded. 0.24.2 is the same release with the files in place; the changes below are the ones 0.24.1 was meant to deliver.

QVAC Inference 0.24.2 keeps existing chats on their KV cache when prompt-cache sharing is turned on, including for loads that send `verbosity`, and moves the engine to `bare-https` 4. `@qvac/sdk@0.24.0` picks it up on a fresh install through its `^0.24.0` range.

## Bug Fixes

### Chats keep their KV cache when `cache_share_across_keys` is turned on

Turning on `cache_share_across_keys`, which `seedFrom` requires, used to move every chat to a new cache folder. The next turn of each existing chat missed its cache and reprocessed its whole history. The cache folder name no longer depends on that setting, so existing cache files are found with no migration.

The folder name also ignores other settings that do not change what a cache file holds. A `verbosity` sent at load counts as its default `0`, and `openclCacheDir` and `cache_ram_mib` are left out, so changing any of them later keeps the folder. A caller that puts a versioned path in `openclCacheDir` no longer replays every chat on each upgrade. A load that omits `verbosity` and one that sends it still get different folders, as in 0.24.0.

`deleteCache({ kvCacheKey, modelId })` still removes the right folder, including from a process that never loaded the model. The engine records the folder for a model under `~/.qvac/kv-cache-dir-ids/`.

### Which loads keep their folder from 0.24.0

A load with sharing off, `verbosity` omitted or `0`, and neither `openclCacheDir` nor `cache_ram_mib` keeps the folder it had on 0.24.0. That covers the SDK defaults and callers that send `verbosity: 0` on every load.

A load that already had `cache_share_across_keys` on, sent a non-zero `verbosity`, or sent `openclCacheDir` or `cache_ram_mib` moves to a new folder once. The next turn of each of its chats reprocesses the history once, and the old folder stays on disk. `deleteCache` with that model id no longer reaches it; `deleteCache` with only the `kvCacheKey` still removes it.

## Dependencies

### `bare-https` 4

The engine now depends on `bare-https@^4.0.0` and on `@qvac/tts-ggml@^0.15.2`, which made the same move, so an install still carries a single `bare-tls` version.

## [0.24.1]

📦 **NPM:** https://www.npmjs.com/package/@qvac/inference/v/0.24.1

QVAC Inference 0.24.1 keeps existing chats on their KV cache when prompt-cache sharing is turned on, including for loads that send `verbosity`, and moves the engine to `bare-https` 4. `@qvac/sdk@0.24.0` picks it up on a fresh install through its `^0.24.0` range.

## Bug Fixes

### Chats keep their KV cache when `cache_share_across_keys` is turned on

Turning on `cache_share_across_keys`, which `seedFrom` requires, used to move every chat to a new cache folder. The next turn of each existing chat missed its cache and reprocessed its whole history. The cache folder name no longer depends on that setting, so existing cache files are found with no migration.

The folder name also ignores other settings that do not change what a cache file holds. A `verbosity` sent at load counts as its default `0`, and `openclCacheDir` and `cache_ram_mib` are left out, so changing any of them later keeps the folder. A caller that puts a versioned path in `openclCacheDir` no longer replays every chat on each upgrade. A load that omits `verbosity` and one that sends it still get different folders, as in 0.24.0.

`deleteCache({ kvCacheKey, modelId })` still removes the right folder, including from a process that never loaded the model. The engine records the folder for a model under `~/.qvac/kv-cache-dir-ids/`.

### Which loads keep their folder from 0.24.0

A load with sharing off, `verbosity` omitted or `0`, and neither `openclCacheDir` nor `cache_ram_mib` keeps the folder it had on 0.24.0. That covers the SDK defaults and callers that send `verbosity: 0` on every load.

A load that already had `cache_share_across_keys` on, sent a non-zero `verbosity`, or sent `openclCacheDir` or `cache_ram_mib` moves to a new folder once. The next turn of each of its chats reprocesses the history once, and the old folder stays on disk. `deleteCache` with that model id no longer reaches it; `deleteCache` with only the `kvCacheKey` still removes it.

## Dependencies

### `bare-https` 4

The engine now depends on `bare-https@^4.0.0` and on `@qvac/tts-ggml@^0.15.2`, which made the same move, so an install still carries a single `bare-tls` version.

## [0.24.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/inference/v/0.24.0

QVAC Inference 0.24.0 is the engine `@qvac/sdk@0.24.0` depends on. It adds multimodal and image embeddings, chat seeding from an existing prompt cache, token counting, resumable downloads, a registry store that processes can share, and many new transcription, speech, music and image controls. Model fit now reports the memory each engine measured per device.

## Breaking Changes

### The home folder is passed to `initialize`

The engine no longer reads `Bare.argv` for its home folder, and `bareRuntimeVersion` is removed from its config. Pass the folder with `initialize({ homeDir })`. This is part of moving the SDK worker onto bare-stow; an app that uses `@qvac/sdk` gets it without a change.

### No system message unless you configure one

The engine no longer adds "You are a helpful assistant." to a completion that carries no system message. The model now sees exactly the history you send. To keep the previous prompt, set `modelConfig: { system_prompt: 'You are a helpful assistant.' }` at load.

### A prefill needs at least one message

`prefill: true` with an empty history used to prime the default system message. With that default gone there is nothing to prime, so the request is rejected.

**Before:**

```typescript
await completion({ modelId, history: [], tools, kvCache: true, prefill: true }).final
// primed "You are a helpful assistant." + tools
```

**After:**

```typescript
// throws RequestValidationFailedError: prefill needs at least one message
await completion({ modelId, history: [], tools, kvCache: true, prefill: true }).final

// supply the message in history...
await completion({
  modelId,
  history: [{ role: 'system', content: '...' }],
  tools,
  kvCache: true,
  prefill: true
}).final
// ...or set it at load
await loadModel({ ...options, modelConfig: { tools: true, system_prompt: '...' } })
```

### Model fit reports per-device memory

`assessModelFit` now returns what each engine addon measured: the memory every model takes on each device, and the pools the verdict was judged on. The `execution` and `policy` inputs are gone, the verdict values are renamed, and the estimator fields are removed. `@qvac/inference/model-resource-profiles` is removed.

**Before:**

```typescript
const fit = await assessModelFit({ models, execution: 'concurrent', policy })
// {
//   verdict: 'likely-fits' | 'likely-too-large' | 'unknown',
//   basis, execution, evidence, budget, floorBytes, reasons, assumptions,
//   models: [{ name, verdict, evidence, floorBytes, estimatorVersion, device, reasons }]
// }

const { fitProbe } = await getLoadedModelInfo({ modelId })
// { verdict: 'fit' | 'does-not-fit' | 'unknown', basis, engine, reason, message, plan, projection }
```

**After:**

```typescript
const fit = await assessModelFit({ models })
// {
//   verdict: 'fits' | 'does-not-fit' | 'unknown',
//   pools: [{ id, unified, usedBytes, freeBytes?, totalBytes? }],
//   models: [{
//     status: 'fits' | 'does-not-fit' | 'unknown',
//     devices: [{ id, name, unified, usedBytes, freeBytes?, totalBytes? }], // host last; [] when unknown
//     stats: { ctxSize, gpuLayers } | {}
//   }]
// }

const { fitProbe } = await getLoadedModelInfo({ modelId })
// { verdict, pools, models } for that one load
```

A custom plugin with a fitter must return the new per-model shape from `assessFit`.

**Remote RPC servers.** the RPC protocol moves from 112 to 116, and a client must match the server. Remote RPC servers need `@qvac/ggml-rpc-server` 0.9.1 or newer; a server on 0.9.0 or earlier is refused. Upgrade every remote RPC server together with this release.

```bash
npm install @qvac/ggml-rpc-server@^0.9.1
```

### EmbeddingGemma-300M constants point at the Dense-layer models

`EMBEDDINGGEMMA_300M_F32` is removed. `EMBEDDINGGEMMA_300M_BF16`, `EMBEDDINGGEMMA_300M_Q4_0` and `EMBEDDINGGEMMA_300M_Q8_0` keep their names but now resolve to the Dense-layer model files. Embeddings from the updated constants differ from those of the old files, so re-ingest any RAG workspace that was built with an earlier EmbeddingGemma-300M constant.

**Before:**

```typescript
import { EMBEDDINGGEMMA_300M_F32 } from '@qvac/inference'
```

**After:**

```typescript
import { EMBEDDINGGEMMA_300M_BF16 } from '@qvac/inference'
```

### The MobileNet classifier loads from the registry

The classifier weights are no longer bundled with the addon. Name the model when you load it.

**Before:**

```typescript
const modelId = await loadModel({ modelType: 'ggml-classification' })
```

**After:**

```typescript
import { MOBILENETV3_3CLASS_V3_FP16 } from '@qvac/inference'

const modelId = await loadModel({
  modelSrc: MOBILENETV3_3CLASS_V3_FP16,
  modelType: 'ggml-classification'
})
```

### Text and media reach the model in the order you wrote them

A user turn that mixed text and media used to be reordered: every image first, then the text joined together. The parts now reach the model in their original order, which changes the prompt of any turn that interleaves them.

**Before:** a turn with `[text A, image A, text B, image B]` reached the model as `[image A, image B, text A + text B]`.

**After:** the same turn reaches the model as `[text A, image A, text B, image B]`.

## New APIs

### Multimodal and image embeddings

EmbeddingGemma 2 embeds text, images and audio into one space, and MegaLoc embeds images for place recognition. `embedBatch` returns one vector per input, and `embed({ modelId, input })` embeds a single input.

```typescript
import {
  embedBatch,
  loadModel,
  EMBEDDINGGEMMA_2_Q8_0,
  MMPROJ_EMBEDDINGGEMMA_2_Q8_0
} from '@qvac/inference'

const modelId = await loadModel({
  modelType: 'llamacpp-embedding',
  modelSrc: EMBEDDINGGEMMA_2_Q8_0,
  modelConfig: { projectionModelSrc: MMPROJ_EMBEDDINGGEMMA_2_Q8_0 }
})

const { embedding } = await embedBatch({
  modelId,
  inputs: [
    'task: search result | query: an elephant',
    [{ media: { type: 'filePath', value: '/path/to/elephant.jpg' } }]
  ]
})
```

```typescript
// MegaLoc: one image, one vector
const megalocId = await loadModel({
  modelSrc: MEGALOC_F16,
  modelType: ModelType.ggmlImageEmbedding
})
const { embedding } = await embed({ modelId: megalocId, input: { image: jpegOrPngBytes } })
```

`embed({ text: string[] })` and `embed({ inputs })` still work but are deprecated in favour of `embedBatch`.

### Seeding a chat from an existing cache

A new conversation can start from the prompt cache of another one, so a long shared prefix such as a system prompt and tool list is evaluated once. Enable prefix sharing at load, prime a base cache, then name it with `seedFrom`.

```typescript
const modelId = await loadModel({
  modelSrc,
  modelType: 'llm',
  modelConfig: { cache_share_across_keys: true }
})

await completion({
  modelId,
  history: systemAndTools,
  stream: false,
  kvCache: 'base',
  prefill: true
}).final

completion({
  modelId,
  history: [...systemAndTools, { role: 'user', content: 'First question' }],
  stream: true,
  kvCache: 'chat-2',
  seedFrom: 'base'
})
```

### Counting tokens and limiting tool search

`calcTokens` returns how many tokens a history and tool list take on a loaded model, before you send it. Completion requests can also cap how many tool definitions one `tool_search` call loads.

```typescript
const tokens = await calcTokens({
  modelId,
  history: [{ role: 'user', content: 'Summarize this document.' }],
  tools
})

const run = completion({
  modelId,
  tools,
  toolSearch: { defaultLimit: 1, maxLimit: 2 },
  history,
  stream: true
})
```

### Ordered text and media content

History content can be a list of text and media parts.

```typescript
import { completion, type HistoryContentPart } from '@qvac/inference'

const content: HistoryContentPart[] = [
  { type: 'text', text: 'Image A: ' },
  { type: 'media', path: '/images/a.jpg' },
  { type: 'text', text: '\nImage B: ' },
  { type: 'media', path: '/images/b.jpg' },
  { type: 'text', text: '\nWhich image is a newspaper?' }
]

completion({ modelId, history: [{ role: 'user', content }], stream: true })
```

### Transcription controls and metadata

Whisper exposes prompt, GPU and diarization controls at load, and its segments report language, no-speech probability, speaker turns and token timings.

```typescript
const modelId = await loadModel({
  modelSrc: './ggml-small.bin',
  modelType: 'whisper',
  modelConfig: {
    language: 'auto',
    token_timestamps: true,
    tdrz_enable: true,
    initial_prompt: 'QVAC',
    carry_initial_prompt: true,
    contextParams: { use_gpu: true, 'main-gpu': 'dedicated' }
  }
})

for (const segment of await transcribe({ modelId, audioChunk: 'meeting.wav', metadata: true })) {
  console.log(segment.language, segment.noSpeechProb, segment.speakerTurnNext, segment.tokens)
}
```

Parakeet gains backend selection, speaker attribution, an encoder prewarm at load, and an energy-based voice activity detector that can be tuned at load or per streaming session.

```typescript
const modelId = await loadModel({
  modelSrc: PARAKEET_UNIFIED_0_6B_Q8_0,
  modelType: 'parakeet-transcription',
  modelConfig: {
    backend: 'cpu',
    prewarm: true,
    streamingEnergyVad: true,
    speakerAttribution: { modelSrc: PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0, padSegmentMs: 250 }
  }
})

for (const { speakerId, startMs, endMs, text } of await transcribe({
  modelId,
  audioChunk,
  metadata: true
})) {
  console.log(speakerId, startMs, endMs, text)
}
```

MOSS transcription accepts an explicit `backend` and reports encoder, prefill and decode timings with token counts. Voice activity events carry a `timestamp`. TranscribePsy-250M-EU (`PARAKEET_TRANSCRIBEPSY_250M_EU_Q8_0`) covers 25 European languages; set `language` to `'en'`, `'other'` or `'auto'`.

### Text-to-speech: chunked output and engine controls

`textToSpeech` results expose `chunkStream`, which yields `Int16Array` chunks as the engine produces them.

```typescript
const result = textToSpeech({ modelId, text })
for await (const chunk of result.chunkStream) {
  const sampleRate = await result.sampleRate
  play(chunk, sampleRate)
}
```

Every engine can name its backend (`backend: 'CUDA0'`) instead of asking for "the GPU". Chatterbox exposes sampling and prosody controls, Supertonic exposes chunk streaming, precision and external voices, Parler and the LavaSR enhancer can run on Core ML, CosyVoice3 takes a per-request `instruct` and returns `speechTokenIds` for replay, Audio8 can switch the cloned voice per request, and MOSS exposes token budgets and separate text and audio samplers. Stats report `firstAudioMs` and the engines' stage timings.

### Music generation: streamed and encoded output

`audioGen` results expose `chunkStream` next to the existing `audio` promise, and can return the run as an encoded file.

```typescript
const run = audioGen({ modelId, caption: 'ambient electronic music', outputFormat: 'flac' })

for await (const samples of run.chunkStream) player.write(samples)

const file = await run.encoded // undefined when no outputFormat was named
if (file) await writeFile(`track.${file.extension}`, file.data)
```

ACE-Step can name its pipeline backend and its language-model backend independently, MiniMax-Music3 can run through Core ML on macOS, and stats report `gpuFallbackReason` so a GPU fallback can be told apart from a slow run.

### Image generation

Qwen-Image-2.1-Turbo is supported, with `custom_sigmas` on the request. MOSS-Image renders from a JSON layout prompt and takes its text encoder's tokenizer through `tokenizerSrc`. FLUX.3 Image Klein is supported.

```typescript
const { outputs } = diffusion({
  modelId,
  prompt: 'A red ceramic teapot on a wooden table.',
  width: 512,
  height: 512,
  sampling_method: 'euler',
  cfg_scale: 1,
  custom_sigmas: [1, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0],
  seed: 42
})
```

### Downloads resume, and processes share the registry

Cancelling a registry download now pauses it: the blocks already fetched are kept and the next load resumes. `deleteCache({ modelSrc })` discards a paused or cached download.

```typescript
cancel({ requestId }) // pause: blocks kept, next load resumes
await deleteCache({ modelSrc: QWEN3_600M_INST_Q4.src })
```

Separate QVAC processes can share the model registry store. A registry query exposes a `requestId` so it can be cancelled, and rejects with `ModelRegistryBusyError` when another process holds the store for too long.

```typescript
import { modelRegistrySearch, cancel, ModelRegistryBusyError } from '@qvac/inference'

const search = modelRegistrySearch({ addon: 'llm' })
stopButton.onclick = () => cancel({ requestId: search.requestId })

try {
  const models = await search
} catch (err) {
  if (err instanceof ModelRegistryBusyError) console.log(err.holder, err.waitedMs)
}
```

### Hardware: AMD NPU and integrated GPU memory

`device: 'npu'` runs an LLM on the AMD XDNA NPU, and completion stats report `backendDevice: 'npu'`. `getSystemResources` reports `dedicatedMemoryTotalBytes` and `dedicatedMemoryUsedBytes` per GPU, which for an integrated GPU is its carve-out of system memory.

```typescript
const modelId = await loadModel({
  modelSrc: QWEN3_5_0_8B_MULTIMODAL_Q4_K_M,
  modelType: 'llm',
  modelConfig: { device: 'npu' }
})
```

### Vector index calibration and staged search

```typescript
import { createVectorIndex, VectorIndexStorage } from '@qvac/inference'

await using index = await createVectorIndex({ dim: 2048, storage: VectorIndexStorage.TURBOVEC_Q4 })
console.log(index.calibrated)
await index.setStagedSearch({ enabled: true })
```

The TurboVec maximum dimension is 16384, up from 1024.

## Bug Fixes

- **Completion output.** A model's stop reason is preserved, an open `<think>` block ends at a tool call, a reasoning-only answer is returned as content, and the framing newlines around reasoning and the answer are dropped.
- **Tools.** UTF-8 in tool callback results is preserved. `tool_search` loads only strong matches, and an exact tool name loads that tool alone.
- **Downloads.** Separate processes no longer corrupt or delete each other's model downloads, and `deleteCache` waits for a download the same process just cancelled. Sharded GGUF models load without a `tensors.txt` file.
- **Platforms.** Reranking runs on the CPU on Pixel phones, mobile bundles stay on Bare 1.36, and the `bare-fs` floor is raised so Windows can reopen on-disk stores.
- **Model fit.** Crash markers left by a fitter now expire.

## Model Changes

### Added

- **Embeddings:** `EMBEDDINGGEMMA_2_Q8_0`, `MMPROJ_EMBEDDINGGEMMA_2_Q8_0`, `MEGALOC_F16`, `MEGALOC_MIXED`
- **LLM:** `GLM_5_3_FLASH_320B_A18B_MULTIMODAL_Q4_K_M_SHARD`, `MMPROJ_GLM_5_3_FLASH_320B_A18B_MULTIMODAL_BF16`, `QWEN3_5_9B_DFLASH_Q8_0` (a DFlash drafter for speculative decoding with Qwen3.5 9B)
- **Transcription:** `PARAKEET_TRANSCRIBEPSY_250M_EU_Q8_0`, `PARAKEET_MOSAIC_Q4_0_Q8_0`, `PARAKEET_MOSAIC_COMPACT_Q4_0_Q8_0_Q3_K_IQ3_S`, `PARAKEET_NEMOTRON_3_DIARIZATION_Q4_K`
- **Text-to-speech:** `TTS_LM_MULTILINGUAL_AUDIO8_Q4_0`
- **Music generation:** `AUDIOGEN_ACESTEP_V15_TURBO_BF16`, `AUDIOGEN_ACESTEP_V15_TURBO_F16`
- **Classification:** `MOBILENETV3_3CLASS_V3_FP16`

### Updated

- `EMBEDDINGGEMMA_300M_BF16`, `EMBEDDINGGEMMA_300M_Q4_0` and `EMBEDDINGGEMMA_300M_Q8_0` now resolve to the Dense-layer model files. Re-ingest RAG workspaces built with the earlier files.

### Removed

- `EMBEDDINGGEMMA_300M_F32`. Use `EMBEDDINGGEMMA_300M_BF16`.

## [0.23.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/inference/v/0.23.0

QVAC Inference 0.23.0 is the engine `@qvac/sdk@0.23.0` depends on. It adds reranking with a new `llamacpp-rerank` model type, speculative decoding, prompt priming with `prefill`, finer prompt-cache control, TranscribePsy transcription, and Qwen-Image-2.1 generation and reference editing. Native addons move onto fabric 0.24, which changes the RPC protocol to 112, and vector indexing now comes from the standalone `@qvac/turbovec-ggml` addon. The model fit runs in process on every platform, and llama.cpp completions now allow parallel tool calls by default.

## Breaking Changes

### Fabric 0.24 addon set

The engine now peers on the fabric 0.24 addon set. These are `0.x` caret ranges, so every installed addon must move to its new floor, and all of them should be upgraded together:

| Package                                   | 0.22.0 floor | 0.23.0 floor |
| ----------------------------------------- | ------------ | ------------ |
| `@qvac/asr-ggml`                          | `^0.10.0`    | `^0.11.1`    |
| `@qvac/audiogen-ggml`                     | `^0.8.0`     | `^0.9.0`     |
| `@qvac/bci-whispercpp`                    | `^0.12.0`    | `^0.14.0`    |
| `@qvac/classification-ggml`               | `^0.31.1`    | `^0.34.0`    |
| `@qvac/diffusion-cpp`                     | `^0.30.0`    | `^0.31.0`    |
| `@qvac/embed-llamacpp`                    | `^0.48.1`    | `^0.53.0`    |
| `@qvac/ggml-rpc-server`                   | `^0.5.1`     | `^0.7.0`     |
| `@qvac/llm-llamacpp`                      | `^0.61.1`    | `^0.65.0`    |
| `@qvac/ocr-ggml`                          | `^0.29.1`    | `^0.31.0`    |
| `@qvac/translation-nmtcpp`                | `^0.21.1`    | `^0.23.0`    |
| `@qvac/tts-ggml`                          | `^0.13.0`    | `^0.14.0`    |
| `@qvac/turbovec-ggml` (new optional peer) | none         | `^0.3.0`     |
| `@qvac/vla-ggml`                          | `^0.32.2`    | `^0.34.0`    |
| `@qvac/rag` (dependency)                  | `^0.8.1`     | `^0.9.0`     |

`@qvac/decoder-audio` and `@qvac/langdetect-text` are unchanged. Fresh installs currently resolve `@qvac/llm-llamacpp` 0.65.1, `@qvac/embed-llamacpp` 0.53.1 and `@qvac/ggml-rpc-server` 0.7.1, patches within these floors that run Fabric 0.25 with the same RPC protocol 112. The engine no longer depends on `bare-runtime`. The fabric-based addons at these floors declare their optional mobile peers `@qvac/fabric-ios` and `@qvac/fabric-android-arm64` at `^0.24.0`, and the current 0.65.1 and 0.53.1 patches declare `^0.25.0`, so a mobile host that pins those packages must move them to match the addon versions it resolves.

RPC discovery now accepts only servers on protocol `112.0.x`; protocol 111 servers are no longer returned. Upgrade every remote RPC server together with the engine.

**Before:**

```sh
npm install @qvac/ggml-rpc-server@^0.5.1 # protocol 111
```

**After:**

```sh
npm install @qvac/ggml-rpc-server@^0.7.0 # protocol 112
```

### Vector indexing needs `@qvac/turbovec-ggml`

Vector indexing moved out of `@qvac/embed-llamacpp` into the standalone `@qvac/turbovec-ggml` addon. The engine declares it as an optional peer and loads it only when an index is created or loaded. Without it, creating or loading an index fails with an error that names the missing package.

**Before:**

```sh
npm install @qvac/inference @qvac/embed-llamacpp
```

**After:**

```sh
npm install @qvac/inference @qvac/embed-llamacpp @qvac/turbovec-ggml
```

### An explicit BCI `backendsDir` is scanned as given

With `@qvac/bci-whispercpp` `^0.14.0`, an explicit `backendsDir` is the directory scanned for the ggml backend modules on Android and Linux; the addon no longer appends `<host>/<module name>`. Without `backendsDir`, it scans the directory next to the loaded addon module, so loads that do not set it are unaffected.

**Before:**

```typescript
await loadModel({
  modelType: 'bci-whispercpp-transcription',
  modelSrc,
  modelConfig: { backendsDir: '/path/to/prebuilds' } // scanned /path/to/prebuilds/<host>/<module name>
})
```

**After:**

```typescript
await loadModel({
  modelType: 'bci-whispercpp-transcription',
  modelSrc,
  modelConfig: { backendsDir: '/path/to/prebuilds/<host>/<module name>' } // scanned as given
})
```

### Rank pooling is gone from embedding configs

`pooling: 'rank'` never produced valid embeddings, and the embedding addon now refuses it. It fails validation with `REQUEST_VALIDATION_FAILED` (50010) in `loadModel()` and in `deviceDefaults`. Use `'none'`, `'mean'`, `'cls'` or `'last'`, and load reranker models with the new `llamacpp-rerank` model type.

**Before:**

```typescript
await loadModel({ modelSrc: MODEL, modelType: 'embeddings', modelConfig: { pooling: 'rank' } })
```

**After:**

```typescript
await loadModel({ modelSrc: MODEL, modelType: 'embeddings', modelConfig: { pooling: 'mean' } })
```

### The model fit runs in process

The engine fitter now runs inside the inference process on every platform, so there is no separate fit process to ship or locate. A fitter that crashes takes the host process down with it. The next fit of the same request runs again; if that one does not finish either, later fits skip the fitter and answer `crashed` for 7 days. A fitter that hangs still answers `unknown` with reason `timeout` after 30 seconds, while its native work keeps running until it returns. Cancelling `loadModel` answers at once and stops the load before the model loads. `fitProbe.reason` no longer reports `unsupported-platform`, `spawn-failed` or `invalid-response`; without a fitter result it is `cancelled`, `crashed`, `invocation-error` or `timeout`.

**Before:**

```typescript
await loadModel({ modelSrc, modelFitPolicy: 'log' })
// Desktop: a crashing fitter killed only its child process; the load continued.
```

**After:**

```typescript
await loadModel({ modelSrc, modelFitPolicy: 'log' })
// A crashing fitter takes down the host process; the retry and 7-day skip apply on the next launch.
```

### Parallel tool calls are on by default

`completion()` and `batchCompletion()` on llama.cpp models now default `generationParams.parallel_tool_calls` to `true`, so a response with tools may carry several tool calls. Set it to `false` to keep one.

**Before:**

```typescript
const run = completion({ modelId, history, tools })
// final.toolCalls: at most one call
```

**After:**

```typescript
const single = completion({
  modelId,
  history,
  tools,
  generationParams: { parallel_tool_calls: false }
})
// final.toolCalls: at most one call; leave it unset to allow several
```

### `executeToolSearch` no longer repeats loaded schemas

Tools loaded by `tool_search` are now declared in the prompt's tools block, which is where the model looks for callable tools. The parsed `executeToolSearch` result therefore no longer carries a top-level `tools` array; read `tool_search.loaded` and look the tools up in your own inventory. After a load, `tool_choice` passes through unchanged and the tool grammar stays on. A deferred tool whose name clashes with another tool once characters outside `A-Z a-z 0-9 -` fold to `-` is no longer offered by the search, so give tools distinct names. A saved result that still has a `tools` array still loads its tools.

**Before:**

```typescript
JSON.parse(executeToolSearch(tools, { query: 'issue' }, []))
// { tool_search: { query, loaded, already_loaded }, tools: [{ ...schema }] }
```

**After:**

```typescript
JSON.parse(executeToolSearch(tools, { query: 'issue' }, []))
// { tool_search: { query, loaded, already_loaded } }
```

### A missing registry model has its own error

`modelRegistryGetModel()` now throws `ModelRegistryModelNotFoundError` (`QVAC_MODEL_REGISTRY_MODEL_NOT_FOUND`, code 53951) when the registry has no model at the given source and path. Query failures still throw `ModelRegistryQueryFailedError` (53950). The new class does not extend the old one, so code that caught not-found through `ModelRegistryQueryFailedError` or code 53950 must handle the new class too.

**Before:**

```typescript
try {
  await modelRegistryGetModel('org/missing.gguf', 'hf')
} catch (err) {
  if (err instanceof ModelRegistryQueryFailedError) handleMissing()
}
```

**After:**

```typescript
import { ModelRegistryModelNotFoundError } from '@qvac/inference/surface'

try {
  await modelRegistryGetModel('org/missing.gguf', 'hf')
} catch (err) {
  if (err instanceof ModelRegistryModelNotFoundError)
    handleMissing(err.registrySource, err.registryPath)
}
```

### One image or video generation at a time per model

Image and video generation now admit one active request per model. A `diffusion()` or `video()` call on a model that already has a generation running is rejected immediately with `RequestRejectedByPolicyError` rather than queued. Wait for the running generation, or cancel it, before starting the next one on the same model.

**Before:**

```typescript
const a = diffusion({ modelId, prompt: 'a lighthouse at dusk' })
const b = diffusion({ modelId, prompt: 'a harbour at dawn' })
await Promise.all([a.outputs, b.outputs])
```

**After:**

```typescript
const first = await diffusion({ modelId, prompt: 'a lighthouse at dusk' }).outputs
const second = await diffusion({ modelId, prompt: 'a harbour at dawn' }).outputs
```

## New APIs

### Reranking

The new `llamacpp-rerank` model type runs reranker GGUFs on the embedding addon, and `rerank()` scores documents against a query. It returns one raw score per document in input order, so compare scores within one model only. The model registry has no reranker yet: supply your own reranker GGUF as a path or URL. Each model runs one rerank at a time and queues up to 64 calls, and the returned promise carries a `requestId` for `cancel()`. The plugin is `rerankPlugin` from `@qvac/inference/llamacpp-rerank/plugin` (`PLUGIN_RERANK`, part of `BUILTIN_PLUGINS`), and the types `RerankParams`, `RerankScores`, `RerankConfig` and `RerankConfigInput` are exported.

```typescript
import { registerPlugin, loadModel, rerank, unloadModel } from '@qvac/inference'
import { rerankPlugin } from '@qvac/inference/llamacpp-rerank/plugin'

registerPlugin(rerankPlugin)

const modelId = await loadModel({ modelSrc: '/models/reranker.gguf', modelType: 'llamacpp-rerank' })
const scores = await rerank({
  modelId,
  query: 'What is the capital of France?',
  documents: ['Paris is the capital of France.', 'Plants convert sunlight into energy.']
})
await unloadModel({ modelId })
```

### Speculative decoding

LLM loads can draft tokens with the model's own multi-token-prediction head, an external MTP head, or a DFlash draft model, and the model verifies every draft, so output keeps the distribution of plain decoding. The keys are `spec_type`, `spec_draft_n_max`, `spec_draft_n_min`, `spec_draft_p_min` and `draftModelSrc`, and completion stats report `draftTokens` and `draftAcceptedTokens`. The catalog adds MTP heads and DFlash draft models to pair with Qwen models.

```typescript
const modelId = await loadModel({
  modelSrc: QWEN3_5_4B_MULTIMODAL_Q4_K_M,
  modelType: 'llm',
  modelConfig: {
    spec_type: 'draft-dflash',
    draftModelSrc: QWEN3_5_4B_DFLASH_Q8_0,
    spec_draft_n_max: 15
  }
})

const { stats } = await completion({ modelId, history }).final
console.log(stats?.draftTokens, stats?.draftAcceptedTokens)
```

### Priming a prompt with `prefill`

`prefill: true` evaluates the system prompt, history and tools into the KV cache without generating an answer, so the real question only processes its own tokens. It needs an enabled `kvCache` and cannot be combined with a forced `tool_choice`. Await `final` before sending the question.

```typescript
await completion({ modelId, history, tools, kvCache: 'chat', prefill: true }).final

const answer = await completion({
  modelId,
  history: [...history, { role: 'user', content: 'What is the weather in Lugano?' }],
  tools,
  kvCache: 'chat'
}).final
```

### Prompt-cache checkpoints and RAM cache

LLM loads control how hybrid, recurrent and sliding-window models keep prompt-cache checkpoints, and how much host RAM holds conversations the model has switched away from: `cache_checkpoints`, `cache_checkpoints_max_bytes`, `cache_checkpoint_storage` (`'memory'` or `'disk'`), `cache_checkpoint_dir` and `cache_ram_mib`. Unset keys keep the addon defaults.

```typescript
await loadModel({
  modelSrc: QWEN3_5_0_8B_MULTIMODAL_Q8_0,
  modelConfig: {
    cache_checkpoints: 2,
    cache_checkpoint_storage: 'disk',
    cache_checkpoint_dir: appCacheDir,
    cache_ram_mib: 1024
  }
})
```

### TranscribePsy transcription

Parakeet loads can run TranscribePsy, with a Core ML distribution that runs the encoder and decoder on the Neural Engine on macOS and iOS. Elsewhere the Core ML constant is refused before download and the error names the GGUF constant to use. `longFormWindowFrames` and `longFormContextFrames` (80 ms encoder frames) control how long recordings are split into overlapping windows.

```typescript
const modelId = await loadModel({
  modelSrc: PARAKEET_TRANSCRIBEPSY_250M_Q8_0,
  modelType: 'parakeet-transcription',
  modelConfig: { longFormWindowFrames: 375, longFormContextFrames: 47 }
})
const text = await transcribe({ modelId, audioChunk: 'session.wav' })
```

### Qwen-Image-2.1 generation and reference editing

Diffusion loads accept `projectionModelSrc`, the vision projector for the LLM encoder, which Qwen-Image-2.1 reference editing requires alongside `llmModelSrc`. `init_images` takes ordered reference images for models that support reference editing, including FLUX.2 and Qwen-Image-2.1. Qwen-Image-2.1 needs width and height in multiples of 32, and the registry has no Qwen-Image-2.1 constants, so load the files from your own paths.

```typescript
const modelId = await loadModel({
  modelSrc: '/models/qwen_image_2.1-Q4_K.gguf',
  modelType: 'sdcpp-generation',
  modelConfig: {
    llmModelSrc: '/models/Qwen3VL-8B-Instruct-Q4_K_M.gguf',
    projectionModelSrc: '/models/mmproj-Qwen3VL-8B-Instruct-F16.gguf',
    vaeModelSrc: '/models/qwen_image_2.1_vae_bf16.safetensors'
  }
})

const { outputs } = diffusion({
  modelId,
  prompt: 'Place the two referenced people together in one office.',
  init_images: [refA, refB],
  width: 512,
  height: 512
})
```

### CPU polling controls

Completion, embedding, decision and rerank configs accept `poll` and `pollBatch`, integers from 0 to 100. The llama.cpp addons now default to sleeping CPU workers, so GPU inference no longer busy-spins CPU threads; raise the values to trade CPU for lower wake latency.

These addon versions also change how CPU threads are split. `threads-batch` now applies only to steps that process several tokens (prompt processing, parallel decoding and speculative verification), and single-sequence generation uses `threads`. `cpu-mask` always applies to generation, and `cpu-mask-batch` inherits it when the batch thread count is unset. A config that set only `threads-batch` to size generation should set `threads` as well.

```typescript
await loadModel({
  modelSrc: '/path/to/model.gguf',
  modelType: 'llamacpp-completion',
  modelConfig: { poll: 50, pollBatch: 0 }
})
```

### Closing a log stream

`loggingStream()` takes a `signal`. Aborting it ends the stream without an error and unregisters the subscription at once, even for a model that logs nothing more. `subscribeServerLogs()`'s `unsubscribe()` and unloading a model release their subscriptions the same way. `untilAborted`, `AbortSignalLike` and `AbortableRPCOptions` are exported. Other operations still stop with `cancel`.

```typescript
import { AbortController } from 'bare-abort-controller'
import { loggingStream } from '@qvac/inference'

const controller = new AbortController()
for await (const log of loggingStream({ id: modelId }, { signal: controller.signal })) {
  console.log(log.message)
}

// elsewhere
controller.abort()
```

### Memory fit for ESRGAN and ABot-World

The diffusion fitter now assesses ESRGAN upscalers and ABot-World loads. `world.fitSteps` (default 100) sets the walk length the fit covers; it does not limit generation or retained history.

```typescript
await loadModel({
  modelSrc: ABOT_WORLD_0_5B_Q8_0,
  modelConfig: {
    mode: 'world',
    taehvModelSrc: ABOT_WORLD_0_5B_LF_TAEHV_VAE,
    sceneSrc: '/path/to/scene.safetensors',
    world: { fitSteps: 200 }
  }
})
```

## Features

The tool-call dialect is now detected from the model name first, then from the GGUF `general.architecture`, then falls back to `hermes`. A fine-tune whose name matches no known pattern gets the dialect of its architecture, so its tool calls parse; KAT-Coder-V2.5-Dev (`MOE_35B_INST_*`) moves from `hermes` to `qwen35`. The dialect is resolved once at load, and an explicit `toolDialect` still overrides it.

Vector indexing loads `@qvac/turbovec-ggml` only when an index is created or loaded, so applications that never index do not load it, and asynchronous index providers are awaited on create, load and shutdown.

## Bug Fixes

`TTS_COSYVOICE3_LLM_COSYVOICE_Q4_0` no longer needs its companion files staged by hand. It now resolves a complete companion set (Q4 LLM, Q4 flow and F16 HiFT weights, plus the shared tokenizer and English voice), downloading 0.985 GiB instead of the 2.230 GiB of the Q8 set, which is unchanged.

Loading a cached model again no longer rehashes every artifact. A digest is reused while the file's path, device, inode, size and timestamps are unchanged, and changed or replaced files are hashed again.

Decoding audio input for transcription and audio generation no longer keeps a full copy of the decoded PCM in the decoder's response.

After `tool_search` loads a deferred tool, small models such as Qwen3.5 0.8B and 4B now call the loaded tool instead of searching again, because the tool is declared in the tools block.

## Model Changes

### Added

Speculative-decoding draft models:

```
QWEN3_5_0_8B_MTP_Q4_K_M
QWEN3_5_2B_MTP_Q4_K_M
QWEN3_5_4B_MTP_Q4_K_M
QWEN3_5_9B_MTP_Q4_K_M
QWEN3_5_4B_DFLASH_Q8_0
QWEN3_8_27B_DFLASH2_Q8_0
QWEN3_8_FLASH_NEXT_177B_DFLASH2_Q8_0
```

Speech recognition (TranscribePsy):

```
PARAKEET_TRANSCRIBEPSY_250M_Q8_0
PARAKEET_TRANSCRIBEPSY_250M_COREML_Q8_0
```

### Updated

```
TTS_COSYVOICE3_LLM_COSYVOICE_Q4_0
```

No model constants were removed.

## [0.22.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/inference/v/0.22.0

QVAC Inference 0.22.0 is the engine `@qvac/sdk@0.22.0` depends on. `assessModelFit` now asks each engine's fitter instead of a shared coefficient table, a load can set `modelFitPolicy` for itself, and completions can issue parallel tool calls with nested JSON Schema still intact. MiniMax-H3 can start a video from a still, `decide()` answers typed Laya questions, and the catalog adds MOSS speech, Laya decisions, and Nemotron diarization. Native addons move onto fabric 0.22.

## Breaking Changes

### `assessModelFit` uses engine fitters

Every candidate is assessed by the engine that would run it. The `'calibration'` evidence class is gone, and so is `estimate` on the result and on each model. Under `'computed-only'`, `floorBytes` is the bound. A candidate the engine itself calls a fit can still come back `likely-too-large`: the `interactive-v1` reserve applies on top of the engine's own headroom.

**Before:**

```typescript
const result = await assessModelFit({ models })
result.evidence // 'calibration' | 'computed-only' | 'native-fit'
result.estimate // { lowerBoundBytes, upperBoundBytes }
result.models[0].estimate // same
```

**After:**

```typescript
const result = await assessModelFit({ models })
result.evidence // 'computed-only' | 'native-fit'
result.floorBytes // bound under 'computed-only'
```

### Per-load `modelFitPolicy`

Skipping the fit probe was process-wide (`QVAC_ADVISORY_MODEL_FIT=0`) and also disabled the engine verdict for `assessModelFit`. The probe is now per load. `'log'` (default) still runs it and never blocks. `'off'` skips it for that load only. `'refuse'` fails a load the engine projects will not fit.

**Before:**

```typescript
// Skipping the fit probe was process-wide, and also disabled the engine
// verdict for assessModelFit.
QVAC_ADVISORY_MODEL_FIT = 0
```

**After:**

```typescript
import { loadModel } from '@qvac/inference'

await loadModel({ modelSrc, modelType, modelFitPolicy: 'off' })
```

```json
{ "modelFitPolicy": "off" }
```

```typescript
await loadModel({
  modelSrc: GPT_OSS_20B_INST_Q4_K_M,
  modelConfig: { ctx_size: 131072, 'cache-type-k': 'f32', 'cache-type-v': 'f32' },
  modelFitPolicy: 'refuse'
})
```

```json
{
  "serve": {
    "models": {
      "big": { "model": "GPT_OSS_20B_INST_Q4_K_M", "modelFitPolicy": "refuse" }
    }
  }
}
```

### Catalog constant names

`PARAKEET_TDT_MODEL` is no longer a first-class catalog export. Load the GGUF constant instead.

**Before:**

```typescript
import { PARAKEET_TDT_MODEL } from '@qvac/inference'
```

**After:**

```typescript
import { loadModel, PARAKEET_TDT_0_6B_V3_F16 } from '@qvac/inference'

await loadModel({ modelSrc: PARAKEET_TDT_0_6B_V3_F16 })
```

### Split addons resolve `#host-addon` from the consumer manifest

bare-link resolves `DT_NEEDED` replacements only from a package's own dependencies, so fabric platform packages must be declared on the native addon consumer (`llm-llamacpp`, `embed-llamacpp`, and the other engine addons), not on application manifests. `require('@qvac/fabric/backends')` is removed. A source-built fabric no longer serves its own `prebuilds/<host>`; run `npm run link:platform` to expose the build as `node_modules/@qvac/fabric-<suffix>`.

Native consumers stop passing `SUBDIR` into `qvac_addon_finalize` and load backends through fabric:

**Before:**

```cmake
qvac_addon_finalize(${addon} SUBDIR "${BACKENDS_SUBDIR_VALUE}")
```

```cpp
ggml_backend_load_all();
```

**After:**

```cmake
qvac_addon_finalize(${addon})
```

```cpp
#include <qvac-fabric.h>
qvac_fabric_load_backends();
```

### Cached turns send the full conversation

Named KV-cache completions send the whole history every turn. `generationParams.remove_thinking_from_context` is gone. A changed tool set on a named key reuses the same cache file, trimmed where it differs. A deleted attachment now fails later cached turns, as it does uncached. `stats.promptTokens` on a cached turn counts only the tokens processed that turn; reused cache tokens are excluded.

**Before:**

```typescript
completion({
  modelId,
  history,
  kvCache: 'chat',
  generationParams: { remove_thinking_from_context: true }
})
```

**After:**

```typescript
completion({ modelId, history, kvCache: 'chat' })
```

### GPU backend selection on generated VLA configs

Generated Kotlin VLA load configs take a backend name string instead of the `LoadModelSrcRequestGgmlVlaModelConfigBackend` enum.

**Before:**

```kotlin
LoadModelSrcRequestGgmlVlaModelConfig(
    backend = LoadModelSrcRequestGgmlVlaModelConfigBackend.CPU
)
```

**After:**

```kotlin
LoadModelSrcRequestGgmlVlaModelConfig(backend = "cpu")
```

### Fabric 0.22 addon set

This cut ships the fabric 0.22 addon set. `@qvac/ggml-rpc-server` moves from `^0.1.2` (0.21.1) to `^0.5.1`.

### Bare runtime floor

`engines.bare` is `>=1.32.0`. The published 0.21.0 engine accepted `>=1.30.3`.

## New APIs

### Model fit

Where the engine reports a placement, `assessModelFit` now carries `projection.devices`: one row per device with `name`, `totalBytes`, `freeBytes`, `weightsBytes`, `contextBytes`, and `computeBytes`.

```typescript
import { assessModelFit } from '@qvac/inference'

const result = await assessModelFit({ models: [load] })
// projection.devices is present where the engine reports a placement per device
// [{ name: 'MTL0', totalBytes, freeBytes, weightsBytes, contextBytes, computeBytes }]
```

OCR and translation loads go through their engine fitters, so a result can be `'native-fit'` instead of a computed floor.

```typescript
const result = await assessModelFit({
  models: [
    {
      modelSrc: OCR_LATIN,
      modelType: 'ggml-ocr',
      modelConfig: { langList: ['en'], detectorModelSrc: OCR_CRAFT }
    }
  ]
})
// result.evidence === 'native-fit'
```

The resolved load, including LavaSR stage paths on TTS, is what the fitter sees. Diffusion video loads are projected instead of refused.

### OCR GPU selection

OCR loads can pick a ggml backend and, on multi-GPU hosts, a dedicated or integrated device.

```typescript
import { loadModel } from '@qvac/inference'

const modelId = await loadModel({
  modelSrc: OCR_LATIN,
  modelType: 'ggml-ocr',
  modelConfig: { langList: ['en'], backendDevice: 'vulkan', mainGpu: 'dedicated' }
})
```

### PCM-only bundles

decoder-audio 0.8.0 lets a bundle omit FFmpeg when the app only streams PCM. Set `includeAudioDecoder` to `false` in config.

```json
{
  "plugins": ["@qvac/sdk/whispercpp-transcription/plugin"],
  "includeAudioDecoder": false
}
```

### Parallel tool calls

llama.cpp completions can return more than one tool call in a single response. Unset or `false` keeps one.

```typescript
await completion({
  modelId,
  history,
  tools,
  generationParams: { parallel_tool_calls: true }
})
```

Nested JSON Schema on tool parameters is kept, including arrays of objects and union types.

```typescript
await completion({
  modelId,
  history,
  tools: [
    {
      type: 'function',
      name: 'plan_trip',
      description: 'Plan a trip',
      parameters: {
        type: 'object',
        properties: {
          stops: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string' } } }
          },
          budget: { type: ['number', 'null'] }
        },
        required: ['stops']
      }
    }
  ]
})
```

Past tool calls can be replayed as structured history: an assistant message with `toolCalls`, then a `tool` message with `toolCallId` and `toolName`.

```typescript
await completion({
  modelId,
  history: [
    { role: 'user', content: 'Weather in Paris?' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'Paris' } }]
    },
    { role: 'tool', content: '18C', toolCallId: 'call_1', toolName: 'get_weather' }
  ],
  tools
})
```

### MiniMax-H3 image-to-video

`video()` accepts `mode: 'img2vid'` with a first-frame `init_image`.

```typescript
const firstFrame = fs.readFileSync('first-frame.png')
const { outputs } = video({
  modelId,
  mode: 'img2vid',
  prompt: 'A sailboat glides across a calm bay.',
  init_image: firstFrame,
  width: 864,
  height: 480,
  video_frames: 22,
  fps: 24,
  cfg_scale: 1
})
```

### Vision image size cap

LLM vision loads accept `'image-max-megapixels'` in `modelConfig`. Larger images are rejected from the header before decode. Default 50.

```typescript
await loadModel({
  modelSrc: SMOLVLM2_500M_MULTIMODAL_Q8_0,
  modelConfig: {
    projectionModelSrc: MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
    'image-max-megapixels': 100
  }
})
```

### Typed decisions

`decide()` answers typed questions (choice, score, or noul) about one state or a batch of states on a `llamacpp-decision` load. `qvac serve` can expose that as System One HTTP.

```typescript
import { decide, loadModel, LAYA_MULTILINGUAL_322M_Q8_0 } from '@qvac/inference'

const modelId = await loadModel({
  modelSrc: LAYA_MULTILINGUAL_322M_Q8_0,
  modelType: 'llamacpp-decision',
  modelConfig: { device: 'cpu' }
})
const result = await decide({
  modelId,
  state: 'Please refund my duplicate payment.',
  questions: { refund: { type: 'noul', instructions: 'A refund is requested.' } }
})
```

### MOSS ASR and Nemotron diarization

MOSS transcribe loads take `transcriptionWorkload` on `assessModelFit` (`audioSeconds`, optional `hotwords`) and can return speaker labels. Nemotron Sortformer diarization on a parakeet load returns overlapping `speakerSegments` with millisecond timestamps.

```typescript
import {
  loadModel,
  transcribe,
  assessModelFit,
  MOSS_TRANSCRIBE_DIARIZE_Q8_0
} from '@qvac/inference'

await assessModelFit({
  models: [
    {
      modelSrc: MOSS_TRANSCRIBE_DIARIZE_Q8_0,
      transcriptionWorkload: { audioSeconds: 300, hotwords: ['Erin'] }
    }
  ]
})

const moss = await loadModel({ modelSrc: MOSS_TRANSCRIBE_DIARIZE_Q8_0 })
await transcribe({
  modelId: moss,
  audioChunk: 'meeting.wav',
  metadata: true,
  hotwords: ['Erin']
})

const nemotron = await loadModel({
  modelSrc: './nemotron-diarization.gguf',
  modelType: 'parakeet-transcription'
})
const segments = await transcribe({
  modelId: nemotron,
  audioChunk: 'meeting.wav',
  metadata: true
})
// segments[].speakerSegments: { speakerId, startMs, endMs }[], preserving overlap.
```

### MOSS TTS 0.11 engines

`tts-ggml` 0.11 adds `moss-sfx` (sound effects) and `moss-speech`. Sound-effect runs take `seconds` and `steps`.

```typescript
import { loadModel, textToSpeech, AUDIOGEN_MOSS_SFX_V2_Q8_0 } from '@qvac/inference'

const modelId = await loadModel({
  modelSrc: AUDIOGEN_MOSS_SFX_V2_Q8_0.src,
  modelType: 'tts-ggml',
  modelConfig: { ttsEngine: 'moss-sfx', useGPU: true }
})

const run = textToSpeech({
  modelId,
  text: 'Heavy rain falling on a tin roof.',
  stream: false,
  seconds: 2,
  steps: 20
})
const samples = await run.buffer
const sampleRate = await run.sampleRate
```

### AudioGen 0.6.0

MiniMax audiogen can be assessed before load and fails the load instead of falling back to CPU. ACE-Step runs accept per-run `shift` and return render metadata on `stats`. Edits take a timbre `referenceAudio` plus prompt metadata. `audioUnderstand` exposes the decoded `seed`.

```typescript
const fit = await assessModelFit({
  models: [
    {
      modelType: 'audiogen',
      modelConfig: { engine: 'minimax', lmModelSrc, synthModelSrc, device: 'gpu' }
    }
  ]
})

const run = audioGen({
  modelId,
  caption: 'a rainy-day lo-fi loop',
  simpleMode: true,
  shift: 1.5
})
const rendered = (await run.stats)?.metadata

const edit = audioEdit({
  modelId,
  sourceAudio,
  operations,
  referenceAudio,
  bpm: 120,
  keyscale: 'C minor'
})

const { seed } = await audioUnderstand({ modelId, sourceAudio }).description
```

### GPU backend selection for LLM, embeddings, and VLA

LLM, embedding, and VLA loads can name an ordered GPU backend list. Unset uses the native default order. Use `device: 'cpu'` for CPU.

```typescript
import { loadModel, ModelType } from '@qvac/inference'

const modelId = await loadModel({
  modelType: ModelType.llamacppCompletion,
  modelSrc: '/models/llm.gguf',
  modelConfig: { backend: 'cuda,vulkan' }
})
```

## Features

The engine fitter now sees the same resolved load `loadModel` would run, including LavaSR enhancer and denoiser paths on TTS. Diffusion video is projected instead of refused up front.

## Bug Fixes

`safe-fetch` calls the http and https request paths separately, so mixed-scheme downloads no longer share one handler.

Concurrent `assessModelFit` / `loadModel` probes await the engine fitter and share in-flight fit markers. Both probes still run; a `.running` marker this process holds is not treated as a crash.

## Model Changes

### Added

```
AUDIOGEN_MOSS_SFX_V2_F16
AUDIOGEN_MOSS_SFX_V2_Q8_0
LAYA_421M_F16
LAYA_421M_Q8_0
LAYA_MULTILINGUAL_322M_F16
LAYA_MULTILINGUAL_322M_Q8_0
LAYA_TYPED_DECISIONS_421M_F16
LAYA_TYPED_DECISIONS_421M_Q8_0
MOSS_TRANSCRIBE_DIARIZE_F16
MOSS_TRANSCRIBE_DIARIZE_Q5_0
MOSS_TRANSCRIBE_DIARIZE_Q8_0
PARAKEET_NEMOTRON_3_DIARIZATION_Q8_0
TTS_CODEC_MOSS_SPEECH_F16
TTS_DIALOGUE_MULTILINGUAL_MOSS_TTSD_F16
TTS_MOSS_SPEECH_BF16
TTS_MOSS_SPEECH_Q8_0
```

### Removed

```
PARAKEET_TDT_MODEL
```

## [0.21.1]

📦 **NPM:** https://www.npmjs.com/package/@qvac/inference/v/0.21.1

QVAC Inference 0.21.1 updates native add-on compatibility ranges to include the latest fixes.

The updated ranges accept the corrected add-ons while allowing future compatible patches.

## [0.21.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/inference/v/0.21.0

QVAC Inference 0.21.0 is the engine cut that SDK 0.21.0 will depend on. A model can split across machines through llama.cpp's RPC backend, Ternary Bonsai 2 27B runs in QVAC's engine, tools can defer their schemas behind `tool_search`, and TTS/ASR pick up MOSS plus Parakeet Core ML on Apple. Catalog constant names for BitNet, Llama tool-calling, and Indic Parakeet change. `assessModelFit` now takes `loadModel` fields instead of a separate workload object, infers `modelType` from `modelSrc` when omitted, and the load-time fit probe runs on every engine that ships a fitter.

## Breaking Changes

### `assessModelFit` uses loadModel parameters

Candidates are described the same way as a load: `modelSrc`, `modelType`, and `modelConfig`. The old `model` / `workload` / `artifacts` object is rejected.

**Before:**

```typescript
await assessModelFit({
  models: [
    {
      model: LLAMA_3_2_1B,
      workload: { kind: 'llm', contextTokens: 4096 },
      artifacts: [MMPROJ_F16]
    }
  ]
})
```

**After:**

```typescript
await assessModelFit({
  models: [
    {
      modelSrc: LLAMA_3_2_1B,
      modelType: 'llamacpp-completion',
      modelConfig: { ctx_size: 4096, projectionModelSrc: MMPROJ_F16 }
    }
  ]
})
```

`modelType` is optional and inferred from `modelSrc` when omitted, the same way `loadModel` infers it. Required only where the source names no engine. A load whose sources are all config fields may omit `modelSrc`. Audio `workload.windowMs` becomes `modelConfig.duration_ms`. `workload.batch` has no equivalent and is gone: no engine takes a batch size at load time.

### Flattened fit-probe projection

`getLoadedModelInfo().fitProbe.projection` is a flat byte breakdown. `projection.devices` and `NativeProbeDevice` are gone. Totals are summed across devices; `deviceName` names the first.

**Before:**

```typescript
info.fitProbe?.projection?.devices
```

**After:**

```typescript
info.fitProbe?.projection?.deviceBytes
info.fitProbe?.projection?.hostBytes
info.fitProbe?.projection?.weightsBytes
info.fitProbe?.projection?.contextBytes
info.fitProbe?.projection?.computeBytes
info.fitProbe?.projection?.deviceName
```

### Catalog constant names

BitNet instructed TQ2_0 exports are retagged as base. Llama tool-calling 1B moves from `Q4_K` to `Q4_K_M`. Indic Parakeet Conformer CTC constants are replaced by the 600M GGUFs.

**Before:**

```typescript
import { BITNET_0_7B_INST_TQ2_0 } from '@qvac/inference'
import { LLAMA_TOOL_CALLING_1B_INST_Q4_K } from '@qvac/inference'
import { PARAKEET_INDIC_CONFORMER_CTC_Q4_0 } from '@qvac/inference'
```

**After:**

```typescript
import { BITNET_0_7B_BASE_TQ2_0 } from '@qvac/inference'
import { LLAMA_TOOL_CALLING_1B_INST_Q4_K_M } from '@qvac/inference'
import { PARAKEET_INDIC_CONFORMER_600M_Q4_0 } from '@qvac/inference'
```

## New APIs

### Clustered inference over RPC

`startRpcServer` starts a worker-owned llama.cpp RPC server. `discoverRpcServers` finds peers on a private topic and `getRpcDeviceMap` builds the `devices` string `loadModel` expects. One model splits across several machines, phones included, by layer or within a layer. Only the initiator needs the model file.

```typescript
import {
  startRpcServer,
  stopRpcServer,
  discoverRpcServers,
  getRpcDeviceMap,
  loadModel,
  unloadModel
} from '@qvac/inference'

const server = await startRpcServer({
  host: '10.0.0.2',
  allowNonLoopbackHost: true,
  discoveryTopic: 'my-private-rpc-group'
})

const selected = (await discoverRpcServers({ topic: 'my-private-rpc-group' }))
  .sort((a, b) => a.url.localeCompare(b.url))
  .slice(0, 2)
const devices = getRpcDeviceMap(selected)
const modelId = await loadModel({
  modelSrc,
  modelConfig: {
    device: 'gpu',
    'rpc-servers': selected.map((s) => s.url).join(','),
    devices: devices.map((d) => d.alias).join(','),
    'split-mode': 'layer',
    'tensor-split': devices.map(() => '1').join(',')
  }
})
await unloadModel({ modelId })
await stopRpcServer({ serverId: server.serverId })
```

Workers bind to loopback unless `allowNonLoopbackHost` is set. The channel is unauthenticated. Prebuilds use TCP; RDMA needs client and worker rebuilt on Linux with RDMA enabled. The current limit is 16 devices.

`@qvac/inference/rpc-server-provider` and `@qvac/inference/ggml-rpc-server/provider` are new subpath exports. `registerRpcServerProvider` and `RpcServerOperationError` are on the public surface.

### Deferred tool loading

A tool may set `deferLoading: true` (or an MCP client entry, to defer all its tools). The first prompt then carries only always-loaded tools and a built-in `tool_search` whose description lists the deferred tools by name and description. When the model calls `tool_search`, run `executeToolSearch()` and push its result as a `tool` message; the matching definitions are callable from the next turn. `completion()` stays stateless and reads the loaded set back from history, so keep that message. Tools without the flag are unchanged.

```typescript
import { completion, executeToolSearch, TOOL_SEARCH_NAME } from '@qvac/inference'

const tools = [
  { name: 'get_weather', description: '...', parameters },
  {
    name: 'create_issue',
    description: 'Open a new issue on a repository',
    parameters,
    deferLoading: true,
    group: 'github'
  }
]

const run = completion({ modelId, history, tools })
history.push({ role: 'assistant', content: (await run.final).raw.fullText })
for (const call of await run.toolCalls) {
  const content =
    call.name === TOOL_SEARCH_NAME
      ? executeToolSearch(tools, call.arguments, history)
      : await runTool(call)
  history.push({ role: 'tool', content })
}

// Defer every tool an MCP client exposes
completion({ modelId, history, mcp: [{ client, deferLoading: true, group: 'github' }] })
```

New options: `deferLoading` and `group` on tools and on `McpClientInput`.
New exports: `TOOL_SEARCH_NAME`, `executeToolSearch(tools, args, history)`, `loadedToolNames(history)`, `searchDeferredTools(deferred, query, limit?)`, `buildToolSearchTool(deferred)`.

`tool_search` is reserved. `generationParams.tool_choice` cannot name a deferred tool; force `tool_search` or drop `deferLoading` from that tool.

### MOSS TTS

`tts-ggml` 0.10.0 adds the MOSS engine. MOSS-TTS-v1.5 is directable (explicit pause and duration, Pinyin/IPA, optional voice cloning). MOSS-TTSD synthesizes 1 to 5 speakers in one pass. The Delay engine streams chunks so playback can start while generation continues.

```typescript
import {
  loadModel,
  textToSpeech,
  TTS_DELAY_LLM_MOSS_TTS_F16,
  TTS_CODEC_DECODER_MOSS_TTS_F16,
  TTS_CODEC_ENCODER_MOSS_TTS_F16
} from '@qvac/inference'

const modelId = await loadModel({
  modelSrc: TTS_DELAY_LLM_MOSS_TTS_F16,
  modelType: 'tts',
  modelConfig: {
    ttsEngine: 'moss',
    mossCodecDecoderModelSrc: TTS_CODEC_DECODER_MOSS_TTS_F16,
    mossCodecEncoderModelSrc: TTS_CODEC_ENCODER_MOSS_TTS_F16,
    referenceAudioSrc: '/voices/speaker-24k.wav',
    streamChunkTokens: 25
  }
})

const result = textToSpeech({
  modelId,
  text: 'Hold on [pause 1.0s] here it comes.'
})
```

On Apple, Audio8 now stages its Core ML codec sidecar and reports `codecSidecarLoaded` / `codecOnCoreml` on synthesis stats.

### ABot-World layer streaming

World-mode `modelConfig.world` accepts `paramsBackend`, `maxVram`, `streamLayers`, and the rest of the placement fields so an ABot-World graph can stream layers the same way other diffusion loads do.

```typescript
modelConfig: {
  mode: 'world',
  world: {
    paramsBackend: 'diffusion=cpu',
    maxVram: 2,
    streamLayers: true,
    verbosity: 3
  }
}
```

### Loaded-model fit probe

`getLoadedModelInfo` can include `fitProbe`: verdict, a flat projection (`deviceBytes`, `hostBytes`, and the breakdown fields the engine filled), and the placement the fitter resolved, judged against the memory the system reports free. The probe runs on every engine that ships a fitter. `assessModelFit` model results can carry `device` and `reasons`. `fitStubBudgetMs` on config (default 40000) budgets the registry fetch of the weightless description.

### BCI stream placement and diagnostics

`bciTranscribe` terminal frames can carry `diagnostics`. Streamed BCI segments expose `windowStartTimestep` so window-local timestamps can be placed on the stream timeline.

## Features

Ternary Bonsai 2 27B (PTQ1_0 at 5.95 GB, PQ2_0 at 7.21 GB) loads through the qvac-fabric engine with the matching rotation applied at run time. CPU (x86 AVX2/VNNI, ARM, portable fallback), Metal, CUDA, HIP, and Vulkan are in scope. A load-time check refuses rotated files on architectures that cannot apply the rotation.

Parakeet GGUFs on Apple download their Core ML sidecars beside the weights. ACE-Step AudioGen packings and additional CosyVoice3 flow/hift/LLM constants are on the catalog.

Llama `gpu_layers` is unset by default so qvac-fabric can place layers to free device memory. Setting `gpu_layers` still pins the count and aborts that fit.

Hyperdrive model downloads stay inside the model cache. NMT `translate()` stats are per-request. Fused TTS export names come from registry tags. `bare-runtime` is `^1.30.3` so a retained lockfile cannot keep 1.24.x next to `engines.bare` `>=1.30.3`.

## Bug Fixes

Loaded deferred tools run under the tool-call grammar instead of text parsing on the search-to-call step.

## Model Changes

### Added

```
AUDIOGEN_ACESTEP_5HZ_LM_0_6B_BF16
AUDIOGEN_ACESTEP_V15_BASE_Q4_K_M
BITNET_0_7B_BASE_TQ2_0
BITNET_1B_BASE_TQ2_0
BITNET_B1_58_3B_BASE_TQ2_0
LLAMA_TOOL_CALLING_1B_INST_Q4_K_M
PARAKEET_INDIC_CONFORMER_600M_F16
PARAKEET_INDIC_CONFORMER_600M_Q4_0
PARAKEET_INDIC_CONFORMER_600M_Q8_0
PARAKEET_TDT_1_1B_F16
PARAKEET_TDT_1_1B_Q8_0
TERNARY_BONSAI_2_27B_MULTIMODAL_PQ2_0
TERNARY_BONSAI_2_27B_MULTIMODAL_PTQ1_0
TTS_CODEC_DECODER_MOSS_TTS_F16
TTS_CODEC_ENCODER_MOSS_TTS_F16
TTS_COSYVOICE3_FLOW_COSYVOICE_BF16
TTS_COSYVOICE3_FLOW_COSYVOICE_FP16
TTS_COSYVOICE3_FLOW_COSYVOICE_Q4_0
TTS_COSYVOICE3_FLOW_COSYVOICE_Q8_0
TTS_COSYVOICE3_HIFT_COSYVOICE_FP16
TTS_COSYVOICE3_LLM_COSYVOICE_FUSED_Q8_0
TTS_COSYVOICE3_LLM_COSYVOICE_Q4_0
TTS_DELAY_LLM_MOSS_TTS_F16
```

### Removed

```
BITNET_0_7B_INST_TQ2_0
BITNET_1B_INST_TQ2_0
BITNET_B1_58_3B_INST_TQ2_0
LLAMA_TOOL_CALLING_1B_INST_Q4_K
PARAKEET_INDIC_CONFORMER_CTC_F16
PARAKEET_INDIC_CONFORMER_CTC_Q4_0
PARAKEET_INDIC_CONFORMER_CTC_Q8_0
```

Peer floors that move with this cut: `@qvac/llm-llamacpp` `0.55.0`, `@qvac/asr-ggml` `^0.7.0`, `@qvac/tts-ggml` `^0.10.0`, `@qvac/audiogen-ggml` `^0.5.0`, `@qvac/bci-whispercpp` `^0.10.0`, `@qvac/decoder-audio` `^0.7.0`, `@qvac/translation-nmtcpp` `0.18.0`, `@qvac/ggml-rpc-server` `0.1.0`.

## [0.20.1]

📦 **NPM:** https://www.npmjs.com/package/@qvac/inference/v/0.20.1

QVAC Inference 0.20.1 is a patch on 0.20.0. It exposes the remaining llama.cpp load-time placement, MoE, fit, and image-token fields, and `assessModelFit` now runs the engine fitter on a registry fit stub instead of coefficients alone.

## New APIs

### llama.cpp placement, MoE, fit, and image-token load fields

`loadModel` for `llamacpp-completion` accepts the rest of the llama.cpp load config that 0.20.0 left off the schema: CPU placement (`threads`, `threads-batch`, `cpu-mask`, `override-tensor`), MoE offload (`cpu-moe`, `n-cpu-moe`, `n-cpu-ffn`, `moe-cache-mib`), batch sizes, KV offload, weight prefetch, tensor-read laziness, `fit` / `fit-target` / `fit-ctx`, and image token caps.

```typescript
loadModel({
  modelSrc,
  modelType: 'llamacpp-completion',
  modelConfig: {
    threads: 8,
    'threads-batch': 16,
    'cpu-mask': 'ff',
    'override-tensor': 'blk\\.(1[0-9])\\.ffn_(up|down|gate)_exps=CPU',
    'cpu-moe': true,
    'n-cpu-moe': 2,
    'n-cpu-ffn': 4,
    'moe-cache-mib': 2048,
    'batch-size': 1024,
    'ubatch-size': 256,
    'kv-offload': false,
    'prefetch-weights': 'auto',
    'tensor-read-lazy': 'on',
    fit: true,
    'fit-target': '1024,512',
    'fit-ctx': 8192,
    'image-max-tokens': 512,
    'image-min-tokens': 64
  }
})
```

### `assessModelFit` uses the engine fitter

When the registry has published a fit description for a model, `assessModelFit` runs the engine fitter on that stub and returns `evidence: 'native-fit'`. Coefficient-only projection remains the fallback when no stub is available.

```typescript
const { verdict, evidence } = await assessModelFit({
  models: [{ model: SOME_CATALOG_CONSTANT, workload: { kind: 'llm', contextTokens: 8192 } }]
})
// evidence === 'native-fit' when the registry published a description for it
```

The engine depends on `@qvac/registry-client` `^0.7.0` so `fitBlobBinding` on those stubs decodes.

## [0.20.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/inference/v/0.20.0

QVAC Inference 0.20.0 is the engine cut that SDK 0.20.0 will depend on. It adds TranslatePsy-AfriSLM translation, an in-process TurboVec vector index, MiniMax-H3 video, Parakeet Nemotron transcription, and the rest of the AudioGen and TTS surfaces. ABot-World sessions (`worldCreateScene` / `worldStep`) are on this surface. `loadModel` runs an advisory llama.cpp fit check. Diffusion VAE constant names, CPU flags, `'row'` split, Parakeet `language` codes, and how system prompts combine with KV cache all change.

Publish this package before `@qvac/sdk@0.20.0`. The SDK release points its `@qvac/inference` range at this version.

## Breaking Changes

### Diffusion CPU flags

`clip_on_cpu`, `vae_on_cpu`, and `control_net_cpu` are gone. Put the text encoder, VAE, or ControlNet on CPU through `params_backend` and `backend`. Layer streaming still needs CPU diffusion parameter residency and `max_vram`.

**Before:**

```typescript
const modelConfig = {
  clip_on_cpu: true,
  vae_on_cpu: true,
  control_net_cpu: true
}
```

**After:**

```typescript
const modelConfig = {
  params_backend: 'te=cpu,vae=cpu',
  backend: 'controlnet=cpu'
}
```

CPU layer streaming:

```typescript
const modelConfig = {
  params_backend: 'diffusion=cpu',
  max_vram: -1,
  stream_layers: true
}
```

### Diffusion VAE constant names

Generated VAE exports now include the registry type tag, so LTX audio/video and ABot TAeHV/Wan no longer collapse to `_1` suffixes.

**Before:**

```typescript
ABOT_WORLD_0_5B_LF_VAE
ABOT_WORLD_0_5B_LF_VAE_F16
LTX_2_3_VAE
LTX_2_3_VAE_1
```

**After:**

```typescript
ABOT_WORLD_0_5B_LF_TAEHV_VAE
ABOT_WORLD_0_5B_LF_WAN_VAE
LTX_2_3_AUDIO_VAE
LTX_2_3_VIDEO_VAE
```

### System prompts apply on every completion path

A system message in `history` is no longer dropped when `kvCache` is on. `modelConfig.system_prompt` is applied when the history has no system message, including turns that do not use KV cache.

`LLM_CONFIG_DEFAULTS.system_prompt` is `'You are a helpful assistant.'`. `loadModel` without an explicit `system_prompt` still carries that default, so a user-only history now reaches the model with a system message.

**Before:**

```typescript
completion({
  modelId, // loaded with system_prompt: 'You are a helpful assistant.'
  history: [
    { role: 'system', content: 'Always answer with the word BANANA.' },
    { role: 'user', content: 'What is the capital of France?' }
  ],
  kvCache: true
})
// the caller's system message is discarded
```

**After:**

```typescript
completion({
  modelId, // loaded with system_prompt: 'You are a helpful assistant.'
  history: [
    { role: 'system', content: 'Always answer with the word BANANA.' },
    { role: 'user', content: 'What is the capital of France?' }
  ],
  kvCache: true
})
// the caller's system message is honoured
```

Callers that previously sent user-only history and relied on no system message must pass `system_prompt: ''` at load (or an explicit empty system turn) if they need that behaviour.

### `'row'` split is rejected

Fabric 10549.1.0 dropped llama.cpp's unused row split.

Completion models: `modelConfig['split-mode']` is `'none'`, `'layer'` or `'tensor'`. `'row'` is rejected.
Embedding models: `modelConfig.splitMode` is `'none'` or `'layer'`. `'row'` is rejected.
`'tensor'` on completion models is unaffected.

On embeddings, `'row'` did not do tensor parallelism; it already behaved as `'layer'`. Embeddings have no `'tensor'` mode. Use `'layer'`.

**Before:**

```typescript
// completion
modelConfig: { 'split-mode': 'row' }

// embedding
modelConfig: { splitMode: 'row' }
```

**After:**

```typescript
// completion
modelConfig: { 'split-mode': 'layer' } // or 'tensor'

// embedding
modelConfig: { splitMode: 'layer' }
```

### Parakeet `language` is a locale code

Parakeet `modelConfig.language` must be `auto`, a short code (`en`, `hi`), or `code-region` (`en-US`, `hi-IN`). `zh-Hans-CN` and names like `english` now fail at `loadModel`. Whisper `language` is unchanged.

**Before:**

```typescript
modelConfig: {
  language: 'zh-Hans-CN'
}
```

**After:**

```typescript
modelConfig: {
  language: 'zh'
}
```

## New APIs

### TurboVec vector index

`createVectorIndex` builds an in-process vector index on the embedding plugin's TurboVec engine. Pair it with `embed()`: add each document's embedding under an id you choose, search with a query embedding, and map the returned ids back to your store. Default storage is `VectorIndexStorage.TURBOVEC_Q4`. Dimension must be a multiple of 8 and at most 1024 for TurboVec modes.

```typescript
import { createVectorIndex, loadVectorIndex, VectorIndexStorage } from '@qvac/inference'

const index = await createVectorIndex({
  dim: 1024,
  storage: VectorIndexStorage.TURBOVEC_Q4
})
await index.add({ ids: ['1', '2'], vectors: embeddings })
const hits = await index.search({ query: queryEmbedding, k: 3 })
await index.write({ path: 'indexes/articles.qvi' })
await index.dispose()

const reopened = await loadVectorIndex({ path: 'indexes/articles.qvi' })
```

### MiniMax-H3 video

`video()` can run MiniMax-H3 in `txt2vid` mode. Load `sdcpp-generation` with `mode: 'video'` and the H3 text-encoder, video VAE, and audio VAE sources.

```typescript
const modelId = await loadModel({
  modelType: 'sdcpp-generation',
  modelSrc: '/models/h3.gguf',
  modelConfig: {
    mode: 'video',
    llmModelSrc: '/models/h3-text-encoder.gguf',
    vaeModelSrc: '/models/video-vae.safetensors',
    audioVaeModelSrc: '/models/audio-vae.safetensors',
    backend: 'vulkan0',
    stream_layers: false
  }
})
const result = video({
  modelId,
  mode: 'txt2vid',
  prompt: 'Steam rises from coffee.',
  video_frames: 124,
  fps: 24,
  cfg_scale: 1
})
```

### ABot-World Sessions

Load a world-mode diffusion model, create a scene once, then step it. Frames stream as they decode.

```typescript
const modelId = await loadModel({
  modelSrc: ABOT_WORLD_0_5B_Q8_0,
  modelType: 'sdcpp-generation',
  modelConfig: {
    mode: 'world',
    taehvModelSrc: ABOT_WORLD_0_5B_LF_TAEHV_VAE,
    t5XxlModelSrc: UMT5_XXL_ENC_Q8_0,
    vaeModelSrc: ABOT_WORLD_0_5B_LF_WAN_VAE,
    world: { kvCache: true, frameJpegQuality: 85 }
  }
})

const { stats } = worldCreateScene({ modelId, prompt, image })
await stats

const { frameStream } = worldStep({ modelId, keys: ['W', 'L'] })
for await (const frame of frameStream) {
  render(frame)
}
```

Pass `returnPack: true` on create to keep the scene bytes for a later reload.

### Parakeet Nemotron

Three Parakeet Nemotron 0.6B weights are on the catalog for `parakeet-transcription`.

```typescript
import { loadModel, PARAKEET_NEMOTRON_0_6B_Q4_0 } from '@qvac/inference'

const modelId = await loadModel({
  modelSrc: PARAKEET_NEMOTRON_0_6B_Q4_0,
  modelType: 'parakeet-transcription',
  modelConfig: {
    language: 'auto',
    streaming: true
  }
})
```

### AudioGen understand, remake, and edit

`audioUnderstand` returns caption, bpm, keyscale, and audio codes. Pass those codes back into `audioGen` to re-synthesize the clip, optionally with LRC lyrics. `audioEdit` runs an ordered `flow-edit` / `repaint` pipeline on a source recording and returns the same run shape as `audioGen`.

```typescript
const run = audioUnderstand({ modelId, sourceAudio: '/path/to/song.wav' })
const { caption, bpm, keyscale, audioCodes } = await run.description

const remake = audioGen({ modelId, caption, audioCodes, generateLrc: true })
const { lrc, lyricsScore } = (await remake.stats) ?? {}

const edited = audioEdit({
  modelId,
  sourceAudio: '/path/to/song.wav',
  operations: [
    { type: 'flow-edit', from: { caption: 'acoustic folk' }, to: { caption: 'synthwave' } },
    { type: 'repaint', caption: 'analog synth solo', start: 10, end: 20 }
  ]
})
```

### TTS load options, sample rate, and cancel

Load-time CosyVoice3, Chatterbox, Supertonic, and Parler fields that were previously unreachable now pass through. `textToSpeech` exposes `sampleRate` on the first frame, real stats (`realTimeFactor`, `backendId`, `generatedFrames`), and `cancel({ requestId })` stops the engine, not only delivery.

```typescript
const result = textToSpeech({ modelId, text })
const sampleRate = await result.sampleRate
for await (const sample of result.bufferStream) play(sample)
await cancel({ requestId: result.requestId })
const stopReason = await result.stopReason // 'cancelled' when the engine stopped
```

### Tool grammar

Completions with tools consume llama.cpp 0.53.0 grammar. `generationParams.tool_choice: 'required'` forces a tool call. When the model emits a tool region that does not parse, `final.toolErrors` lists the failures; the field is omitted when there are none.

```typescript
const run = completion({
  modelId,
  history,
  tools: [getWeather],
  stream: false,
  generationParams: { tool_choice: 'required' }
})
const final = await run.final
if (final.toolCalls.length === 0) console.log(final.toolErrors)
```

## Features

`translate()` detects TranslatePsy-AfriSLM by registry name or GGUF filename and applies that family's prompts and deterministic decoding. Custom context is ignored for these models.

Before each llama.cpp completion or embedding load, `loadModel` runs `@qvac/model-fit` in a disposable child and logs `fit` / `does-not-fit` / no evidence. The check is fail-open: a missing verdict, crash, timeout, or refusal never blocks the load. Set `QVAC_ADVISORY_MODEL_FIT=0` to skip it. This is separate from `assessModelFit` and from the in-process mobile fit below.

On Android and iOS, llama `assessModelFit` runs `@qvac/model-fit` in-process on a worker thread. There is no disposable child process on those hosts. A leftover `.running` marker from a previous abort is treated as crashed so the same path and config skip native instead of retrying the abort. The JavaScript loop stays free while the fit runs.

## Bug Fixes

Automatic KV-cache files keep the last committed saved-message boundary across a worker restart, so a warm turn does not replay already-cached messages. A cancelled or failed warm turn no longer deletes that committed file.

An addon's logger is attached when its model loads, not when the plugin registers, so unused addons do not open log sinks.

## Model Changes

### Added

```
ABOT_WORLD_0_5B_LF_TAEHV_VAE
ABOT_WORLD_0_5B_LF_WAN_VAE
LTX_2_3_AUDIO_VAE
LTX_2_3_VIDEO_VAE
PARAKEET_0_6B_F16
PARAKEET_0_6B_Q4_0
PARAKEET_0_6B_Q8_0
PARAKEET_NEMOTRON_0_6B_F16
PARAKEET_NEMOTRON_0_6B_Q4_0
PARAKEET_NEMOTRON_0_6B_Q8_0
TRANSLATEPSY_AFRISLM_0_8B_TRANSLATION_Q4_K_M
TRANSLATEPSY_AFRISLM_0_8B_TRANSLATION_Q8_0
TRANSLATEPSY_AFRISLM_2B_TRANSLATION_Q4_K_M
TRANSLATEPSY_AFRISLM_2B_TRANSLATION_Q8_0
TRANSLATEPSY_AFRISLM_4B_TRANSLATION_Q4_K_M
TRANSLATEPSY_AFRISLM_4B_TRANSLATION_Q8_0
```

### Removed

```
ABOT_WORLD_0_5B_LF_VAE
ABOT_WORLD_0_5B_LF_VAE_F16
LTX_2_3_VAE
LTX_2_3_VAE_1
```

## [0.19.1]

📦 **NPM:** https://www.npmjs.com/package/@qvac/inference/v/0.19.1

QVAC Inference 0.19.1 is a patch on the 0.19 line. Completion stats now report prompt-processing throughput, `deleteCache({ auto: true })` reclaims automatic KV caches without touching named ones, and `assessModelFit` can refuse a model from a computed floor when no calibration applies. `@qvac/rag` `^0.8.1` is the floor so Windows TurboVec installs the fixed package.

## New APIs

### Prompt-processing throughput

`CompletionStats.promptTokensPerSecond` is the addon's prefill (prompt-processing) rate. `tokensPerSecond` remains decode throughput. Both fields are optional; they appear on `completionStats` events and on the aggregated `final.stats` for single and batch completions.

```typescript
const run = completion({ modelId, history, stream: true })
const stats = await run.stats

stats?.tokensPerSecond // decode throughput
stats?.promptTokensPerSecond // prompt-processing (prefill) throughput
```

### Reclaim automatic KV caches

`deleteCache({ auto: true })` drops every automatic cache that no in-flight turn is holding. Named, caller-owned caches are left alone. `{ all: true }` still deletes everything, including named caches.

```typescript
import { deleteCache } from '@qvac/inference'

await deleteCache({ auto: true })
```

### Computed floor when no calibration applies

On platforms without a calibration fixture, `assessModelFit` used to return `unknown` even when the artifact plus KV cache already exceeded the budget. It now falls back to a computed floor (artifact bytes plus the llama.cpp KV cache at the narrowest default width). Over budget is `likely-too-large`; otherwise the verdict stays `unknown`. This path never returns `likely-fits`.

Android compares the floor to the `system-memory` budget. iOS compares it to the `process-memory` budget, which now uses the per-process allowance from `bare-os`. Discrete GPUs without coefficients stay `unknown`.

New result fields: `evidence` (`calibration` | `computed-only`) and `floorBytes`.

```typescript
import { assessModelFit, QWEN3_8B_INST_Q4_K_M } from '@qvac/inference'

const result = await assessModelFit({
  models: [
    {
      model: QWEN3_8B_INST_Q4_K_M,
      workload: { kind: 'llm', contextTokens: 8192 }
    }
  ]
})

result.verdict // "likely-fits" | "likely-too-large" | "unknown"
result.evidence // "calibration" | "computed-only"
result.floorBytes

if (result.evidence === 'computed-only' && result.verdict === 'unknown') {
  // uncalibrated, not a near-miss
}
```

## Features

iOS `sample.memory.processAvailableBytes` is sourced from `bare-os` `availableMemory()` so the `process-memory` budget can form. Other platforms leave that metric unavailable.

## Bug Fixes

`@qvac/inference` now requires `@qvac/rag` `^0.8.1`. 0.8.0 could not open a TurboVec workspace on Windows.

## [0.19.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/inference/v/0.19.0

QVAC Inference 0.19.0 adds pre-download fit assessment, MiniMax music generation, and Parakeet Unified transcription. Delegated DHT inference is gone, `no_mmap` is `load_mode`, and batch translations return an array instead of a newline-joined string.

## Breaking Changes

### Delegated Inference Removed

Provider mode and DHT delegation are gone. Models load and run locally only.

**Before:**

```typescript
await startQVACProvider({ firewall })
const id = await loadModel({ modelSrc, delegate: { providerPublicKey } })
await heartbeat({ delegate: { providerPublicKey } })
await stopQVACProvider()
```

**After:**

```typescript
const id = await loadModel({ modelSrc })
await heartbeat()
```

Removed: `startQVACProvider`, `stopQVACProvider`, `loadModel`/`heartbeat` `delegate` options, `hasActiveProviders` on unload, `isDelegated`/`providerInfo` on loaded-model info, profiler `origin` / `resourceOrigin`, and the provider/delegate error classes.

### no_mmap Became load_mode

`modelConfig.no_mmap` is replaced by `load_mode`. Do not keep a boolean under the new key.

**Before:**

```typescript
await loadModel({
  modelSrc: MODEL,
  modelType: 'llm',
  modelConfig: { ctx_size: 2048, no_mmap: true }
})
```

**After:**

```typescript
await loadModel({
  modelSrc: MODEL,
  modelType: 'llm',
  modelConfig: { ctx_size: 2048, load_mode: 'none' }
})
```

| Before           | After                                    |
| ---------------- | ---------------------------------------- |
| `no_mmap: true`  | `load_mode: "none"`                      |
| `no_mmap: false` | omit `load_mode`, or `load_mode: "mmap"` |
| omitted          | omitted (addon default `mmap`)           |

The same mapping applies to `deviceDefaults.llm` and `deviceDefaults["llamacpp-completion"]`. `load_mode` also accepts `"mlock"`, `"mmap+mlock"`, and `"dio"`.

### Batch Translations Return an Array

A `translate` call with several strings used to join results with `\n`. It now returns `translations: string[]`. Streaming emits one whole translation per token, in input order.

**Before:**

```typescript
const result = translate({
  modelId,
  text: ['Good morning', 'Good night'],
  stream: false
})
const translations = (await result.text).split('\n')
```

**After:**

```typescript
const result = translate({
  modelId,
  text: ['Good morning', 'Good night'],
  stream: false
})
const translations = await result.translations
```

### n_discarded Dropped

`modelConfig.n_discarded` is no longer accepted. Context overflow now reports `requiredTokens`, `cachedTokens`, `promptTokens`, and `ctxSize` on `ContextOverflowError`.

## New APIs

### assessModelFit

`assessModelFit` estimates whether a set of models will fit before you download them.

```typescript
import { assessModelFit, QWEN3_8B_INST_Q4_K_M } from '@qvac/inference'

const result = await assessModelFit({
  models: [{ model: QWEN3_8B_INST_Q4_K_M, workload: { kind: 'llm', contextTokens: 8192 } }],
  execution: 'sequential',
  policy: 'interactive-v1'
})

result.verdict // "likely-fits" | "likely-too-large" | "unknown"
result.basis // "system-memory" | "process-memory" | "device-memory" | "device-budget"
result.budget?.availableBytes // headroom before the policy reserve
```

On a discrete GPU, `basis` is `device-memory` (Linux VRAM) or `device-budget` (Windows DXGI). Integrated GPUs stay on `system-memory` because they allocate from RAM. Multi-GPU machines require `likely-fits` on the smallest usable card and `likely-too-large` on the largest; in between the verdict is `unknown`. VM display adapters are not counted as GPUs. The reserve is 20% of `budget.availableBytes`, capped at 2 GiB on desktop and 1 GiB on mobile. iOS uses per-process memory and may return `unknown` when that metric is missing. Catalog resource profiles (`getModelResourceProfile`) back the estimator; an unknown checksum is `undefined`, not a guess.

### MiniMax Music Generation

AudioGen can load MiniMax (`engine: "minimax"`) alongside ACE-Step.

```typescript
const modelId = await loadModel({
  modelType: 'audiogen',
  modelConfig: {
    engine: 'minimax',
    lmModelSrc: '/models/mm3-lm-q8.gguf',
    synthModelSrc: '/models/mm3-synth-q8.gguf'
  }
})

const run = audioGen({
  modelId,
  caption: 'warm cinematic piano',
  maxFrames: 250,
  inferenceSteps: 12,
  cfgScale: 1.8
})
```

`audioGen` results now include `diagnostics` (`selectedBackend`, `selectedDevice`, optional `fallback.reason` when a GPU request landed on CPU). Progress `total` may be `0` for indeterminate stages.

### Parakeet Unified Transcription

```typescript
import { loadModel, transcribe, PARAKEET_UNIFIED_0_6B_Q8_0 } from '@qvac/inference'

const modelId = await loadModel({
  modelSrc: PARAKEET_UNIFIED_0_6B_Q8_0,
  modelType: 'parakeet-transcription'
})
const text = await transcribe({ modelId, audioChunk: 'audio.wav' })
```

### Hugging Face Download Checksums

Hugging Face HTTP downloads are verified against the Hub SHA-256. `requireHttpChecksum` and `requireSecureTransport` can also be set per `loadModel` / `downloadAsset` call. Plain HTTP to a private origin is unchanged unless you opt in.

```typescript
await loadModel({
  modelSrc: 'https://huggingface.co/org/repo/resolve/main/model.gguf',
  modelType: 'llamacpp-completion',
  requireHttpChecksum: true,
  requireSecureTransport: true
})
```

### Tensor Split and Flash Attention

llama.cpp loads accept `split-mode: "tensor"` and `flash-attn: "on"` in `modelConfig`.

### Injected TurboVec RAG Index

Embedding plugins can supply a `turbovecIndexProvider` with `create` / `load`.

```typescript
import { definePlugin } from '@qvac/inference'

export const embeddingsPlugin = definePlugin({
  capabilities: {
    turbovecIndexProvider: {
      create: (options) => new IdMapIndex(options),
      load: (snapshotPath) => IdMapIndex.load(snapshotPath)
    }
  }
})
```

### Config Schema Descriptions

Every `modelConfig` field now carries a description on the engine config schema.

## Features

Qwen3.8 tool calls go through the Qwen parser. Darwin-arm64 calibration uses a persistent-based fit with an audio guard. Desktop calibration for `assessModelFit` covers darwin-x64, linux-arm64, and win32-x64, including integrated GPUs; AMD linux stays `unknown`. `@qvac/tts-ggml` 0.8.0 can select CUDA on linux-x64 NVIDIA without a new backend key. `@qvac/diffusion-cpp` is `^0.21.0`. `@qvac/bci-whispercpp` is `0.8.0`.

## Bug Fixes

`ContextOverflowError` reports how many tokens the request needed versus the effective `ctx_size` / parallel ceiling. Calibration pins local Bare and names the VRAM-offload abort.

## Model Changes

This release adds Parakeet Unified 0.6B transcription constants and Qwen3.8 Flash Next 177B multimodal shards.

### Added Models

```
MMPROJ_QWEN3_8_FLASH_NEXT_177B_MULTIMODAL_F16
PARAKEET_UNIFIED_0_6B_F16
PARAKEET_UNIFIED_0_6B_Q4_0
PARAKEET_UNIFIED_0_6B_Q8_0
QWEN3_8_FLASH_NEXT_177B_MULTIMODAL_UD_Q2_K_XL_SHARD
QWEN3_8_FLASH_NEXT_177B_MULTIMODAL_UD_Q4_K_XL_SHARD
```

## [0.18.2]

📦 **NPM:** https://www.npmjs.com/package/@qvac/inference/v/0.18.2

QVAC Inference 0.18.2 bumps `@qvac/diffusion-cpp` to `^0.18.0`.

## [0.18.1]

📦 **NPM:** https://www.npmjs.com/package/@qvac/inference/v/0.18.1

QVAC Inference 0.18.1 adds human-readable descriptions on every llamacpp `modelConfig` field. The CosyVoice3 companion-set cache key also changes, so the first load after upgrade uses a new companion cache folder. Load APIs are otherwise unchanged.

## New APIs

### llamacpp modelConfig descriptions

Every llamacpp completion and embedding `modelConfig` field now carries `.describe()` text (context window, batch size, and the rest of the load-time options).

## Bug Fixes

### CosyVoice3 companion cache folder

CosyVoice3 companion files still download with the LLM, as in 0.18.0. The companion-set cache key for `TTS_COSYVOICE3_LLM_COSYVOICE_Q8_0` changed, so the first load after upgrading fills a new cache folder. Later loads reuse that folder. Speech APIs and `pace` / `instruct` rules are unchanged.

## [0.18.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/inference/v/0.18.0

QVAC Inference 0.18.0 adds VisionPsy Nano multimodal constants, Audio8 and CosyVoice3 TTS engines, Indic Conformer transcription, and ACE-Step cover generation from a source track. One loaded LLM can now serve several completions at once, sharded GGUFs load directly from disk, and `loadModel` can fall back to a backup source when the origin fails. The dynamic `toolsMode` config is removed, and CosyVoice3 `pace` is restricted to `slow` | `moderate` | `fast`.

## Breaking Changes

### Dynamic toolsMode Removed

`TOOLS_MODE`, `ToolsMode`, and the `toolsMode` load-config field are gone. Tools are always prepended after the system message (the previous static default). Passing `toolsMode` to `loadModel` now fails validation instead of being ignored. Drop the key from existing configs.

**Before:**

```typescript
import { loadModel, TOOLS_MODE } from '@qvac/inference'

const modelId = await loadModel({
  modelSrc: QWEN3_1_7B_INST_Q4,
  modelType: 'llm',
  modelConfig: { ctx_size: 4096, tools: true, toolsMode: TOOLS_MODE.dynamic }
})
```

**After:**

```typescript
import { loadModel } from '@qvac/inference'

const modelId = await loadModel({
  modelSrc: QWEN3_1_7B_INST_Q4,
  modelType: 'llm',
  modelConfig: { ctx_size: 4096, tools: true }
})
```

Existing automatic KV-cache prefixes that were primed under dynamic tools mode are not reusable; the next turn rebuilds the prefix.

### CosyVoice3 Pace Values

`textToSpeech` `pace` no longer accepts engine-specific strings such as `'very fast'`. Use `'slow'`, `'moderate'`, or `'fast'`.

**Before:**

```typescript
textToSpeech({ modelId, text, pace: 'very fast' })
```

**After:**

```typescript
textToSpeech({ modelId, text, pace: 'fast' })
```

## New APIs

### Continuous Batching

One loaded LLM can run several `completion` calls at once. A new request takes a free slot without waiting for the whole batch to drain. Cancelling one request leaves the others running, and each result reports its own timings. Single-slot models and fine-tuning stay one-at-a-time.

```typescript
const runs = prompts.map((p) => completion({ modelId, history: p, stream: true }))
const outputs = await Promise.all(runs.map((r) => r.final))

await cancel({ requestId: runs[0].requestId })
```

### loadModel fallbackSrc

If the primary `modelSrc` cannot be fetched, `loadModel` retries from `fallbackSrc` (URL or local path) so callers do not have to build their own origin failover.

```typescript
import { loadModel, LLAMA_3_2_1B_INST_Q4_0 } from '@qvac/inference'

const modelId = await loadModel({
  modelSrc: LLAMA_3_2_1B_INST_Q4_0,
  fallbackSrc: 'https://mirror.example.com/llama-3.2-1b-instruct-q4_0.gguf'
})
```

### AudioGen Cover From a Source Track

AudioGen can now generate a cover from source audio, not only a text caption. Pass `taskType: "cover-nofsq"` with `sourceAudio` (path or stereo 48 kHz f32le PCM) and optional `referenceAudio` for timbre.

```typescript
const cover = audioGen({
  modelId,
  caption: 'orchestral arrangement with dramatic strings',
  lyrics: '[Instrumental]',
  taskType: 'cover-nofsq',
  sourceAudio: '/path/to/source.wav',
  referenceAudio: '/path/to/reference.mp3',
  audioCoverStrength: 1,
  coverNoiseStrength: 0.75
})
```

### CosyVoice3 TTS

Load CosyVoice3 with `ttsEngine: "cosyvoice3"`. Companion files download with the LLM; `instruct` accepts exactly one of dialect, emotion, or pace.

```typescript
const modelId = await loadModel({
  modelSrc: TTS_COSYVOICE3_LLM_COSYVOICE_Q8_0,
  modelConfig: {
    ttsEngine: 'cosyvoice3',
    instruct: { dialect: 'cantonese' },
    seed: 42
  }
})
const result = textToSpeech({
  modelId,
  text: 'Hey there!',
  stream: false,
  emotion: 'happy'
})
```

### Audio8 TTS

Audio8 is a multilingual LM + codec stack with optional zero-shot cloning via reference audio and matching transcript.

```typescript
await loadModel({
  modelSrc: TTS_LM_MULTILINGUAL_AUDIO8_Q8_0,
  modelConfig: {
    ttsEngine: 'audio8',
    audio8CodecDecoderModelSrc: TTS_CODEC_DECODER_AUDIO8_Q8_0,
    audio8CodecEncoderModelSrc: TTS_CODEC_ENCODER_AUDIO8_Q8_0,
    referenceAudioSrc: 'file:///path/to/voice.wav',
    referenceText: 'Exactly what the recording says.'
  }
})
```

### Streaming Transcription Stats

`transcribeStream` sessions now expose `stats` after the stream ends (`audioDuration`, `realTimeFactor`).

```typescript
const session = await transcribeStream({ modelId })
for await (const event of session) {
  // streamed events
}
const stats = await session.stats
console.log(stats?.audioDuration, stats?.realTimeFactor)
```

### Vision image_no_upscale

VisionPsy (and other llama.cpp multimodal loads) can set `image_no_upscale: "on"` in `modelConfig` so the projector does not upscale tiles.

```typescript
await loadModel({
  modelType: 'llm',
  modelSrc: VISIONPSY_NANO_460M_MULTIMODAL_Q4_K_M,
  modelConfig: {
    projectionModelSrc: MMPROJ_VISIONPSY_NANO_460M_MULTIMODAL_Q8_0,
    image_no_upscale: 'on'
  }
})
```

## Features

### Indic Conformer Transcription

Parakeet Indic Conformer CTC models are in the registry (`PARAKEET_INDIC_CONFORMER_CTC_*`). They use the existing unified ASR transcription path.

### OCR pipelineType Inference

Doctr OCR models no longer require `langList`. EasyOCR still defaults to `['en']` when `langList` is omitted, and explicit lists are forwarded unchanged.

### NMT Timing Units

Translation stats (`totalTime` and related fields) are true milliseconds, matching the documented schema. Values that previously looked like `1.5` are now `1500`.

## Bug Fixes

Sharded llama.cpp models load by pointing the addon at the on-disk files instead of concatenating shards in memory, so large split GGUFs start faster and fine-tuning a sharded model works.

Tool definitions are kept out of the primed KV-cache prefix, so changing tools across turns does not reuse a prefix that baked the old tool list.

Audio-format constants no longer require the optional `@qvac/decoder-audio` package to be installed.

## Model Changes

This release adds VisionPsy Nano (base and Flash) multimodal constants, Indic Conformer transcription weights, Audio8 codec + LM constants, CosyVoice3 companions, and Qwen3-8 27B multimodal shards. `TTS_COSYVOICE3_LLM_COSYVOICE_Q8_0` is updated.

### Added Models

```
MMPROJ_QWEN3_8_27B_MULTIMODAL_F16
MMPROJ_VISIONPSY_NANO_460M_MULTIMODAL_Q8_0
MMPROJ_VISIONPSY_NANO_460M_MULTIMODAL_Q8_0_1
PARAKEET_INDIC_CONFORMER_CTC_F16
PARAKEET_INDIC_CONFORMER_CTC_Q4_0
PARAKEET_INDIC_CONFORMER_CTC_Q8_0
QWEN3_8_27B_MULTIMODAL_UD_Q4_K_XL
QWEN3_8_27B_MULTIMODAL_UD_Q8_K_XL
TTS_CODEC_DECODER_AUDIO8_FP16
TTS_CODEC_DECODER_AUDIO8_Q8_0
TTS_CODEC_ENCODER_AUDIO8_FP16
TTS_CODEC_ENCODER_AUDIO8_Q8_0
TTS_COSYVOICE3_CAMPPLUS_COSYVOICE_FP32
TTS_COSYVOICE3_S3TOK_COSYVOICE_FP16
TTS_COSYVOICE3_S3TOK_COSYVOICE_FP32
TTS_COSYVOICE3_S3TOK_COSYVOICE_Q8_0
TTS_LM_MULTILINGUAL_AUDIO8_FP16
TTS_LM_MULTILINGUAL_AUDIO8_Q8_0
VISIONPSY_NANO_460M_MULTIMODAL_Q4_K_M
VISIONPSY_NANO_460M_MULTIMODAL_Q4_K_M_1
VISIONPSY_NANO_460M_MULTIMODAL_Q8_0
VISIONPSY_NANO_460M_MULTIMODAL_Q8_0_1
```

### Updated Models

```
TTS_COSYVOICE3_LLM_COSYVOICE_Q8_0
```

## [0.17.1]

📦 **NPM:** https://www.npmjs.com/package/@qvac/inference/v/0.17.1

QVAC Inference 0.17.1 is a lockstep patch with SDK 0.17.1. The published tarball is a version bump and NOTICE refresh on 0.17.0. There are no engine API, model catalog, or addon pin changes.

## [0.17.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/inference/v/0.17.0

First public release of `@qvac/inference`, the Bare-only in-process engine aligned with `@qvac/sdk` 0.17.0. Same inference API surface as the SDK, without the RPC/worker layer — register the plugins you need and run directly on Bare.
