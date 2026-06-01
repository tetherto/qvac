# Changelog

## [0.12.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.12.0

This release expands the SDK into new modalities and tightens the Bare distribution story. You can now run vision-language-action inference (SmolVLA), image classification, and text-to-video generation from the same SDK surface that already handles LLMs and diffusion. TTS moves from the ONNX stack to `@qvac/tts-ggml`, Parakeet transcription advances to the 0.6.0 GGUF backend, and a new `@qvac/bare-sdk` package lets Bare workers register only the plugins they need. Tooling consumers get `@qvac/sdk/commands` for bundling and verification, the model registry picks up Gemma 4 and Qwen 3.5/3.6 multimodal constants, and several mobile and delegation fixes land alongside the feature work.

## Breaking Changes

### TTS migrates from ONNX to tts-ggml

The SDK TTS plugin now targets `@qvac/tts-ggml` instead of `@qvac/tts-onnx`. The old multi-file ONNX Chatterbox layout — separate speech encoder, embed tokens, conditional decoder, and language model paths — is replaced by single GGUF constants and a simpler load path.

**Before:**

```typescript
await loadModel({
  modelSrc: TTS_MULTILINGUAL_LANGUAGE_MODEL_CHATTERBOX.src,
  modelType: "tts",
  modelConfig: {
    ttsEngine: "chatterbox",
    language: "en",
    ttsSpeechEncoderSrc: TTS_MULTILINGUAL_SPEECH_ENCODER_CHATTERBOX.src,
    ttsEmbedTokensSrc: TTS_MULTILINGUAL_EMBED_TOKENS_CHATTERBOX.src,
    ttsConditionalDecoderSrc: TTS_MULTILINGUAL_CONDITIONAL_DECODER_CHATTERBOX.src,
    ttsLanguageModelSrc: TTS_MULTILINGUAL_LANGUAGE_MODEL_CHATTERBOX.src,
  },
});
```

**After:**

```typescript
import { TTS_S3GEN_MULTILINGUAL_CHATTERBOX } from "@qvac/sdk";

await loadModel({
  modelSrc: TTS_S3GEN_MULTILINGUAL_CHATTERBOX,
  modelType: "tts",
});
```

New registry constants cover Chatterbox and Supertonic variants in GGUF form (`TTS_S3GEN_*`, `TTS_T3_*`, `TTS_*_SUPERTONIC_*`).

### Parakeet advances to 0.6.0 GGML

Building on the 0.11.0 single-file GGUF migration, Parakeet now targets `@qvac/transcription-parakeet` 0.6.0. Per-variant `modelType` discriminators and multi-file encoder/decoder/vocab fields are gone — pass a single GGUF constant and the addon detects TDT, CTC, EOU, or Sortformer from metadata.

**Before:**

```typescript
await loadModel({
  modelType: "parakeet",
  modelConfig: {
    modelType: "tdt",
    parakeetEncoderSrc: PARAKEET_TDT_ENCODER_INT8,
    parakeetDecoderSrc: PARAKEET_TDT_DECODER_INT8,
    parakeetVocabSrc: PARAKEET_TDT_VOCAB,
    parakeetPreprocessorSrc: PARAKEET_TDT_PREPROCESSOR,
  },
});
```

**After:**

```typescript
import { PARAKEET_TDT_0_6B_V3_Q8_0 } from "@qvac/sdk";

await loadModel({
  modelSrc: PARAKEET_TDT_0_6B_V3_Q8_0,
  modelType: "parakeet",
});
```

### `@qvac/bare-sdk` requires explicit plugin registration

Bare consumers that previously called `getRPC()` against the full `@qvac/sdk` worker must switch to `@qvac/bare-sdk` and register only the plugins their worker uses. The slim package ships no built-in addon dependencies — unregistered calls raise `WorkerPluginsNotRegisteredError`.

**Before:**

```typescript
import { getRPC } from "@qvac/sdk";

const rpc = await getRPC();
await rpc.loadModel({ /* any built-in modelType works */ });
```

**After:**

```typescript
import { plugins } from "@qvac/bare-sdk";
import { nmtPlugin } from "@qvac/bare-sdk/nmtcpp-translation/plugin";
import { llmPlugin } from "@qvac/bare-sdk/llamacpp-completion/plugin";

const sdk = plugins([nmtPlugin, llmPlugin]);

await sdk.loadModel({
  modelSrc: BERGAMOT_EN_FR,
  modelType: "nmt",
});
```

Install matching addon packages (`@qvac/translation-nmtcpp`, `@qvac/llm-llamacpp`, etc.) alongside `@qvac/bare-sdk`. `@qvac/sdk` remains the right choice for Node and Expo apps that want the full default worker.

### CLI bundle/verify delegates to `@qvac/sdk/commands`

`@qvac/cli` no longer embeds its own bundle and verify implementations. The commands are thin wrappers around `@qvac/sdk/commands`, and `@qvac/cli` now depends on `@qvac/sdk` directly rather than treating it as a dev-only peer with a runtime semver floor.

**Before:**

```typescript
// packages/cli served with its own bundle logic and a runtime MIN_SDK_VERSION check
const MIN_SDK_VERSION = "0.11.0";
```

**After:**

```typescript
import { bundleSdk, verifyBundle } from "@qvac/sdk/commands";

await bundleSdk({
  projectRoot: process.cwd(),
  configPath: "./qvac.config.json",
  quiet: true,
});

await verifyBundle({
  projectRoot: process.cwd(),
  addonsSource: "./qvac/worker.bundle.js",
  hosts: ["android-arm64", "ios-arm64"],
});
```

CLI publishers must confirm `@qvac/sdk@0.12.0` is on npm and flip `packages/cli/package.json` to `"@qvac/sdk": "^0.12.0"` before publishing `@qvac/cli`.

### react-native-bare-kit peer widened to ^0.14.0

Mobile consumers should upgrade `react-native-bare-kit` to `^0.14.0` alongside `@qvac/sdk@0.12.0`. Pinning `0.12.x` will fail peer resolution.

## New APIs

### Vision-language-action with SmolVLA

Load a SmolVLA model from the registry and run robot action inference with image preprocessing helpers:

```typescript
import {
  loadModel,
  vla,
  vlaHparams,
  vlaPreprocessImage,
  vlaPadState,
  SMOLVLA_LIBERO_VISION_Q8,
} from "@qvac/sdk";

const modelId = await loadModel({
  modelSrc: SMOLVLA_LIBERO_VISION_Q8,
  modelType: "vla",
  modelConfig: { backend: "auto" },
});

const { hparams } = await vlaHparams({ modelId });
const image = vlaPreprocessImage(pixels, width, height, {
  size: hparams.visionImageSize,
});
const state = vlaPadState(robotState, hparams.maxStateDim);

const { actions, actionDim, chunkSize } = await vla({
  modelId,
  images: [image],
  imgWidth: hparams.visionImageSize,
  imgHeight: hparams.visionImageSize,
  state,
  tokens,
  mask,
});
```

### Image classification

Classify JPEG/PNG buffers or raw RGB bytes with bundled MobileNetV3-Small or a custom GGUF:

```typescript
import { loadModel, classify } from "@qvac/sdk";

const modelId = await loadModel({
  modelType: "classification",
  modelConfig: { topK: 3 },
});

const results = await classify({ modelId, image: jpegBytes });
// → [{ label: "food", confidence: 0.91 }, ...]
```

### Text-to-video generation

Generate video frames from text prompts using WAN models:

```typescript
import { video } from "@qvac/sdk";

const run = video({
  modelId,
  mode: "txt2vid",
  prompt: "a cat surfing a wave at sunset",
  width: 480,
  height: 832,
  video_frames: 17,
  fps: 16,
  steps: 20,
});

for await (const tick of run.progressStream) {
  console.log(`step ${tick.step}/${tick.totalSteps}`);
}

const frames = await run.outputs;
```

### `@qvac/sdk/commands` for bundling and verification

Programmatic access to worker bundling and prebuild verification — the same primitives `qvac bundle` and `qvac verify bundle` use:

```typescript
import { bundleSdk, verifyBundle } from "@qvac/sdk/commands";

await bundleSdk({ projectRoot: process.cwd(), configPath: "./qvac.config.json" });
await verifyBundle({
  projectRoot: process.cwd(),
  addonsSource: "./qvac/worker.bundle.js",
  hosts: ["android-arm64", "ios-arm64"],
});
```

### RAG cancellation detection

Detect cancelled RAG operations without importing `@qvac/rag/errors`:

```typescript
import { RAG_ERROR_CODES } from "@qvac/sdk";

if (err.code === RAG_ERROR_CODES.OPERATION_CANCELLED) {
  // ingest was cancelled
}
```

### Diffusion flash attention toggle

`modelConfig.diffusion_fa` enables per-transformer flash attention on diffusion models (default on as of `@qvac/diffusion-cpp@0.8.0`). The deprecated `flux_flow` prediction mode is removed.

### Standalone ESRGAN device reporting

The standalone upscaler now forwards `device` from load config and exposes `backendDevice` in upscale stats.

### Expo plugin hoisted SDK resolution

Expo config plugins resolve `@qvac/sdk` from ancestor `node_modules` directories, fixing monorepo layouts where the SDK is hoisted above the app root.

### Completion prompt token counts and context overflow

LLM completion now surfaces real input token counts in stats and throws a typed `ContextOverflowError` when the prompt exceeds the model context window — including across the Bare RPC boundary:

```typescript
import { ContextOverflowError } from "@qvac/sdk";

const run = sdk.completion({ /* ... */ });
try {
  const final = await run.final;
  console.log(final.stats?.promptTokens);
} catch (err) {
  if (err instanceof ContextOverflowError) {
    console.warn(
      `prompt of ${err.promptTokens} tokens exceeded ${err.ctxSize}`,
    );
  }
}
```

## Bug Fixes and Reliability

- Bare delegated RPC now routes through the model registry instead of ad-hoc connection state.
- `@qvac/sdk` builds cleanly under both Bun and npm.
- Suspend/resume lifecycle ordering is corrected in the runtime.
- Snap-packaged apps use the common directory for QVAC home.
- SDK `peerDependencies` on Holepunch libraries are removed; CI enforces the expected peer ranges instead.
- `@qvac/rag` and `@qvac/registry-client` bump to `^0.6.0`.

## Model Registry

The registry sync adds Gemma 4 and Qwen 3.5/3.6 multimodal LLM/VLM constants, expands Bergamot translation pairs, introduces Parakeet 0.6.0 GGUF constants, and replaces ONNX TTS constants with tts-ggml equivalents.

### Added

```
GEMMA4_31B_MULTIMODAL_Q4_K_M
GEMMA4_2B_MULTIMODAL_Q4_K_M
QWEN3_5_0_8B_MULTIMODAL_Q4_K_M
QWEN3_6_27B_MULTIMODAL_Q4_K_XL
TTS_S3GEN_MULTILINGUAL_CHATTERBOX
TTS_T3_MULTILINGUAL_CHATTERBOX_Q4_0
TTS_EN_SUPERTONIC_Q8_0
PARAKEET_TDT_0_6B_V3_Q8_0
(and 60+ more — see models.md)
```

### Updated

```
BERGAMOT_EN_BG
BERGAMOT_EN_HR
BERGAMOT_EN_NL
BERGAMOT_METADATA_13
```

## [0.11.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.11.0

This release completes the request-lifecycle and cancellation overhaul that began in
0.10.0: every long-running SDK call — `completion`, `embed`, `transcribe`,
`transcribeStream`, `translate`, `finetune`, `loadModel`, `downloadAsset`, and the
cancellable `rag` operations — now flows through a unified `RequestRegistry`, exposes
its `requestId` synchronously on the returned promise, and can be cancelled
individually with `cancel({ requestId })`. The wire envelope for `cancel(...)` is
consolidated to two shapes, two legacy call signatures are removed, and the SDK gains
typed `instanceof` for policy/cancel errors across the RPC boundary. Alongside the
lifecycle work, this release adds Harmony / Qwen3.5 / Gemma4 tool-call dialects,
FLUX.2 multi-reference fusion and per-call LoRA on diffusion, ESRGAN upscaling (both
as a post-step and as a standalone `upscale()` API), Whisper VAD and end-of-turn
events, multi-GPU `split-mode` / `tensor-split` / `main-gpu` on the LLM and embed
plugins, a `reasoning_budget` knob for Qwen/Gemma reasoning, and a fresh Parakeet
0.4.0 GGUF backend with duplex streaming. The mobile build flow now auto-verifies the
worker bundle through `qvac verify bundle`, and the model registry was regenerated
against the upstream `base-memory` Bergamot fix (dropping the deprecated Marian Opus
constants on the way).

