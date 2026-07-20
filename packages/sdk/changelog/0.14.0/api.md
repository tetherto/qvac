# 🔌 API Changes v0.14.0

## Add `subscribeServerLogs` to capture all server logs

PR: [#2558](https://github.com/tetherto/qvac/pull/2558)

```typescript
import { subscribeServerLogs } from "@qvac/sdk";

// One handler for every server-side log — no per-ID loggingStream() calls.
const unsubscribe = subscribeServerLogs((log) => {
  console.log(`[${log.level}] [${log.namespace}] ${log.message}`);
});

// later
unsubscribe();
```

---

## Separate TTS language validation per engine

PR: [#2581](https://github.com/tetherto/qvac/pull/2581)

```typescript
import {
  TTS_CHATTERBOX_LANGUAGES, // en, es, fr, de, it, pt, nl, pl, tr, sv, da, fi, no, el, ms, sw, ar, ko
  TTS_SUPERTONIC_LANGUAGES, // en, es, fr, pt, ko
  type TtsChatterboxLanguage,
  type TtsSupertonicLanguage,
} from "@qvac/sdk";

// Chatterbox now accepts all 18 multilingual languages
await loadModel({
  modelSrc: ...,
  modelConfig: { ttsEngine: "chatterbox", language: "tr" },
});
```

---

## Friendly, field-level validation errors for user input

PR: [#2618](https://github.com/tetherto/qvac/pull/2618)

```typescript
import { loadModel, RequestValidationFailedError, LLAMA_3_2_1B_INST_Q4_0 } from "@qvac/sdk";

try {
  await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0, modelConfig: { dtx_size: 4096 } });
} catch (err) {
  if (err instanceof RequestValidationFailedError) {
    console.error(err.message);
    // Invalid request:
    // ✖ Unrecognized key: "dtx_size"
    //   → at modelConfig
  }
}
```

---

## Expose tts-ggml chatterbox config

PR: [#2716](https://github.com/tetherto/qvac/pull/2716)

```typescript
await loadModel({
  modelSrc: TTS_T3_TURBO_EN_CHATTERBOX_Q8_0,
  modelType: "tts-ggml",
  modelConfig: {
    ttsEngine: "chatterbox",
    language: "en",
    s3genModelSrc: TTS_S3GEN_EN_CHATTERBOX.src,
    streamChunkTokens: 25,
    streamFirstChunkTokens: 10,
    cfmSteps: 1,
    threads: 8,
    nGpuLayers: 99,
    seed: 42,
  },
});
```

---

## Expose parakeet 0.8 runtime fields

PR: [#2787](https://github.com/tetherto/qvac/pull/2787)

```typescript
const modelId = await loadModel({
  modelSrc: PARAKEET_MODEL,
  modelConfig: {
    useGPU: true,
    backendsDir: "/path/to/native/libs",
    openclCacheDir: "/path/to/opencl-cache",
  },
});

for await (const event of transcribe({ modelId, audioChunk })) {
  if (event.done && event.stats?.gpuUnsupported === 1) {
    // GPU was present but Parakeet routed to CPU by backend policy.
  }
}
```

---

## Support explicit BCI embedder loading

PR: [#2791](https://github.com/tetherto/qvac/pull/2791)

```typescript
import { loadModel, BCI_WINDOWED, BCI_EMBEDDER } from "@qvac/sdk";

const modelId = await loadModel({
  modelSrc: BCI_WINDOWED,
  modelConfig: {
    embedderModelSrc: BCI_EMBEDDER,
    whisperConfig: { language: "en", temperature: 0.0 },
    bciConfig: { day_idx: 1 },
  },
});
```

---

## Expose remove_thinking_from_context completion param

PR: [#2797](https://github.com/tetherto/qvac/pull/2797)

```typescript
// SDK — drop this turn's reasoning block from the KV cache after generation
await model.completion({
  history,
  generationParams: { remove_thinking_from_context: true },
});
```

```jsonc
// CLI serve OpenAI API — same flag on the request body
// POST /v1/chat/completions { "model": "qwen3...", "messages": [...], "remove_thinking_from_context": true }
```

---

## Support positive reasoning_budget token caps in llm schemas

PR: [#2799](https://github.com/tetherto/qvac/pull/2799)

```typescript
// Per-request: cap the reasoning channel at 128 tokens for a single run()
await session.run({
  history: [{ role: "user", content: "Solve this step by step" }],
  reasoning_budget: 128, // -1 = unrestricted, 0 = disabled, N = cap at N tokens
});

// Load-time default
await loadModel(src, { reasoning_budget: 256 });
```

---

## Harden Gemma4 completion drains

PR: [#2802](https://github.com/tetherto/qvac/pull/2802)

```json
{
  "model": "gemma4-31b",
  "messages": [{ "role": "user", "content": "The ocean is" }],
  "reasoning_budget": 0
}
```

---

## Support more Chatterbox languages

PR: [#2832](https://github.com/tetherto/qvac/pull/2832)

```typescript
import { TTS_CHATTERBOX_LANGUAGES } from "@qvac/sdk";

await loadModel({
  modelSrc: "...",
  modelConfig: {
    ttsEngine: "chatterbox",
    language: "zh",
    s3genModelSrc: "...",
  },
});

// TTS_CHATTERBOX_LANGUAGES now includes: he, ru, zh, hi
```

---

## Add image_tile_mode SDK config + bump addon deps to new fabric version

PR: [#2874](https://github.com/tetherto/qvac/pull/2874)

```typescript
await loadModel({
  modelSrc: QWEN3_5_VL_MODEL,
  modelType: "llamacpp-completion",
  modelConfig: { image_tile_mode: "sequential" }, // "disabled" | "batched" | "sequential" (default: "sequential")
});
```

---

