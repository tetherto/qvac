# QVAC Inference v0.24.0 Release Notes

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

**Remote RPC servers.** The engine now depends on `@qvac/ggml-rpc-server` `^0.9.0`, and the RPC protocol changed since 0.23. Upgrade every remote RPC server together with this release.

```bash
npm install @qvac/ggml-rpc-server@^0.9.0
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
- **LLM:** `GLM_5_3_FLASH_320B_A18B_MULTIMODAL_Q4_K_M_SHARD`, `MMPROJ_GLM_5_3_FLASH_320B_A18B_MULTIMODAL_BF16`
- **Transcription:** `PARAKEET_TRANSCRIBEPSY_250M_EU_Q8_0`, `PARAKEET_MOSAIC_Q4_0_Q8_0`, `PARAKEET_MOSAIC_COMPACT_Q4_0_Q8_0_Q3_K_IQ3_S`, `PARAKEET_NEMOTRON_3_DIARIZATION_Q4_K`
- **Text-to-speech:** `TTS_LM_MULTILINGUAL_AUDIO8_Q4_0`
- **Music generation:** `AUDIOGEN_ACESTEP_V15_TURBO_BF16`, `AUDIOGEN_ACESTEP_V15_TURBO_F16`
- **Classification:** `MOBILENETV3_3CLASS_V3_FP16`

### Updated

- `EMBEDDINGGEMMA_300M_BF16`, `EMBEDDINGGEMMA_300M_Q4_0` and `EMBEDDINGGEMMA_300M_Q8_0` now resolve to the Dense-layer model files. Re-ingest RAG workspaces built with the earlier files.

### Removed

- `EMBEDDINGGEMMA_300M_F32`. Use `EMBEDDINGGEMMA_300M_BF16`.
