# 🔌 API Changes v0.18.0

## Multi-job continuous batching in the SDK

PR: [#3682](https://github.com/tetherto/qvac/pull/3682)

```typescript
const runs = prompts.map((p) => completion({ modelId, history: p, stream: true }))
const outputs = await Promise.all(runs.map((r) => r.final))

// Cancel one without disturbing its peers:
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

```typescript
const model = new TranslationNmtcpp({ files, params, config, opts: { stats: true } })
await model.load()
const response = await model.run('Hello')
await response.await()
if ('TPS' in response.stats) {
  console.log(response.stats.TPS, response.stats.totalTime) // seconds (see README units table)
}
```

```typescript
const { QvacErrorAddonMarian, ERR_CODES } = require('@qvac/translation-nmtcpp/lib/error')
```

---

## Integrate @qvac/translation-nmtcpp 0.8.0 into SDK

PR: [#3817](https://github.com/tetherto/qvac/pull/3817)

```typescript
// TranslationStats timing fields are true milliseconds now
// (previously second-valued despite the ms-documented schema):
const response = await translate({ modelId, text: 'Hello', stream: false, modelType: 'nmt' })
console.log(response.stats?.totalTime)  // e.g. 1500 (ms), was 1.5

// Server-side NMT types alias the addon's exported types:
import type { NmtResponse, NmtStats } from '@/server/bare/types/addon-responses'
// NmtResponse = TranslationNmtcpp.TranslationResponse (typed .stats)
// NmtStats    = TranslationNmtcpp.RuntimeStats
```

---

## Integrate @qvac/ocr-ggml 0.16.0 in @qvac/sdk

PR: [#3825](https://github.com/tetherto/qvac/pull/3825)

```typescript
// Auto-inferred pipelineType: 'doctr' — no langList required
const modelId = await loadModel({ modelSrc: OCR_DOCTR })

// EasyOCR keeps the ['en'] default when langList is omitted,
// and explicit lists are forwarded unchanged:
await loadModel({
  modelSrc: OCR_LATIN,
  modelConfig: { langList: ['en', 'fr'], detectorModelSrc: OCR_CRAFT }
})
```

---

## Add fallbackSrc to loadModel

PR: [#3845](https://github.com/tetherto/qvac/pull/3845)

```typescript
import { loadModel, LLAMA_3_2_1B_INST_Q4_0 } from "@qvac/sdk";

// Load a catalog model, falling back to an alternate source when the registry is unreachable.
const modelId = await loadModel({
  modelSrc: LLAMA_3_2_1B_INST_Q4_0,
  fallbackSrc: "https://mirror.example.com/llama-3.2-1b-instruct-q4_0.gguf", // or a local file path
});
```

---

## Expose image_no_upscale in the SDK config schema

PR: [#3854](https://github.com/tetherto/qvac/pull/3854)

```typescript
await sdk.loadModel({
  modelType: ModelType.llamacppCompletion,
  modelSrc: VISIONPSY_NANO_460M_MULTIMODAL_Q4_K_M,
  modelConfig: {
    projectionModelSrc: MMPROJ_VISIONPSY_NANO_460M_MULTIMODAL_Q8_0,
    image_no_upscale: 'on'
  }
})
```

---

## Add CosyVoice3 TTS support to the SDK

PR: [#3857](https://github.com/tetherto/qvac/pull/3857)

```typescript
textToSpeech({ modelId, text, pace: 'very fast' }) // accepted, engine-dependent behavior
```

```typescript
textToSpeech({ modelId, text, pace: 'fast' }) // pace: 'slow' | 'moderate' | 'fast'
```

```typescript
// CosyVoice3 — the companion set auto-downloads the rest of the model dir
const modelId = await loadModel({
  modelSrc: TTS_COSYVOICE3_LLM_COSYVOICE_Q8_0,
  modelConfig: {
    ttsEngine: 'cosyvoice3',
    instruct: { dialect: 'cantonese' }, // or emotion / pace — exactly one
    seed: 42
  }
})
const result = textToSpeech({ modelId, text: 'Hey there!', stream: false, emotion: 'happy' })
```

```
TTS_COSYVOICE3_LLM_COSYVOICE_Q8_0
```

---

## Add Audio8 TTS support to the SDK

PR: [#3858](https://github.com/tetherto/qvac/pull/3858)

```typescript
// Audio8 — LM + codec decoder; optional zero-shot voice cloning
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

## Integrate @qvac/audiogen-ggml 0.2.1 into the SDK

PR: [#3899](https://github.com/tetherto/qvac/pull/3899)

```typescript
const cover = audioGen({
  modelId,
  caption: 'orchestral arrangement with dramatic strings',
  lyrics: '[Instrumental]',
  taskType: 'cover-nofsq',
  sourceAudio: '/path/to/source.wav',        // decoded server-side, or a Buffer of raw stereo 48 kHz f32le PCM
  referenceAudio: '/path/to/reference.mp3',  // optional timbre reference
  audioCoverStrength: 1,
  coverNoiseStrength: 0.75,
  lmTemperature: 0.85,
  dcwEnabled: true
})
```

---