## Breaking Changes

### `unloadModel` no longer auto-closes the Bare worker

On Bare, `unloadModel` used to call `close()` whenever no models or providers were
left, which terminated the worker host on every routine unload. Long-lived Bare
workers either had to avoid `unloadModel` or work around the auto-close.

The default now flips by runtime: Node and Electron preserve the existing
auto-close behaviour (`autoClose: true` by default), while Bare leaves the
connection open (`autoClose: false` by default). Pass the field explicitly to
override.

**Before (Bare):**

```typescript
import { unloadModel } from "@qvac/sdk";

await unloadModel({ modelId });
// RPC connection closed → Bare worker host terminated.
```

**After (Bare):**

```typescript
import { unloadModel } from "@qvac/sdk";

await unloadModel({ modelId });
// Worker survives; opt in to closing explicitly:
await unloadModel({ modelId, autoClose: true });
```

### Parakeet plugin moves to the 0.4.0 single-file GGUF API

`@qvac/transcription-parakeet` 0.4.0 replaced the legacy multi-file ONNX bundle
(encoder + decoder + vocab + preprocessor, plus the CTC / Sortformer variants)
with a single GGUF backed by `qvac-parakeet.cpp`. The SDK plugin now follows
suit: every per-variant `parakeet*Src` field on `modelConfig` is gone, the
`modelType` discriminator is gone, and the addon auto-detects TDT / CTC / EOU /
Sortformer from GGUF metadata.

**Before:**

```typescript
await loadModel({
  modelSrc: PARAKEET_TDT_ENCODER_INT8,
  modelType: "parakeet",
  modelConfig: {
    parakeetEncoderSrc: PARAKEET_TDT_ENCODER_INT8,
    parakeetDecoderSrc: PARAKEET_TDT_DECODER_INT8,
    parakeetVocabSrc: PARAKEET_TDT_VOCAB,
    parakeetPreprocessorSrc: PARAKEET_TDT_PREPROCESSOR_INT8,
  },
});

await loadModel({
  modelSrc: PARAKEET_CTC_FP32,
  modelType: "parakeet",
  modelConfig: {
    modelType: "ctc",
    parakeetCtcModelSrc: PARAKEET_CTC_FP32,
    parakeetTokenizerSrc: PARAKEET_CTC_TOKENIZER,
  },
});
```

**After:**

```typescript
await loadModel({
  modelSrc: PARAKEET_TDT_0_6B_V3_Q8_0,
  modelType: "parakeet",
});

await loadModel({
  modelSrc: PARAKEET_CTC_0_6B_Q8_0,
  modelType: "parakeet",
});
```

The new GGUF constants (`PARAKEET_TDT_0_6B_V3_Q8_0`, `PARAKEET_CTC_0_6B_Q8_0`,
`PARAKEET_SORTFORMER_4SPK_V1_Q8_0`, `PARAKEET_EOU_120M_V1_Q8_0`) are added in
this release; the legacy multi-file constants are gone.

### Two legacy `cancel(...)` call shapes are removed

`cancel({ operation: "downloadAsset", downloadKey, clearCache })` and
`cancel({ operation: "rag", workspace })` are removed because neither carried a
`requestId` and neither can be mechanically back-mapped onto the new two-arm
cancel wire envelope. Callers must migrate to the `requestId`-targeted cancel
path (the primary one in 0.11.0) or to the broad cancel-by-`modelId` escape
hatch.

**Before — downloadAsset:**

```typescript
import { downloadAsset, cancel } from "@qvac/sdk";

const op = downloadAsset({ assetSrc, onProgress });
await cancel({ operation: "downloadAsset", downloadKey: assetSrc.key, clearCache: true });
```

**After — downloadAsset:** the decorated promise now exposes `op.requestId`
synchronously, and `clearCache` is honoured on the `requestId` path.

```typescript
import { downloadAsset, cancel } from "@qvac/sdk";

const op = downloadAsset({ assetSrc, onProgress });
await cancel({ requestId: op.requestId, clearCache: true });
```

**Before — rag:**

```typescript
import { ragIngest, cancel } from "@qvac/sdk";

ragIngest({ workspace: "my-workspace", documents });
await cancel({ operation: "rag", workspace: "my-workspace" });
```

**After — rag (primary path, by `requestId`):**

```typescript
import { ragIngest, cancel } from "@qvac/sdk";

const op = ragIngest({ workspace: "my-workspace", documents });
await cancel({ requestId: op.requestId });
```

**After — rag (broad escape hatch, no `requestId` to hand):**

```typescript
import { cancel } from "@qvac/sdk";

// Cancel every in-flight RAG operation running on the embedding model:
await cancel({ modelId: ragEmbeddingModelId, kind: "rag" });
```

Every other `cancel(...)` shape still works: `cancel({ operation: "inference",
modelId })`, `cancel({ operation: "embeddings", modelId })`, `cancel({ modelId
})`, `cancel({ modelId, kind })`, and `cancel({ requestId })` are all preserved
by the client-side normalisation layer.

## New APIs and Capabilities

### `requestId` exposed synchronously on every cancellable call

Every long-running SDK call now returns a decorated promise (or run handle) that
carries a `requestId` you can read on the same tick the call is dispatched.
That lets you wire a Stop button to a specific in-flight call without racing the
network round-trip. The pattern covers `completion`, `loadModel`, `embed`,
`transcribe`, `transcribeStream`, `translate`, `finetune`, `downloadAsset`, and
the three cancellable RAG ops (`ragIngest`, `ragSaveEmbeddings`, `ragReindex`).

```typescript
import {
  completion,
  loadModel,
  embed,
  downloadAsset,
  ragIngest,
  cancel,
} from "@qvac/sdk";

const run = completion({ modelId, history });
console.log(run.requestId);

const op = loadModel({ modelSrc: "..." });
console.log(op.requestId);                    // synchronously, before await
const modelId = await op;                     // legacy unwrap still works

const handle = embed({ modelId, text: "hello" });
console.log(handle.requestId);
await handle;

const download = downloadAsset({ assetSrc, onProgress });
stopButton.onclick = () => cancel({ requestId: download.requestId });
await download;                                // rejects with InferenceCancelledError if cancelled

const ingest = ragIngest({ workspace: "ws-a", modelId, documents });
console.log(ingest.requestId);
await ingest;
```

The non-cancellable RAG ops (`ragChunk`, `ragSearch`, `ragDeleteEmbeddings`,
`ragListWorkspaces`, `ragCloseWorkspace`, `ragDeleteWorkspace`) intentionally do
not decorate — they're fast-path operations that don't register with the
server-side request registry, so a `requestId` would point at nothing.

### Typed errors that survive the RPC boundary

`InferenceCancelledError`, `RequestRejectedByPolicyError`,
`RequestIdConflictError`, and `RequestNotFoundError` are now re-exported from
`@qvac/sdk` and reconstructed on the client side with their typed fields
intact, so `err instanceof RequestRejectedByPolicyError` actually narrows and
`err.modelId` / `err.reason` / `err.requestId` are populated from the
server-side throw.

`RequestRejectedByPolicyError` (code 52420) fires when an admission policy
blocks the request — for example, the worker's default
`oneAtATimePerModel: true` rule for `completion` kind, which promotes the
llama.cpp addon's opaque "job already set" error into a typed framework-level
rejection.

```typescript
import { completion, RequestRejectedByPolicyError } from "@qvac/sdk";

try {
  const run = completion({ modelId, history });
  for await (const event of run.events) { /* ... */ }
} catch (err) {
  if (err instanceof RequestRejectedByPolicyError) {
    showBusy({ modelId: err.modelId, reason: err.reason });
    return;
  }
  throw err;
}
```

### New broad-cancel sugar and consolidated wire envelope

The `cancel` wire envelope shrinks to two shapes — request-targeted (`{
operation: "request", requestId }`) and broad-by-model (`{ operation: "broad",
modelId, kind? }`). Two new client sugars wrap the broad shape so callers don't
have to think about the wire representation:

```typescript
import { cancel } from "@qvac/sdk";

await cancel({ modelId: "llama-3.2-1b", kind: "completion" });
await cancel({ modelId: "llama-3.2-1b" });
```

### Plugin authors: declare cancel scope per handler

`PluginHandlerDefinition` gains an optional `cancel: { scope, hard? }` field so
plugin authors can declare upfront whether each handler accepts a per-request
cancel token, whether it cancels by model, or whether it has no addon-level
cancel surface at all (soft-cancel only — the registry aborts the signal, the
stream stops yielding, the C++ work runs to completion in the background).

`scope` is `"request" | "model" | "none"`; `hard: true` documents that the
addon-side cancel actually interrupts compute. Plugin manifests that omit the
field still load — it's optional.

```typescript
import { definePlugin, defineHandler } from "@qvac/sdk";

definePlugin({
  manifestVersion: 1,
  handlers: {
    myStream: defineHandler({
      requestSchema,
      responseSchema,
      streaming: true,
      cancel: { scope: "model", hard: true },
      handler: async function* (request, ctx) { /* ... */ },
    }),
  },
});
```

### Multi-GPU `split-mode`, `tensor-split`, and `main-gpu` on LLM and embed

LLM and embed model configs now expose the underlying llamacpp multi-GPU knobs.
LLM uses the canonical hyphenated keys (`"split-mode"`, `"tensor-split"`,
`"main-gpu"`) to mirror the llama.cpp CLI; embed uses the existing camelCase
convention (`splitMode`, `tensorSplit`, `mainGpu`).

```typescript
// LLM
await loadModel({
  modelSrc: LLAMA_3_2_1B_INST_Q4_0,
  modelType: "llm",
  modelConfig: {
    "split-mode": "layer",        // "none" | "layer" | "row"
    "tensor-split": "1,1",        // proportional split across GPUs
    "main-gpu": 0,                // integer index or "integrated" | "dedicated"
  },
});

// Embed
await loadModel({
  modelSrc: EMBEDDING_GEMMA_300M_Q8_0,
  modelType: "embed",
  modelConfig: {
    splitMode: "layer",
    tensorSplit: "1,1",
    mainGpu: 0,
  },
});
```

### Whisper VAD and end-of-turn events on `transcribeStream`

`transcribeStream` gains a conversational mode opted into via `emitVadEvents:
true`. The session yields a discriminated event stream that includes live
voice-activity probabilities and turn boundaries, so apps can build push-to-talk
or barge-in UX without poll-the-text hacks.

```typescript
import { transcribeStream } from "@qvac/sdk";

const session = await transcribeStream({
  modelId: "whisper-base",
  emitVadEvents: true,
  endOfTurnSilenceMs: 800,
  vadRunIntervalMs: 100,
});

for await (const event of session) {
  if (event.type === "vad") console.log("speaking:", event.speaking, event.probability);
  else if (event.type === "endOfTurn") console.log("turn ended after", event.silenceDurationMs, "ms");
  else if (event.type === "text") process.stdout.write(event.text);
}

session.write(audioChunk);
session.end();
```

`TranscribeStreamEvent`, `VadStateEvent`, `EndOfTurnEvent`, and
`TranscribeStreamConversationSession` are new exported types. The existing
text-only, segment, and audio-chunk overloads are unchanged.

### Parakeet duplex streaming with EOU events

The new parakeet plugin (see Breaking Changes) ships a duplex
`transcribeStream` session that mirrors the whisper one. EOU model checkpoints
surface as `{ type: "endOfTurn" }` events on the same iterator as `{ type:
"text" }`.

```typescript
const session = await transcribeStream({
  modelId,
  parakeetStreamingConfig: {
    chunkMs: 1000,
    emitPartials: true,
  },
});

ffmpeg.stdout.on("data", (chunk: Buffer) => session.write(chunk));

for await (const event of session) {
  switch (event.type) {
    case "text":
      process.stdout.write(event.text);
      break;
    case "endOfTurn":
      console.log("\n[endOfTurn] turn boundary detected\n");
      break;
  }
}
```

