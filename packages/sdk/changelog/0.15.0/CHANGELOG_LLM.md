# QVAC SDK v0.15.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.15.0

QVAC SDK 0.15.0 introduces single-job batch completion for running many prompts through one loaded model, adds LavaSR speech enhancement and denoising to the TTS pipeline, and extends Chatterbox TTS to Japanese and Chinese. It also gives multimodal models explicit GPU/CPU control over the vision encoder and ships stability fixes for Android worklets, worker RPC teardown, registry caching, and symlinked installs.

## New APIs

### Single-Job Batch Completion

`batchCompletion` runs many prompts through a single loaded model in one job, streaming per-prompt deltas and returning ordered results. Each prompt can carry its own history, generation parameters, and optional per-prompt tools or MCP-sourced tools.

```typescript
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
  ],
});

for await (const { id, event } of run.events) {
  if (event.type === "contentDelta") process.stdout.write(`[${id}] ${event.text}`);
}

const results = await run.results; // ordered, all-or-nothing on stream-level failure
const stats = await run.stats; // batch-level CompletionStats | undefined
```

### GPU Placement for Multimodal Vision Encoders

Multimodal LLMs can now force the vision encoder (mmproj) onto the GPU or CPU explicitly via the `mmproj-use-gpu` config key. Omit it to keep the previous per-device-class auto-selection.

```typescript
await loadModel({
  modelSrc: SMOLVLM2_500M_MULTIMODAL_Q8_0,
  modelConfig: {
    projectionModelSrc: MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
    "mmproj-use-gpu": true, // true = GPU, false = CPU; omit to auto-select
  },
});
```

## Features

### LavaSR Speech Enhancement and Denoising for TTS

Supertonic TTS gains optional LavaSR post-processing: an enhancer and a denoiser that clean up generated audio. Both are opt-in via new load-time config keys, and Supertonic output can be resampled to a chosen rate.

```typescript
await sdk.loadModel({
  ttsEngine: "supertonic",
  modelSrc: TTS_MULTILINGUAL_SUPERTONIC3_Q8_0.src,
  // LavaSR post-processing (both optional)
  lavasrDenoiserModelSrc: TTS_DENOISER_LAVASR_FP16.src,
  lavasrEnhancerModelSrc: TTS_ENHANCER_LAVASR_FP16.src,
  // Supertonic-only output sample rate (8000-192000 Hz)
  outputSampleRate: 48000,
});
```

### Japanese and Chinese Chatterbox TTS

Chatterbox TTS now supports Japanese and Chinese. Japanese uses a MeCab IPADIC dictionary asset and Chinese uses a new Cangjie TSV asset, both passed at load time alongside the shared T3 and S3Gen models.

```typescript
import {
  loadModel,
  TTS_T3_MULTILINGUAL_CHATTERBOX_Q4_0,
  TTS_S3GEN_MULTILINGUAL_CHATTERBOX_Q4_0,
  TTS_MECAB_IPADIC_CHATTERBOX,
  TTS_CANGJIE_ZH_CHATTERBOX,
} from "@qvac/sdk";

// Japanese
await loadModel({
  modelSrc: TTS_T3_MULTILINGUAL_CHATTERBOX_Q4_0,
  modelConfig: {
    ttsEngine: "chatterbox",
    language: "ja",
    s3genModelSrc: TTS_S3GEN_MULTILINGUAL_CHATTERBOX_Q4_0,
    mecabDictSrc: TTS_MECAB_IPADIC_CHATTERBOX,
  },
});

// Chinese
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

## Bug Fixes

Android inference now always terminates the Bare worklet on teardown, preventing the worklet leak and out-of-memory growth seen under repeated model loads. When the bare-rpc channel closes, pending worker calls now surface as proper `WorkerCrashedError` / `WorkerShutdownError` instead of a generic RPC error, and the dead connection is torn down eagerly so the next call respawns cleanly. The registry descriptor cache honors its cache metadata, avoiding stale or unnecessary re-fetches, and bundled SDK installs correctly resolve the SDK's hoisted `bare-*` dependencies for symlinked (workspace) setups.

## Model Changes

This release adds the LavaSR enhancer and denoiser assets, several Parakeet transcription models, and a Cangjie Chinese asset for Chatterbox, and refreshes the quantized multilingual Supertonic 3 model.

### Added Models

```text
PARAKEET_CTC_0_6B_F16
PARAKEET_CTC_0_6B_Q4_0
PARAKEET_EOU_120M_V1_F16
PARAKEET_SORTFORMER_4SPK_V1_F16
PARAKEET_TDT_0_6B_V3_F16
TTS_CANGJIE_ZH_CHATTERBOX
TTS_DENOISER_LAVASR_FP16
TTS_DENOISER_LAVASR_FP32
TTS_ENHANCER_LAVASR_FP16
TTS_ENHANCER_LAVASR_FP32
```

### Updated Models

```text
TTS_MULTILINGUAL_SUPERTONIC3_Q4_0
```
