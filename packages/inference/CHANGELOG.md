# Changelog

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
