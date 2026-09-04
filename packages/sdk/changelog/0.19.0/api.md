# 🔌 API Changes v0.19.0

## Add ABot-World interactive world sessions to the SDK

PR: [#3812](https://github.com/tetherto/qvac/pull/3812)

```typescript
const modelId = await loadModel({
  modelSrc: ABOT_WORLD_0_5B_Q8_0,
  modelType: 'sdcpp-generation',
  modelConfig: {
    mode: 'world',
    taehvModelSrc: ABOT_WORLD_0_5B_LF_VAE, // taew2_2 streaming decoder, used by every step
    t5XxlModelSrc: UMT5_XXL_ENC_Q8_0,
    vaeModelSrc: ABOT_WORLD_0_5B_LF_VAE_F16, // full Wan2.2 VAE, encodes the first frame
    world: { kvCache: true, frameJpegQuality: 85 }
  }
})

// Once per world. `stats` is the completion signal; the world is live on the
// session and no pack crosses the wire.
const { stats } = worldCreateScene({ modelId, prompt, image })
await stats

// Pass returnPack to keep the bytes, e.g. to walk the same world after a reload.
const { scene } = worldCreateScene({ modelId, prompt, image, returnPack: true })
fs.writeFileSync('world.safetensors', await scene)

// Walk: one generated block per call, frames stream as they decode.
const { frameStream } = worldStep({ modelId, keys: ['W', 'L'] })
for await (const frame of frameStream) render(frame)
```

---

## Generate model resource profiles for the catalog

PR: [#4045](https://github.com/tetherto/qvac/pull/4045)

```typescript
import { getModelResourceProfile } from '@qvac/inference/model-resource-profiles'
import { GEMMA4_31B_MULTIMODAL_Q4_K_M } from '@qvac/sdk/models'

const profile = getModelResourceProfile(GEMMA4_31B_MULTIMODAL_Q4_K_M.sha256Checksum)
// {
//   schemaVersion: 1,
//   engine: 'llamacpp-completion',
//   artifactBytes: 19598488192,
//   ggufFacts: {
//     architecture: 'gemma4', blockCount: 60, contextLength: 262144,
//     slidingWindow: 1024, keyLengthSwa: 256, valueLengthSwa: 256,
//     kvLayerClasses: [
//       { count: 50, headCountKv: 16, keyLength: 256, valueLength: 256, windowed: true },
//       { count: 10, headCountKv: 4, keyLength: 512, valueLength: 512, windowed: false }
//     ],
//     ...
//   }
// }
// undefined => unknown; the estimator must not guess.
```

---

## AssessModelFit pre-download fit assessment

PR: [#4047](https://github.com/tetherto/qvac/pull/4047)

```typescript
import { assessModelFit } from '@qvac/inference'
import { QWEN3_8B_INST_Q4_K_M, WHISPER_EN_SMALL_Q8_0 } from '@qvac/inference/models'

const result = await assessModelFit({
  models: [
    { model: QWEN3_8B_INST_Q4_K_M, workload: { kind: 'llm', contextTokens: 8192 } },
    { model: WHISPER_EN_SMALL_Q8_0, workload: { kind: 'audio', windowMs: 30_000, streaming: true } }
  ],
  execution: 'sequential', // declared assumption for aggregation, not scheduling
  policy: 'interactive-v1' // 2 GiB or 15% desktop, 1 GiB or 20% mobile
})

result.verdict // 'likely-fits' | 'likely-too-large' | 'unknown'
result.budget // { totalBytes, usedBytes, reservedBytes, availableAfterReserveBytes }
result.estimate // { lowerBoundBytes, upperBoundBytes }
result.models // per-candidate verdict, estimate, estimatorVersion, reasons
result.assumptions // e.g. default KV-cache types, mmap'd weights counted at full size
```

---

## Expose assessModelFit from the SDK

PR: [#4048](https://github.com/tetherto/qvac/pull/4048)

```typescript
import { assessModelFit, QWEN3_8B_INST_Q4_K_M } from '@qvac/sdk'

const result = await assessModelFit({
  models: [{ model: QWEN3_8B_INST_Q4_K_M, workload: { kind: 'llm', contextTokens: 8192 } }],
  execution: 'sequential',
  policy: 'interactive-v1'
})

if (result.verdict === 'likely-too-large') {
  // offer a smaller model, or a smaller context
}
// 'unknown' means "can't say" — never render it as "no"
```

---

## Describe shared modelSrc descriptor fields

PR: [#4052](https://github.com/tetherto/qvac/pull/4052)

```typescript
import { modelSourceSchema } from '@qvac/sdk/schemas'

modelSourceSchema.options[1].shape.src.description
// "Location of the model file: a local file path, an HTTP(S) URL, or a `registry://` / `hyperdrive://` URI."
```

---

## Describe classification modelConfig fields

PR: [#4061](https://github.com/tetherto/qvac/pull/4061)

```typescript
classificationConfigSchema.shape.topK.description
// "Limit returned results to the top-K classes. Default: all classes."
```

---

## Describe OCR modelConfig fields

PR: [#4062](https://github.com/tetherto/qvac/pull/4062)

```typescript
ocrConfigSchema.shape.pipelineType.description
// "OCR pipeline: 'easyocr' (CRAFT detector + CRNN recognizer, default) or 'doctr' (…language-agnostic)."
```

---

## Describe AudioGen load-time modelConfig fields

PR: [#4064](https://github.com/tetherto/qvac/pull/4064)

```typescript
audioGenConfigSchema.shape.ditModelSrc.description
// "DiT model source; generates the audio latent (the quality-defining stage)."
```

---

## Describe remaining diffusion modelConfig fields

PR: [#4065](https://github.com/tetherto/qvac/pull/4065)

```typescript
sdcppConfigSchema.shape.rng.description
// "Context RNG type: 'cpu', 'cuda' (default; Philox, not GPU-specific), or 'std_default'."
```

---

## Describe NMT modelConfig union arms

PR: [#4066](https://github.com/tetherto/qvac/pull/4066)

```typescript
// nmtConfigBaseSchema.options[0] is the Bergamot arm
nmtConfigBaseSchema.options[1].shape.temperature.description
// "Sampling temperature (0–2). Default 0.3."
```

---

## Describe TTS modelConfig union arms

PR: [#4067](https://github.com/tetherto/qvac/pull/4067)

```typescript
ttsAudio8LoadConfigSchema.shape.audio8CodecDecoderModelSrc.description
// "Audio8 codec decoder model source (codes to 44.1 kHz waveform)."
```

---

## Describe whisper + parakeet modelConfig fields

PR: [#4068](https://github.com/tetherto/qvac/pull/4068)

```typescript
whisperConfigSchema.shape.language.description
// "Transcription language (ISO 639-1) or 'auto' to detect."
```

---

## Describe BCI modelConfig fields

PR: [#4069](https://github.com/tetherto/qvac/pull/4069)

```typescript
bciConfigSchema.shape.embedderModelSrc.description
// "BCI embedder model source (neural-signal embedder weights)."
```

---

## Add injected TurboVec RAG index support

PR: [#4074](https://github.com/tetherto/qvac/pull/4074)

```jsonc
// qvac.config.json
{
  "ragTurbovec": true
}
```

```typescript
import { definePlugin } from '@qvac/inference'

export const embeddingsPlugin = definePlugin({
  // ...
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

```ts
const result = await client.audioGen({ prompt: 'lofi piano', config: { useGPU: true } })

const diagnostics = await result.diagnostics
// {
//   selectedBackend: 'vulkan',
//   selectedDevice: 'gpu',
//   graphicsApi: 'vulkan'
// }

if (diagnostics?.selectedDevice === 'cpu') {
  // the run came back on the CPU
}
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

```python
from tetherto.qvac_sdk import (
    LoadModelSrcRequestAudiogenGgmlModelConfig,
    LoadModelSrcRequestAudiogenGgmlModelConfigLmModelSrc,
)
```

```python
from tetherto.qvac_sdk import (
    LoadModelSrcRequestAudiogenGgmlModelConfigAcestep,
    LoadModelSrcRequestAudiogenGgmlModelConfigAcestepLmModelSrc,
    LoadModelSrcRequestAudiogenGgmlModelConfigMinimax,
    LoadModelSrcRequestAudiogenGgmlModelConfigMinimaxLmModelSrc,
)
```

---

## Verify Hugging Face HTTP model downloads against Hub SHA-256

PR: [#4110](https://github.com/tetherto/qvac/pull/4110)

```typescript
import { setConfig, loadModel, downloadAsset } from "@qvac/sdk";

// Global default (engine config):
setConfig({ requireHttpChecksum: true, requireSecureTransport: true });

// Or per call (overrides config for this call only):
await loadModel({
  modelSrc: "https://huggingface.co/org/repo/resolve/main/model.gguf",
  modelType: "llamacpp-completion",
  requireHttpChecksum: true,
  requireSecureTransport: true,
});
await downloadAsset({ assetSrc: "https://huggingface.co/org/repo/resolve/main/model.gguf", requireSecureTransport: true });

// Hugging Face URLs are verified against the Hub SHA-256 regardless of the flags.
// Bring-your-own HTTP is unchanged unless requireSecureTransport is set:
await loadModel({ modelSrc: "http://my-model-server.internal/model.gguf", modelType: "llamacpp-completion" });
```

---

## Guard that every modelConfig field is described

PR: [#4122](https://github.com/tetherto/qvac/pull/4122)

```typescript
ttsCosyvoice3LoadConfigSchema // instruct: { dialect, volume, style } now each carry a description
```

---

## Update @qvac/tts-ggml to 0.8.0

PR: [#4138](https://github.com/tetherto/qvac/pull/4138)

```js
// Unchanged surface — CUDA is selected inside the engine; there is no backend key to pass.
const model = new TTSGgml({
  files: { modelDir: "./models" },
  config: { language: "en", useGPU: true }, // linux-x64 + NVIDIA -> CUDA, otherwise Vulkan / CPU
  opts: { stats: true },
});
```

---

## Add Parakeet Unified transcription to the SDK

PR: [#4155](https://github.com/tetherto/qvac/pull/4155)

```
PARAKEET_UNIFIED_0_6B_F16
PARAKEET_UNIFIED_0_6B_Q4_0
PARAKEET_UNIFIED_0_6B_Q8_0
```

```typescript
import { loadModel, transcribe, PARAKEET_UNIFIED_0_6B_Q8_0 } from '@qvac/sdk'

const modelId = await loadModel({
  modelSrc: PARAKEET_UNIFIED_0_6B_Q8_0,
  modelType: 'parakeet-transcription'
})
const text = await transcribe({ modelId, audioChunk: 'audio.wav' })
```

```python
bbox: list[Any] | None = None
```

```python
bbox: tuple[float, float, float, float] | None = None
```

---

## Configurable worker RPC init timeout and typed startup failure cause

PR: [#4159](https://github.com/tetherto/qvac/pull/4159)

```typescript
// 1. Configurable handshake timeout — qvac.config.json
{
  "rpcInitTimeoutMs": 120000
}
// or, taking precedence over the config file (and also raising `qvac doctor`'s probe):
//   QVAC_RPC_INIT_TIMEOUT_MS=120000 node app.js

// 2. Typed pre-handshake failure, always attached as the cause of RPC_INIT_TIMEOUT
import { WorkerStartupError, loadModel } from '@qvac/sdk'

try {
  await loadModel({ modelSrc, modelType: 'llamacpp-completion' })
} catch (error) {
  const cause = (error as Error).cause
  if (cause instanceof WorkerStartupError) {
    if (cause.workerExited) {
      // Dead, not slow — raising the timeout will not help.
      console.error(`worker died: code=${cause.exitCode} signal=${cause.exitSignal}`)
    } else {
      // Still running, just never connected — a longer rpcInitTimeoutMs may help.
      console.error('worker still running but never connected')
    }
    if (cause.stderrTail) console.error(cause.stderrTail)
  }
}
```

---

## Drop n_discarded from the SDK config schema

PR: [#4163](https://github.com/tetherto/qvac/pull/4163)

```typescript
await loadModel({
  modelSrc: MODEL,
  modelType: 'llm',
  modelConfig: { ctx_size: 2048, n_discarded: 256 }
})
```

```typescript
await loadModel({
  modelSrc: MODEL,
  modelType: 'llm',
  modelConfig: { ctx_size: 2048 }
})
```

```typescript
try {
  await completion({ modelId, history, kvCache }).final
} catch (err) {
  if (err instanceof ContextOverflowError) {
    err.requiredTokens // total context the request needs, in ctxSize units
    err.cachedTokens // cached conversation, on a warm-cache overflow
    err.promptTokens // the prompt alone, only when reported in tokens
    err.ctxSize // effective ceiling for this request: ctx_size / parallel slots
  }
}
```

---

## Surface modelConfig descriptions for every model type in qvac configure

PR: [#4172](https://github.com/tetherto/qvac/pull/4172)

```typescript
import { configSchemaForModelType } from '@qvac/sdk/schemas'

// Resolve a model type's modelConfig schema by canonical name, alias, or engine string
const schema = configSchemaForModelType('whisper') // 'tts-ggml', 'llm', 'diffusion', ...

// z.toJSONSchema(schema) surfaces each field's .describe() text as `description`,
// so tools (e.g. the CLI's `qvac configure`) can document config without a per-addon list.
```

---

## Report why an audiogen run fell back to the CPU

PR: [#4200](https://github.com/tetherto/qvac/pull/4200)

```js
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

result.basis // 'system-memory' | 'process-memory' — which budget backed the verdict
// iOS today: basis 'process-memory', verdict 'unknown', with the reason
// 'the per-process allowance metric is not available on this build'
// Android: basis 'system-memory', with the decision stated in `assumptions`
```

---

## Add tensor split mode and flash attention config

PR: [#4211](https://github.com/tetherto/qvac/pull/4211)

```typescript
await loadModel({
  modelSrc: "model.gguf",
  modelConfig: {
    "split-mode": "tensor",
    "flash-attn": "on",
    ctx_size: 8192,
  },
});
```

---

## Land desktop calibration fixtures and GPU-memory assessment

PR: [#4238](https://github.com/tetherto/qvac/pull/4238)

```typescript
const { basis, budget } = await assessModelFit({ models, execution: 'sequential' })
// Single discrete GPU on linux: 'device-memory', budget.totalBytes is the card's VRAM.
// Windows: 'device-budget', budget.totalBytes is the DXGI budget for this process.
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

