# QVAC SDK v0.10.0 Release Notes

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
