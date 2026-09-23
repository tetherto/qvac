# QVAC Inference v0.19.0 Release Notes

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
