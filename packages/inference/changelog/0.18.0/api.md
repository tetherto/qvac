# 🔌 API Changes v0.18.0

## Multi-job continuous batching

PR: [#3682](https://github.com/tetherto/qvac/pull/3682)

```typescript
const runs = prompts.map((p) => completion({ modelId, history: p, stream: true }))
const outputs = await Promise.all(runs.map((r) => r.final))

await cancel({ requestId: runs[0].requestId })
```

---

## Expose streaming transcription stats

PR: [#3734](https://github.com/tetherto/qvac/pull/3734)

```typescript
const session = await transcribeStream({ modelId })

for await (const event of session) {
  // Handle streamed transcription events.
}

const stats = await session.stats
console.log(stats?.audioDuration, stats?.realTimeFactor)
```

---

## Address translation-nmtcpp package-review findings

PR: [#3753](https://github.com/tetherto/qvac/pull/3753)

Translation stats (`totalTime` and related fields) are true milliseconds, matching the documented schema.

```typescript
const response = await translate({ modelId, text: 'Hello', stream: false, modelType: 'nmt' })
console.log(response.stats?.totalTime) // e.g. 1500 (ms)
```

---

## Add fallbackSrc to loadModel

PR: [#3845](https://github.com/tetherto/qvac/pull/3845)

```typescript
import { loadModel, LLAMA_3_2_1B_INST_Q4_0 } from '@qvac/inference'

const modelId = await loadModel({
  modelSrc: LLAMA_3_2_1B_INST_Q4_0,
  fallbackSrc: 'https://mirror.example.com/llama-3.2-1b-instruct-q4_0.gguf'
})
```

---

## Expose image_no_upscale in the config schema

PR: [#3854](https://github.com/tetherto/qvac/pull/3854)

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

---

## Add CosyVoice3 TTS support

PR: [#3857](https://github.com/tetherto/qvac/pull/3857)

```typescript
const modelId = await loadModel({
  modelSrc: TTS_COSYVOICE3_LLM_COSYVOICE_Q8_0,
  modelConfig: {
    ttsEngine: 'cosyvoice3',
    instruct: { dialect: 'cantonese' },
    seed: 42
  }
})
const result = textToSpeech({ modelId, text: 'Hey there!', stream: false, emotion: 'happy' })
```

```
TTS_COSYVOICE3_LLM_COSYVOICE_Q8_0
```

---

## Add Audio8 TTS support

PR: [#3858](https://github.com/tetherto/qvac/pull/3858)

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

---

## Integrate @qvac/audiogen-ggml 0.2.1

PR: [#3899](https://github.com/tetherto/qvac/pull/3899)

```typescript
const cover = audioGen({
  modelId,
  caption: 'orchestral arrangement with dramatic strings',
  lyrics: '[Instrumental]',
  taskType: 'cover-nofsq',
  sourceAudio: '/path/to/source.wav',
  referenceAudio: '/path/to/reference.mp3',
  audioCoverStrength: 1,
  coverNoiseStrength: 0.75,
  lmTemperature: 0.85,
  dcwEnabled: true
})
```

---