Per-call streaming overrides — `chunkMs`, `historyMs`, `leftContextMs`,
`rightLookaheadMs`, `emitPartials`, `emitEnergyVad` — are accepted on
`parakeetStreamingConfig` and fall back to their `parakeetConfig.streaming*`
load-time counterparts.

### Harmony, Qwen3.5, and Gemma4 tool-call dialects

`toolDialect` now covers `"hermes" | "pythonic" | "json" | "harmony"`, plus
auto-detected `qwen35` and `gemma4` parsers. Harmony adds first-class support
for GPT-OSS models — including streaming the final-channel content
incrementally instead of buffering until `<|return|>`, so long GPT-OSS responses
no longer stall — and fixes a regression where protocol markers
(`<|channel|>analysis<|message|>...`, `<|start|>assistant`, `<|return|>`) were
leaking into `contentDelta`. Qwen3.5 covers the Pythonic-XML
`<tool_call><function=NAME><parameter=KEY>...</parameter></function></tool_call>`
framing; Gemma4 covers the native
`<|tool_call>call:NAME{key:<|"|>val<|"|>,...}<tool_call|>` framing.

```typescript
import { completion, type ToolDialect } from "@qvac/sdk";

const result = completion({
  modelId,                         // gpt-oss-20b-Q4_K_M auto-routes to "harmony"
  history,
  tools,
  toolDialect: "harmony",          // optional explicit override
});

const dialect: ToolDialect = "harmony";
```

Qwen3.5 / Qwen3.6 and Gemma4 are auto-detected from the model name; the parsers
ship without any caller-side wiring. The `harmony` parser also surfaces
malformed-JSON, unknown-tool, and non-object payloads as structured
`ToolCallError`s instead of silently dropping the event.

### `reasoning_budget` knob for thinking models

`@qvac/llm-llamacpp@0.20.0` introduced a `reasoning_budget` parameter that gates
how much "thinking" a reasoning model is allowed to produce: `-1` =
unrestricted, `0` = disabled. The SDK exposes it both as a load-time default on
`LlmConfig` and as a per-request override on `GenerationParams`.

```typescript
import { loadModel, completion } from "@qvac/sdk";

const modelId = await loadModel({
  modelSrc: "/models/Qwen3.5-7B-Instruct-Q4_K_M.gguf",
  modelType: "llm",
  modelConfig: { ctx_size: 4096, reasoning_budget: -1 },
});

const run = completion({
  modelId,
  history: [{ role: "user", content: "Think step by step." }],
  generationParams: { reasoning_budget: 0 }, // override per-request
});
```

The same bump fixes a regression where `system_prompt` (a JS-only
`completion-stream.ts` field) was being forwarded to the C++ arg parser as
`--system-prompt`, which had been removed in llamacpp 8189+ — model loads were
failing outright until this fix landed.

### FLUX.2 multi-reference fusion and per-call LoRA for diffusion

The diffusion API gains FLUX.2 multi-reference fusion (`init_images:
Uint8Array[]`, mutually exclusive with the existing single `init_image`), FLUX.2
reference-image tunables (`increase_ref_index`, `auto_resize_ref_image`), and a
per-call `lora` field that takes an absolute filesystem path. A new load-time
`lora_apply_mode` controls whether the adapter is fused permanently into the
model or applied per-call (`"auto" | "immediately" | "at_runtime"`).

```typescript
const refA = fs.readFileSync("scientist-a.jpg");
const refB = fs.readFileSync("scientist-b.jpg");
const { outputs } = diffusion({
  modelId,
  prompt: "a portrait using most visual traits from @image1 and the eyes from @image2",
  init_images: [refA, refB],
  width: 768,
  height: 768,
});

const { outputs: loraOutputs } = diffusion({
  modelId,
  prompt: "a watercolor cat",
  lora: "/home/user/loras/watercolor.safetensors",
});

await loadModel(modelSrc, {
  modelType: "diffusion",
  modelConfig: { prediction: "flux2_flow", lora_apply_mode: "immediately" },
});
```

Relative LoRA paths are rejected: the SDK runs across processes with differing
cwds, so absolute paths (POSIX, Windows drive-letter, or UNC) are the only safe
shape.

### ESRGAN upscaling — post-step and standalone

Two new paths land for ESRGAN upscalers. The first attaches an upscaler to a
diffusion model and runs it as a post-step on every generated image. The second
loads an ESRGAN file as a standalone `upscale()`-only model so consumers can
feed an arbitrary PNG or JPEG into the SDK and get an upscaled image back —
without standing up a full diffusion pipeline.

```typescript
// Post-step upscale during diffusion
const modelId = await loadModel({
  modelSrc: SD_V2_1_1B_Q8_0,
  modelType: "diffusion",
  modelConfig: {
    prediction: "v",
    upscaler: {
      type: "esrgan",
      model_src: "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth",
      tile_size: 128,
    },
  },
});

const { outputs } = diffusion({
  modelId,
  prompt: "an illustrated red fox portrait",
  width: 128,
  height: 128,
  upscale: { repeats: 2 },
});
```

```typescript
// Standalone upscale — no diffusion model required
import { upscale, loadModel, REALESRGAN_X4PLUS_ANIME_6B } from "@qvac/sdk";

const modelId = await loadModel(REALESRGAN_X4PLUS_ANIME_6B, {
  modelType: "diffusion",
  modelConfig: {
    mode: "upscale",
    upscaler: { tile_size: 128 },
  },
});

const { outputs, stats } = upscale({
  modelId,
  image: pngBytes,        // Uint8Array (PNG/JPEG)
  repeats: 1,             // each pass multiplies dims by the model's native scale factor
});

const [upscaledPng] = await outputs;
console.log(await stats); // { upscaleMs, totalUpscaleMs, width, height, totalPixels, repeats, ... }
```

Calling `upscale()` against a model that wasn't loaded with `mode: "upscale"`
raises `ModelOperationNotSupportedError` upfront, and loading a diffusion model
with `modelConfig.upscaler` set but `model_src` missing fails fast with a
structured `ModelLoadFailedError` instead of letting the native addon error
mid-load.

### Mobile build flow auto-verifies the worker bundle

Expo prebuild now runs `qvac verify bundle` against the emitted
`worker.mobile.bundle.js` before copying it into the SDK's `dist/`. The flow is
`runBundler → assert bundle exists → runVerifier → copyFileSync`, so the SDK
`dist/worker.mobile.bundle.js` only updates when verification passes. Failure
preserves the last known-good artifact and fails Expo prebuild fast with a new
`BundleVerificationFailedError` (code 50609).

If a `qvac.config.{json,js,mjs,ts}` is present, ABI checks are pinned to its
`bareRuntimeVersion`; without config, the CLI auto-detects from `node_modules`
(`bare-runtime` → `bare`) and falls through to a warning only when neither is
installed. `@qvac/cli` peer dep range moves from `^0.2.4` to `^0.4.0` — the
first version that ships `qvac verify bundle` — with the existing npx fallback
still in place for consumers that don't pin the dep.

Pear consumers aren't auto-wired yet — run `qvac verify bundle --addons-source
./node_modules --host <host> --config qvac.config.json` manually before `pear
stage` / `pear run`.

### `cancelFinetune` is now fire-and-forget

`cancelFinetune(modelId)` used to await the addon's cancel flip before
resolving. It now fires a synchronous registry cancel and returns immediately;
the actual `model.cancel()` runs out-of-band via the new context's abort
listener. The result shape is unchanged (`status: "CANCELLED"` still
populated), but workbench / CLI / external consumers that gated subsequent
calls on cancel-resolution timing should switch to `await cancel({ requestId
})`, which has been synchronous-after-abort since the lifecycle work began.

## Bug Fixes

### Delegated inference connect is fast again

The `loadModel.delegation.connection` regression introduced in 0.10.0 — where
`@qvac/sdk` 0.9.0 → 0.10.0 took the consumer-side connect from ≈2.5s to ≈8.3s
on first delegated call — is fixed by dropping the explicit `await
swarm.dht.fullyBootstrapped()` block before `dht.connect()` in
`ensureRPCConnection`. The SDK's normal init path already warms the routing
table via `getSwarm()` during registry initialisation, so the explicit guard
was redundant. Measured cold-start connect mean drops from 3.82s back down to
1.18s (≈3.2× faster) on the same hardware and network.

### KV cache priming no longer wastes a token

`initSystemPromptCache` used to start generation and then race the first output
token against a cancel. That always produced one token of unnecessary work and
relied on a fragile output/cancel race. The SDK now uses the addon's new
`prefill: true` runtime option (in `@qvac/llm-llamacpp ^0.17.3`) so priming
ingests the prompt and tools into the KV cache without producing any output
tokens. `initSystemPromptCache` resolves as soon as priming finishes.

### React Native duplex RPC no longer uses Node-only `Buffer`

The RN duplex RPC path was using Node's `Buffer` global, which isn't available
on Hermes. The path now uses `Uint8Array` end-to-end so mobile consumers can
use duplex streaming (transcribe, parakeet, tts) without hitting `Buffer is
not defined`.

### SDK bundles its own `worker.js` for packaged consumers

Apps consuming the SDK from a bundler (Metro, esbuild, webpack) were missing
`worker.js` from the published package, so consumers had to hand-copy it. The
package now ships `worker.js` alongside `worker.mobile.bundle.js` so packaged
consumers no longer need extra bundling steps.

### Dedup of stateful Holepunch singletons

The SDK and `@qvac/registry-client` had drifting declarations for
`corestore`, `hyperblobs`, `hyperdb`, and `hyperswarm`: the SDK declared them
as `peerDependencies`, the registry client declared them as hard
`dependencies`, and the version ranges didn't match. The mismatch caused npm
to install duplicate copies, producing separate DHT nodes and broken
connectivity. Bumping `@qvac/registry-client` to `^0.5.0` (where those libs
move to `peerDependencies`) and `@qvac/embed-llamacpp` to `^0.16.0` and
`@qvac/transcription-whispercpp` to `^0.7.0` completes the dedup chain.

## Model Registry Changes

The Bergamot translation pairs `BERGAMOT_EN_IT` and `BERGAMOT_ES_EN` were
pinned to the buggy `tiny` variant, which caused leading `"- "` hallucinations
on short inputs and an en→it quality regression (~3 pp `chrF++` drop direct,
~33 pp via Spanish pivot). The registry was regenerated against the upstream
`base-memory` Bergamot fix (synced to the DHT on 2026-05-05); paths now point
at `bergamot-{enit,esen}/2026-04-28/...` and `expectedSize` flipped from
17.1 MB to 30.1 MB on both pairs, confirming the switch landed.

The regeneration also picked up the auto-deprecation of the 32 Marian Opus NMT
entries (`NMT_Q0F16` through `NMT_Q0F16_9`, `NMT_Q4_0` through `NMT_Q4_0_21`)
that were superseded earlier in the release line. A separate fix corrects the
Bergamot vocab being re-downloaded on every `loadModel` for shared-vocab pairs
— the shared vocab is now cached and reused.

### Added

```
PARAKEET_TDT_0_6B_V3_Q8_0
PARAKEET_CTC_0_6B_Q8_0
PARAKEET_SORTFORMER_4SPK_V1_Q8_0
PARAKEET_EOU_120M_V1_Q8_0
```

### Removed

```
NMT_Q0F16 through NMT_Q0F16_9 (10 entries)
NMT_Q4_0 through NMT_Q4_0_21 (22 entries)
```

The legacy multi-file Parakeet constants (`PARAKEET_TDT_ENCODER_INT8`,
`PARAKEET_TDT_DECODER_INT8`, `PARAKEET_TDT_VOCAB`, `PARAKEET_TDT_PREPROCESSOR_INT8`,
`PARAKEET_CTC_FP32`, `PARAKEET_CTC_TOKENIZER`, etc.) are gone alongside the
plugin migration — see Breaking Changes above for the migration path.

## Tests and Infrastructure

- E2E bootstrap was scoped down to only the dependencies required by the
  filtered test set, shortening cold CI runs.
- Multi-GPU integration tests are now skipped on mobile (real multi-GPU hardware
  isn't represented in the mobile farm; tests are validated against the
  shared-dev `2× RTX 5090` rig in CI logs).
- `@qvac/tts-onnx` bumped to `0.9.0` and `@qvac/transcription-parakeet` to
  `0.5.0` to match the addon-side releases that land in this SDK version.

## [0.10.2]

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.10.2

This is a hotfix release that restores delegated-inference connection performance to the level it was at in v0.9.0. No API or model changes — drop-in replacement for v0.10.1.

## Bug Fixes

### Delegated connect no longer waits for full DHT bootstrap

Consumers using `loadModel({ delegate: true, ... })` against a remote provider were spending ~2.5–3s longer per connection in v0.10.0/0.10.1 than in v0.9.0. Profiler traces from the Workbench team showed `loadModel.delegation.connection` regressing from ~2.5s (v0.9.0) to ~8.3s (v0.10.0) on the same machine and network.

The cause was a serial `await swarm.dht.fullyBootstrapped()` call that was added to the consumer's connect path in the v0.10.0 redesign. `dht.fullyBootstrapped()` only resolves once Hyperdht has populated its full routing table, which is a slow process from a cold swarm — and on a hot swarm `dht.connect(publicKey)` already drives the lookups it needs internally, so the explicit wait is redundant. Removing it lets the connection use the DHT in whatever state it's in at call time, exactly the way it did in v0.9.0.

The DHT routing table is still populated lazily as `dht.connect()` issues lookups, so cold-swarm correctness is unchanged — `PEER_NOT_FOUND` for non-existent peers and connection timeouts for unreachable ones both still fire on the same code path. The fallback-to-local behaviour for `loadModel` is unaffected; only the hot-path latency improves.

Local benchmarks (10 consumer↔provider runs each, against the published v0.10.1 baseline):

| Build              | Mean connection time | p50    | p95    |
| ------------------ | -------------------- | ------ | ------ |
| v0.10.1 (baseline) | 3.82s                | 3.71s  | 4.94s  |
| v0.10.2 (this fix) | 1.18s                | 1.12s  | 1.49s  |

That's ~3.2× faster on average and brings cold delegated `loadModel` back below the v0.9.0 numbers.

If you were on v0.10.0 or v0.10.1 and had pinned around the regression (custom timeouts, retry shims, falling back to local inference earlier than necessary), you can drop those workarounds.

## [0.10.1]

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.10.1

This patch release adds a new tool-call dialect for OpenAI's `gpt-oss` (Harmony) models, fixes a regression that caused Bergamot translation models to re-download their vocab files on every `loadModel`, and refreshes the model registry with updated Bergamot translation pairs and the removal of deprecated Marian Opus entries.

## New APIs

### Harmony tool-call dialect for `gpt-oss`

`completion()` now supports a fourth tool-call dialect, `"harmony"`, used by OpenAI's `gpt-oss` family of models. The new dialect is wired into the same streaming/event surface as the existing dialects (`hermes`, `pythonic`, `json`), so tool calls emitted in Harmony frames are parsed and surfaced through the standard `CompletionEvent` stream. `gpt-oss-20b-Q4_K_M` auto-routes to the Harmony dialect; the `toolDialect` parameter is available as an explicit override on any model.

```typescript
import { completion, type ToolDialect } from "@qvac/sdk";

