# 🔌 API Changes v0.24.0

## Run the SDK worker on bare-stow

PR: [#5186](https://github.com/tetherto/qvac/pull/5186)

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

## Seed a new chat from an existing cache

PR: [#5291](https://github.com/tetherto/qvac/pull/5291)

```typescript
// Seeding needs prefix sharing enabled at load; without it the request throws KvCacheSeedSharingDisabledError.
const modelId = await loadModel({ modelSrc, modelType: 'llm', modelConfig: { cache_share_across_keys: true } })

await completion({ modelId, history: systemAndTools, stream: false, kvCache: 'base', prefill: true }).final

completion({
  modelId,
  history: [...systemAndTools, { role: 'user', content: 'First question' }],
  stream: true,
  kvCache: 'chat-2',
  seedFrom: 'base'
})
```

---

## Add chunked Int16Array output to textToSpeech

PR: [#5348](https://github.com/tetherto/qvac/pull/5348)

```ts
const result = textToSpeech({ modelId, text })
for await (const chunk of result.chunkStream) {
  // iterating chunkStream starts the run; sampleRate resolves with the first frame
  const sampleRate = await result.sampleRate
  // chunk: Int16Array of signed 16-bit samples, one per engine frame (one per sentence with sentenceStream: true)
  play(chunk, sampleRate)
}
```

---

## Replace JSON PCM transport with binary audio transport

PR: [#5380](https://github.com/tetherto/qvac/pull/5380)

```json
{ "type": "textToSpeech", "buffer": [], "pcm": "AQD///9/AIA=", "done": false, "sampleRate": 44100 }
```

---

## Keep backend fields on streamed TTS stats and put the audiogen GPU fallback code on the wire

PR: [#5384](https://github.com/tetherto/qvac/pull/5384)

```ts
// SDK: tell a GPU fallback from a slow run
const run = audioGen({ modelId, caption: "warm cinematic piano" });
const stats = await run.stats;
stats?.backendDevice; // 0 CPU, 1 GPU, as before
stats?.gpuFallbackReason; // new: 0 none, 1 not requested, 2 no devices, 3 init failed
(await run.diagnostics)?.fallback?.reason; // "no-devices" | "init-failed", as before
```

---

## Support EmbeddingGemma 2 multimodal embeddings

PR: [#5464](https://github.com/tetherto/qvac/pull/5464)

```kotlin
import io.tether.qvac.sdk.generated.schema.EmbedRequest
import io.tether.qvac.sdk.generated.schema.EmbedTextRequest
import io.tether.qvac.sdk.generated.schema.EmbedTextRequestText

val request = EmbedRequest.EmbedTextRequest(
    EmbedTextRequest(
        modelId = "m",
        text = EmbedTextRequestText.Variant1("hi"),
        requestId = "embed-1",
    ),
)
```

```python
from tetherto.qvac_sdk import EmbedRequest

request = EmbedRequest(model_id="m", text="hi", request_id="embed-1")
model_id = request.root.model_id
text = request.root.text
request_id = request.root.request_id
```

```typescript
const { embedding } = await embedBatch({
  modelId,
  inputs: [
    'task: search result | query: an elephant',
    [{ media: { type: 'filePath', value: '/path/to/elephant.jpg' } }]
  ]
})
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
  segment.language        // detected language, e.g. 'en'
  segment.noSpeechProb    // 0–1
  segment.speakerTurnNext // true when a speaker turn follows
  for (const token of segment.tokens ?? []) {
    const { text, startMs, endMs, probability }: TranscribeToken = token
  }
}
```

---

## Expose parakeet energy-VAD tuning and prewarm controls in the SDK

PR: [#5478](https://github.com/tetherto/qvac/pull/5478)

```typescript
import { loadModel, transcribeStream, PARAKEET_TDT_0_6B_V3_Q8_0 } from '@qvac/sdk'

const modelId = await loadModel({
  modelSrc: PARAKEET_TDT_0_6B_V3_Q8_0,
  modelType: 'parakeet-transcription',
  modelConfig: {
    useGPU: true,
    streaming: true,
    prewarm: true,                      // encoder pass at load, not on the first request
    prewarmAudioSeconds: 2,             // length of that pass in seconds (default 1)
    streamingEnergyVad: true,           // { type: 'vad', source: 'energy' } events
    streamingEnergyVadThresholdDb: -40, // speech threshold in dBFS RMS (default -35)
    streamingEnergyVadWindowMs: 50,     // RMS window in ms (default 30, capped at 1000)
    streamingEnergyVadHangoverMs: 300   // silence before leaving "speaking" (default 200)
  }
})

// Per-session overrides of the three detector knobs
const session = await transcribeStream({
  modelId,
  parakeetStreamingConfig: {
    emitEnergyVad: true,
    energyVadThresholdDb: -35,
    energyVadWindowMs: 30,
    energyVadHangoverMs: 200
  }
})
```

---

## Expose MegaLoc image embeddings through SDK

PR: [#5499](https://github.com/tetherto/qvac/pull/5499)

```typescript
const modelId = await loadModel({
  modelSrc: 'https://models.example.com/megaloc-f16.gguf',
  modelType: ModelType.ggmlImageEmbedding
})
try {
  const { embedding } = await embed({ modelId, input: { image: jpegOrPngBytes } })
} finally {
  await unloadModel({ modelId })
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
CompletionStreamRequestHistoryItem(
    role = "user",
    content = CompletionStreamRequestHistoryItemContent.Variant1("Hello"),
)
```

---

## Expose MOSS backend, ASR stats and VAD timestamp fields in the SDK

PR: [#5510](https://github.com/tetherto/qvac/pull/5510)

```typescript
import { loadModel, transcribe, transcribeStream, MOSS_TRANSCRIBE_DIARIZE_Q8_0 } from '@qvac/sdk'

const mossId = await loadModel({
  modelSrc: MOSS_TRANSCRIBE_DIARIZE_Q8_0,
  modelConfig: { backend: 'cuda' } // explicit device; fails at load if unavailable
})
const run = transcribe({ modelId: mossId, audioChunk: 'meeting.wav', metadata: true })
await run
const stats = await run.stats
stats?.totalSegments   // MOSS output segments
stats?.encoderTime     // audio-encoder time, ms
stats?.prefillTime     // prompt prefill time, ms (MOSS only)
stats?.decoderTime     // decode time, ms
stats?.audioTokens     // MOSS only
stats?.promptTokens    // MOSS only
stats?.generatedTokens // MOSS only

const session = await transcribeStream({ modelId: parakeetId, emitVadEvents: true })
for await (const event of session) {
  if (event.type === 'vad') event.timestamp // seconds from the session start
}
;(await session.stats)?.aoscActive // 1 when the Sortformer v2.1 speaker cache was active
```

---

## Answer model fit from the addons' per-device memory

PR: [#5512](https://github.com/tetherto/qvac/pull/5512)

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
npm install @qvac/ggml-rpc-server@^0.9.0
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

## Resume paused registry downloads and reclaim abandoned ones

PR: [#5534](https://github.com/tetherto/qvac/pull/5534)

```typescript
cancel({ requestId }) // pause: blocks kept, next load resumes
await deleteCache({ modelSrc: QWEN3_600M_INST_Q4.src }) // discard a paused or cached download
```

---

## SDK caller sessions, model leases and scoped cancellation

PR: [#5541](https://github.com/tetherto/qvac/pull/5541)

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
await a.close()                  // releases a's remaining leases
await close()                    // owner shutdown, ends b
```

The Kotlin and Python forms are under [Kotlin client](#kotlin-client) and [Python client](#python-client) below.

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
    temperature: 0.8, topK: 1000, topP: 0.95, repeatPenalty: 1.2,
    exaggeration: 0.7, cfgWeight: 0.5, minP: 0.05,
    nPredict: 1500, maxSentenceChars: 180, crossfadeMs: 30,
    batchCfmSteps: 4, streamLeftContextTokens: 32,
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
    streamChunkTokens: 50, streamFirstChunkTokens: 20,
    streamChunkTolerancePct: 20, streamMinChunkTokens: 30,
    voiceJsonSrc: '/voices/cloned.json', noiseNpySrc: '/voices/noise.npy',
    prewarmText: 'A sentence of representative length.', vulkanDevice: -1
  }
})

// CosyVoice3: flowCutPrompt / vulkanDevice at load, instruct per request
const cosy = textToSpeech({ modelId, text: '今天天气真好。', stream: false, instruct: { dialect: 'cantonese' } })

// Audio8: switch the cloned voice per request
const audio8 = textToSpeech({
  modelId, text: 'Spoken in another voice.', stream: false,
  referenceAudioSrc: '/voices/someone-else.wav',
  referenceText: 'Exactly what that recording says.'
})

// Stats: firstAudioMs plus the engines' stage timings and counters
const stats = await cosy.stats
console.log(stats?.firstAudioMs, stats?.lmDecodeMs, stats?.speechTokens, stats?.stageTotalMs)
```

---

## Cache SDK e2e models per model and restore only what each leg runs

PR: [#5556](https://github.com/tetherto/qvac/pull/5556)

```typescript
import { createHash } from 'node:crypto'
import { models } from '@qvac/inference/models'
import { getModelCacheLayout } from '@qvac/inference/model-cache-layout'

const shortHash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)
const layout = getModelCacheLayout(models[0], 'darwin', shortHash)
// { path: 'sets/<key>' | '<hash>_<file>', files: [{ path, size, sha256 }] }, or undefined
```

---

## Add SDK support for Qwen-Image-2.1-Turbo

PR: [#5576](https://github.com/tetherto/qvac/pull/5576)

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
const [png] = await outputs
```

---

## Add chunkStream, encoded output and MiniMax Core ML to audioGen

PR: [#5604](https://github.com/tetherto/qvac/pull/5604)

```typescript
const run = audioGen({ modelId, caption: "ambient electronic music", outputFormat: "flac" });

// The PCM as Int16Array chunks, next to the existing `run.audio` promise.
for await (const samples of run.chunkStream) {
  player.write(samples);
}

// The same run as a file; `undefined` when no `outputFormat` was named.
const file = await run.encoded;
if (file) await writeFile(`track.${file.extension}`, file.data);

// MiniMax-Music3 through a compiled full Core ML profile (macOS 15+).
await loadModel({
  modelType: "audiogen",
  modelConfig: {
    engine: "minimax",
    lmModelSrc: "/models/mm3-lm-f16.gguf",
    synthModelSrc: "/models/mm3-synth-f16.gguf",
    coremlProfileDir: "/models/minimax-coreml",
    coremlComputeUnits: "CPU_AND_NE",
  },
});
```

---

## Report AMD APU memory and GPU carve-outs from bare-gpu-info 0.1.3

PR: [#5612](https://github.com/tetherto/qvac/pull/5612)

```typescript
import { getSystemResources } from '@qvac/sdk'

const { capabilities, sample } = await getSystemResources({ sample: true })

if (capabilities.gpus.status === 'supported') {
  for (const gpu of capabilities.gpus.value) {
    // An integrated GPU's carve-out, or all of a discrete GPU's memory
    console.log(gpu.dedicatedMemoryTotalBytes)
  }
}
if (sample?.gpus.status === 'supported') {
  for (const gpu of sample.gpus.value) {
    // How much of it is in use
    console.log(gpu.dedicatedMemoryUsedBytes)
  }
}
```

---

## Support device 'npu' for the AMD XDNA NPU in the SDK

PR: [#5635](https://github.com/tetherto/qvac/pull/5635)

```typescript
const modelId = await loadModel({
  modelSrc: QWEN3_5_0_8B_MULTIMODAL_Q4_K_M,
  modelType: 'llm',
  modelConfig: { device: 'npu' }
})
// completion stats report backendDevice: 'npu'
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
    { label: 'text', caption: 'Bold white sans-serif title.', text: 'SUMMIT', bbox: [-448, -352, -320, 352] },
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
for (const { speakerId, startMs, endMs, text } of await transcribe({ modelId, audioChunk, metadata: true })) {
  console.log(speakerId, startMs, endMs, text)
}

for await (const event of session) {
  if (event.type === 'segment') console.log(event.segment.tokenIds, event.segment.isFinal, event.segment.chunkIndex)
  if (event.type === 'endOfTurn' && event.source === 'parakeet') console.log(event.timestamp, event.confidence)
}
```

---

## Expose calcTokens in the SDK

PR: [#5663](https://github.com/tetherto/qvac/pull/5663)

```ts
const tokens = await calcTokens({
  modelId,
  history: [{ role: 'user', content: 'Summarize this document.' }],
  tools
})
```

---

## Let completion requests set tool_search limits

PR: [#5669](https://github.com/tetherto/qvac/pull/5669)

```typescript
const params = { modelId, tools, toolSearch: { defaultLimit: 1, maxLimit: 2 } }
const run = completion({ ...params, history, stream: true })
// running the search yourself:
history.push({ role: 'tool', content: executeToolSearch(params, call.arguments, history) })
```

---

## Expose ACE-Step backend selection and the audiogen Core ML sidecars

PR: [#5673](https://github.com/tetherto/qvac/pull/5673)

```typescript
// ACE-Step: name the pipeline backend and the LM backend independently.
await loadModel({
  modelType: "audiogen",
  modelConfig: {
    textEncModelSrc: AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0,
    lmModelSrc: AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0,
    ditModelSrc: AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M,
    vaeModelSrc: AUDIOGEN_VAE_BF16, // on macOS and iOS its Core ML decoder is staged with it
    backend: "CUDA0", // the load fails when the host cannot provide it
    lmBackend: "cpu",
    dumpStagesDir: "/tmp/acestep-stages", // diagnostics: an existing directory
  },
});

// MiniMax-Music3: the conditioner alone through Core ML (macOS).
await loadModel({
  modelType: "audiogen",
  modelConfig: {
    engine: "minimax",
    lmModelSrc: "/models/mm3-lm-q8.gguf",
    synthModelSrc: "/models/mm3-synth-q8.gguf",
    device: "gpu",
    coremlConditionerPath: "/models/minimax-conditioner.mlmodelc",
  },
});
```

---

## Add TranscribePsy-250M-EU support to the SDK

PR: [#5683](https://github.com/tetherto/qvac/pull/5683)

```
PARAKEET_TRANSCRIBEPSY_250M_EU_Q8_0
```

```typescript
const modelId = await loadModel({
  modelSrc: PARAKEET_TRANSCRIBEPSY_250M_EU_Q8_0, // 25 European languages, ggml everywhere
  modelType: 'parakeet-transcription',
  modelConfig: { language: 'other' } // 'en' (English trunk) | 'other' (adapters) | 'auto' (default)
})
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
    precision: 'f16', f16Attn: 1, f16Weights: -1, kvAttnType: 0,
    f16WeightsDenyList: ['vocoder.*'],
    vulkanEnvOverrides: { GGML_VK_PIPELINE_CACHE_DIR: '/cache/vk' },
    voiceStyleTtl: ttl, voiceStyleDp: dp,
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
  modelConfig: { ttsEngine: 'parler', coremlDecoder: true, coremlComputeUnits: 'cpu_and_ane', coremlStrict: false }
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
    nCtx: 8192, maxNewTokens: 4096, durationTokens: 3000,
    textTemperature: 0.7, textTopP: 0.9, textTopK: 40,
    audioTemperature: 0.8, audioTopP: 0.95, audioTopK: 50, audioRepetitionPenalty: 1.1
  }
})
```

---

## Expose TurboVec calibration and staged search controls

PR: [#5691](https://github.com/tetherto/qvac/pull/5691)

```typescript
import { createVectorIndex, VectorIndexStorage } from '@qvac/sdk'

await using index = await createVectorIndex({
  dim: 2048,
  storage: VectorIndexStorage.TURBOVEC_Q4
})
console.log(index.calibrated)
await index.setStagedSearch({ enabled: true })
console.log(index.stagedSearch)
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

## Other additions in this release

Surface the sections above do not show, by feature.

- **Embeddings** ([#5499](https://github.com/tetherto/qvac/pull/5499), [#5464](https://github.com/tetherto/qvac/pull/5464))
  - `embedBatch({ modelId, inputs })` returns one vector per input, and `embed({ modelId, input })` embeds one text, one list of text and media parts, or one image (`{ image: bytes }`).
  - `embed({ text: string[] })` and `embed({ inputs })` are deprecated in favour of `embedBatch` and log a warning.
  - `ModelType.ggmlImageEmbedding` loads an image-embedding model. Its load config takes `backend`, `threads` and `backendsDir`, and its stats report `backendId`, `cpuFallbackNodes` and `weightBytes`. The plugin is exported at `@qvac/sdk/ggml-image-embedding/plugin` and is part of the default plugin set.
  - The `llamacpp-embedding` load config gains `projectionModelSrc`, `ctxSize`, `imageMinTokens`, `imageMaxTokens`, `imageMaxMegapixels`, `audioMaxSeconds`, `mmprojNoAudio` and `mmprojUseGpu`. Media inputs need `projectionModelSrc`.
- **Sessions, leases and cancellation** ([#5541](https://github.com/tetherto/qvac/pull/5541))
  - New error classes: `SessionInvalidatedError` (50208), `ModelHandleInvalidatedError` (50209), `SessionIdConflictError` (53620), `SessionNotOpenError` (53621), `ModelLeasedError` (53622), `OwnerOnlyError` (53623), `ModelReconfiguredError` (53624) and `RAGWorkspaceBusyError` (52812).
  - `requestId` is on the results of `classify`, `ocr`, `upscale`, `vla`, `invokePlugin`, `invokePluginStream` and every `VectorIndex` method, so each can be cancelled. `invokePlugin` and `invokePluginStream` also accept one.
  - `cancel` accepts the kinds `classification`, `plugin`, `vectorIndex`, `imageEmbedding` and `modelRegistry`.
  - `QvacSession` exposes `sessionId`, `opened` and `isModelHeld()`, `LoadedModelInfo` gains `leaseCount`, and `RPCOptions` gains `sessionId`.
  - `cancel`, `deleteCache`, `unloadModel`, `diffusion`, `audioGen`, `video`, `heartbeat`, `state`, `suspend`, `resume`, `getModelInfo`, `getSystemResources`, `assessModelFit`, `subscribeServerLogs` and the `modelRegistry*` calls take a trailing `options?: RPCOptions`.
  - Plugin authors: handlers receive a third `context` argument (`PluginHandlerContext`), and `requestParent` is exported.
- **Completion**
  - `cache_share_across_keys` (load config, default `false`) lets a request reuse a prompt prefix held by another conversation on the same model. `seedFrom` needs it ([#5291](https://github.com/tetherto/qvac/pull/5291)).
  - New error classes: `InvalidSeedFromParamsError` (53204), `KvCacheSeedSourceNotFoundError` (53205) and `KvCacheSeedSharingDisabledError` (53206).
  - `resolveToolSearchSource`, `ToolSearchSource` and `ToolSearchOptions` are exported, and batch prompts accept `toolSearch` ([#5669](https://github.com/tetherto/qvac/pull/5669)).
- **Audio**
  - `AudioEncodeFailedError` (52424), `AUDIOGEN_OUTPUT_FORMATS` and `AUDIOGEN_MINIMAX_COREML_COMPUTE_UNITS`; an encoded result carries `mimeType` and `format`, and stats carry `encodeError` ([#5604](https://github.com/tetherto/qvac/pull/5604)).
  - `TTS_PARLER_COREML_COMPUTE_UNITS`, `TTS_LAVASR_COREML_COMPUTE_UNITS` and `TTS_SUPERTONIC_PRECISIONS`; `lavasrDenoiserCoremlModelPath` and `lavasrDenoiserCoremlComputeUnits`; stats `denoiserBackendDevice`, `denoiserBackendId`, `dacSidecarLoaded` and `decoderOnCoreml` ([#5684](https://github.com/tetherto/qvac/pull/5684)).
  - Parakeet `speakerAttribution` takes `mergeSameSpeaker` and `minSegmentMs`, segments carry `eotConfidence`, and `vad` and `endOfTurn` events carry `chunkIndex` ([#5659](https://github.com/tetherto/qvac/pull/5659)).
- **Images and vectors**
  - `vae_tile_size` on diffusion requests ([#5576](https://github.com/tetherto/qvac/pull/5576)).
  - The TurboVec maximum dimension is 16384, up from 1024 ([#5691](https://github.com/tetherto/qvac/pull/5691)).
- **Model registry**: a busy registry store reports code `QVAC_MODEL_REGISTRY_BUSY` (53952) ([#5707](https://github.com/tetherto/qvac/pull/5707)).
- **Plugin authors**: `QvacPlugin.fitRequest` is new ([#5512](https://github.com/tetherto/qvac/pull/5512)).

---

## Client libraries

The Python client (`tetherto-qvac-sdk`) and the Kotlin client (`io.tether:qvac-sdk-kotlin` and the `io.tether:qvac-sdk-android` AARs) ship at the SDK's version. Their generated request and response types gain every field the sections above add; the entries below are the hand-written surface and the calls that differ from TypeScript.

### Python client

#### Caller sessions, model leases and scoped cancel

`Client.open_session(name=None)` returns a `Session`. Pass `session.transport` wherever a function takes a transport. Only the `Client`'s exit stops the runtime, and it ends every session.

```python
from tetherto.qvac_sdk import Client, cancel, completion, load_model, unload_model
from tetherto.qvac_sdk.models import QWEN3_600M_INST_Q4

async with Client() as client:
    harness = await client.open_session(name="harness")
    skill_runner = await client.open_session(name="skill-runner")

    model_id = await load_model(harness.transport, model_src=QWEN3_600M_INST_Q4)
    await load_model(skill_runner.transport, model_src=QWEN3_600M_INST_Q4)  # same id, second lease

    run = completion(
        harness.transport,
        model_id=model_id,
        history=[{"role": "user", "content": "Write a long essay about the history of Rome."}],
    )
    await cancel(skill_runner.transport, request_id=run.request_id)  # not its request: the run continues
    await cancel(harness.transport, request_id=run.request_id)  # cancels

    await unload_model(harness.transport, model_id)  # releases harness's lease; the model stays for skill_runner
    await skill_runner.close()  # releases the last lease
    await harness.close()
```

- `Session` exposes `transport`, `session_id`, `name`, `is_model_held()` and `close()`, and is an async context manager.
- `suspend`, `resume`, `delete_cache`, `start_rpc_server`, `stop_rpc_server` and opening or closing a session are owner-only: on a session transport they raise `OwnerOnlyError`.
- New error classes: `SessionIdConflictError`, `SessionNotOpenError`, `SessionInvalidatedError`, `ModelLeasedError`, `ModelReconfiguredError`, `ModelHandleInvalidatedError`, `OwnerOnlyError` and `RagWorkspaceBusyError`.
- `UnloadModelResponse` gains `released`, `unloaded` and `has_open_sessions`, and `LoadedModelInfo` gains `lease_count`. `unload_model()` still returns `None`.
- `invoke_plugin()` and `invoke_plugin_stream()` take `request_id`.

#### Worker lifecycle errors

```python
from tetherto.qvac_sdk import Client, WorkerCrashedError, WorkerStartupError

try:
    async with Client(config={"rpcInitTimeoutMs": 120_000}) as client:
        ...
except WorkerStartupError as error:
    print(error.timed_out, error.exit_code, error.signal)
except WorkerCrashedError as error:
    print(error.exit_code, error.signal)
```

`Client(worker_path=...)` accepts a folder written by `qvac bundle sdk --language python`.

#### `completion(seed_from=)` and `completion(tool_search=)`

```python
await completion(t, model_id=model_id, history=system_and_tools, stream=False, kv_cache="base", prefill=True).final

run = completion(
    t,
    model_id=model_id,
    history=[*system_and_tools, {"role": "user", "content": "First question"}],
    kv_cache="chat-2",
    seed_from="base",
    tools=tools,
    tool_search={"default_limit": 1, "max_limit": 2},
)
```

#### `calc_tokens` (raw stub)

```python
from tetherto.qvac_sdk import CalcTokensRequest, calc_tokens

result = await calc_tokens(
    t,
    CalcTokensRequest.model_validate(
        {
            "modelId": model_id,
            "history": [{"role": "system", "content": "You are a helpful assistant."}],
            "text": "Summarize this conversation.",
        }
    ),
)
print(result.tokens)
```

#### Multimodal and image embeddings

`EmbedRequest` accepts `inputs` (text and media parts) as well as `text`, and `embed_batch(transport, EmbedBatchRequest)` returns one vector per input. `model_type="ggml-image-embedding"` loads MegaLoc.

```python
from tetherto.qvac_sdk import EmbedRequest, embed

response = await embed(
    t,
    EmbedRequest(
        model_id=model_id,
        inputs=[
            "task: search result | query: an elephant",
            [{"media": {"type": "filePath", "value": "/path/to/elephant.jpg"}}],
        ],
    ),
)
```

#### Model fit from per-device memory

```python
result = await assess_model_fit(
    t,
    models=[
        {"model_src": QWEN3_600M_INST_Q4, "model_type": "llamacpp-completion", "model_config": {"ctx_size": 8192}},
    ],
)
print(result.verdict.value)
for model in result.models:
    print(model.status.value, [(device.name, device.used_bytes) for device in model.devices])
for pool in result.pools:
    print(pool.id, pool.used_bytes, pool.free_bytes)
```

#### Registry downloads and the shared registry store

```python
from tetherto.qvac_sdk import ModelRegistryBusyError, delete_cache, model_registry_search

await delete_cache(t, model_src=QWEN3_600M_INST_Q4.src)  # discard a paused or cached download
try:
    models = await model_registry_search(t, addon="llm")
except ModelRegistryBusyError as error:
    print(error.holder, error.waited_ms)
```

#### Ordered text and media content in history

```python
run = completion(
    t,
    model_id=model_id,
    history=[
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "First:"},
                {"type": "media", "path": "/images/a.jpg"},
                {"type": "text", "text": "Second:"},
                {"type": "media", "path": "/images/b.jpg"},
            ],
        }
    ],
)
```

#### Generated stubs send their constant labels

`type`, `operation` and `modelType` are always sent, so a request such as `HeartbeatRequest()` no longer needs `type=`.

### Kotlin client

#### Caller sessions, model leases and scoped cancel

`client.openSession(name)` returns a `QvacSession`. A session has the same `models`, `completion`, `speech`, `vision`, `media` and `embeddings` accessors as the client. `suspend`, `resume`, `deleteCache`, `startRpcServer`, `stopRpcServer` and the `system` accessor stay on `QvacClient`.

```kotlin
val harness = client.openSession(name = "harness")
val skillRunner = client.openSession(name = "skill-runner")

val model = Models.QWEN3_600M_INST_Q4
val loaded = harness.models.load(source = model.src, modelType = model.engine, modelName = model.name)
val modelId = loaded.modelId ?: error(loaded.error ?: "loadModel failed")
skillRunner.models.load(source = model.src, modelType = model.engine, modelName = model.name) // same id, second lease

val run = harness.completion.run(
    modelId = modelId,
    history = listOf(QvacMessage.user("Write a long essay about the history of Rome.")),
)
run.cancel() // a session cancels only its own requests

val unloaded = harness.models.unload(modelId) // released = true, unloaded = false: the model stays for skillRunner
skillRunner.close() // releases the last lease
harness.close()
client.close() // owner shutdown, ends every session
```

- Media and vision runs expose `requestId`, and `media.audio`, `media.diffusion`, `media.video`, `media.upscale`, `vision.ocr` and `vision.classify` accept one.
- New exceptions: `QvacSessionClosedException`, `QvacModelHandleInvalidatedException` and `QvacOwnerOnlyException`.
- `UnloadModelResponse` gains `released`, `unloaded` and `hasOpenSessions`, and `LoadedModelInfo` gains `leaseCount`.

#### Ordered text and media parts

```kotlin
QvacMessage.user(
    listOf(
        QvacContentPart.Text("Image A: "),
        QvacContentPart.Media("/images/a.jpg"),
    ),
)
```

#### Seed a chat from another cache

```kotlin
client.completion.run(
    modelId = modelId,
    history = history,
    options = QvacCompletionOptions(kvCache = QvacKvCache.Key("chat-2"), seedFrom = "base"),
)
```

#### Deferred tools and `tool_search` limits

`QvacTool` gains `deferLoading` and `group`, and `QvacCompletionOptions.toolSearch` takes a `QvacToolSearchLimits`. Deferred tools work with `orchestrate()`.

```kotlin
client.completion.orchestrate(
    modelId,
    history,
    tools,
    options = QvacCompletionOptions(toolSearch = QvacToolSearchLimits(defaultLimit = 1, maxLimit = 2)),
)
```

#### `calcTokens`

```kotlin
val tokens = client.calcTokens(CalcTokensRequest(modelId = modelId, text = "Hello")).tokens
```

#### Multimodal and image embeddings

`EmbedRequest` is a sealed type with `EmbedTextRequest`, `EmbedInputsRequest` and `EmbedSingleRequest` variants, and `embedBatch` returns one vector per input. `QvacCapability.IMAGE_EMBEDDINGS` and `ModelType.ggmlImageEmbedding` are new. Of the published Android profiles, only the all-in-one `qvac-sdk-android` carries the image-embedding plugin.

#### Model fit from per-device memory

`client.models.assessFit(AssessModelFitRequest(models))` returns `verdict`, `pools` and, per model, `status`, `devices` and `stats`.

#### Desktop JVM host (experimental)

`JvmBareKitTransport.connect()` from the `:jvm-barekit` module runs a worker on a desktop JVM. The module is built from the repository and is not published.

```kotlin
val client = QvacClient(JvmBareKitTransport.connect())
try {
    println(client.heartbeat())
} finally {
    client.close()
}
```

#### Examples and packaging

- About 100 runnable examples live in `packages/sdk-kotlin/examples/` (`./gradlew -p examples run -Pexample=<Name>`).
- Each `sdk-v<version>` GitHub release carries one Maven repository zip per Android runtime profile plus the JVM client. Extract a zip and point a `maven { url = uri(...) }` repository at the folder. The checksum asset is named `qvac-sdk-kotlin-<version>-SHA256SUMS`.

---

