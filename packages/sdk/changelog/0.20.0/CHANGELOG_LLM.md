# QVAC SDK v0.20.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.20.0

QVAC SDK 0.20.0 adds TranslatePsy-AfriSLM translation, an in-process TurboVec vector index, MiniMax-H3 video, Parakeet Nemotron transcription, and the rest of the AudioGen and TTS surfaces. ABot-World sessions (`worldCreateScene` / `worldStep`) are on this surface. `loadModel` runs an advisory llama.cpp fit check. Diffusion VAE constant names, CPU flags, `'row'` split, Parakeet `language` codes, and how system prompts combine with KV cache all change.

`@qvac/sdk`, `@qvac/inference`, and `tetherto-qvac-sdk` all ship at 0.20.0. Install `@qvac/sdk` and `@qvac/inference` together at this version.

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

`createVectorIndex` builds an in-worker vector index on the embedding plugin's TurboVec engine. Pair it with `embed()`: add each document's embedding under an id you choose, search with a query embedding, and map the returned ids back to your store. Default storage is `VectorIndexStorage.TURBOVEC_Q4`. Dimension must be a multiple of 8 and at most 1024 for TurboVec modes.

```typescript
import { createVectorIndex, loadVectorIndex, VectorIndexStorage } from '@qvac/sdk'

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

Three Parakeet Nemotron 0.6B weights are on the SDK catalog for `parakeet-transcription`.

```typescript
import { loadModel, PARAKEET_NEMOTRON_0_6B_Q4_0 } from '@qvac/sdk'

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

`@qvac/tts-ggml` 0.9.x installs host binaries in per-platform packages (`@qvac/tts-ggml-darwin-arm64` and siblings) next to the meta package. `qvac verify bundle` looks there instead of under the meta package's `prebuilds/`.

## Bug Fixes

Automatic KV-cache files keep the last committed saved-message boundary across a worker restart, so a warm turn does not replay already-cached messages. A cancelled or failed warm turn no longer deletes that committed file.

An addon's logger is attached when its model loads, not when the plugin registers, so unused addons do not open log sinks.

Mobile `withQvacSDK` prebuild verifies only the hosts the bundle actually links, and only the current Android or iOS target's hosts. A missing addon pin now names the exact platform package instead of a generic missing-prebuild error.

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
