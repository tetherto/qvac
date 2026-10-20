# 🔌 API Changes v0.22.0

## Port OCR GPU selection from the updated addon

PR: [#4797](https://github.com/tetherto/qvac/pull/4797)

```typescript
const modelId = await loadModel({
  modelSrc: OCR_LATIN,
  modelType: 'ggml-ocr',
  modelConfig: { langList: ['en'], backendDevice: 'vulkan', mainGpu: 'dedicated' }
})
```

---

## Support PCM-only SDK bundles with decoder-audio 0.8.0

PR: [#4819](https://github.com/tetherto/qvac/pull/4819)

```json
{
  "plugins": ["@qvac/sdk/whispercpp-transcription/plugin"],
  "includeAudioDecoder": false
}
```

---

## Add opt-in parallel tool calls

PR: [#4830](https://github.com/tetherto/qvac/pull/4830)

```typescript
await completion({ modelId, history, tools, generationParams: { parallel_tool_calls: true } })
```

---

## Keep nested JSON Schema in tool parameters

PR: [#4846](https://github.com/tetherto/qvac/pull/4846)

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

---

## Integrate H3 image-to-video

PR: [#4852](https://github.com/tetherto/qvac/pull/4852)

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

---

## Carry the engine's per-device rows into the projection

PR: [#4862](https://github.com/tetherto/qvac/pull/4862)

```typescript
const result = await assessModelFit({ models: [load] })
// projection.devices is present where the engine reports a placement per device
// [{ name: 'MTL0', totalBytes, freeBytes, weightsBytes, contextBytes, computeBytes }]
```

---

## Expose image-max-megapixels in the llm load config

PR: [#4885](https://github.com/tetherto/qvac/pull/4885)

```typescript
await loadModel({
  modelSrc: SMOLVLM2_500M_MULTIMODAL_Q8_0,
  modelConfig: {
    projectionModelSrc: MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
    'image-max-megapixels': 100 // accept images up to 100 MP (default 50)
  }
})
```

---

## Let a load decide what the engine fitter's verdict does to it

PR: [#4889](https://github.com/tetherto/qvac/pull/4889)

```typescript
// Skipping the fit probe was process-wide, and also disabled the engine
// verdict for assessModelFit.
QVAC_ADVISORY_MODEL_FIT = 0
```

```typescript
await loadModel({ modelSrc, modelType, modelFitPolicy: 'off' })
```

```json
{ "modelFitPolicy": "off" }
```

```typescript
// Refuse a load the engine fitter projects will not fit.
await loadModel({
  modelSrc: GPT_OSS_20B_INST_Q4_K_M,
  modelConfig: { ctx_size: 131072, 'cache-type-k': 'f32', 'cache-type-v': 'f32' },
  modelFitPolicy: 'refuse'
})
```

```json
{
  "serve": {
    "models": { "big": { "model": "GPT_OSS_20B_INST_Q4_K_M", "modelFitPolicy": "refuse" } }
  }
}
```

---

## Carry past tool calls as structured history

PR: [#4898](https://github.com/tetherto/qvac/pull/4898)

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

---

## Add generic decision API and System One HTTP support

PR: [#4910](https://github.com/tetherto/qvac/pull/4910)

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

---

## Add MOSS ASR and Nemotron diarization support

PR: [#4945](https://github.com/tetherto/qvac/pull/4945)

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
await transcribe({ modelId: moss, audioChunk: 'meeting.wav', metadata: true, hotwords: ['Erin'] })

const nemotron = await loadModel({
  modelSrc: './nemotron-diarization.gguf',
  modelType: 'parakeet-transcription'
})
const segments = await transcribe({ modelId: nemotron, audioChunk: 'meeting.wav', metadata: true })
// segments[].speakerSegments: { speakerId, startMs, endMs }[], preserving overlap.
```

```
MOSS_TRANSCRIBE_DIARIZE_F16
MOSS_TRANSCRIBE_DIARIZE_Q5_0
MOSS_TRANSCRIBE_DIARIZE_Q8_0
PARAKEET_NEMOTRON_3_DIARIZATION_Q8_0
```

---

## Expose TTS 0.11 MOSS engines and examples

PR: [#4982](https://github.com/tetherto/qvac/pull/4982)

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

---

## Expose audiogen-ggml 0.6.0 controls, metadata and MiniMax fit

PR: [#5000](https://github.com/tetherto/qvac/pull/5000)

```typescript
// MiniMax: check memory before loading, and fail the load instead of
// falling back to the CPU.
const fit = await assessModelFit({
  models: [
    {
      modelType: 'audiogen',
      modelConfig: { engine: 'minimax', lmModelSrc, synthModelSrc, device: 'gpu' }
    }
  ]
})

// ACE-Step: per-run steps and shift, and what the run rendered.
const run = audioGen({ modelId, caption: 'a rainy-day lo-fi loop', simpleMode: true, shift: 1.5 })
const rendered = (await run.stats)?.metadata // caption, lyrics, bpm, keyscale, seed, ...

// Edits take a timbre reference and prompt metadata for every operation.
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

---

## Expose GPU backend selection for LLM, embeddings, and VLA

PR: [#5005](https://github.com/tetherto/qvac/pull/5005)

```kotlin
LoadModelSrcRequestGgmlVlaModelConfig(
    backend = LoadModelSrcRequestGgmlVlaModelConfigBackend.CPU
)
```

```kotlin
LoadModelSrcRequestGgmlVlaModelConfig(backend = "cpu")
```

```typescript
import { loadModel, ModelType } from '@qvac/inference'

const modelId = await loadModel({
  modelType: ModelType.llamacppCompletion,
  modelSrc: '/models/llm.gguf',
  modelConfig: { backend: 'cuda,vulkan' }
})
```

---

## Assess ocr and translation loads with their engine fitters

PR: [#5057](https://github.com/tetherto/qvac/pull/5057)

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

---
