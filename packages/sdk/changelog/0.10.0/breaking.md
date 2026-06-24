# 💥 Breaking Changes v0.10.0

## Add parallel orchestration, download dedupe, and generic companion-set support

PR: [#1636](https://github.com/tetherto/qvac/pull/1636)

**BEFORE:**
**

```typescript
onProgress: (progress) => {
  if (progress.onnxInfo) {
    console.log(
      `[${progress.onnxInfo.currentFile}] ` +
      `file ${progress.onnxInfo.fileIndex}/${progress.onnxInfo.totalFiles} — ` +
      `${progress.onnxInfo.overallPercentage.toFixed(1)}% overall`
    );
  }
}
```

**

**AFTER:**
**

```typescript
onProgress: (progress) => {
  if (progress.fileSetInfo) {
    console.log(
      `[${progress.fileSetInfo.currentFile}] ` +
      `file ${progress.fileSetInfo.fileIndex}/${progress.fileSetInfo.totalFiles} — ` +
      `${progress.fileSetInfo.overallPercentage.toFixed(1)}% overall`
    );
  }
}
```

## 🔌 Extensibility: adding a new companion format

The companion pipeline is generic. Only `companions.ts` contains format-specific detection (currently ONNX). To add a new format:

1. Add a detection function in `companions.ts`
2. Call it from `groupCompanionSets`

Everything downstream (codegen, resolver, cache probing, storage cleanup) handles it automatically.

## 🧪 How was it tested?

- Unit tests for `resolveClearStorageTarget` — companion set paths, legacy ONNX paths, flat cache, outside-cache paths, trailing slashes, Windows backslash paths
- Unit tests for `groupCompanionSets` — ONNX + `_data`/`.data` patterns, non-ONNX models, deterministic `setKey` generation
- **Companion set smoke test** — ran Parakeet CTC and TDT end-to-end, validated all 4 cache paths (legacy `_data` probe, legacy `.data` probe, canonical fresh download, canonical cache hit) with correct transcription output on each
- **Parallel orchestration**: ran `examples/llamacpp-multimodal.ts` with labeled progress — confirmed primary and projection models download concurrently via interleaved output
- **Profiling**: ran `examples/profiling/basic.ts` — confirmed `sourceType`, `cacheHit`, `sharedTransfer`, `totalLoadTime`, `modelInitializationTime`, `checksumValidationTime` populate correctly through `buildDownloadProfilingFields()`. Ran `examples/llamacpp-multimodal.ts` with profiling enabled — confirmed aggregate stats merge correctly across primary and projection downloads
- **Cancellation**: `^C` during multimodal download cleanly aborts both active transfers with no leaked state
- Build, lint, and typecheck pass

---

## Unified CompletionEvent stream as canonical completion API

PR: [#1673](https://github.com/tetherto/qvac/pull/1673)

**BEFORE:**
**

```typescript
// Wire response
{ type: "completionStream", token: "Hello", toolCallEvent: {...} }
{ type: "completionStream", token: "", done: true, stats: {...}, toolCalls: [...] }
```

**

**AFTER:**
**

```typescript
// Wire response
{ type: "completionStream", events: [{ type: "contentDelta", seq: 0, text: "Hello" }] }
{ type: "completionStream", done: true, events: [
  { type: "completionStats", seq: 5, stats: {...} },
  { type: "completionDone", seq: 6, raw: { fullText: "..." } }
]}
```

**Client API**: `completion()` return type is now `CompletionRun` (was anonymous object). Legacy fields still work but are derived views.

**BEFORE:**

```typescript
const result = completion({ modelId, history, stream: true });
for await (const token of result.tokenStream) { ... }
const stats = await result.stats;
```

**AFTER:**

```typescript
const run = completion({ modelId, history, stream: true, captureThinking: true });
for await (const event of run.events) {
  if (event.type === "contentDelta") process.stdout.write(event.text);
  if (event.type === "toolCall") console.log(event.call.name);
}
const result = await run.final;
// result.contentText, result.thinkingText, result.toolCalls, result.stats, result.raw.fullText
```

## 🧪 How was it tested?

- **Unit tests**: event schema validation and wire strictness, normalizer state machine (content, thinking, tool framing, fail-open, error-finish, scoped dedupe), and client-side event aggregation with error-done rejection
- **Manual**: ran `examples/completion-events.ts` (new event-driven API) and existing legacy examples — both produce correct output
- Build and typecheck passes

---

## Migrate SDK plugins to new addon constructor shape

PR: [#1688](https://github.com/tetherto/qvac/pull/1688)

**BEFORE:**
**

```typescript
export const myPlugin = definePlugin({
  // ...
  createModel(params: CreateModelParams): PluginModelResult {
    return { model, loader: null };
  },
});
```

**

**AFTER:**
**

---

## Switch delegation to direct DHT connect, drop topic end-to-end

PR: [#1729](https://github.com/tetherto/qvac/pull/1729)

**BEFORE:**
**
- Consumer: `swarm.join(topic)` → `swarm.flush()` → wait for `connection` event matching `peerPublicKey` → filter out everyone else.
- Provider: `swarm.join(topic, { server: true })` → `discovery.flushed()` → `swarm.flush()` (full topic announce on the DHT).

**

**AFTER:**
**
- Consumer: `swarm.dht.connect(publicKey)` — direct connection, no discovery, no filtering.
- Provider: `swarm.listen()` — binds the DHT server on the keyPair so consumers can reach it via `dht.connect(publicKey)`. No topic announce.

---

## Improve model type & capability system

PR: [#1748](https://github.com/tetherto/qvac/pull/1748)

**BEFORE:**
**

```typescript
import type { LoadModelOptions } from "@qvac/sdk";

const opts: LoadModelOptions = {
  modelSrc: "/path/foo",
  modelType: "my-custom-plugin",
  modelConfig: { whatever: 1 },
};
await loadModel(opts);
```

**

**AFTER:**
**

```typescript
import type { LoadCustomPluginModelOptions } from "@qvac/sdk";

// Generic must be supplied; it pins the literal plugin string.
const opts: LoadCustomPluginModelOptions<"my-custom-plugin"> = {
  modelSrc: "/path/foo",
  modelType: "my-custom-plugin",
  modelConfig: { whatever: 1 },
};
await loadModel(opts);

// Or just drop the annotation — TS picks the right overload.
```

### Wrong-model error code/message change (runtime)

Built-in SDK operations now surface `MODEL_OPERATION_NOT_SUPPORTED` instead of `PLUGIN_HANDLER_NOT_FOUND`. Low-level `pluginInvoke` / `pluginInvokeStream` still use `PLUGIN_HANDLER_NOT_FOUND`.

**BEFORE:**

```typescript
import { SDK_SERVER_ERROR_CODES } from "@qvac/sdk";

try {
  await transcribe({ modelId: llmModelId /* ... */ });
} catch (e) {
  if ((e as { code?: number })?.code === SDK_SERVER_ERROR_CODES.PLUGIN_HANDLER_NOT_FOUND) {
    /* ... */
  }
}
```

**AFTER:**

```typescript
import { SDK_SERVER_ERROR_CODES } from "@qvac/sdk";

try {
  await transcribe({ modelId: llmModelId /* ... */ });
} catch (e) {
  if ((e as { code?: number })?.code === SDK_SERVER_ERROR_CODES.MODEL_OPERATION_NOT_SUPPORTED) {
    // Message includes the requested operation, the loaded model type,
    // supported operations on the loaded model, and suggested model types.
  }
}
```

`PLUGIN_HANDLER_NOT_FOUND` is still the low-level path for `pluginInvoke` / `pluginInvokeStream`.

### `translate(...)` validates caller-supplied `modelType` against loaded type (runtime)

`translate(...)` now routes by the loaded model's registered type. A mismatched caller-supplied `modelType` throws `ModelTypeMismatchError` instead of being silently mis-routed.

**BEFORE:**

```typescript
// Loaded an NMT model, but called translate with modelType: "llm".
// Worker routed to the NMT plugin (modelId-based) but treated the input as LLM-style. Confusing failures.
await translate({ modelId: nmtModelId, modelType: "llm", text: "..." });
```

**AFTER:**

```typescript
// Drop modelType; the registered type drives behavior.
await translate({ modelId: nmtModelId, text: "..." });

// Or keep it — but it must match the loaded type, otherwise:
//   ModelTypeMismatchError: expected "nmtcpp-translation", got "llamacpp-completion"
await translate({ modelId: nmtModelId, modelType: "nmt", text: "..." });
```

## 🔌 API Changes

```typescript
import { getLoadedModelInfo, transcribe } from "@qvac/sdk";

// Introspect a loaded modelId (local or delegated). Discriminated on `isDelegated`.
const info = await getLoadedModelInfo({ modelId });

// Preflight a built-in SDK call before sending the RPC.
// Local: handlers + modelType are authoritative.
// Delegated: handlers is [] and preflight defers to the provider.
if (info.isDelegated || info.handlers.includes("transcribeStream")) {
  await transcribe({ modelId /* ... */ });
}

if (!info.isDelegated) {
  // info.modelType, info.loadedAt
  // info.displayName?, info.addonPackage?  (from the plugin)
  // info.name?, info.path?                 (from the model file)
}

// Throws ModelNotFoundError if modelId isn't loaded.
```

---

