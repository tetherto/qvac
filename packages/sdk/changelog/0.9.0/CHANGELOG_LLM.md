# QVAC SDK v0.9.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.9.0

This release significantly expands the SDK's capabilities with finetuning support, image generation via Stable Diffusion, duplex streaming transcription, and a suspend/resume lifecycle for mobile apps. Delegation gets healthier with heartbeat probes and remote cancellation. Tool-calling completions are now more robust with KV cache fixes, and a new profiler gives deep visibility into operation performance. React Native compatibility improves with Buffer-free diffusion and better progress event handling.

---

## 💥 Breaking Changes

### `ping()` Replaced by `heartbeat()`

The `ping()` API has been replaced by `heartbeat()`, which supports both local and delegated (P2P) health checks. This enables proactive provider status monitoring before and during delegated inference.

**Before:**

```typescript
import { ping } from "@qvac/sdk";
const pong = await ping();
```

**After:**

```typescript
import { heartbeat } from "@qvac/sdk";

// Local heartbeat (replaces ping)
await heartbeat();

// Delegated heartbeat — check if a remote provider is alive
await heartbeat({
  delegate: { topic: "topicHex", providerPublicKey: "peerHex", timeout: 3000 },
});
```

---

## 🔌 New APIs

### Finetuning

The SDK now supports LoRA finetuning of loaded LLM models. Training runs can be started, paused, resumed, cancelled, and inspected — all through a single `finetune()` function. Progress streams provide real-time loss and step metrics.

```typescript
import { finetune } from "@qvac/sdk";

const handle = finetune({
  modelId,
  options: {
    trainDatasetDir: "./dataset/train",
    validation: { type: "dataset", path: "./dataset/eval" },
    outputParametersDir: "./artifacts/lora",
    numberOfEpochs: 2,
  },
});

for await (const progress of handle.progressStream) {
  console.log(progress.global_steps, progress.loss);
}
const result = await handle.result;
```

Operations: `start`, `resume`, `pause`, `cancel`, `getState`. Omit `operation` to let the addon auto-detect whether to start fresh or resume.

### Image Generation (Diffusion)

Stable Diffusion models are now integrated as a first-class SDK capability. Load a diffusion model and generate images with step-by-step progress tracking.

```typescript
import { loadModel, diffusion, SD_V2_1_1B_Q8_0 } from "@qvac/sdk";

const modelId = await loadModel({
  modelSrc: SD_V2_1_1B_Q8_0,
  modelType: "diffusion",
  modelConfig: { prediction: "v" },
});

const { progressStream, outputs, stats } = diffusion({
  modelId,
  prompt: "a cat sitting on a windowsill",
  width: 512,
  height: 512,
  steps: 20,
});

for await (const { step, totalSteps } of progressStream) {
  console.log(`${step}/${totalSteps}`);
}
const buffers = await outputs;
```

### Duplex Streaming Transcription (`transcribeStream`)

A new bidirectional streaming API lets you feed audio incrementally and receive transcription segments as speech is detected, enabling real-time voice interfaces.

```typescript
import { transcribeStream } from "@qvac/sdk";

const session = await transcribeStream({ modelId });
session.write(audioChunk);
session.end();

for await (const text of session) {
  console.log(text);
}
session.destroy();
```

The previous single-shot `transcribeStream({ modelId, audioChunk })` pattern still works but logs a deprecation warning — use `transcribe()` for batch transcription.

### Suspend/Resume Lifecycle

Mobile and desktop apps can now cleanly suspend and resume SDK operations when the app enters the background or foreground, preventing resource leaks and stale state.

```typescript
import { suspend, resume } from "@qvac/sdk";

await suspend(); // app going to background
await resume();  // app returning to foreground
```

### Delegated Cancellation

Remote inference and downloads running on a delegation provider can now be cancelled from the consumer side.

```typescript
import { cancel } from "@qvac/sdk";

await cancel({ operation: "inference", modelId: "delegated-model-id" });

await cancel({
  operation: "downloadAsset",
  downloadKey: "download-key",
  delegate: { topic: "topicHex", providerPublicKey: "peerHex" },
});
```

### Delegation Health Check Timeout

