# 💥 Breaking Changes v0.19.0

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
  - `qvac bundle sdk --host` defaults to this machine, or to every phone host for `--target react-native`. Pass `--host` for each other platform you ship.
  - `qvac doctor` reports the runtime check as `bare-sidecar-runtime` (was `bare-runtime`). An `engines-mismatch` is now a warning, and the failing case is reported as `abi-mismatch`. Update scripts that match on these codes.
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

**Remote RPC servers:** the SDK now depends on `@qvac/ggml-rpc-server` `^0.9.0`, and the RPC protocol changed since 0.23. Upgrade every remote RPC server together with the CLI.

```bash
npm install @qvac/ggml-rpc-server@^0.9.0
```

### `POST /qvac/v1/models/fit`

The HTTP route follows the same contract. The request body is strict: `execution` and `policy` are no longer accepted and answer `400`. The `invalid_execution` and `invalid_policy` error codes are removed, and `400 invalid_model_config` is added for a `config` the engine's schema refuses.

**BEFORE:**

```jsonc
// POST /qvac/v1/models/fit
{ "models": [{ "model": "qwen9b" }], "execution": "concurrent" }
// → { "object": "model_fit", "verdict": "likely-fits" | "likely-too-large" | "unknown",
//     "basis", "execution", "evidence", "budget", "floorBytes", "reasons", "assumptions",
//     "models": [{ "name", "verdict", "evidence", "floorBytes", "estimatorVersion", "device", "reasons" }] }
```

**AFTER:**

```jsonc
// POST /qvac/v1/models/fit
{ "models": [{ "model": "qwen9b" }] }
// → { "object": "model_fit", "verdict": "fits" | "does-not-fit" | "unknown",
//     "pools": [{ "id", "unified", "usedBytes", "freeBytes"?, "totalBytes"? }],
//     "models": [{ "model", "status", "devices": [{ "id", "name", "unified", "usedBytes", "freeBytes"?, "totalBytes"? }],
//                  "stats": { "ctxSize", "gpuLayers" } | {} }] }
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

## Named KV cache sessions for /v1/responses

PR: [#5548](https://github.com/tetherto/qvac/pull/5548)

**BEFORE:**

```jsonc
// POST /v1/chat/completions → usage
{
  "prompt_tokens": 120,
  "completion_tokens": 7,
  "total_tokens": 127,
  "prompt_tokens_details": { "cached_tokens": 2569 }
}
```

**AFTER:**

```jsonc
{ "prompt_tokens": 120, "completion_tokens": 7, "total_tokens": 127 }
```

---

## Report input tokens and separate reasoning on /v1/responses

PR: [#5557](https://github.com/tetherto/qvac/pull/5557)

`output[0]` of a `/v1/responses` answer is no longer always the `message` item. On a `<think>` model a `reasoning` item comes first, and a turn that only calls tools carries no empty `message` item. Find the item by `type` instead of by index. `usage.input_tokens` now reports the real prompt size (it was always `0`).

**BEFORE:**

```jsonc
{
  "output": [
    {
      "type": "message",
      "role": "assistant",
      "content": [{ "type": "output_text", "text": "<think>…</think>answer" }]
    }
  ],
  "usage": { "input_tokens": 0, "output_tokens": 7, "total_tokens": 7 }
}
```

**AFTER:**

```jsonc
{
  "output": [
    {
      "type": "reasoning",
      "id": "rs_…",
      "summary": [],
      "content": [{ "type": "reasoning_text", "text": "…" }]
    },
    {
      "type": "message",
      "role": "assistant",
      "content": [{ "type": "output_text", "text": "answer only" }]
    }
  ],
  "usage": { "input_tokens": 120, "output_tokens": 7, "total_tokens": 127 }
}
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

## Default qvac serve port to 11435

PR: [#5695](https://github.com/tetherto/qvac/pull/5695)

**BEFORE:**

```bash
qvac serve --openai   # http://127.0.0.1:11434/v1
```

**AFTER:**

```bash
qvac serve --openai               # http://127.0.0.1:11435/v1
qvac serve --openai --port 11434  # previous behaviour
```

---