const run = completion({
  modelId,                 // gpt-oss-20b-Q4_K_M auto-routes to "harmony"
  history,
  tools,
  toolDialect: "harmony",  // optional explicit override
});

const dialect: ToolDialect = "harmony";
// ToolDialect is now "hermes" | "pythonic" | "json" | "harmony"
```

This release also picks up `@qvac/llm-llamacpp` 0.17.2, which stops the addon from suppressing the `<|call|>` end-of-generation token — required for Harmony tool-call parsing to work end-to-end.

## Bug Fixes

### Bergamot vocab no longer re-downloaded on every `loadModel`

Bergamot translation pairs that share a vocab blob across two file paths (the same SHA-256 under different names) were being collapsed by registry deduplication, which deleted their standalone vocab entries and forced the plugin to re-download the vocab file every time a model was loaded. This release adjusts the dedup pass to preserve any registry entry that is referenced as a companion file in a companion set, restoring the seven shared-vocab entries (`BERGAMOT_FR_EN_VOCAB`, `BERGAMOT_EN_DE_VOCAB`, `BERGAMOT_EN_CS_VOCAB`, `BERGAMOT_ET_EN_VOCAB`, `BERGAMOT_FI_EN_VOCAB`, `BERGAMOT_PL_EN_VOCAB`, `BERGAMOT_PT_EN_VOCAB`) along with their correct `expectedSize`/`sha` lookups.

For `registry://` Bergamot loads with auto-derived vocabs (both non-pivot and pivot), the plugin now skips the separate per-vocab `resolveModelPath` call entirely — the companion-set download already colocates vocabs under `sets/<setKey>/`, and `createModel` derives those paths via `deriveColocatedBergamotVocabPaths`. This eliminates redundant flat-cache downloads without changing the contract for `pear://` sources or user-supplied vocab overrides, and is locked behind unit tests in `nmtcpp-resolve-vocab.test.ts`.

## Model Changes

### Updated translation pairs

`BERGAMOT_EN_IT` and `BERGAMOT_ES_EN` are bumped to the `base-memory` variant (`bergamot-enit/2026-04-28/`, `bergamot-esen/2026-04-28/`). This fixes leading `"- "` hallucinations on short inputs and an en→it quality regression that affected the previous build.

### Restored shared-vocab Bergamot entries

The vocab fix above restores seven Bergamot vocab constants that had been incorrectly removed by registry dedup:

```
BERGAMOT_EN_CS_VOCAB
BERGAMOT_EN_DE_VOCAB
BERGAMOT_ET_EN_VOCAB
BERGAMOT_FI_EN_VOCAB
BERGAMOT_FR_EN_VOCAB
BERGAMOT_PL_EN_VOCAB
BERGAMOT_PT_EN_VOCAB
```

### Removed Marian Opus models

The legacy Marian Opus translation entries are dropped from the registry. They were auto-deprecated upstream and superseded by the Bergamot family.

```
NMT_Q0F16
NMT_Q0F16_1
NMT_Q0F16_2
NMT_Q0F16_3
NMT_Q0F16_4
NMT_Q0F16_5
NMT_Q0F16_6
NMT_Q0F16_7
NMT_Q0F16_8
NMT_Q0F16_9
NMT_Q4_0
NMT_Q4_0_1
NMT_Q4_0_2
NMT_Q4_0_3
NMT_Q4_0_4
NMT_Q4_0_5
NMT_Q4_0_6
NMT_Q4_0_7
NMT_Q4_0_8
NMT_Q4_0_9
NMT_Q4_0_10
NMT_Q4_0_11
NMT_Q4_0_12
NMT_Q4_0_13
NMT_Q4_0_14
NMT_Q4_0_15
NMT_Q4_0_16
NMT_Q4_0_17
NMT_Q4_0_18
NMT_Q4_0_19
NMT_Q4_0_20
NMT_Q4_0_21
```

If you were importing any of these constants, switch to the equivalent `BERGAMOT_*` pair.

## [0.10.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.10.0

This release lands a redesigned completion API built on a unified event stream, a generic
companion-set system that handles multi-file models in parallel, and a much stronger model
type/capability system that catches mis-routed calls at compile time. It also rewires
delegated inference to direct DHT connections, expands the addon surface (img2img,
structured output, dynamic tools, tool dialects, per-segment whisper metadata,
sentence-streaming TTS), and reshapes the model registry around companion sets.

## Breaking Changes

### Unified `CompletionEvent` stream

`completion()` now returns a `CompletionRun` with a single canonical `events` stream that
carries content, thinking, tool calls, stats, and completion in one ordered, sequenced
sequence. The legacy `tokenStream`/`stats` fields still work as derived views, but the
event stream is the authoritative API going forward and is what enables features like
captured thinking and structured tool framing.

**Before:**

```typescript
const result = completion({ modelId, history, stream: true });
for await (const token of result.tokenStream) { /* ... */ }
const stats = await result.stats;
```

**After:**

```typescript
const run = completion({ modelId, history, stream: true, captureThinking: true });
for await (const event of run.events) {
  if (event.type === "contentDelta") process.stdout.write(event.text);
  if (event.type === "toolCall") console.log(event.call.name);
}
const result = await run.final;
// result.contentText, result.thinkingText, result.toolCalls, result.stats, result.raw.fullText
```

### Model type & capability system overhaul

`LoadModelOptions` is no longer a single catch-all. Custom plugins must use the new
`LoadCustomPluginModelOptions<"plugin-name">` generic so the literal plugin string is
pinned at the type level. Built-in model types continue to pick the right overload
automatically when the annotation is dropped.

At runtime, built-in SDK operations now throw `MODEL_OPERATION_NOT_SUPPORTED` when called
against the wrong model type — with a message that lists the requested operation, the
loaded model's type, and the supported operations on it. The lower-level `pluginInvoke`
and `pluginInvokeStream` paths still surface `PLUGIN_HANDLER_NOT_FOUND` as before.

`translate(...)` now routes by the loaded model's registered type. Passing a mismatched
`modelType` throws `ModelTypeMismatchError` instead of silently mis-routing the call.

**Before:**

```typescript
import type { LoadModelOptions } from "@qvac/sdk";

const opts: LoadModelOptions = {
  modelSrc: "/path/foo",
  modelType: "my-custom-plugin",
  modelConfig: { whatever: 1 },
};
await loadModel(opts);
```

**After:**

```typescript
import type { LoadCustomPluginModelOptions } from "@qvac/sdk";

const opts: LoadCustomPluginModelOptions<"my-custom-plugin"> = {
  modelSrc: "/path/foo",
  modelType: "my-custom-plugin",
  modelConfig: { whatever: 1 },
};
await loadModel(opts);
// Or just drop the annotation — TS picks the right overload.
```

```typescript
import { SDK_SERVER_ERROR_CODES } from "@qvac/sdk";

try {
  await transcribe({ modelId: llmModelId /* ... */ });
} catch (e) {
  if ((e as { code?: number })?.code === SDK_SERVER_ERROR_CODES.MODEL_OPERATION_NOT_SUPPORTED) {
    // Includes requested operation, loaded model type, supported operations,
    // and suggested model types.
  }
}
```

### Companion-set download progress field

Multi-file model downloads (ONNX, future formats) now report progress through a generic
`fileSetInfo` field instead of the ONNX-specific `onnxInfo`. The shape is identical, only
the field name changed.

**Before:**

```typescript
onProgress: (progress) => {
  if (progress.onnxInfo) {
    console.log(`[${progress.onnxInfo.currentFile}] ${progress.onnxInfo.overallPercentage.toFixed(1)}%`);
  }
}
```

**After:**

```typescript
onProgress: (progress) => {
  if (progress.fileSetInfo) {
    console.log(`[${progress.fileSetInfo.currentFile}] ${progress.fileSetInfo.overallPercentage.toFixed(1)}%`);
  }
}
```

### Delegated inference uses direct DHT connect

Delegation no longer rendezvous over a shared topic. Consumers connect directly to a
provider's public key via `swarm.dht.connect(publicKey)`, and providers bind the DHT
server with `swarm.listen()` instead of announcing a topic. This removes a class of
discovery-flake failures and shortens connect time. Callers using the high-level
delegation API see no surface change; integrators driving Hyperswarm directly should
update their join/listen logic.

### Plugin constructor migration

SDK plugins (`definePlugin`) now use the new addon constructor shape. Plugin authors
need to migrate their `createModel` implementation to match — the SDK in this release
ships with all first-party plugins already migrated.

## New APIs and Capabilities

### `getLoadedModelInfo` for runtime introspection

A new `getLoadedModelInfo` API returns metadata for a loaded `modelId`, discriminated on
`isDelegated`. Local models expose their authoritative handler list and `modelType`;
delegated models defer to the provider. Useful for preflighting a built-in SDK call
before issuing the RPC.

```typescript
import { getLoadedModelInfo, transcribe } from "@qvac/sdk";

const info = await getLoadedModelInfo({ modelId });

if (info.isDelegated || info.handlers.includes("transcribeStream")) {
  await transcribe({ modelId /* ... */ });
}
```

### Structured output (`responseFormat`)

`completion()` now accepts a `responseFormat` option that constrains the model to emit
schema-valid JSON. The output is guaranteed to parse against the supplied JSON Schema.

```typescript
const run = completion({
  modelId,
  history: [{ role: "user", content: "Extract: I'm Alice, 30, data engineer." }],
  stream: true,
  responseFormat: {
    type: "json_schema",
    json_schema: {
      name: "Person",
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "integer" },
          occupation: { type: "string" },
        },
        required: ["name", "age", "occupation"],
        additionalProperties: false,
      },
    },
  },
});

for await (const event of run.events) {
  if (event.type === "contentDelta") process.stdout.write(event.text);
}
const final = await run.final;
JSON.parse(final.contentText); // schema-valid
```