A new `healthCheckTimeout` option on the delegate config lets you control how long the RPC health probe waits before marking a cached connection as stale and reconnecting.

```typescript
await loadModel({
  modelSrc: LLAMA_3_2_1B_INST_Q4_0,
  modelType: "llm",
  delegate: {
    topic: topicHex,
    providerPublicKey,
    timeout: 30_000,
    healthCheckTimeout: 2000,
  },
});
```

### Addon Stats Across All Operations

All inference operations now return detailed performance stats from the underlying addons. Completion, transcription, translation, TTS, and embedding responses all include stats like `tokensPerSecond`, `timeToFirstToken`, `audioDuration`, and the new `backendDevice` field (`"cpu"` or `"gpu"`).

```typescript
const { embedding, stats } = await embed({ modelId, text: "hello" });
console.log(stats?.backendDevice); // "cpu" | "gpu"
```

---

## ✨ Features

- **CLD2 language detection** is now integrated into the SDK for automatic language identification.
- **OCR plugin updated** to work with `@qvac/ocr-onnx@0.4.0`.
- **TTS interface refactored** — the TTS package uses a new `files`-based constructor with absolute paths, replacing the legacy loader pattern.

---

## 🐞 Bug Fixes

- **KV cache preserved across tool-call round-trips** — multi-turn tool-calling completions no longer lose context between rounds.
- **KV cache save race condition** fixed in tool-calling completions — concurrent saves no longer corrupt the cache.
- **`<think>` blocks stripped** before parsing tool calls — reasoning traces from models like DeepSeek no longer break tool call extraction.
- **Progress event buffering** — throttled progress events are now buffered instead of dropped, ensuring no updates are lost during fast download sequences.
- **RPC progress throttling** — progress frames are throttled to prevent `Maximum call stack size exceeded` errors during high-frequency updates.
- **Clean process exit** — the Bare runtime process global is now handled correctly, and RPC close triggers a clean exit.
- **Connection teardown race** in `closeConnections` resolved — concurrent teardowns no longer deadlock.
- **React Native diffusion compatibility** — `Buffer` replaced with `Uint8Array` in the diffusion client, fixing React Native builds.
- **Download progress accuracy** — registry downloads now use network-layer progress instead of disk I/O measurements.
- **VLM addon classification** — the model registry was regenerated to fix incorrect VLM addon type assignments.
- **ONNX companion files** — `.onnx.data` companion files are now correctly resolved during registry model resolution.
- **Security hardening** — multiple code scanning alerts resolved across SDK pod packages.

---

## 📦 Model Changes

Model registry updated: 312 → 653 (+341). See [model changes](./models.md) for the full list.

- **295 Bergamot translation models** — offline NMT covering 42 language pairs bidirectional (az, be, bg, bn, bs, ca, da, de, el, et, fa, fi, gu, he, hi, hr, hu, id, is, kn, ko, lt, lv, ml, ms, mt, nb, nl, nn, pl, ro, sk, sl, sq, sr, sv, ta, te, tr, uk, vi). Each pair includes model weights, lexical shortlists, vocabularies, and metadata.
- **5 FLUX models** — FLUX.2 Klein 4B in Q4_0, Q4_K_M, Q6_K, Q8_0 quantizations plus VAE.
- **4 Stable Diffusion models** — SD v2.1 1B (Q4_0, Q8_0) and SDXL Base 1.0 3B (Q4_0, Q8_0).
- **17 TTS Supertonic models** — Official Supertone FP32 variants including duration predictor, text encoder, vocoder, config, unicode indexer, and 10 voice styles.
- **1 LLM model** — Qwen3 4B (Q4_K_M).

---

## 🧹 Other Changes

- Updated addon dependencies: `@qvac/tts-onnx` to v0.6.7, `@qvac/transcription-whispercpp` to latest, Parakeet to v0.2.7, `@qvac/diffusion-cpp` to ^0.1.3.
- Replaced FeatureBase support links with Discord channel.
- Bumped `bare-crypto` and `@qvac/rag` for runtime stability.
- Renamed `@tetherto` npm references to `@qvac` namespace across READMEs.
- Improved test infrastructure with SDK test bootstrap and CI model caching.
