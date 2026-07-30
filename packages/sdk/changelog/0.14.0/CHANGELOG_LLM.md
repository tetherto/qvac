# QVAC SDK v0.14.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.14.0

QVAC SDK 0.14.0 makes the SDK quiet by default, replaces the ONNX OCR stack with a GGML backend, and expands the model registry with medical LLMs, multimodal Qwen3.5, and broader multilingual TTS. It also adds finer-grained control over completion reasoning, friendlier validation errors, and per-engine TTS language handling.

## Breaking Changes

### Logs Are Now Silent by Default

The SDK and its native backends (llama.cpp / ggml) no longer print to the console automatically. Applications get a clean console out of the box and explicitly opt in when they want diagnostics. SDK logs are enabled through the config file, native backend output additionally requires a debug log level, and logs can also be captured programmatically.

**Before:**

```typescript
// SDK and native logs printed to the console by default.
await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0 });
// → console fills with SDK + native output
```

**After:**

```typescript
// Silent by default — no console output.
await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0 });

// Opt in:
//   qvac.config.json → { "loggerConsoleOutput": true }                          // SDK logs
//   qvac.config.json → { "loggerConsoleOutput": true, "loggerLevel": "debug" }  // + native backend output
//   loggingStream({ id: SDK_LOG_ID })                                           // capture SDK logs programmatically
```

### bare-process Is No Longer Bundled

The bundled `bare-process` shim has been removed in favor of Bare primitives. Code that relied on `process` as a global in Bare environments must either use the equivalent Bare primitive or install `bare-process` explicitly.

**Before:**

```typescript
// process available as a global
process.exit(0);
```

**After:**

```typescript
import process from "bare-process";
process.exit(0);
```

### OCR Now Runs on GGML

The SDK's OCR path moves from ONNX to GGML-OCR 0.4.0. The legacy ONNX OCR model constants `OCR_CRAFT_DETECTOR_GGML` and `OCR_LATIN_RECOGNIZER_GGML` are removed; use the new GGML-backed OCR constants listed in the model changes below.

## New APIs

### Capture Every Server Log From One Handler

`subscribeServerLogs` registers a single handler that receives all server-side logs, removing the need for per-ID `loggingStream()` calls.

```typescript
import { subscribeServerLogs } from "@qvac/sdk";

const unsubscribe = subscribeServerLogs((log) => {
  console.log(`[${log.level}] [${log.namespace}] ${log.message}`);
});

// later
unsubscribe();
```

### Field-Level Validation Errors

Invalid input now produces readable, field-level errors instead of opaque failures. A `RequestValidationFailedError` carries a message that points at the offending field.

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

### Finer Control Over Reasoning

Completions can now cap or disable the reasoning channel per request or at load time via `reasoning_budget`, and drop a turn's reasoning block from the KV cache after generation via `remove_thinking_from_context`.

```typescript
// Per-request: cap the reasoning channel at 128 tokens for a single run()
await session.run({
  history: [{ role: "user", content: "Solve this step by step" }],
  reasoning_budget: 128, // -1 = unrestricted, 0 = disabled, N = cap at N tokens
});

// Load-time default
await loadModel(src, { reasoning_budget: 256 });
```

```typescript
// Drop this turn's reasoning block from the KV cache after generation
await model.completion({
  history,
  generationParams: { remove_thinking_from_context: true },
});
```

The same `remove_thinking_from_context` flag is accepted on the CLI's OpenAI-compatible `/v1/chat/completions` request body.

### Multimodal Image Tiling Control

A new `image_tile_mode` config controls how multimodal images are tiled before inference.

```typescript
await loadModel({
  modelSrc: QWEN3_5_VL_MODEL,
  modelType: "llamacpp-completion",
  modelConfig: { image_tile_mode: "sequential" }, // "disabled" | "batched" | "sequential" (default: "sequential")
});
```

### Per-Engine TTS Language Validation and More Languages

TTS language validation is now scoped per engine, with dedicated constants and types for each backend. Chatterbox gains additional languages (`he`, `ru`, `zh`, `hi` on top of the existing multilingual set), and the tts-ggml Chatterbox config is fully exposed.