### Dynamic tools mode

LLM models can now opt into a `dynamic` tools mode at load time. Subsequent
`completion()` calls can pass an entirely different `tools` array on each turn, and the
addon trims the previous tool block from the KV cache so rotation is free — no need to
invalidate the cache or pin the tool set per-session.

```typescript
import { loadModel, completion, TOOLS_MODE, QWEN3_1_7B_INST_Q4 } from "@qvac/sdk";

const modelId = await loadModel({
  modelSrc: QWEN3_1_7B_INST_Q4,
  modelType: "llm",
  modelConfig: {
    ctx_size: 4096,
    tools: true,
    toolsMode: TOOLS_MODE.dynamic,
  },
});

// Turn 1 — weather tools.
const turn1 = completion({
  modelId, history, kvCache, stream: true,
  tools: [{ name: "get_weather", description: "...", parameters: weatherSchema }],
});

// Turn 2 — same kvCache, different tools. Free rotation.
const turn2 = completion({
  modelId, history, kvCache, stream: true,
  tools: [{ name: "get_horoscope", description: "...", parameters: horoscopeSchema }],
});
```

### Tool-call dialect routing

Tool-call parsing is now dialect-aware. The SDK auto-detects between `hermes`,
`pythonic`, and `json` framings, and a new `toolDialect` parameter lets you force a
specific parser when auto-detection picks the wrong path — common for Llama 3.x
fine-tunes that emit native pythonic headers, which the auto-router defaults to `hermes`
for empirical reasons.

```typescript
import { completion, type ToolDialect } from "@qvac/sdk";

const result = completion({
  modelId, history, tools, stream: true,
  toolDialect: "pythonic", // "hermes" | "pythonic" | "json"
});
```

### img2img for diffusion models

The diffusion API now accepts an `init_image` for SDEdit-style image-to-image on
SD/SDXL, and in-context conditioning on FLUX.2. `strength` controls how much of the
source is preserved on SD/SDXL; FLUX.2 ignores it (the path is purely conditional).

```typescript
const initImage = new Uint8Array(fs.readFileSync("input.png"));
const { outputs } = diffusion({
  modelId,
  prompt: "oil painting style, vibrant colors",
  init_image: initImage,
  strength: 0.5, // 0 = keep source, 1 = ignore source
});
```

### Sentence-level TTS streaming

Onnx text-to-speech can now stream output one sentence at a time, either as a
self-contained `textToSpeech({ stream: true, sentenceStream: true })` call or via a
duplex `textToSpeechStream` session that you can pipe a streaming LLM into. Each chunk
exposes the int16 PCM samples plus the source sentence and chunk index.

```typescript
const session = await textToSpeechStream({
  modelId: ttsModelId,
  inputType: "text",
  accumulateSentences: true,
  sentenceDelimiterPreset: "latin", // "latin" | "cjk" | "multilingual"
  flushAfterMs: 400,
});

(async () => {
  for await (const delta of completion({ modelId: llmModelId /* ... */ }).tokenStream) {
    session.write(delta);
  }
  session.end();
})();

for await (const chunk of session) {
  // chunk.buffer / chunk.chunkIndex / chunk.sentenceChunk
  if (chunk.done) break;
}
```

### Per-segment whisper metadata

Both `transcribe` (batch) and `transcribeStream` (duplex) now return structured
`TranscribeSegment` objects with start/end timestamps, segment IDs, and an `append`
flag — enabling proper subtitle generation and timeline alignment instead of raw text
concatenation.

```typescript
const segments = await transcribe({ modelId, audioChunk: audioFilePath, metadata: true });
for (const s of segments) {
  console.log(`[${s.startMs}ms → ${s.endMs}ms] id=${s.id} append=${s.append} ${s.text}`);
}
```

### Suspend lifecycle gate and `state()`

`suspend()` is now serialized through a lifecycle gate that prevents overlapping
suspend/resume races. A new `state()` API reports the current lifecycle phase:
`active`, `suspending`, `suspended`, or `resuming`.

```typescript
import { state, suspend, resume, type LifecycleState } from "@qvac/sdk";

await suspend();
const current: LifecycleState = await state();
if (current !== "active") {
  await resume();
}
```

### Registry download retries and configurable stream timeout

Two new SDK config knobs cover slow/unstable links: `registryDownloadMaxRetries` retries
`REQUEST_TIMEOUT` failures (set to `0` to disable), and `registryStreamTimeoutMs`
extends the per-block stream timeout beyond the default 60s.

```typescript
import { setSDKConfig } from "@qvac/sdk";

setSDKConfig({
  registryDownloadMaxRetries: 5,
  registryStreamTimeoutMs: 180_000,
});
```

### Auto KV-cache: replay the canonical assistant turn

When auto KV-cache is enabled, the completion result now exposes
`final.cacheableAssistantContent` — the exact assistant string the SDK persisted to the
cache key on this turn. Push it back into `history` verbatim on the next turn to
guarantee a cache hit. Tool-call turns aren't auto-cached today and omit the field;
fall back to `final.contentText` in that case.

```typescript
const run = completion({ modelId, history, kvCache: true });
for await (const _ of run.tokenStream) { /* stream */ }
const final = await run.final;
const nextHistory = [
  ...history,
  { role: "assistant", content: final.cacheableAssistantContent ?? final.contentText },
  { role: "user", content: "follow-up question" },
];
```

### LLM-addon cache API plumbed through SDK

The SDK now wires through the LLM addon's first-class cache API — including explicit
`deleteCache({ kvCacheKey })` for evicting a named cache key — so consumers can manage
KV-cache lifetimes alongside `loadModel`/`unloadModel`.

### NMTcpp 2.0.1 surface

The SDK NMT plugin now targets `@qvac/translation-nmtcpp 2.0.1` with a structured
constructor that distinguishes primary and pivot model files, vocab files, and pivot
config (beam size, top-k). Bergamot models are also picked up via path-based vocab
resolution and grouped into companion sets, which lets the cache and download paths
treat them like any other multi-file model.

## Features

### Parallel orchestration and download dedupe

Model loading is now genuinely parallel where it can be: the primary model and any
companion files (vision projection, vocab, etc.) download concurrently, and concurrent
requests for the same asset are deduplicated to a single transfer. Cancellation cleans
up all active transfers atomically with no leaked state. Profiling fields
(`sourceType`, `cacheHit`, `sharedTransfer`, `totalLoadTime`,
`modelInitializationTime`, `checksumValidationTime`) are populated correctly across
both primary and companion downloads, with aggregate stats merged at the run level.

The companion pipeline is also generic: `companions.ts` is the only format-aware piece,
and adding a new multi-file format is a matter of dropping in a detection function and
registering it with `groupCompanionSets`. Everything downstream — codegen, resolver,
cache probing, storage cleanup — handles it automatically.

### Real-time voice assistant example

A new end-to-end example demonstrates a real-time voice assistant pipeline (whisper →
LLM → TTS) wired together using the SDK's streaming primitives.

## Bug Fixes

- RPC initialization in the Node runtime now has an explicit timeout, so a wedged
  transport can no longer hang `loadModel`/`unloadModel` indefinitely.
- The registry client now opens its corestore with `wait: true`, eliminating a startup
  race where downloads could begin before replication was ready.
- KV-cache `savedCount` is no longer incremented on cancelled or zero-token turns,
  preventing inflated cache stats.
- `delete-cache` RPC now scopes invalidation to the deleted key only instead of wiping
  unrelated entries.
- Delegated transports strip the `__profiling` envelope before zod validation, fixing a
  spurious validation error when profiling is enabled on the consumer side.
- Replaced `z.xor` with `z.union` and bumped the zod floor to `^4.3.0` to track upstream
  breaking changes.
- LLM-based translation now uses deterministic decoding so the same input produces the
  same output across runs.
- Inflight delegation requests that get rejected now run their cleanup chain to
  completion instead of leaking pending promises.

## Model Registry Changes

The model registry was regenerated around companion-set metadata. The user-facing surface
is leaner: families that used to live as separate `*_DATA`, `*_LEX`, `*_VOCAB`, and
`METADATA_*` constants are now companion-only — they're still downloaded, but they're
not addressable as standalone model sources. Marian Opus models were renamed under the
`NMT_*` namespace to match the rest of the NMT family.

### Added

```
NMT_Q0F16 through NMT_Q0F16_9 (10 entries)
NMT_Q4_0 through NMT_Q4_0_12+ (22 entries)
```

### Removed (now companion-only or renamed)

```
*_DATA (32 entries — companion-only, e.g. PARAKEET_TDT_ENCODER_DATA_FP32, TTS_*_DATA)
BERGAMOT_*_LEX (93 entries — companion-only)
BERGAMOT_*_VOCAB (93 entries — companion-only)
BERGAMOT_METADATA_* (87 entries — companion-only)
MARIAN_OPUS_* (32 entries — renamed to NMT_*)
```

## Documentation, Tests, and Infrastructure

- Diffusion documentation was extended to cover the new img2img flows (SDEdit on
  SD/SDXL, in-context conditioning on FLUX.2).
- Android sharded-model-resume tests no longer trip Scudo OOM — the test harness now
  bounds memory more conservatively on long-running resume scenarios.
- The tests-qvac docs, tooling, and CI workflow job names were refreshed for the new
  suite filtering and PR-triggered e2e workflows. Suite filtering plus PR-trigger labels
  let CI run targeted SDK e2e subsets on demand instead of always running the full grid.
- A pre-terminate cleanup hook stabilises mobile smoke: the mobile auto-close path now
  awaits worker cleanup acknowledgement before terminating the worklet.
- `DataLoader` cleanup logic was scoped down to `packages/rag` so the SDK no longer
  carries that surface.

## [0.9.2]

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.9.2

Hotfix patch release. Single-fix patch — no API, behavioral, or model changes.

---

## 🐞 Fixes

### Fix `TypeError: z.xor is not a function` for consumers on zod < 4.3

The SDK's finetune schemas used `z.xor([z.number(), z.nan()])` in 8 places, an API only available in zod ≥ 4.3.0. The package declared `"zod": "^4.0.17"`, so consumer projects whose tree resolved zod to a 4.0.x / 4.1.x / 4.2.x version crashed at runtime when finetune schemas loaded.

Two coordinated changes:

- Replaced `z.xor([z.number(), z.nan()])` with `z.union([z.number(), z.nan()])` in `packages/sdk/schemas/finetune.ts`. In zod v4, `z.number()` rejects `NaN` by default, so `z.number()` and `z.nan()` are disjoint — `z.xor` and `z.union` are semantically identical here.
- Bumped the declared `zod` floor from `^4.0.17` to `^4.3.0` to align the declared range with the version of zod the SDK is actually built and tested against.

Consumers who hit `_zod.z.xor is not a function` on `0.9.1` will be unblocked at runtime after upgrading to `0.9.2`.

