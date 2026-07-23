# 🔌 API Changes v0.15.0

## Single-job batch processing

PR: [#2627](https://github.com/tetherto/qvac/pull/2627)

```ts
import {
  batchCompletion,
  loadModel,
  LLAMA_3_2_1B_INST_Q4_0,
} from "@qvac/sdk";

const modelId = await loadModel({
  modelSrc: LLAMA_3_2_1B_INST_Q4_0,
  modelType: "llm",
  modelConfig: { ctx_size: 4096, parallel: 4 },
});

const run = batchCompletion({
  modelId,
  prompts: [
    {
      id: "a",
      history: [{ role: "user", content: "Reply with only APPLE." }],
      generationParams: { temp: 0, predict: 16 },
    },
    {
      id: "b",
      history: [{ role: "user", content: "What's the weather in Paris?" }],
      tools: [getWeatherTool], // optional per-prompt tools
      generationParams: { temp: 0, predict: 64 },
    },
    {
      id: "c",
      history: [{ role: "user", content: "List my files" }],
      mcp: [mcpClientConfig], // optional per-prompt MCP-sourced tools
    },
  ],
});

for await (const { id, event } of run.events) {
  if (event.type === "contentDelta") process.stdout.write(`[${id}] ${event.text}`);
}

const results = await run.results; // ordered, all-or-nothing on stream-level failure
const stats = await run.stats; // batch-level CompletionStats | undefined
```

---

## Add LavaSR speech enhancer and denoiser support to TTS

PR: [#3069](https://github.com/tetherto/qvac/pull/3069)

```typescript
await sdk.loadModel({
  ttsEngine: "supertonic",
  modelSrc: TTS_MULTILINGUAL_SUPERTONIC3_Q8_0.src,
  // LavaSR post-processing (both optional)
  lavasrDenoiserModelSrc: TTS_DENOISER_LAVASR_FP16.src,
  lavasrEnhancerModelSrc: TTS_ENHANCER_LAVASR_FP16.src,
  // Supertonic-only output sample rate (8000-192000 Hz)
  outputSampleRate: 48000,
})
```

```
TTS_ENHANCER_LAVASR_FP16
TTS_ENHANCER_LAVASR_FP32
TTS_DENOISER_LAVASR_FP16
TTS_DENOISER_LAVASR_FP32
PARAKEET_CTC_0_6B_F16
PARAKEET_CTC_0_6B_Q4_0
PARAKEET_EOU_120M_V1_F16
PARAKEET_TDT_0_6B_V3_F16
PARAKEET_SORTFORMER_4SPK_V1_F16
```

```
TTS_MULTILINGUAL_SUPERTONIC3_Q4_0
```

---

## Add chatterbox japanese and chinese asset support

PR: [#3091](https://github.com/tetherto/qvac/pull/3091)

```typescript
import {
  loadModel,
  TTS_T3_MULTILINGUAL_CHATTERBOX_Q4_0,
  TTS_S3GEN_MULTILINGUAL_CHATTERBOX_Q4_0,
  TTS_MECAB_IPADIC_CHATTERBOX,
  TTS_CANGJIE_ZH_CHATTERBOX,
} from "@qvac/sdk";

await loadModel({
  modelSrc: TTS_T3_MULTILINGUAL_CHATTERBOX_Q4_0,
  modelConfig: {
    ttsEngine: "chatterbox",
    language: "ja",
    s3genModelSrc: TTS_S3GEN_MULTILINGUAL_CHATTERBOX_Q4_0,
    mecabDictSrc: TTS_MECAB_IPADIC_CHATTERBOX,
  },
});

await loadModel({
  modelSrc: TTS_T3_MULTILINGUAL_CHATTERBOX_Q4_0,
  modelConfig: {
    ttsEngine: "chatterbox",
    language: "zh",
    s3genModelSrc: TTS_S3GEN_MULTILINGUAL_CHATTERBOX_Q4_0,
    cangjieTsvSrc: TTS_CANGJIE_ZH_CHATTERBOX,
  },
});
```

```
TTS_CANGJIE_ZH_CHATTERBOX
```

---

## Expose llm-llamacpp mmproj-use-gpu config key

PR: [#3170](https://github.com/tetherto/qvac/pull/3170)

```typescript
// Force the vision encoder onto the GPU (or CPU) when loading a multimodal LLM.
await loadModel({
  modelSrc: SMOLVLM2_500M_MULTIMODAL_Q8_0,
  modelConfig: {
    projectionModelSrc: MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
    'mmproj-use-gpu': true // true = GPU, false = CPU; omit to auto-select per device class
  }
})
```

---

