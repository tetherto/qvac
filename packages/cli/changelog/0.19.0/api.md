# 🔌 API Changes v0.19.0

## Run the SDK worker on bare-stow

PR: [#5186](https://github.com/tetherto/qvac/pull/5186)

```typescript
// Custom worker entry
import { initializeWorker, ensureRPCSetup } from '@qvac/sdk/worker-lifecycle'

// bundleSdk callers
const result = await bundleSdk({ hosts, checkEngines: false })
result.entryPaths.worker
```

```typescript
// Custom worker entry
import { startWorker } from '@qvac/sdk/worker'
export default (ipc, ready) => startWorker(ipc, ready, { plugins: [llmPlugin] })

// bundleSdk callers
const result = await bundleSdk({ target: 'bare-sidecar', hosts })
result.entryPath
```

```typescript
await bundleSdk({
  target, // 'bare-sidecar' | 'react-native' | 'pear-runtime' | 'bare-kit'
  language, // 'javascript' | 'python' | 'kotlin'; 'kotlin' for bare-kit, else 'javascript'
  languageOptions,
  outputDir, // empty or not existing; default qvac/worker/
  hosts,
  installMissingPrebuilds,
  verify,
  link
})
// returns { target, hosts, language, entryPath, outputDir, bundlePath, plugins, addons, addonModules, installedPrebuilds, linked, verification }

// qvac bundle sdk --target <bare-sidecar|react-native|pear-runtime> --language <javascript|python>
// New error codes: REACT_NATIVE_BARE_KIT_UNSUPPORTED (50620), BUNDLE_FAILED (50621), BUNDLE_TARGET_NOT_INSTALLED (50622)
```

---

## Experimental world scene endpoints under /qvac/v1/world

PR: [#5421](https://github.com/tetherto/qvac/pull/5421)

```bash
curl -sS localhost:11435/qvac/v1/world/scenes \
  -F model=abot-world -F prompt='| unknown | A forest path' -F image=@first-frame.jpg
# → 201 { "id": "scene_…", "object": "world.scene", "status": "active", … }

curl -sS localhost:11435/qvac/v1/world/scenes/scene_…/steps \
  -H 'Content-Type: application/json' -d '{"keys":["W"]}'
# → 200 { "object": "world.step", "output_format": "png", "data": [{ "b64_json": "…" }], "stats": { … } }
```

---

## Serve runtime state, loaded models and admin-gated suspend/resume

PR: [#5426](https://github.com/tetherto/qvac/pull/5426)

```bash
qvac serve --enable-admin --api-key-file ./key
curl -sS -X POST http://localhost:11435/qvac/v1/runtime/suspend -H "Authorization: Bearer $KEY"
# { "object": "runtime.state", "state": "suspended" }
curl -sS http://localhost:11435/qvac/v1/system -H "Authorization: Bearer $KEY"
# 503 { "error": { "code": "runtime_suspended", ... } }
```

---

## Expose whisper segment fields and prompt/GPU controls in the SDK

PR: [#5468](https://github.com/tetherto/qvac/pull/5468)

```typescript
import { loadModel, transcribe, type TranscribeToken } from '@qvac/sdk'

const modelId = await loadModel({
  modelSrc: './ggml-small.bin',
  modelType: 'whisper',
  modelConfig: {
    language: 'auto',
    token_timestamps: true,
    tdrz_enable: true,
    initial_prompt: 'QVAC',
    carry_initial_prompt: true,
    contextParams: { use_gpu: true, 'main-gpu': 'dedicated' } // or a registry index such as 0
  }
})

const segments = await transcribe({ modelId, audioChunk: 'meeting.wav', metadata: true })
for (const segment of segments) {
  segment.language // detected language, e.g. 'en'
  segment.noSpeechProb // 0–1
  segment.speakerTurnNext // true when a speaker turn follows
  for (const token of segment.tokens ?? []) {
    const { text, startMs, endMs, probability }: TranscribeToken = token
  }
}
```

---

## Accept ordered text and media content in history

PR: [#5505](https://github.com/tetherto/qvac/pull/5505)

```ts
import { completion, type HistoryContentPart } from '@qvac/sdk'

const content: HistoryContentPart[] = [
  { type: 'text', text: 'Image A: ' },
  { type: 'media', path: '/images/a.jpg' },
  { type: 'text', text: '\nImage B: ' },
  { type: 'media', path: '/images/b.jpg' },
  { type: 'text', text: '\nWhich image is a newspaper?' }
]
const history = [{ role: 'user', content }]

completion({ modelId, history, stream: true })
```

```kotlin
QvacMessage.user(listOf(
    QvacContentPart.Text("Image A: "),
    QvacContentPart.Media("/images/a.jpg"),
))
```

```kotlin
CompletionStreamRequestHistoryItem(role = "user", content = "Hello")
```

```kotlin
CompletionStreamRequestHistoryItem(
    role = "user",
    content = CompletionStreamRequestHistoryItemContent.Variant1("Hello"),
)
```

---

## Answer model fit from the addons' per-device memory

PR: [#5512](https://github.com/tetherto/qvac/pull/5512)

```typescript
const fit = await assessModelFit({ models, execution: 'concurrent', policy })
// {
//   verdict: 'likely-fits' | 'likely-too-large' | 'unknown',
//   basis, execution, evidence, budget, floorBytes, reasons, assumptions,
//   models: [{ name, verdict, evidence, floorBytes, estimatorVersion, device, reasons }]
// }

const { fitProbe } = await getLoadedModelInfo({ modelId })
// { verdict: 'fit' | 'does-not-fit' | 'unknown', basis, engine, reason, message, plan, projection }

import { getModelResourceProfile } from '@qvac/inference/model-resource-profiles'
```

```typescript
const fit = await assessModelFit({ models })
// {
//   verdict: 'fits' | 'does-not-fit' | 'unknown',
//   pools: [{ id, unified, usedBytes, freeBytes?, totalBytes? }],
//   models: [{
//     status: 'fits' | 'does-not-fit' | 'unknown',
//     devices: [{ id, name, unified, usedBytes, freeBytes?, totalBytes? }],  // host last; [] when unknown
//     stats: { ctxSize, gpuLayers } | {}
//   }]
// }

const { fitProbe } = await getLoadedModelInfo({ modelId })
// { verdict, pools, models }  for that one load

// @qvac/inference/model-resource-profiles is removed.
```

```bash
npm install @qvac/ggml-rpc-server@^0.9.1
```

```typescript
import { assessModelFit, type ModelFitStats, type LlamaFitStats } from '@qvac/sdk'

const { verdict, pools, models } = await assessModelFit({
  models: [
    { modelSrc: QWEN3_4B_INST_Q4_K_M, modelConfig: { ctx_size: 8192 } },
    { modelSrc: WHISPER_TINY }
  ]
})

for (const pool of pools) console.log(pool.id, pool.usedBytes, pool.freeBytes)
const llm = models[0]
if ('ctxSize' in llm.stats) console.log(llm.stats.ctxSize, llm.stats.gpuLayers)
```

---

## SDK caller sessions, model leases and scoped cancellation

PR: [#5541](https://github.com/tetherto/qvac/pull/5541)

```typescript
const unload = (modelId: string): Promise<void> => unloadModel({ modelId })

const diffusionMock: typeof diffusion = () => ({ progressStream, outputs, stats })
```

```typescript
const unload = async (modelId: string): Promise<void> => {
  await unloadModel({ modelId }) // resolves with UnloadModelResult { released, unloaded }
}

const diffusionMock: typeof diffusion = () => ({ requestId: 'r-1', progressStream, outputs, stats })
```

```typescript
import { openSession, close } from '@qvac/sdk'

const a = openSession({ name: 'harness' })
const b = openSession({ name: 'skill-runner' })

const modelId = await a.loadModel({ modelSrc: QWEN3_600M_INST_Q4 })
await b.loadModel({ modelSrc: QWEN3_600M_INST_Q4 }) // same modelId, second lease

const run = a.completion({ modelId, history, stream: true })
await b.cancel({ requestId: run.requestId }) // cancelled: 0, run continues
await a.cancel({ requestId: run.requestId }) // cancels

const img = a.diffusion({ modelId: sdModelId, prompt })
await a.cancel({ requestId: img.requestId }) // diffusion now exposes requestId

await a.unloadModel({ modelId }) // { released: true, unloaded: false }, model stays for b
await a.close() // releases a's remaining leases
await close() // owner shutdown, ends b
```

```kotlin
val session = client.openSession(name = "harness")
val run = session.diffusion(modelId, prompt)
session.cancel(run.requestId)
session.close()
```

```python
async with Client() as client:
    session = await client.open_session(name="harness")
    run = diffusion_stream(session.transport, DiffusionStreamRequest(model_id=model_id, prompt=prompt))
    await cancel(session.transport, request_id=run.request_id)
    await session.close()
```

---

## Named KV cache sessions for /v1/responses

PR: [#5548](https://github.com/tetherto/qvac/pull/5548)

```jsonc
// POST /v1/chat/completions → usage
{
  "prompt_tokens": 120,
  "completion_tokens": 7,
  "total_tokens": 127,
  "prompt_tokens_details": { "cached_tokens": 2569 }
}
```

```jsonc
{ "prompt_tokens": 120, "completion_tokens": 7, "total_tokens": 127 }
```

```jsonc
// POST /v1/responses
{ "model": "qwen9b", "input": "…", "prompt_cache_key": "conversation-1" }
// or header X-QVAC-KV-Cache-Key: conversation-1, or metadata.qvac_kv_cache_key
// → usage: { "input_tokens": 2568, "qvac_cache_tokens": 2569, "output_tokens": 1, "total_tokens": 2569 }
```

---

## Expose the tts-ggml controls and stats the SDK dropped

PR: [#5554](https://github.com/tetherto/qvac/pull/5554)

```typescript
// Chatterbox (load): sampling, prosody, length / streaming cost, pre-baked voice
await loadModel({
  modelSrc: TTS_T3_MULTILINGUAL_CHATTERBOX_Q8_0,
  modelType: 'tts',
  modelConfig: {
    ttsEngine: 'chatterbox',
    language: 'de',
    s3genModelSrc: TTS_S3GEN_MULTILINGUAL_CHATTERBOX,
    temperature: 0.8,
    topK: 1000,
    topP: 0.95,
    repeatPenalty: 1.2,
    exaggeration: 0.7,
    cfgWeight: 0.5,
    minP: 0.05,
    nPredict: 1500,
    maxSentenceChars: 180,
    crossfadeMs: 30,
    batchCfmSteps: 4,
    streamLeftContextTokens: 32,
    voiceDir: '/voices/me'
  }
})

// Supertonic (load): native chunk streaming, external voice, deployment controls
await loadModel({
  modelSrc: TTS_MULTILINGUAL_SUPERTONIC3_Q8_0,
  modelType: 'tts',
  modelConfig: {
    ttsEngine: 'supertonic',
    language: 'en',
    streamChunkTokens: 50,
    streamFirstChunkTokens: 20,
    streamChunkTolerancePct: 20,
    streamMinChunkTokens: 30,
    voiceJsonSrc: '/voices/cloned.json',
    noiseNpySrc: '/voices/noise.npy',
    prewarmText: 'A sentence of representative length.',
    vulkanDevice: -1
  }
})

// CosyVoice3: flowCutPrompt / vulkanDevice at load, instruct per request
const cosy = textToSpeech({
  modelId,
  text: '今天天气真好。',
  stream: false,
  instruct: { dialect: 'cantonese' }
})

// Audio8: switch the cloned voice per request
const audio8 = textToSpeech({
  modelId,
  text: 'Spoken in another voice.',
  stream: false,
  referenceAudioSrc: '/voices/someone-else.wav',
  referenceText: 'Exactly what that recording says.'
})

// Stats: firstAudioMs plus the engines' stage timings and counters
const stats = await cosy.stats
console.log(stats?.firstAudioMs, stats?.lmDecodeMs, stats?.speechTokens, stats?.stageTotalMs)
```

---

## Report input tokens and separate reasoning on /v1/responses

PR: [#5557](https://github.com/tetherto/qvac/pull/5557)

```jsonc
// POST /v1/responses on a <think> model
{
  "output": [
    {
      "type": "reasoning",
      "id": "rs_…",
      "summary": [],
      "content": [{ "type": "reasoning_text", "text": "…" }]
    },
    {
      "type": "message",
      "role": "assistant",
      "content": [{ "type": "output_text", "text": "answer only" }]
    }
  ],
  "usage": { "input_tokens": 120, "output_tokens": 7, "total_tokens": 127 }
}
```

---

## Make /v1/responses work with Codex requests

PR: [#5559](https://github.com/tetherto/qvac/pull/5559)

```json
{
  "model": "qwen9b",
  "input": "What is the project name in package.json?",
  "tools": [
    { "type": "web_search" },
    {
      "type": "namespace",
      "name": "mcp__files",
      "tools": [
        {
          "type": "function",
          "name": "read_file",
          "parameters": { "type": "object", "properties": { "path": { "type": "string" } } }
        }
      ]
    }
  ]
}
```

```json
{
  "type": "function_call",
  "namespace": "mcp__files",
  "name": "read_file",
  "call_id": "call_1",
  "arguments": "{\"path\":\"package.json\"}"
}
```

```json
{
  "type": "response.failed",
  "response": { "status": "failed", "error": { "code": "context_length_exceeded", "message": "…" } }
}
```

---

## Load MOSS-Image JSON layout text-to-image with tokenizerSrc

PR: [#5644](https://github.com/tetherto/qvac/pull/5644)

```typescript
import { close, diffusion, loadModel, unloadModel } from '@qvac/sdk'
import fs from 'fs'

const HF = 'https://huggingface.co'
const mossRepo = `${HF}/Comfy-Org/MOSS-Image/resolve/530a4c94f92c35ef6818b1b035a983fe9dcf5f54`

const modelId = await loadModel({
  modelSrc: `${mossRepo}/diffusion_models/moss_image_sft_bf16.safetensors`,
  modelType: 'sdcpp-generation',
  modelConfig: {
    llmModelSrc: `${HF}/unsloth/Qwen3.5-9B-GGUF/resolve/3885219b6810b007914f3a7950a8d1b469d598a5/Qwen3.5-9B-Q4_K_M.gguf`,
    vaeModelSrc: `${mossRepo}/vae/flux2-vae_small.safetensors`,
    // New in this PR: the Qwen3.5 encoder's external tokenizer.json.
    tokenizerSrc: `${HF}/OpenMOSS-Team/MOSS-Image-SFT/resolve/f972bd4b4b9e3852133cc5da954d87bc32cd8fb9/tokenizer/tokenizer.json`
  }
})

// Boxes are [y_min, x_min, y_max, x_max] in pixels, origin at the canvas centre.
const layout = {
  summary: {
    meta: ['poster'],
    canvas: 'single',
    caption: 'A minimalist travel poster of a snowy mountain at sunrise, flat illustration style.'
  },
  items: [
    {
      label: 'text',
      caption: 'Bold white sans-serif title.',
      text: 'SUMMIT',
      bbox: [-448, -352, -320, 352]
    },
    { label: 'object', caption: 'A snowy mountain peak at sunrise.', bbox: [-224, -320, 384, 320] }
  ],
  bbox_coord_space: 'abs_centralized',
  bbox_format: 'yxyx'
}

const { outputs } = diffusion({
  modelId,
  prompt: JSON.stringify(layout),
  width: 1024,
  height: 1024,
  steps: 50,
  cfg_scale: 3,
  sampling_method: 'euler',
  scheduler: 'discrete',
  seed: 42
})

const [image] = await outputs
fs.writeFileSync('moss_image.png', image!)

await unloadModel({ modelId })
await close()
```

---

## Expose Parakeet backend, speaker attribution and streaming metadata in the SDK

PR: [#5659](https://github.com/tetherto/qvac/pull/5659)

```typescript
const modelId = await loadModel({
  modelSrc: PARAKEET_UNIFIED_0_6B_Q8_0,
  modelType: 'parakeet-transcription',
  modelConfig: {
    backend: 'cpu',
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

for await (const event of session) {
  if (event.type === 'segment')
    console.log(event.segment.tokenIds, event.segment.isFinal, event.segment.chunkIndex)
  if (event.type === 'endOfTurn' && event.source === 'parakeet')
    console.log(event.timestamp, event.confidence)
}
```

---

## Expose the tts-ggml 0.15 backend, Core ML, sampling and replay controls

PR: [#5684](https://github.com/tetherto/qvac/pull/5684)

```typescript
// Every engine: name the backend instead of asking for "the GPU"
await loadModel({
  modelSrc: TTS_MULTILINGUAL_SUPERTONIC3_Q8_0,
  modelType: 'tts',
  modelConfig: {
    ttsEngine: 'supertonic',
    language: 'en',
    backend: 'CUDA0',
    // Supertonic precision / environment / in-memory voice
    precision: 'f16',
    f16Attn: 1,
    f16Weights: -1,
    kvAttnType: 0,
    f16WeightsDenyList: ['vocoder.*'],
    vulkanEnvOverrides: { GGML_VK_PIPELINE_CACHE_DIR: '/cache/vk' },
    voiceStyleTtl: ttl,
    voiceStyleDp: dp,
    // LavaSR enhancer on Core ML (macOS / iOS)
    lavasrEnhancerModelSrc: TTS_ENHANCER_LAVASR_FP16.src,
    lavasrEnhancerCoremlModelPath: '/models/lavasr-enhancer.mlmodelc',
    lavasrEnhancerCoremlComputeUnits: 'CPU_AND_NE'
  }
})

// Parler Core ML sidecars
await loadModel({
  modelSrc: TTS_MINI_V1_EN_PARLER_TTS_Q8_0,
  modelType: 'tts',
  modelConfig: {
    ttsEngine: 'parler',
    coremlDecoder: true,
    coremlComputeUnits: 'cpu_and_ane',
    coremlStrict: false
  }
})
const stats = await result.stats
console.log(stats?.decoderSidecarLoaded, stats?.dacOnCoreml)

// CosyVoice3: reproducible takes and replay
const take = textToSpeech({ modelId, text: 'Hello.', stream: false })
await take.buffer
const tokens = await take.speechTokenIds // number[] | undefined
await loadModel({
  modelSrc: TTS_COSYVOICE3_LLM_COSYVOICE_Q8_0,
  modelType: 'tts',
  modelConfig: { ttsEngine: 'cosyvoice3', greedy: true, forceSpeechTokens: tokens }
})

// MOSS: budgets and separate text / audio samplers
await loadModel({
  modelSrc: TTS_DELAY_LLM_MOSS_TTS_F16,
  modelType: 'tts',
  modelConfig: {
    ttsEngine: 'moss',
    mossCodecDecoderModelSrc: TTS_CODEC_DECODER_MOSS_TTS_F16,
    nCtx: 8192,
    maxNewTokens: 4096,
    durationTokens: 3000,
    textTemperature: 0.7,
    textTopP: 0.9,
    textTopK: 40,
    audioTemperature: 0.8,
    audioTopP: 0.95,
    audioTopK: 50,
    audioRepetitionPenalty: 1.1
  }
})
```

---

## Let QVAC processes share the model registry store

PR: [#5707](https://github.com/tetherto/qvac/pull/5707)

```typescript
import { modelRegistrySearch, cancel, ModelRegistryBusyError } from '@qvac/sdk'

const search = modelRegistrySearch({ addon: 'llm' }) // Promise & { requestId }
stopButton.onclick = () => cancel({ requestId: search.requestId })

try {
  const models = await search
} catch (err) {
  if (err instanceof ModelRegistryBusyError) {
    // err.holder: 'current' | 'legacy', err.waitedMs: number
  }
}
```

---

## `qvac serve` routes, fields and error codes added in this release

The sections above show each feature through the PR's own example. This is the HTTP surface they add, by route.

- **Runtime** ([#5426](https://github.com/tetherto/qvac/pull/5426))
  - `GET /qvac/v1/runtime/state` reads the lifecycle state and answers while the runtime is suspended.
  - `GET /qvac/v1/runtime/models` lists the `serve.models` aliases whose model is loaded.
  - `POST /qvac/v1/runtime/suspend` and `POST /qvac/v1/runtime/resume` are admin-only. Start the server with `--enable-admin` or set `serve.enableAdmin` in the config file; otherwise they answer `403 admin_disabled`. A browser request from an origin outside the CORS allowlist answers `403 origin_not_allowed`.
  - While the runtime is not active, every other route answers `503 runtime_suspended`.
  - `--enable-admin` on a non-loopback host needs `--api-key` or `--api-key-file`, even with `--allow-unauthenticated`.
- **World scenes** ([#5421](https://github.com/tetherto/qvac/pull/5421)): `GET /qvac/v1/world/scenes/:id` reads a scene. Creating a scene accepts `width`, `height` and `returnPack`, and a step accepts `stream`.
- **`POST /v1/responses`**
  - A tool type the server does not run (such as `web_search`) is skipped instead of answering `400 invalid_tool_type`. A malformed `namespace` tool answers `400 invalid_tools`. Input items shaped `{ "role", "content" }` are accepted without `type` ([#5559](https://github.com/tetherto/qvac/pull/5559)).
  - `system` and `developer` turns are merged into one leading `system` turn, on `/v1/chat/completions` as well ([#5559](https://github.com/tetherto/qvac/pull/5559)).
  - A KV cache key sent more than once answers `400 invalid_kv_cache_key`. CORS allows the `X-QVAC-KV-Cache-Key` header, and `DELETE /qvac/v1/kv_cache` also clears the Responses caches ([#5548](https://github.com/tetherto/qvac/pull/5548)).
- **`POST /v1/audio/transcriptions`** ([#5468](https://github.com/tetherto/qvac/pull/5468)): `verbose_json` carries a top-level `language`, and per segment `language`, `no_speech_prob`, `speaker_turn_next` and `token_timestamps` when the whisper engine reports them.
- **`POST /v1/audio/speech`** ([#5554](https://github.com/tetherto/qvac/pull/5554)): `instructions` is forwarded to a CosyVoice3 alias as `instruct` when the alias configures no conditioning of its own. On every other engine it stays an ignored parameter.
- **Registry routes** ([#5707](https://github.com/tetherto/qvac/pull/5707)): answer `503 registry_busy` when another process holds the registry store, with `Retry-After: 5` when that holder is a current-version process.
- **`serve.models` config**
  - A model constant name is resolved in every `*Src` key and `*Srcs` list of an alias's `config`, not only in `*ModelSrc` keys ([#5644](https://github.com/tetherto/qvac/pull/5644)).
  - `ggml-image-embedding` is an accepted alias `type` ([#5551](https://github.com/tetherto/qvac/pull/5551)). No HTTP route serves image embeddings yet.

---