See PR [#1790](https://github.com/tetherto/qvac/pull/1790) for full details and reasoning.

## [0.9.1]

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.9.1

Patch release with a minor documentation fix to the SDK README quickstart example — no API, behavioral, or model changes.

---

## 📘 Docs

- Remove trailing comma in quickstart import example.

## [0.9.0]

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

Model registry updated: 312 → 653 (+341). See [model changes](./changelog/0.9.0/models.md) for the full list.

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

## [0.8.3]

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.8.3

This is a patch release that fixes a race condition in the KV cache save path during tool-calling completions, improving stability for multi-turn conversations that use tool integration.

---

## 🐞 Bug Fixes

### KV Cache Save Race Condition in Tool-Calling Completions

The KV cache save during tool-calling completions could race with ongoing inference because the session path was not passed to the save command and the save response was not awaited. This could result in corrupted or missing session state between tool-call rounds.

The fix ensures the save command receives the correct session path and the SDK awaits the save response before proceeding. If the save fails, the error is now logged as a warning instead of propagating as an unhandled exception, so inference can continue gracefully.

**What changed:**

- The cache save now explicitly passes the session path alongside the save instruction, preventing the addon from writing to a stale or missing path
- The save response is awaited so subsequent inference steps don't race against an in-flight disk write
- A new `logCacheSaveError` helper captures save failures as warnings, keeping the completion stream alive even if the cache write fails

---

## 📘 Documentation

- Added npm keywords to `package.json` for better discoverability on the npm registry, covering AI/ML, inference engines, supported platforms, and P2P capabilities.
- Added a link to the consolidated plaintext documentation export (`llms-full.txt`) in the SDK README for AI/LLM tool consumption.

## [0.8.2]

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.8.2

This is a maintenance release that refreshes the SDK README with a streamlined quickstart guide and updated documentation links pointing to the new docs site at docs.qvac.tether.io.

---

## 📘 Documentation

### README Rewrite

The SDK README has been rewritten to provide a cleaner onboarding experience. The verbose installation, usage, and feature sections have been replaced with a concise quickstart that gets users running in four steps, and all documentation links now point to the new docs site.

Key changes:

- **Simplified quickstart** — A minimal four-step guide (create workspace, install, write script, run) replaces the previous multi-section setup
- **Updated links** — Documentation URLs now point to `docs.qvac.tether.io` instead of `qvac.tether.dev`
- **Support channel** — The support link now points to the Discord channel instead of FeatureBase
- **Leaner content** — Detailed platform instructions (Expo, Linux), feature lists, and example indexes have been moved to the docs site to keep the README focused

---

## ⚙️ Infrastructure

- SDK dependency installs in CI publish and pod check workflows are now frozen to prevent unexpected version drift during builds.

## [0.8.1]

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.8.1

This release introduces a heartbeat mechanism for proactive provider health monitoring in delegated inference, and adds RPC health probes with delegated cancellation support. Several stability fixes address RPC progress throttling, registry download progress accuracy, and security alerts.

---

## 💥 Breaking Changes

### Heartbeat Replaces Ping

The `ping()` function has been replaced by `heartbeat()`, which extends health checking to support delegated (remote) providers. Local usage is a straightforward rename, while the new delegated mode lets consumers verify provider connectivity before initiating model loads or inference.

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

// Delegated heartbeat — verify a remote provider is reachable
await heartbeat({
  delegate: { topic: "topicHex", providerPublicKey: "peerHex", timeout: 3000 },
});
```

---

## 🔌 New APIs

### RPC Health Probe for Delegation

Delegated model loading now supports an optional `healthCheckTimeout` parameter. When set, the SDK performs an RPC-level health probe before attempting the load, and stale connections are cleaned up centrally rather than per-caller.

```typescript
await loadModel({
  modelSrc: LLAMA_3_2_1B_INST_Q4_0,
  modelType: "llm",
  delegate: {
    topic: topicHex,
    providerPublicKey,
    timeout: 30_000,
    healthCheckTimeout: 2000, // optional, defaults to 1500ms
  },
});
```

### Delegated Cancellation

Cancel operations now route automatically to remote providers when the target model is delegated. Inference cancellation requires no API change — the SDK detects delegation from the model registry. Remote download cancellation accepts an optional `delegate` field.

```typescript
// Cancel delegated inference (routes automatically via model registry)
await cancel({ operation: "inference", modelId: "delegated-model-id" });

// Cancel delegated remote download
await cancel({
  operation: "downloadAsset",
  downloadKey: "download-key",
  delegate: { topic: "topicHex", providerPublicKey: "peerHex" },
});
```

---

## 🐞 Bug Fixes

- **IndicTrans model type unblocked** — The NMT translation plugin no longer incorrectly blocks IndicTrans models from loading, restoring multi-engine translation support.
- **Accurate download progress** — Registry downloads now report progress from the network layer instead of disk I/O polling, giving real-time progress that reflects actual bytes received.
- **RPC progress throttling** — Progress frames sent over RPC are now throttled to prevent call stack overflow when large models produce rapid progress updates.
- **VLM addon classification** — The model registry has been regenerated to correctly classify VLM (Vision-Language Model) addons, fixing misrouted model loads.
- **Security alerts resolved** — Code scanning alerts across SDK pod packages have been addressed.

---

## 📘 Documentation

- All SDK READMEs now reference the `@qvac` npm namespace instead of the legacy `@tetherto` scope.

---

## 🧪 Testing

- New E2E tests cover parallel download scenarios and cancel isolation to prevent race conditions between concurrent operations.
- The mobile E2E test executor has been refactored to an asset-based architecture for more reliable cross-platform testing.

## [0.8.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.8.0

This release adds Parakeet as a new transcription engine alongside Whisper, decouples builtin plugins from the core load path for a cleaner architecture, adds CTC and Sortformer transcription models, introduces a built-in profiler for diagnosing performance, and brings Bergamot pivot translation support. Several addon logging and delegation bugs have also been resolved.

---

## 💥 Breaking Changes

### Embedding Model Config Uses Structured Fields

The embedding addon no longer accepts the raw tab-delimited config string. Use the structured fields instead.

**Before:**

```typescript
await loadModel({
  modelSrc: EMBEDDINGS_NOMIC_EMBED_TEXT_V1_5,
  modelType: "embeddings",
  modelConfig: {
    rawConfig: "-ngl\t99\n-dev\tgpu\n--batch_size\t1024",
  },
});
```

**After:**

```typescript
await loadModel({
  modelSrc: EMBEDDINGS_NOMIC_EMBED_TEXT_V1_5,
  modelType: "embeddings",
  modelConfig: {
    gpuLayers: 99,
    device: "gpu",
    batchSize: 1024,
  },
});
```

### Companion Model Sources Moved Into `modelConfig`

Top-level companion source fields (`projectionModelSrc`, `vadModelSrc`, `srcVocabSrc`, `dstVocabSrc`) have been removed from `loadModel`. They now live inside `modelConfig`. The unused `toolFormat` field has also been removed.

**Before:**

```typescript
await loadModel({
  modelType: "llm",
  modelSrc: ".../model.gguf",
  projectionModelSrc: ".../mmproj.gguf",
});

await loadModel({
  modelType: "whisper",
  modelSrc: ".../model.bin",
  vadModelSrc: ".../vad.bin",
});

await loadModel({
  modelType: "nmt",
  modelSrc: ".../model.intgemm.alphas.bin",
  srcVocabSrc: ".../srcvocab.spm",
  dstVocabSrc: ".../trgvocab.spm",
});
```

**After:**

```typescript
await loadModel({
  modelType: "llm",
  modelSrc: ".../model.gguf",
  modelConfig: {
    projectionModelSrc: ".../mmproj.gguf",
  },
});

await loadModel({
  modelType: "whisper",
  modelSrc: ".../model.bin",
  modelConfig: {
    vadModelSrc: ".../vad.bin",
  },
});

await loadModel({
  modelType: "nmt",
  modelSrc: ".../model.intgemm.alphas.bin",
  modelConfig: {
    srcVocabSrc: ".../srcvocab.spm",
    dstVocabSrc: ".../trgvocab.spm",
  },
});
```

Additionally, custom plugins must now provide a `loadConfigSchema`. For plugins that accept any config, use a passthrough schema:

```typescript
const myPlugin: QvacPlugin = {
  modelType: "my-plugin",
  displayName: "My Plugin",
  addonPackage: "@my/addon",
  loadConfigSchema: z.object({}).catchall(z.unknown()),
  createModel: (params) => ({ model, loader }),
  handlers: {},
};
```

### Parakeet Model Constants Renamed

All existing Parakeet model constants now include a variant prefix (`TDT_`) to distinguish them from the new CTC and Sortformer variants. This is a find-and-replace migration:

| Old Constant | New Constant |
|---|---|
| `PARAKEET_ENCODER_*` | `PARAKEET_TDT_ENCODER_*` |
| `PARAKEET_DECODER_*` | `PARAKEET_TDT_DECODER_*` |
| `PARAKEET_VOCAB` | `PARAKEET_TDT_VOCAB` |
| `PARAKEET_PREPROCESSOR_*` | `PARAKEET_TDT_PREPROCESSOR_*` |

---

## 🔌 New APIs

### Parakeet Transcription Plugin

NVIDIA Parakeet ONNX models are now supported as an alternative transcription engine alongside Whisper.cpp. Parakeet uses a multi-file model architecture (encoder, encoder-data, decoder, vocab, preprocessor) resolved through the QVAC Registry.

```typescript
import {
  PARAKEET_TDT_ENCODER_FP32,
  PARAKEET_TDT_ENCODER_DATA_FP32,
  PARAKEET_TDT_DECODER_FP32,
  PARAKEET_TDT_VOCAB,
  PARAKEET_TDT_PREPROCESSOR_FP32,
} from "@qvac/sdk";

const modelId = await loadModel({
  modelType: "parakeet",
  modelSrc: PARAKEET_TDT_ENCODER_FP32,
  modelConfig: {
    parakeetEncoderSrc: PARAKEET_TDT_ENCODER_FP32,
    parakeetEncoderDataSrc: PARAKEET_TDT_ENCODER_DATA_FP32,
    parakeetDecoderSrc: PARAKEET_TDT_DECODER_FP32,
    parakeetVocabSrc: PARAKEET_TDT_VOCAB,
    parakeetPreprocessorSrc: PARAKEET_TDT_PREPROCESSOR_FP32,
  },
});

const stream = transcribeStream({ modelId, audioInput: "./audio.mp3" });
for await (const chunk of stream) {
  process.stdout.write(chunk);
}
```

Supports MP3, WAV, OGG, M4A, RAW, and FLAC audio formats. The plugin filters `[No speech detected]` chunks automatically, mirroring Whisper's `[BLANK_AUDIO]` filtering.

### Bergamot Pivot Translation

Translate between language pairs that don't have a direct model by chaining through a pivot language (typically English). Configure the pivot model inside `modelConfig`:

```typescript
await loadModel({
  modelSrc: BERGAMOT_ES_EN,
  modelType: "nmt",
  modelConfig: {
    engine: "Bergamot",
    from: "es",
    to: "it",
    pivotModel: {
      modelSrc: BERGAMOT_EN_IT,
      beamsize: 4,
      temperature: 0.3,
      topk: 100,
      normalize: 1,
      lengthpenalty: 1.2,
    },
  },
});
```

### SDK Profiler

A built-in profiler lets you measure SDK operation performance at runtime. Enable it globally or on a per-call basis:

```typescript
import { profiler } from "@qvac/sdk";

profiler.enable({
  mode: "verbose",
  includeServerBreakdown: true,
});

// Run operations, then export results
console.log(profiler.exportSummary());
console.log(profiler.exportTable());
console.log(profiler.exportJSON({ includeRecentEvents: true }));

profiler.disable();
```

Per-call profiling control is also available on `embed`, `completion`, `transcribe`, `translate`, `ragSearch`, and `invokePlugin`:

```typescript
await embed(
  { modelId, text: "hello" },
  { profiling: { enabled: true } },
);
```

---

## ✨ Features

### CTC and Sortformer Transcription Models

The SDK now supports two additional Parakeet model variants beyond the existing TDT models:

**CTC transcription** for fast, streaming-friendly speech-to-text:

```typescript
const modelId = await loadModel({
  modelSrc: PARAKEET_CTC_FP32_1,
  modelType: "parakeet",
  modelConfig: {
    modelType: "ctc",
    parakeetCtcModelSrc: PARAKEET_CTC_FP32_1,
    parakeetCtcModelDataSrc: PARAKEET_CTC_DATA_FP32_1,
    parakeetTokenizerSrc: PARAKEET_CTC_TOKENIZER,
  },
});
const text = await transcribe({ modelId, audioChunk: "/path/to/audio.wav" });
```

**Sortformer diarization** for speaker identification:

```typescript
const modelId = await loadModel({
  modelSrc: PARAKEET_SORTFORMER_FP32,
  modelType: "parakeet",
  modelConfig: {
    modelType: "sortformer",
    parakeetSortformerSrc: PARAKEET_SORTFORMER_FP32,
  },
});
const diarization = await transcribe({ modelId, audioChunk: "/path/to/audio.wav" });
// Returns: "Speaker 0: 0.00s - 4.24s\nSpeaker 1: 4.65s - 14.32s\n..."
```

### AfriqueGemma Support

AfriqueGemma models for African language translation are now available through the SDK.

### Profiler Operation Transport and Metrics

The profiler now captures detailed load/download metrics and stream profiling data, giving deeper visibility into SDK operation performance.

---

## 🐞 Bug Fixes

- **Addon logging fixed across all plugins** — Logging callbacks were not being properly attached to some addon plugins, resulting in missing addon-level logs. All plugins now correctly route native addon logs through the SDK logging system.
- **Parakeet addon logger** now uses the correct `params.modelId` for log routing.
- **RPC race condition** in `getRPCInstance` resolved — concurrent initialization calls no longer create duplicate worker instances.
- **Delegated model unload** now correctly unloads the model on the provider device instead of only removing the local registry entry.
- **Stale delegated model entries** are replaced on re-registration instead of accumulating.

---

## 📦 Model Changes

### Added Models

**OCR:**
- `OCR_DETECTOR_DB_MOBILENET_V3_LARGE`
- `OCR_DETECTOR_DB_RESNET50`
- `OCR_RECOGNIZER_CRNN_MOBILENET_V3_SMALL`
- `OCR_RECOGNIZER_PARSEQ`

**Parakeet (CTC):**
- `PARAKEET_CTC_FP32`, `PARAKEET_CTC_DATA_FP32`, `PARAKEET_CTC_VOCAB`, `PARAKEET_CTC_INT8`, `PARAKEET_CTC_CONFIG`
- `PARAKEET_CTC_FP32_1`, `PARAKEET_CTC_DATA_FP32_1`, `PARAKEET_CTC_TOKENIZER`

**Parakeet (Sortformer / EOU):**
- `PARAKEET_SORTFORMER_FP32`
- `PARAKEET_EOU_ENCODER_FP32`, `PARAKEET_EOU_DECODER_FP32`, `PARAKEET_EOU_TOKENIZER`

**Parakeet (TDT — renamed from unprefixed):**
- `PARAKEET_TDT_ENCODER_FP32`, `PARAKEET_TDT_ENCODER_DATA_FP32`, `PARAKEET_TDT_DECODER_FP32`, `PARAKEET_TDT_VOCAB`, `PARAKEET_TDT_PREPROCESSOR_FP32`
- `PARAKEET_TDT_ENCODER_INT8`, `PARAKEET_TDT_DECODER_INT8`, `PARAKEET_TDT_PREPROCESSOR_INT8`

### Removed Models

The following unprefixed Parakeet constants were replaced by their `TDT_` equivalents (see breaking changes):

- `PARAKEET_ENCODER_FP32`, `PARAKEET_ENCODER_DATA_FP32`, `PARAKEET_DECODER_FP32`, `PARAKEET_VOCAB`, `PARAKEET_PREPROCESSOR_FP32`
- `PARAKEET_ENCODER_INT8`, `PARAKEET_DECODER_INT8`, `PARAKEET_PREPROCESSOR_INT8`

---

## 🧹 Other Changes

- Consolidated transcription schemas and shared ops into a unified structure.
- Updated `@qvac/tts-onnx` to v0.6.1 and `@qvac/transcription-whispercpp` addon.
- Aligned TTS plugin artifact patterns.
- Ported Android E2E test workflow to the monorepo.
- Improved changelog aggregation to prefer `CHANGELOG_LLM.md` when available.
- Reorganized monorepo documentation structure.
- Ported logging executor to direct assertions and added missing test handlers.
- Enabled profiling in test-qvac desktop and mobile consumers.

## [0.7.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.7.0

This release introduces the Model Registry integration, a powerful plugin system, and two new TTS engines (Chatterbox and Supertonic). Model constant names have been standardized for consistency, and several Windows-specific bugs have been resolved.

---

## 💥 Breaking Changes

### Model Constant Naming Standardization

Model constant names have been normalized for consistency. If your code references model constants directly, you'll need to update the imports.

**Bergamot translation models** now use underscores between language codes:

```typescript
// Before
import { BERGAMOT_AREN } from "@qvac/sdk";

// After
import { BERGAMOT_AR_EN } from "@qvac/sdk";
```

**Whisper models** have simplified names without author/repo prefixes:

```typescript
// Before
import { WHISPER_ENGLISH_BASE_OPENAI_WHISPER_BASE_F16 } from "@qvac/sdk";

// After
import { WHISPER_EN_BASE_Q0F16 } from "@qvac/sdk";
```

**LLM models** have normalized version prefixes:

```typescript
// Before
import { QWEN_3_1_7B_INST_Q4 } from "@qvac/sdk";

// After
import { QWEN3_1_7B_INST_Q4 } from "@qvac/sdk";
```

### HyperdriveItem Type Renamed to RegistryItem

The model metadata type has been renamed and restructured to support the new registry system.

```typescript
// Before
import type { HyperdriveItem } from "@qvac/sdk";

// After
import type { RegistryItem } from "@qvac/sdk";
```

The shape has also changed: `hyperdriveKey` and `hyperbeeKey` fields are replaced by `registryPath`, `registrySource`, `blobCoreKey`, and new metadata fields (`engine`, `quantization`, `params`).

---

## ✨ New Features

### Model Registry Integration

Discover and search models directly through the SDK without needing a separate registry client package.

```typescript
import {
  modelRegistryList,
  modelRegistrySearch,
  modelRegistryGetModel,
} from "@qvac/sdk";

// List all available models
const models = await modelRegistryList();

// Search by engine type
const llmModels = await modelRegistrySearch({ engine: "@qvac/llm-llamacpp" });

// Search by text filter
const whisperModels = await modelRegistrySearch({ filter: "whisper" });

// Search by quantization
const q4Models = await modelRegistrySearch({ quantization: "q4" });

// Get a specific model by path
const model = await modelRegistryGetModel(registryPath, registrySource);
```

### Plugin System

Build custom model integrations with the new plugin architecture. Plugins support both request/reply and streaming patterns.

```typescript
import { invokePlugin, invokePluginStream, definePlugin, defineHandler } from "@qvac/sdk";

// Invoke a plugin handler
const result = await invokePlugin<MyResponse>({
  modelId,
  handler: "myHandler",
  params: { key: "value" },
});

// Stream responses from a plugin
for await (const chunk of invokePluginStream<MyStreamResponse>({
  modelId,
  handler: "myStreamHandler",
  params: { key: "value" },
})) {
  console.log(chunk.result);
}
```

### Chatterbox TTS Engine (Voice Cloning)

Clone voices from reference audio samples with the new Chatterbox engine.

```typescript
const modelId = await loadModel({
  modelSrc,
  modelType: "tts",
  modelConfig: {
    ttsEngine: "chatterbox",
    language: "en",
    ttsTokenizerSrc,
    ttsSpeechEncoderSrc,
    ttsEmbedTokensSrc,
    ttsConditionalDecoderSrc,
    ttsLanguageModelSrc,
    referenceAudioSrc, // Your voice sample
  },
});

const audio = await textToSpeech({
  modelId,
  text: "Hello in a cloned voice!",
  inputType: "text",
  stream: false,
});
```

### Supertonic TTS Engine (General Purpose)

High-quality text-to-speech with adjustable speed and inference steps.

```typescript
const modelId = await loadModel({
  modelSrc,
  modelType: "tts",
  modelConfig: {
    ttsEngine: "supertonic",
    language: "en",
    ttsTokenizerSrc,
    ttsTextEncoderSrc,
    ttsLatentDenoiserSrc,
    ttsVoiceDecoderSrc,
    ttsVoiceSrc,
    ttsSpeed: 1.0,           // Playback speed
    ttsNumInferenceSteps: 5, // Quality vs speed tradeoff
  },
});
```

### CLI SDK Path Option

Explicitly specify the SDK location when running CLI commands:

```bash
qvac --sdk-path /custom/path/to/sdk <command>
```

### Direct Registry Downloads

Model downloads now use `downloadBlob` for more efficient direct registry fetching, improving download performance and resume support.

---

## 🔌 API Changes

### Async Close Handler

The `close()` function is now properly async and awaitable for clean shutdown:

```typescript
import { close } from "@qvac/sdk";

// Now returns a Promise
await close();
```

### Engine-Addon Mapping Utilities

Map between engine names and addon types:

```typescript
import { resolveCanonicalEngine, getAddonFromEngine } from "@qvac/sdk";

const engine = resolveCanonicalEngine("@qvac/llm-llamacpp"); // "llamacpp-completion"
const addon = getAddonFromEngine("llamacpp-completion");     // "llm"
```

---

## 🐞 Bug Fixes

### Windows Compatibility

- **EBUSY on shutdown** — Fixed corestore directory deletion order that caused file lock errors on Windows
- **File descriptor race** — Added proper await for `closeRegistryClient` in `findModelShards` to prevent fd-lock races
- **Download resume** — Corestore storage path is now stable, enabling reliable download resume across sessions

### Security

- **Path traversal protection** — Added validation to prevent directory traversal attacks in file paths

### TTS Improvements

- Empty text input is now rejected with a clear error message
- Addon errors are properly wrapped with context

### Expo/React Native

- Extracted `expo-device` to a stubbable module for easier testing
- Removed persistent `node-rpc-client` truncation from Expo plugin
- SDK package directory is now resolved dynamically in Expo plugins

### RPC Client

- Fixed delegate RPC client connection bugs for more reliable remote model access

---

## ⚙️ Infrastructure

- SDK changelog generation tooling updated with root CHANGELOG.md aggregation
- Test workflows now configured with auth tokens for CI/CD

---

## Migration Checklist

1. **Update model constant imports** — Run a find-and-replace for renamed constants
2. **Update `HyperdriveItem` to `RegistryItem`** — If you use the type directly
3. **Await `close()` calls** — Add `await` if you call `close()` during shutdown
4. **Test on Windows** — Verify clean shutdown with no EBUSY errors

## [0.6.1]

Release Date: 2026-02-10

## 🧹 Chores

- Bump llamacpp dependencies and remove iphone 17 cpu override. (see PR [#213](https://github.com/tetherto/qvac/pull/213))

## ⚙️ Infrastructure

- Update SDK pod changelog generation and shared tooling. (see PR [#155](https://github.com/tetherto/qvac/pull/155))

## [0.6.0]

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.6.0

This release brings major improvements to the RAG pipeline with progress streaming, cancellation support, and workspace management. We've also added OCR capabilities, a new Bergamot translation engine, and support for sharded model downloads. Several breaking changes streamline the API for better developer experience.

---

## 💥 Breaking Changes

### RAG API Redesign

The RAG system has been restructured for better control and flexibility. The main change: `ragSaveEmbeddings` now expects pre-embedded documents, while a new `ragIngest` function handles the full pipeline.

**Before:**

```typescript
await ragSaveEmbeddings({
  modelId,
  documents: ["Doc 1", "Doc 2"],
  chunk: false,
});
```

**After:**

```typescript
// Full pipeline (same behavior as old ragSaveEmbeddings)
await ragIngest({
  modelId,
  documents: ["Doc 1", "Doc 2"],
});

// Or: segregated flow with pre-embedded docs
await ragSaveEmbeddings({
  documents: [
    { id: "1", content: "Doc 1", embedding: [...], embeddingModelId: "model-id" }
  ],
});
```

Other RAG changes:
- `ragSaveEmbeddings` no longer returns `droppedIndices`
- `ragDeleteEmbeddings` now returns `void` instead of `boolean` (throws on failure)
- `ragDeleteEmbeddings` no longer requires `modelId` (uses cached workspace)
- Chunking is now enabled by default in `ragIngest`

### Embedding Config is Now Structured

No more string-based config! Use typed properties for embedding model configuration.

**Before:**

```typescript
await loadModel({
  modelSrc: "embed-model.gguf",
  modelType: "embeddings",
  modelConfig: {
    config: "-ngl\t99\n-dev\tgpu\n--batch_size\t1024",
  },
});
```

**After:**

```typescript
await loadModel({
  modelSrc: "embed-model.gguf",
  modelType: "embeddings",
  modelConfig: {
    gpuLayers: 99,
    device: "gpu",
    batchSize: 1024,
  },
});

// Escape hatch for advanced CLI control
await loadModel({
  modelSrc: "embed-model.gguf",
  modelType: "embeddings",
  modelConfig: {
    rawConfig: "-ngl\t99\n-dev\tgpu\n--batch_size\t1024",
  },
});
```

### Translation Engine Must Be Specified

Loading translation models now requires an explicit `engine` field for type-safe language validation.

**Before:**

```typescript
const modelId = await loadModel({
  modelSrc: MARIAN_OPUS_EN_IT_Q0F32,
  modelType: "nmt",
  modelConfig: { from: "en", to: "it" },
});
```

**After:**

```typescript
const modelId = await loadModel({
  modelSrc: MARIAN_OPUS_EN_IT_Q0F32,
  modelType: "nmt",
  modelConfig: {
    engine: "Opus",  // Required: "Opus" | "Bergamot" | "IndicTrans"
    from: "en",
    to: "it",
  },
});
```

---

## ✨ New Features

### Bergamot Translation Engine

A new translation engine option with support for batch translation and automatic vocabulary file derivation.

```typescript
import { loadModel, translate, BERGAMOT_ENFR } from "@qvac/sdk";

const modelId = await loadModel({
  modelSrc: BERGAMOT_ENFR,
  modelType: "nmt",
  modelConfig: {
    engine: "Bergamot",
    from: "en",
    to: "fr",
    normalize: 1,  // Bergamot-specific option
  },
});

// Batch translation
const result = translate({
  modelId,
  text: ["Hello world", "How are you?"],
  modelType: "nmt",
  stream: false,
});

const translated = await result.text;
// "Bonjour le monde\nComment allez-vous?"
```

### Import Maps for Cross-Runtime Compatibility

The SDK now uses import maps internally, improving compatibility across Node.js, Bare, and React Native runtimes.

---

## 🔌 New APIs

### OCR (Optical Character Recognition)

Extract text from images with bounding boxes and confidence scores.

```typescript
import { loadModel, ocr, OCR_CRAFT_LATIN_RECOGNIZER } from "@qvac/sdk";

const modelId = await loadModel({
  modelSrc: OCR_CRAFT_LATIN_RECOGNIZER,
  modelType: "ocr",
  modelConfig: { langList: ["en"] },
});

// Get all text blocks at once
const { blocks, done } = ocr({ modelId, image: "/path/to/image.png" });
const result = await blocks;
await done;

// Or stream blocks as they're detected
const { blockStream, done } = ocr({ modelId, image: imageBuffer, stream: true });
for await (const blocks of blockStream) {
  console.log(blocks);
  // [{ text: "Hello", bbox: [10, 20, 100, 50], confidence: 0.95 }]
}
```

### Sharded Model Downloads

Load large models split across multiple files, from URLs or archives.

```typescript
// Pattern-based sharded URLs (auto-detects shard pattern)
await loadModel({
  modelSrc: "https://huggingface.co/user/model/resolve/main/model-00001-of-00003.gguf",
  modelType: "llm",
});

// Archive-based shards (.tar.gz, .tar, .tgz)
await loadModel({
  modelSrc: "https://huggingface.co/user/model/resolve/main/model.tar.gz",
  modelType: "llm",
});
```

### Device-Specific Model Configuration

Configure model defaults per device brand, platform, or other runtime context.

```javascript
// qvac.config.js
{
  "deviceDefaults": [
    {
      "name": "All Google Android devices",
      "match": {
        "platform": "android",
        "deviceBrand": "google"
      },
      "defaults": {
        "llamacpp-completion": { "device": "cpu" },
        "llamacpp-embedding": { "device": "cpu" }
      }
    }
  ]
}
```

### Canonical Model Type Naming

Model types now use a consistent `engine-usecase` format. Old names still work but show deprecation warnings.

```typescript
// Preferred
loadModel({ modelType: "onnx-ocr", ... });

// Deprecated (logs warning)
loadModel({ modelType: "ocr", ... });
// [sdk:client] Model type "ocr" is an alias and will be deprecated. Use "onnx-ocr" instead.
```

---

## 🐞 Bug Fixes

- **Whisper cold start eliminated** — Transcription now starts immediately without initialization delay
- **Incomplete download detection** — Cache validation now checks file size, not just existence
- **Offline cache fallback** — HTTP model validation works without network connectivity
- **Mobile archive extraction** — Archive-based models now extract correctly on iOS/Android
- **KV cache context reuse** — Fixed issues where conversation context wasn't being preserved across requests

---

## 📦 New Models

Six new LLM models added:

- `GPT_OSS_20B_INST_Q4_K_M` — GPT-OSS 20B instruction model
- `LFM_2_5_1_2B_INST_Q4_0` — LFM 2.5 1.2B (Q4_0 quantization)
- `LFM_2_5_1_2B_INST_Q4_K_M` — LFM 2.5 1.2B (Q4_K_M quantization)
- `LLAMA_TOOL_CALLING_3_2_1B_INST_Q4_K` — Llama 3.2 1B with tool calling support
- `QWEN_3_4B_INST_Q4_K_M` — Qwen 3 4B instruction model
- `QWEN_3_8B_INST_Q4_K_M` — Qwen 3 8B instruction model

## [0.5.0]

This release introduces a streamlined configuration system, powerful new APIs for batch embeddings and MCP tool integration, and a unified logging experience across all SDK components. We've also improved Android compatibility and fixed several critical audio processing issues.

---

## Breaking Changes

### Configuration is Now File-Based

The SDK now uses a config file instead of the `setConfig()` API. This simplifies initialization—create a `qvac.config.json` in your project root and the SDK handles the rest automatically.

**Before:**

```typescript
import { setConfig, loadModel } from "@qvac/sdk";

await setConfig({
  cacheDirectory: "/custom/cache/path",
});

await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0, modelType: "llama" });
```

**After:**

```json
// qvac.config.json
{
  "cacheDirectory": "/custom/cache/path",
  "swarmRelays": ["relay-key-1", "relay-key-2"]
}
```

```typescript
import { loadModel } from "@qvac/sdk";

