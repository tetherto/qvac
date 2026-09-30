# 🔌 API Changes v0.19.0

## Generate model resource profiles for the catalog

PR: [#4045](https://github.com/tetherto/qvac/pull/4045)

```typescript
import { getModelResourceProfile } from '@qvac/inference/model-resource-profiles'
import { GEMMA4_31B_MULTIMODAL_Q4_K_M } from '@qvac/inference'

const profile = getModelResourceProfile(GEMMA4_31B_MULTIMODAL_Q4_K_M.sha256Checksum)
// undefined => unknown; the estimator must not guess.
```

---

## AssessModelFit pre-download fit assessment

PR: [#4047](https://github.com/tetherto/qvac/pull/4047)

```typescript
import { assessModelFit } from '@qvac/inference'
import { QWEN3_8B_INST_Q4_K_M, WHISPER_EN_SMALL_Q8_0 } from '@qvac/inference'

const result = await assessModelFit({
  models: [
    { model: QWEN3_8B_INST_Q4_K_M, workload: { kind: 'llm', contextTokens: 8192 } },
    { model: WHISPER_EN_SMALL_Q8_0, workload: { kind: 'audio', windowMs: 30_000, streaming: true } }
  ],
  execution: 'sequential',
  policy: 'interactive-v1'
})

result.verdict // 'likely-fits' | 'likely-too-large' | 'unknown'
```

---

## Describe shared modelSrc descriptor fields

PR: [#4052](https://github.com/tetherto/qvac/pull/4052)

Engine `modelSource` schema fields now carry `.describe()` text (local path, HTTP(S) URL, or `registry://` / `hyperdrive://` URI).

---

## Describe classification modelConfig fields

PR: [#4061](https://github.com/tetherto/qvac/pull/4061)

Classification config fields now carry `.describe()` text (for example `topK`: "Limit returned results to the top-K classes. Default: all classes.").

---

## Describe OCR modelConfig fields

PR: [#4062](https://github.com/tetherto/qvac/pull/4062)

OCR config fields now carry `.describe()` text (`pipelineType`: EasyOCR vs DocTR).

---

## Describe AudioGen load-time modelConfig fields

PR: [#4064](https://github.com/tetherto/qvac/pull/4064)

AudioGen load-config fields now carry `.describe()` text (for example `ditModelSrc`).

---

## Describe remaining diffusion modelConfig fields

PR: [#4065](https://github.com/tetherto/qvac/pull/4065)

Diffusion config fields now carry `.describe()` text (for example `rng`).

---

## Describe NMT modelConfig union arms

PR: [#4066](https://github.com/tetherto/qvac/pull/4066)

NMT config union arms now carry `.describe()` text (for example Marian `temperature`).

---

## Describe TTS modelConfig union arms

PR: [#4067](https://github.com/tetherto/qvac/pull/4067)

TTS load-config union arms now carry `.describe()` text (including Audio8 codec sources).

---

## Describe whisper + parakeet modelConfig fields

PR: [#4068](https://github.com/tetherto/qvac/pull/4068)

Whisper and Parakeet config fields now carry `.describe()` text (for example `language`).

---

## Describe BCI modelConfig fields

PR: [#4069](https://github.com/tetherto/qvac/pull/4069)

BCI config fields now carry `.describe()` text (for example `embedderModelSrc`).

---

## Add injected TurboVec RAG index support

PR: [#4074](https://github.com/tetherto/qvac/pull/4074)

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

---

## Surface audiogen backend diagnostics on the run result

PR: [#4099](https://github.com/tetherto/qvac/pull/4099)

```typescript
const result = audioGen({ modelId, caption: 'lofi piano' })
const diagnostics = await result.diagnostics
// { selectedBackend, selectedDevice, graphicsApi }
```

---

## Add MiniMax music generation support

PR: [#4105](https://github.com/tetherto/qvac/pull/4105)

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

---

## Verify Hugging Face HTTP model downloads against Hub SHA-256

PR: [#4110](https://github.com/tetherto/qvac/pull/4110)

```typescript
await loadModel({
  modelSrc: 'https://huggingface.co/org/repo/resolve/main/model.gguf',
  modelType: 'llamacpp-completion',
  requireHttpChecksum: true,
  requireSecureTransport: true
})
```

Hugging Face URLs are verified against the Hub SHA-256 regardless of the flags. Bring-your-own HTTP is unchanged unless `requireSecureTransport` is set.

---

## Guard that every modelConfig field is described

PR: [#4122](https://github.com/tetherto/qvac/pull/4122)

A test guard fails if a `modelConfig` field is missing `.describe()` text.

---

## Update @qvac/tts-ggml to 0.8.0

PR: [#4138](https://github.com/tetherto/qvac/pull/4138)

Unchanged TTS surface. CUDA is selected inside the engine on linux-x64 NVIDIA; there is no new backend key to pass.

---

## Add Parakeet Unified transcription

PR: [#4155](https://github.com/tetherto/qvac/pull/4155)

```typescript
import { loadModel, transcribe, PARAKEET_UNIFIED_0_6B_Q8_0 } from '@qvac/inference'

const modelId = await loadModel({
  modelSrc: PARAKEET_UNIFIED_0_6B_Q8_0,
  modelType: 'parakeet-transcription'
})
const text = await transcribe({ modelId, audioChunk: 'audio.wav' })
```

```
PARAKEET_UNIFIED_0_6B_F16
PARAKEET_UNIFIED_0_6B_Q4_0
PARAKEET_UNIFIED_0_6B_Q8_0
```

---

## Drop n_discarded from the config schema

PR: [#4163](https://github.com/tetherto/qvac/pull/4163)

```typescript
try {
  await completion({ modelId, history, kvCache }).final
} catch (err) {
  if (err instanceof ContextOverflowError) {
    err.requiredTokens
    err.cachedTokens
    err.promptTokens
    err.ctxSize
  }
}
```

---

## Report why an audiogen run fell back to the CPU

PR: [#4200](https://github.com/tetherto/qvac/pull/4200)

```typescript
const diagnostics = await result.diagnostics
// {
//   selectedBackend: 'cpu',
//   selectedDevice: 'cpu',
//   fallback: { requestedDevice: 'gpu', reason: 'no-devices' }
// }
```

---

## Mobile memory budget basis — per-process on iOS, explicit system on Android

PR: [#4208](https://github.com/tetherto/qvac/pull/4208)

```typescript
const result = await assessModelFit({ models: [...] })
result.basis // 'system-memory' | 'process-memory'
```

---

## Add tensor split mode and flash attention config

PR: [#4211](https://github.com/tetherto/qvac/pull/4211)

```typescript
await loadModel({
  modelSrc: 'model.gguf',
  modelConfig: {
    'split-mode': 'tensor',
    'flash-attn': 'on',
    ctx_size: 8192
  }
})
```

---

## Land desktop calibration fixtures and GPU-memory assessment

PR: [#4238](https://github.com/tetherto/qvac/pull/4238)

```typescript
const { basis, budget } = await assessModelFit({ models, execution: 'sequential' })
// Single discrete GPU on linux: 'device-memory'
// Windows: 'device-budget'
```

---

## Allow indeterminate AudioGen progress totals

PR: [#4243](https://github.com/tetherto/qvac/pull/4243)

```typescript
for await (const progress of run.progressStream) {
  if (progress.total > 0) {
    renderDeterminateProgress(progress.step, progress.total)
  } else {
    renderIndeterminateProgress(progress.stage)
  }
}
```

---

## Widen desktop coverage to integrated GPUs and two more platforms

PR: [#4265](https://github.com/tetherto/qvac/pull/4265)

```typescript
const { basis, budget } = await assessModelFit({ models, execution: 'sequential' })
// Integrated GPU: basis stays 'system-memory'
```

---