```typescript
import {
  TTS_CHATTERBOX_LANGUAGES,
  TTS_SUPERTONIC_LANGUAGES,
  type TtsChatterboxLanguage,
  type TtsSupertonicLanguage,
} from "@qvac/sdk";

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

### Parakeet 0.8 Runtime Fields and Explicit BCI Embedder Loading

Parakeet transcription exposes new runtime fields (`useGPU`, `backendsDir`, `openclCacheDir`) and reports when the GPU was present but the backend routed work to the CPU. BCI transcription supports loading an explicit embedder model alongside the windowed model.

```typescript
const modelId = await loadModel({
  modelSrc: BCI_WINDOWED,
  modelConfig: {
    embedderModelSrc: BCI_EMBEDDER,
    whisperConfig: { language: "en", temperature: 0.0 },
    bciConfig: { day_idx: 1 },
  },
});
```

## Bug Fixes

Worker startup stderr is now surfaced so worker boot failures are diagnosable. Misplaced `loadModel` config fields produce clearer guidance. HTTP model downloads now survive process suspension and network drops through reconnect-aware retry. Bare examples register built-in plugins (with clearer Bare docs and errors), and classification plugin bundling is fixed with added mobile e2e coverage. Qwen hybrid tool-call frames now recover correctly, GPT-OSS Harmony output is normalized, Gemma4 completion drains are hardened, and the `@qvac/sdk` plugin subpath stays resolvable after the publish rename.

## Model Changes

This release adds healthcare/medical LLMs (1.7B and 4B variants across multiple quantizations), Qwen3.5 multimodal projectors, GGML-backed OCR constants, MeCab IPADIC Chatterbox assets, and Supertonic 3 multilingual TTS (now spanning 31 languages). The legacy ONNX OCR constants are removed in favor of the GGML OCR path.

### Added Models

```text
HEALTHCARE_1_7B_MEDICAL_BF16
HEALTHCARE_1_7B_MEDICAL_IQ3_M
HEALTHCARE_1_7B_MEDICAL_IQ3_XXS
HEALTHCARE_1_7B_MEDICAL_IQ4_NL
HEALTHCARE_1_7B_MEDICAL_IQ4_XS
HEALTHCARE_1_7B_MEDICAL_Q4_K_M
HEALTHCARE_1_7B_MEDICAL_Q5_K_M
HEALTHCARE_1_7B_MEDICAL_Q8_0
HEALTHCARE_4B_MEDICAL_BF16
HEALTHCARE_4B_MEDICAL_IQ3_M
HEALTHCARE_4B_MEDICAL_IQ3_XXS
HEALTHCARE_4B_MEDICAL_IQ4_NL
HEALTHCARE_4B_MEDICAL_IQ4_XS
HEALTHCARE_4B_MEDICAL_Q4_K_M
HEALTHCARE_4B_MEDICAL_Q5_K_M
HEALTHCARE_4B_MEDICAL_Q8_0
MMPROJ_QWEN3_5_2B_MULTIMODAL_Q8_0
MMPROJ_QWEN3_5_4B_MULTIMODAL_Q8_0
OCR_CRAFT
OCR_DOCTR
OCR_DOCTR_1
OCR_LATIN
TTS_MECAB_IPADIC_CHATTERBOX
TTS_MECAB_IPADIC_CHATTERBOX_1
TTS_MECAB_IPADIC_CHATTERBOX_2
TTS_MECAB_IPADIC_CHATTERBOX_3
TTS_MECAB_IPADIC_CHATTERBOX_4
TTS_MECAB_IPADIC_CHATTERBOX_5
TTS_MULTILINGUAL_SUPERTONIC3_FP16
TTS_MULTILINGUAL_SUPERTONIC3_FP32
TTS_MULTILINGUAL_SUPERTONIC3_Q4_0
TTS_MULTILINGUAL_SUPERTONIC3_Q8_0
```

### Removed Models

```text
OCR_CRAFT_DETECTOR_GGML
OCR_LATIN_RECOGNIZER_GGML
```