// Config automatically loaded at initialization!
await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0, modelType: "llama" });
```

#### Config Resolution Order

The SDK searches for configuration in this order:

1. **`QVAC_CONFIG_PATH` environment variable** — Explicit path to config file
2. **Project root** — Auto-discovers `qvac.config.{ts,js,json}`
3. **SDK defaults** — Fallback if no config found

#### Supported Formats

| Format     | Filename           | Notes                        |
| ---------- | ------------------ | ---------------------------- |
| JSON       | `qvac.config.json` | Simplest option              |
| JavaScript | `qvac.config.js`   | Use `export default`         |
| TypeScript | `qvac.config.ts`   | Fully typed with `QvacConfig` |

**TypeScript example:**

```typescript
// qvac.config.ts
import type { QvacConfig } from "@qvac/sdk";

const config: QvacConfig = {
  cacheDirectory: "/custom/cache/path",
  swarmRelays: ["relay-key-1", "relay-key-2"],
};

export default config;
```

#### Migration Steps

1. Remove all `setConfig()` calls from your code
2. Create a config file in your project root
3. *(Optional)* For non-standard locations, set `QVAC_CONFIG_PATH` before importing the SDK

---

### Model Constant Cleanup

Some model constants have been renamed for clarity, and duplicate constants have been removed.

**Changes:**

| Before                     | After                                             |
| -------------------------- | ------------------------------------------------- |
| `WHISPER_SMALL`            | `WHISPER_SMALL_Q8`                                |
| `WHISPER_NORWEGIAN_TINY_1` | *(removed — use `WHISPER_NORWEGIAN_TINY`)*        |
| `WHISPER_TINY_SILERO`      | *(removed — use `WHISPER_TINY`)*                  |
| `MARIAN_OPUS_EN_FR_Q4_0_1` | *(removed — use `MARIAN_OPUS_EN_FR_Q4_0`)*        |
| `MARIAN_OPUS_FR_EN_Q4_0_1` | *(removed — use `MARIAN_OPUS_FR_EN_Q4_0`)*        |
| `MARIAN_OPUS_IT_EN`        | *(removed — use `MARIAN_OPUS_EN_IT`)*             |

All model metadata and hyperdrive keys remain unchanged—only the constant names were affected.

---

### Unified Logging API

The logging stream API has been simplified with consistent naming.

#### Parameter Change

**Before:**

```typescript
for await (const log of loggingStream({ modelId: myModelId })) {
  console.log(log.message);
}
```

**After:**

```typescript
for await (const log of loggingStream({ id: myModelId })) {
  console.log(log.message);
}
```

#### Response Property Change

The response object property also changed from `log.modelId` to `log.id`.

#### Global Log Level Moved to Config

`setGlobalLogLevel()` has been removed from the public API. It only worked in the client process, not the server. Use the config file instead:

```json
{
  "loggerLevel": "debug"
}
```

Or use per-logger control: `logger.setLevel("debug")`.

---

## New APIs

### Config Hot-Reload

You can now update a model's configuration without unloading it. Pass the existing `modelId` to `loadModel()` with new config options—the model stays loaded with zero downtime.

```typescript
// Load model with initial config
const modelId = await loadModel({
  modelSrc: "pear://.../whisper.gguf",
  modelType: "whisper",
  modelConfig: { language: "en" },
});

