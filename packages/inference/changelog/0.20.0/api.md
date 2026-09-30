# 🔌 API Changes v0.20.0

## Integrate MiniMax-H3 video generation across inference and SDK

PR: [#4351](https://github.com/tetherto/qvac/pull/4351)

```ts
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

---

## Add ABot-World interactive world sessions to the SDK

PR: [#3812](https://github.com/tetherto/qvac/pull/3812)

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

const { scene } = worldCreateScene({ modelId, prompt, image, returnPack: true })
fs.writeFileSync('world.safetensors', await scene)

const { frameStream } = worldStep({ modelId, keys: ['W', 'L'] })
for await (const frame of frameStream) render(frame)
```

---

## Add Nemotron SDK support

PR: [#4357](https://github.com/tetherto/qvac/pull/4357)

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

```
PARAKEET_NEMOTRON_0_6B_F16
PARAKEET_NEMOTRON_0_6B_Q4_0
PARAKEET_NEMOTRON_0_6B_Q8_0
```

---

## Adopt @qvac/audiogen-ggml 0.4.0 and expose the rest of its surface

PR: [#4406](https://github.com/tetherto/qvac/pull/4406)

```typescript
// Describe a clip, then re-synthesize it from the recovered codes.
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

---

## Close the SDK gaps against @qvac/tts-ggml 0.8.x

PR: [#4414](https://github.com/tetherto/qvac/pull/4414)

```typescript
// Load-time options that were unreachable before
await loadModel({
  modelSrc: TTS_COSYVOICE3_LLM_COSYVOICE_Q8_0,
  modelType: 'tts',
  modelConfig: {
    ttsEngine: 'cosyvoice3',
    referenceAudioSrc: '/path/to/reference.wav',
    cosyvoice3S3tokModelSrc: TTS_COSYVOICE3_S3TOK_COSYVOICE_Q8_0.src,
    cosyvoice3CampplusModelSrc: TTS_COSYVOICE3_CAMPPLUS_COSYVOICE_FP32.src,
    promptText: 'Exactly what the reference recording says.', // omit for cross-lingual
    lavasrEnhancerModelSrc: TTS_ENHANCER_LAVASR_FP16.src
  }
})
// Likewise: Chatterbox { outputSampleRate, ttsSpeed, nCtx, kvCacheType },
// Supertonic { pace, threads, nGpuLayers, seed }, Parler { lavasr*ModelSrc },
// all engines { backendsDir } (+ openclCacheDir where the engine reads it).

// New result surface
const result = textToSpeech({ modelId, text })
const sampleRate = await result.sampleRate // resolves on the first frame; 48000 with the enhancer
for await (const sample of result.bufferStream) play(sample)
const stats = await result.stats // realTimeFactor, backendId, generatedFrames, …
await cancel({ requestId: result.requestId }) // stops the engine, not just delivery
;(await result.stopReason) === 'cancelled'

// Response frames: sampleRate, chunkIndex, sentenceChunk, isLast; terminal frame: stats, stopReason
// New root exports: TTS_ENGINES, TtsEngine, TTS_PARLER_EMOTIONS, TTS_SENTENCE_DELIMITER_PRESETS,
// TTS_CHATTERBOX_LANGUAGES, TTS_SUPERTONIC_LANGUAGES, TtsChatterbox*/TtsSupertonic* config types,
// TextToSpeechStreamResult, TtsSentenceChunkUpdate, TtsResponse, TtsStats, TextToSpeechStreamFailedError
```

---

## Update @qvac/tts-ggml to 0.9.1

PR: [#4428](https://github.com/tetherto/qvac/pull/4428)

```bash
# tts-ggml 0.9.0 installs the host's binaries next to the meta package
node_modules/@qvac/tts-ggml/                    # JavaScript only: addon: true, no prebuilds/
node_modules/@qvac/tts-ggml-darwin-arm64/       # os/cpu filtered optionalDependency
  addon/package.json                            # { "name": "@qvac/tts-ggml", "addon": true }
  addon/prebuilds/darwin-arm64/qvac__tts-ggml.bare

# Passes on this branch; on main it reports missing-prebuild for every host
qvac verify bundle --addons-source ./node_modules --host darwin-arm64
```

```text
@qvac/tts-ggml@0.9.0 is missing a prebuild for linux-x64
(expected …/@qvac/tts-ggml/prebuilds/linux-x64/*.bare).
No per-platform package @qvac/tts-ggml-linux-x64 is installed alongside it either.
```

---

## Expose the TurboVec vector index on the SDK

PR: [#4457](https://github.com/tetherto/qvac/pull/4457)

```typescript
const index = await createVectorIndex({ dim: 1024, storage: VectorIndexStorage.TURBOVEC_Q4 })
await index.add({ ids: ['1', '2'], vectors: embeddings })
const hits = await index.search({ query: queryEmbedding, k: 3 }) // [{ id, score }]
await index.write({ path: 'indexes/articles.qvi' })
await index.dispose()

const reopened = await loadVectorIndex({ path: 'indexes/articles.qvi' })
```

---

## Consume the llm-llamacpp 0.53.0 tool grammar in the SDK

PR: [#4476](https://github.com/tetherto/qvac/pull/4476)

```ts
const run = sdk.completion({
  modelId,
  history,
  tools: [getWeather],
  stream: false,
  generationParams: { tool_choice: 'required' }
})
const final = await run.final
if (final.toolCalls.length === 0) console.log(final.toolErrors)
```

---
