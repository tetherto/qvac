# 🔌 API Changes v0.17.0

## Add Parler-TTS support to SDK

PR: [#3473](https://github.com/tetherto/qvac/pull/3473)

```typescript
const modelId = await loadModel({
  modelSrc: TTS_MINI_V1_EN_PARLER_TTS_Q8_0,
  modelConfig: {
    ttsEngine: 'parler',
    voice: 'Laura',
    seed: 42
  }
})

const result = textToSpeech({
  modelId,
  text: 'Hey, how are you doing today?',
  inputType: 'text',
  stream: false,
  emotion: 'happy'
})

const audio = await result.buffer
```

---

## Add AudioGen support to SDK

PR: [#3506](https://github.com/tetherto/qvac/pull/3506)

```typescript
import {
  AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0,
  AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M,
  AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0,
  AUDIOGEN_VAE_BF16,
  audioGen,
  cancel,
  loadModel
} from '@qvac/sdk'

const modelId = await loadModel({
  modelType: 'audiogen',
  modelConfig: {
    textEncModelSrc: AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0,
    lmModelSrc: AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0,
    ditModelSrc: AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M,
    vaeModelSrc: AUDIOGEN_VAE_BF16
  }
})

const run = audioGen({ modelId, caption: 'ambient electronic music' })
stopButton.onclick = () => cancel({ requestId: run.requestId })

for await (const progress of run.progressStream) {
  console.log(progress.stage, progress.step, progress.total)
}

const { pcm, sampleRate, channels } = await run.audio
```

```
AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0
AUDIOGEN_ACESTEP_V15_SFT_Q8_0
AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M
AUDIOGEN_ACESTEP_V15_TURBO_Q8_0
AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0
AUDIOGEN_VAE_BF16
```

---

## Add local system resources API

PR: [#3507](https://github.com/tetherto/qvac/pull/3507)

```typescript
import { getSystemResources } from '@qvac/sdk'

const resources = await getSystemResources({ sample: true })

if (resources.capabilities.memory.totalBytes.status === 'supported') {
  console.log(resources.capabilities.memory.totalBytes.value)
}

if (resources.sample?.cpu.status === 'supported') {
  console.log(resources.sample.cpu.value)
}
```

---

## Count emitted tokens for usage, keep decode count for length

PR: [#3573](https://github.com/tetherto/qvac/pull/3573)

```typescript
const stats = await result.stats
// Decode count — length / KV-cache budget decisions
stats?.generatedTokens
// Addon-streamed non-empty pieces — prefer for OpenAI usage accounting
stats?.emittedTokens

// Serve usage prefers emittedTokens when present:
// usage.completion_tokens === stats.emittedTokens ?? stats.generatedTokens
```

---

## Terminate generation at context boundary

PR: [#3608](https://github.com/tetherto/qvac/pull/3608)

```typescript
const response = await model.run(messages)
await response.await()

if (response.stats?.stopReason === 'contextOverflow') {
  console.log('Generation reached the context boundary')
}
```

---

## Expose GR00T multi-embodiment selection in VLA SDK

PR: [#3625](https://github.com/tetherto/qvac/pull/3625)

```typescript
import { loadModel, vlaHparams, vlaSetEmbodiment, GROOT_MULTI_Q8_VF16 } from '@qvac/sdk'

// Select an embodiment at load (multi-embodiment GR00T GGUF)
const modelId = await loadModel({
  modelSrc: GROOT_MULTI_Q8_VF16,
  modelType: 'ggml-vla',
  modelConfig: { embodiment: 'libero_sim' } // or 24, or { catId: 3, numCameras: 2 }
})

// Confirm what was resolved
const { hparams } = await vlaHparams({ modelId })
hparams.selectedEmbodimentTag // 'libero_sim'
hparams.selectedEmbodimentCatId // 2

// Switch at runtime — no reload; rebuild inputs from the refreshed hparams
const { hparams: refreshed } = await vlaSetEmbodiment({ modelId, embodiment: 24 })
refreshed.numCameras // camera count follows the new embodiment
```

---

## Add backend diagnostics contract

PR: [#3663](https://github.com/tetherto/qvac/pull/3663)

```typescript
import { profiler } from '@qvac/sdk'

profiler.enable({ mode: 'verbose' })
profiler.onRecord((event) => {
  if (event.backend?.fallback) {
    console.log(
      `Selected ${event.backend.selectedBackend} after fallback:`,
      event.backend.fallback.reason
    )
  }
})
```

---

## Add opt-in profiler resource gauges

PR: [#3664](https://github.com/tetherto/qvac/pull/3664)

```typescript
import { profiler } from '@qvac/sdk'

profiler.enable({
  mode: 'verbose',
  includeResourceGauges: true
})

const profile = profiler.exportJSON()
console.log(profile.recentEvents?.map((event) => event.resources))
```

---

## Add DSML tool call support for DeepSeek V3.2/V4

PR: [#3668](https://github.com/tetherto/qvac/pull/3668)

```typescript
const result = completion({
  modelId,
  history: [{ role: 'user', content: "What's the weather in Tokyo?" }],
  stream: true,
  tools,
  toolDialect: 'dsml' // optional — auto-detected from "deepseek-v4" / "deepseek-v3.2"
})

for await (const evt of result.toolCallStream) {
  if (evt.type === 'toolCall') console.log(evt.call.name, evt.call.arguments)
}
```

---
