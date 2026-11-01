# 🔌 API Changes v0.16.0

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
import { decide, loadModel, LAYA_MULTILINGUAL_322M_Q8_0 } from '@qvac/sdk'

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
import { loadModel, transcribe, assessModelFit, MOSS_TRANSCRIBE_DIARIZE_Q8_0 } from '@qvac/sdk'

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
import { loadModel, textToSpeech, AUDIOGEN_MOSS_SFX_V2_Q8_0 } from '@qvac/sdk'

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

## Expose GPU backend selection for LLM, embeddings, and VLA

PR: [#5005](https://github.com/tetherto/qvac/pull/5005)

```json
{
  "serve": {
    "models": {
      "chat": {
        "model": "QWEN3_600M_INST_Q4",
        "config": { "backend": ["cuda", "vulkan"] }
      }
    }
  }
}
```

---

## Let serve clients verify the listener before sending the key

PR: [#5022](https://github.com/tetherto/qvac/pull/5022)

```bash
qvac serve --openai --api-key-file key --port 0 --ready-fd 3
# fd 3: QVAC_SERVE_READY {"port":53127,"pid":4242}

curl "http://127.0.0.1:53127/qvac/identity?nonce=$NONCE"
# {"proof":"<base64url HMAC-SHA256(key, \"qvac-serve-identity-v1\n53127\n$NONCE\")>"}
```

---

## Forward parallel_tool_calls from qvac serve

PR: [#4923](https://github.com/tetherto/qvac/pull/4923)

```bash
curl -sS http://127.0.0.1:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<alias>",
    "messages": [{"role": "user", "content": "Weather in Paris and London?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}}
      }
    }],
    "parallel_tool_calls": false
  }'
```

`POST /v1/responses` accepts the same field on a request that includes `tools`.

---