// Hot-reload with new config (same modelId, no reload delay)
await loadModel({
  modelId,
  modelType: "whisper",
  modelConfig: { language: "es" },
});
```

---

### MCP Tool Integration

The SDK now supports the Model Context Protocol (MCP) for tool integration. Pass MCP clients directly to `completion()` and use `call()` to execute tool calls.

**Using MCP clients:**

```typescript
import { completion } from "@qvac/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// Create and connect your MCP client
const mcpClient = new Client({ name: "my-app", version: "1.0.0" });
await mcpClient.connect(transport);

// Pass MCP clients to completion
const result = completion({
  modelId,
  history,
  mcp: [{ client: mcpClient }],
});

// Execute tool calls
for (const toolCall of await result.toolCalls) {
  const response = await toolCall.call();
}

// Clean up when done
await mcpClient.close();
```

**Using inline tools with handlers:**

```typescript
import { z } from "zod";

const result = completion({
  modelId,
  history,
  tools: [
    {
      name: "get_weather",
      description: "Get weather for a city",
      parameters: z.object({ city: z.string() }),
      handler: async (args) => {
        return await fetchWeather(args.city);
      },
    },
  ],
});

for (const toolCall of await result.toolCalls) {
  const response = await toolCall.call(); // Executes your handler
}
```

---

### Batch Embeddings

The `embed()` function now accepts arrays, enabling efficient batch processing. Return types are automatically inferred based on input.

```typescript
// Single text → returns number[]
const embedding = await embed({ modelId, text: "hello" });

// Batch texts → returns number[][]
const embeddings = await embed({ modelId, text: ["a", "b", "c"] });
```

Batch processing uses a default batch size of 1024 for optimal throughput.

---

### Addon Log Streaming

C++ addon logs from llama.cpp, whisper.cpp, and other native libraries are now streamed through the SDK's unified logging system.

**Key features:**

- Logs broadcast to all active SDK loggers per namespace (`llamacpp:llm`, `llamacpp:embed`)
- Automatic buffering during `loadModel()` — logs are flushed when `loggingStream()` connects
- Memory-safe: 100 log limit with 30s expiry
- Console output control via `enableConsole` option

**Run the example:**

```bash
bun run examples/logging-streaming
```

---

## Features

### Unified Addon Logging

All native addons (Whisper, TTS, NMT) now use the same logging infrastructure, providing consistent log output across the entire SDK.

### Android 16KB Page Size Compatibility

Dependencies have been upgraded to comply with Android's 16KB page size requirement, ensuring compatibility with newer Android devices.

### bare-ffmpeg Decoder

The SDK now uses `bare-ffmpeg` for audio decoding, improving compatibility and performance.

### Developer Experience Improvements

- **Changelog generator** with commit/PR validation keeps release notes consistent
- **Non-blocking model update checks** in pre-commit hooks don't slow down your workflow

---

## Bug Fixes

### Audio Processing Fixes

- **Corrupted audio files no longer hang** — The SDK now properly handles malformed audio instead of blocking indefinitely
- **Decoder exit handling** — Fixed process hanging due to decoder not exiting properly
- **Decoder bump** — Updated to latest decoder version

### Whisper Improvements

- **Prompt state isolation** — Whisper prompt state no longer leaks between transcriptions, ensuring consistent results

### Android Compatibility

- **Flash Attention disabled on Android for Embeddings** — Prevents crashes on Android devices that don't support Flash Attention

---

## Documentation & Infrastructure

### Documentation

- Standardized documentation format across all guides
- New `docs:gen-pages` script for building documentation
- New `docs:gen-api` script for API reference generation
- Updated PR template, contributing guide, and README

### Infrastructure

- Automatic git tagging after npm publish
- Publish workflow for `npm-patch-*` branches
- Removed npm lockfile, standardized on Bun
