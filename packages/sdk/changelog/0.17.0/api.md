# 🔌 API Changes v0.17.0

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
  loadModel,
} from "@qvac/sdk";

const modelId = await loadModel({
  modelType: "audiogen",
  modelConfig: {
    textEncModelSrc: AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0,
    lmModelSrc: AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0,
    ditModelSrc: AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M,
    vaeModelSrc: AUDIOGEN_VAE_BF16,
  },
});

const run = audioGen({ modelId, caption: "ambient electronic music" });
stopButton.onclick = () => cancel({ requestId: run.requestId });

for await (const progress of run.progressStream) {
  console.log(progress.stage, progress.step, progress.total);
}

const { pcm, sampleRate, channels } = await run.audio;
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

