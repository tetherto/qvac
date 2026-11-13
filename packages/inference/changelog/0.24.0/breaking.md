# 💥 Breaking Changes v0.24.0

## Run the SDK worker on bare-stow

PR: [#5186](https://github.com/tetherto/qvac/pull/5186)

**BEFORE:**

```typescript
// Custom worker entry
import { initializeWorker, ensureRPCSetup } from '@qvac/sdk/worker-lifecycle'

// bundleSdk callers
const result = await bundleSdk({ hosts, checkEngines: false })
result.entryPaths.worker
```

**AFTER:**

```typescript
// Custom worker entry
import { startWorker } from '@qvac/sdk/worker'
export default (ipc, ready) => startWorker(ipc, ready, { plugins: [llmPlugin] })

// bundleSdk callers
const result = await bundleSdk({ target: 'bare-sidecar', hosts })
result.entryPath
```

A Node.js or Electron app on the default worker, with no bundle step, needs no changes unless it uses an error or setting from the first bullet.

- **All Node.js and Electron apps**
  - A failed start rejects with `WORKER_STARTUP_FAILED` instead of `RPC_INIT_TIMEOUT`, and `workerExited` is replaced by `exitCode`, `exitSignal` and `timedOut`.
  - `rpcInitTimeoutMs` covers the whole start, 60 s by default (was the handshake only, 30 s). `QVAC_RPC_INIT_TIMEOUT_MS` and `bareRuntimeVersion` are removed.
  - The worker runs on `bare-sidecar`'s Bare, not `bare-runtime`, so move any override that pinned `bare-runtime`.
- **Apps that bundle the worker** (`qvac bundle sdk`, `bundleSdk`, the Electron Forge plugin)
  - Bundle again after upgrading; the output is now the `qvac/worker/` folder. The Forge plugin and `npx expo prebuild` do this for you.
  - Bundling needs Node.js `^22.21.0 || >=24.9.0`. Bundling for another desktop host needs that host's addon packages, e.g. `@qvac/fabric-darwin-x64`.
  - pnpm and bun's isolated linker need `bare-stow-runtime` and `bare-stow-host` in the app's dependencies, plus `bare-sidecar` for desktop, `react-native-bare-kit` for React Native or `bare-path` for Pear. Yarn needs `nodeLinker: node-modules`.
  - `qvac verify bundle` drops `--bare-runtime-version` and `--config`, `--json` reports one runtime per platform, and an `engines-mismatch` is a warning.
  - `bundleSdk` drops `checkEngines` and returns `entryPath`, `outputDir` and `verification` instead of `entryPaths` and `manifestPath`. In `@qvac/sdk/commands`, `RuntimeGroup` is `PlatformRuntime` and `EnginesUpgrade` is removed.
- **Custom worker entries:** `@qvac/sdk/worker-lifecycle` is replaced by `startWorker` from `@qvac/sdk/worker`.
- **Expo and React Native:** Expo SDK 58+ (was 54). The peer ranges are now `>=58.0.0` for `expo-build-properties`, `expo-device`, `expo-file-system` and `expo-modules-core`, and `^0.17.1` for `react-native-bare-kit` (was `>=0.16.0`). Run `npx expo prebuild` again. `@qvac/sdk/worker.mobile.bundle` is now `@qvac/sdk/worker.mobile`.
- **Pear:** install `bare-stow-target-pear-runtime`, bundle with `--target pear-runtime`, and call `usePearRuntime(pear)` from `@qvac/sdk/pear` instead of importing `@qvac/sdk/pear-pre`. `pear-pipe` is no longer a peer dependency.
- **`@qvac/inference` used directly:** pass the home folder with `initialize({ homeDir })`, since `Bare.argv` is no longer read, and drop `bareRuntimeVersion` from its config.
- **Python:** needs Linux with glibc 2.34+ (not musl), macOS 13+ or Windows. `QVAC_BARE_PATH` takes `bare-sidecar`'s Bare. Worker failures raise `WorkerStartupError`, `WorkerCrashedError`, `WorkerShutdownError` or `SetConfigFailedError`.
- **Kotlin Android:** `compileSdk` 36+ and `abiFilters` set to `arm64-v8a`. `AndroidBareKitTransport.connect(assetName)` is now `connect()`.
- **Kotlin desktop JVM:** the published zip no longer runs a worker, and `JvmBareRpcTransport` is removed. Build the experimental `:jvm-barekit` module and use `JvmBareKitTransport.connect()`.
- **Removed error codes:** `RPC_INIT_TIMEOUT` (50204), `PEAR_WORKER_ENTRY_REQUIRED` (50606), `WORKER_PLUGINS_NOT_REGISTERED` (50608), `BARE_PACK_NOT_INSTALLED` (50610), `BARE_PACK_ERROR` (50611) and `BARE_RUNTIME_BINARY_NOT_FOUND` (50614), with their Kotlin `QvacKnownException` subclasses and `BareRuntimeBinaryNotFoundError`.

---

## Support EmbeddingGemma 2 multimodal embeddings

PR: [#5464](https://github.com/tetherto/qvac/pull/5464)

**BEFORE:**

```kotlin
import io.tether.qvac.sdk.generated.schema.EmbedRequest
import io.tether.qvac.sdk.generated.schema.EmbedRequestText

val request = EmbedRequest(
    modelId = "m",
    text = EmbedRequestText.Variant1("hi"),
    requestId = "embed-1",
)
```

**AFTER:**

```kotlin
import io.tether.qvac.sdk.generated.schema.EmbedRequest
import io.tether.qvac.sdk.generated.schema.EmbedTextRequest
import io.tether.qvac.sdk.generated.schema.EmbedTextRequestText

val request = EmbedRequest.EmbedTextRequest(
    EmbedTextRequest(
        modelId = "m",
        text = EmbedTextRequestText.Variant1("hi"),
        requestId = "embed-1",
    ),
)
```

For text batches, use `EmbedTextRequestText.Variant2(texts)` inside the same wrapper. For multimodal batches, use `EmbedRequest.EmbedInputsRequest` wrapping an `EmbedInputsRequest`. When inspecting a request typed as `EmbedRequest`, select the variant and read its fields through `.value`.

The existing `QvacEmbeddings.embed(modelId, text)` and `embed(modelId, texts)` convenience methods remain supported and need no caller migration.

### Python

The existing keyword constructor still works. `EmbedRequest` is now a Pydantic `RootModel` containing the selected request variant, so direct `.model_id`, `.text`, and `.request_id` access must move under `.root`.

**BEFORE:**

```python
from tetherto.qvac_sdk import EmbedRequest

request = EmbedRequest(model_id="m", text="hi", request_id="embed-1")
model_id = request.model_id
text = request.text
request_id = request.request_id
```

**AFTER:**

```python
from tetherto.qvac_sdk import EmbedRequest

request = EmbedRequest(model_id="m", text="hi", request_id="embed-1")
model_id = request.root.model_id
text = request.root.text
request_id = request.root.request_id
```

For the `inputs` variant, read `request.root.inputs` after selecting that variant. Continue passing the outer `request` to `embed(transport, request)`; do not replace it with `request.root`. Wire serialization remains flat, with no `root` or `value` field added to the RPC payload.

---

## Accept ordered text and media content in history

PR: [#5505](https://github.com/tetherto/qvac/pull/5505)

**BEFORE:**
A user turn with `[text A, image A, text B, image B]` reached the model
as `[image A, image B, text A + text B]`.

**AFTER:**
The same turn reaches the model as `[text A, image A, text B, image B]`.

### Kotlin

Direct users of the generated Kotlin history models must wrap text in the generated content union. JSON wire compatibility for string content and the `QvacMessage` API is preserved.

**BEFORE:**

```kotlin
CompletionStreamRequestHistoryItem(role = "user", content = "Hello")
```

**AFTER:**

```kotlin
CompletionStreamRequestHistoryItem(
    role = "user",
    content = CompletionStreamRequestHistoryItemContent.Variant1("Hello"),
)
```

---

## Answer model fit from the addons' per-device memory

PR: [#5512](https://github.com/tetherto/qvac/pull/5512)

**BEFORE:**

```typescript
const fit = await assessModelFit({ models, execution: 'concurrent', policy })
// {
//   verdict: 'likely-fits' | 'likely-too-large' | 'unknown',
//   basis, execution, evidence, budget, floorBytes, reasons, assumptions,
//   models: [{ name, verdict, evidence, floorBytes, estimatorVersion, device, reasons }]
// }

const { fitProbe } = await getLoadedModelInfo({ modelId })
// { verdict: 'fit' | 'does-not-fit' | 'unknown', basis, engine, reason, message, plan, projection }

import { getModelResourceProfile } from '@qvac/inference/model-resource-profiles'
```

**AFTER:**

```typescript
const fit = await assessModelFit({ models })
// {
//   verdict: 'fits' | 'does-not-fit' | 'unknown',
//   pools: [{ id, unified, usedBytes, freeBytes?, totalBytes? }],
//   models: [{
//     status: 'fits' | 'does-not-fit' | 'unknown',
//     devices: [{ id, name, unified, usedBytes, freeBytes?, totalBytes? }],  // host last; [] when unknown
//     stats: { ctxSize, gpuLayers } | {}
//   }]
// }

const { fitProbe } = await getLoadedModelInfo({ modelId })
// { verdict, pools, models }  for that one load

// @qvac/inference/model-resource-profiles is removed.
```

**Remote RPC servers:** the SDK now depends on `@qvac/ggml-rpc-server` `^0.9.0`, and the RPC protocol changed since 0.23. Upgrade every remote RPC server together with the SDK.

```bash
npm install @qvac/ggml-rpc-server@^0.9.0
```

---

## SDK caller sessions, model leases and scoped cancellation

PR: [#5541](https://github.com/tetherto/qvac/pull/5541)

**BEFORE:**

```typescript
const unload = (modelId: string): Promise<void> => unloadModel({ modelId })

const diffusionMock: typeof diffusion = () => ({ progressStream, outputs, stats })
```

**AFTER:**

```typescript
const unload = async (modelId: string): Promise<void> => {
  await unloadModel({ modelId }) // resolves with UnloadModelResult { released, unloaded }
}

const diffusionMock: typeof diffusion = () => ({ requestId: 'r-1', progressStream, outputs, stats })
```

---

## Load the MobileNet classifier from the registry

PR: [#5551](https://github.com/tetherto/qvac/pull/5551)

**BEFORE:**

```json
{ "serve": { "models": { "classifier": { "type": "ggml-classification" } } } }
```

**AFTER:**

```json
{ "serve": { "models": { "classifier": { "model": "MOBILENETV3_3CLASS_V3_FP16" } } } }
```

An alias with `type` and no `src` fails with `serve.models.<alias>: "src" is required`.

Kotlin Android runtime: `qvac/classification/mobilenetv3_3class_v3_fp16.gguf` and the `resources` entry of `qvac/profile.json` are no longer packaged; load `Models.MOBILENETV3_3CLASS_V3_FP16`.

---

## Point EmbeddingGemma-300M constants at the Dense-layer models

PR: [#5634](https://github.com/tetherto/qvac/pull/5634)

**BEFORE:**

```typescript
import { EMBEDDINGGEMMA_300M_F32 } from '@qvac/sdk'
```

**AFTER:**

```typescript
import { EMBEDDINGGEMMA_300M_BF16 } from '@qvac/sdk'
```

`EMBEDDINGGEMMA_300M_BF16`, `EMBEDDINGGEMMA_300M_Q4_0` and `EMBEDDINGGEMMA_300M_Q8_0` keep their names but now resolve to the Dense-layer model files. Embeddings from the updated constants differ from those of the old files, so re-ingest any RAG workspace that was built with an earlier EmbeddingGemma-300M constant.

---

## Send no system message unless the caller configures one

PR: [#5686](https://github.com/tetherto/qvac/pull/5686)

**BEFORE:**

```typescript
const modelId = await loadModel({ modelSrc, modelType: 'llm' })

completion({
  modelId,
  history: [{ role: 'user', content: 'What is the capital of France?' }]
})
// payload: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', ... }]
```

**AFTER:**

```typescript
const modelId = await loadModel({ modelSrc, modelType: 'llm' })

completion({
  modelId,
  history: [{ role: 'user', content: 'What is the capital of France?' }]
})
// payload: [{ role: 'user', ... }]

// To keep the previous prompt, set it at load:
await loadModel({
  modelSrc,
  modelType: 'llm',
  modelConfig: { system_prompt: 'You are a helpful assistant.' }
})
```

---

## Reject a prefill with no message and fix the SDK e2e prefill failures

PR: [#5708](https://github.com/tetherto/qvac/pull/5708)

**BEFORE:**

```typescript
await completion({ modelId, history: [], tools, kvCache: true, prefill: true }).final
// primed "You are a helpful assistant." + tools
```

**AFTER:**

```typescript
// throws RequestValidationFailedError: prefill needs at least one message
await completion({ modelId, history: [], tools, kvCache: true, prefill: true }).final

// supply the message in history...
await completion({
  modelId,
  history: [{ role: 'system', content: '...' }],
  tools,
  kvCache: true,
  prefill: true
}).final
// ...or set it at load
await loadModel({ ...options, modelConfig: { tools: true, system_prompt: '...' } })
```

---

## Changes outside the tagged PRs that can break 0.23 code

These arrived in PRs that were not tagged breaking, or as side effects of the sections above.

- **A stale model handle throws instead of restarting the worker** ([#5541](https://github.com/tetherto/qvac/pull/5541)). After `close()` or a worker crash, a call that names a `modelId` loaded on the stopped runtime throws `ModelHandleInvalidatedError` (50209). Load the model again and use the new id.
- **A streaming call's `timeout` is now enforced** ([#5334](https://github.com/tetherto/qvac/pull/5334)). `rpcOptions.timeout` on a streaming call applies to each chunk and throws `OperationTimeoutError`; in 0.23 it never fired on streams. A timeout on a unary call now also cancels the request on the worker. Raise or remove a timeout that was sized for the old behaviour.
- **The MobileNet classifier needs a source in TypeScript too** ([#5551](https://github.com/tetherto/qvac/pull/5551)). `loadModel({ modelType: 'ggml-classification' })` no longer finds bundled weights. Pass `modelSrc: MOBILENETV3_3CLASS_V3_FP16`.
- **Result types gained required members** ([#5541](https://github.com/tetherto/qvac/pull/5541), [#5691](https://github.com/tetherto/qvac/pull/5691)). `ocr()` and `upscale()` results carry `requestId`, `VectorIndex` carries `calibrated`, `stagedSearch` and `setStagedSearch`, and `invokePluginStream` is no longer an `async function*`. Mocks and wrappers typed against these need the new members.
- **`verifyBundle` from `@qvac/sdk/commands`** ([#5186](https://github.com/tetherto/qvac/pull/5186)). The `bareRuntimeVersion` and `configPath` options are removed, the result's `runtime` is replaced by `runtimes` (one per platform), and the `invalid-runtime-version` and `config-load-failed` issue codes are removed.
- **`WorkerStartupError` is thrown directly** ([#5186](https://github.com/tetherto/qvac/pull/5186)). It is no longer the `cause` of an `RPCInitTimeoutError`, and its `stderrTail` can be `undefined`.
- **Custom plugins with a fitter** ([#5512](https://github.com/tetherto/qvac/pull/5512)). `QvacPlugin.assessFit` must return `Promise<ModelFitModelResult>`.

---
