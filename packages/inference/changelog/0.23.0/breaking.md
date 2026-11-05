# 💥 Breaking Changes v0.23.0

## Native addons move to the fabric 0.24 line

PRs: [#5386](https://github.com/tetherto/qvac/pull/5386), [#5297](https://github.com/tetherto/qvac/pull/5297), [#5328](https://github.com/tetherto/qvac/pull/5328), [#5350](https://github.com/tetherto/qvac/pull/5350), [#5293](https://github.com/tetherto/qvac/pull/5293), [#5302](https://github.com/tetherto/qvac/pull/5302), [#5347](https://github.com/tetherto/qvac/pull/5347), [#5227](https://github.com/tetherto/qvac/pull/5227), [#5385](https://github.com/tetherto/qvac/pull/5385)

`@qvac/inference` 0.22.0 peered on the fabric 0.22 addon set. 0.23.0 peers on the fabric 0.24 set. Because these are `0.x` caret ranges, every installed addon must move to the new floor. Upgrade them together:

| Package                                   | 0.22.0 floor | 0.23.0 floor |
| ----------------------------------------- | ------------ | ------------ |
| `@qvac/asr-ggml`                          | `^0.10.0`    | `^0.11.1`    |
| `@qvac/audiogen-ggml`                     | `^0.8.0`     | `^0.9.0`     |
| `@qvac/bci-whispercpp`                    | `^0.12.0`    | `^0.14.0`    |
| `@qvac/classification-ggml`               | `^0.31.1`    | `^0.34.0`    |
| `@qvac/diffusion-cpp`                     | `^0.30.0`    | `^0.31.0`    |
| `@qvac/embed-llamacpp`                    | `^0.48.1`    | `^0.53.0`    |
| `@qvac/ggml-rpc-server`                   | `^0.5.1`     | `^0.7.0`     |
| `@qvac/llm-llamacpp`                      | `^0.61.1`    | `^0.65.0`    |
| `@qvac/ocr-ggml`                          | `^0.29.1`    | `^0.31.0`    |
| `@qvac/translation-nmtcpp`                | `^0.21.1`    | `^0.23.0`    |
| `@qvac/tts-ggml`                          | `^0.13.0`    | `^0.14.0`    |
| `@qvac/turbovec-ggml` (new optional peer) | none         | `^0.3.0`     |
| `@qvac/vla-ggml`                          | `^0.32.2`    | `^0.34.0`    |
| `@qvac/rag` (dependency)                  | `^0.8.1`     | `^0.9.0`     |

`@qvac/decoder-audio` (`^0.8.1`) and `@qvac/langdetect-text` (`^0.1.2`) are unchanged. `bare-runtime` is no longer a dependency, and `bare-process` is now a development dependency only.

Fresh installs currently resolve `@qvac/llm-llamacpp` 0.65.1, `@qvac/embed-llamacpp` 0.53.1 and `@qvac/ggml-rpc-server` 0.7.1, patches within these floors that run Fabric 0.25 with the same RPC protocol 112.

The fabric-based addons at these floors declare their optional mobile peers `@qvac/fabric-ios` and `@qvac/fabric-android-arm64` at `^0.24.0` (the 0.22.0 floors used `^0.22.0`), and the current patches (`@qvac/llm-llamacpp` 0.65.1, `@qvac/embed-llamacpp` 0.53.1) declare `^0.25.0`. A mobile host that pins those packages must move them to the range of the addon versions it resolves.

RPC discovery now accepts only servers on protocol `112.0.x`. Servers on protocol 111 are no longer returned. Upgrade every remote `@qvac/ggml-rpc-server` together with the engine.

**BEFORE:**

```sh
# Remote RPC servers matching the 0.22.0 floor (protocol 111)
npm install @qvac/ggml-rpc-server@^0.5.1
```

**AFTER:**

```sh
# Remote RPC servers matching the 0.23.0 floor (protocol 112)
npm install @qvac/ggml-rpc-server@^0.7.0
```

---

## Vector indexing needs @qvac/turbovec-ggml

PRs: [#5227](https://github.com/tetherto/qvac/pull/5227), [#5239](https://github.com/tetherto/qvac/pull/5239), [#5385](https://github.com/tetherto/qvac/pull/5385)

Vector indexing moved out of `@qvac/embed-llamacpp` into the standalone `@qvac/turbovec-ggml` addon. `@qvac/inference` declares it as an optional peer and imports it only when an index is created or loaded. Without it, creating or loading an index fails with "Vector indexing requires the optional peer dependency @qvac/turbovec-ggml".

**BEFORE:**

```sh
npm install @qvac/inference @qvac/embed-llamacpp
```

**AFTER:**

```sh
npm install @qvac/inference @qvac/embed-llamacpp @qvac/turbovec-ggml
```

---

## An explicit BCI backendsDir is scanned as given

PRs: [#5293](https://github.com/tetherto/qvac/pull/5293), [#5350](https://github.com/tetherto/qvac/pull/5350)

With `@qvac/bci-whispercpp` `^0.14.0`, an explicit `backendsDir` is the directory scanned for the ggml backend modules (Android and Linux). The addon no longer appends `<host>/<module name>` to it. Without `backendsDir`, it scans the directory next to the loaded addon module. Loads that do not set `backendsDir` are unaffected.

**BEFORE:**

```typescript
await loadModel({
  modelType: 'bci-whispercpp-transcription',
  modelSrc,
  modelConfig: { backendsDir: '/path/to/prebuilds' } // scanned /path/to/prebuilds/<host>/<module name>
})
```

**AFTER:**

```typescript
await loadModel({
  modelType: 'bci-whispercpp-transcription',
  modelSrc,
  modelConfig: { backendsDir: '/path/to/prebuilds/<host>/<module name>' } // scanned as given
})
```

---

## Drop rank pooling from the embedding config schema

PR: [#5277](https://github.com/tetherto/qvac/pull/5277)

`pooling: 'rank'` is no longer a valid embedding config value. A `loadModel()` call or a `deviceDefaults` entry that sets it fails validation with `REQUEST_VALIDATION_FAILED` (50010). The option never produced valid embeddings. Load reranker models with the new `llamacpp-rerank` model type and call `rerank()`.

**BEFORE:**

```typescript
await loadModel({
  modelSrc: MODEL,
  modelType: 'embeddings',
  modelConfig: { pooling: 'rank' } // accepted, returned random vectors
})
```

**AFTER:**

```typescript
await loadModel({
  modelSrc: MODEL,
  modelType: 'embeddings',
  modelConfig: { pooling: 'mean' } // 'none' | 'mean' | 'cls' | 'last'; 'rank' fails validation
})
```

---

## Run the model fit in process on every platform

PR: [#5279](https://github.com/tetherto/qvac/pull/5279)

The engine fitter runs in the inference process on every platform. There is no separate fit process. A fitter that crashes takes down the process it runs in, which for direct `@qvac/inference` users is the host process. `fitProbe.reason` no longer reports `unsupported-platform`, `spawn-failed` or `invalid-response`; when no fitter result is available it is one of `cancelled`, `crashed`, `invocation-error` or `timeout`.

**BEFORE:**

```typescript
await loadModel({ modelSrc, modelFitPolicy: 'log' })
// Desktop: a fitter that crashes kills only its child process.
// The load continues and fitProbe.reason is 'crashed'.
// A fitter that hangs answers 'unknown' with reason 'timeout' after 30 s.
```

**AFTER:**

```typescript
await loadModel({ modelSrc, modelFitPolicy: 'log' })
// A fitter that crashes takes down the process it runs in.
// The next fit of the same request runs again. If that one does not finish
// either, later fits skip the fitter and answer 'crashed' for 7 days.
// A fitter that hangs answers 'unknown' with reason 'timeout' after 30 s,
// and its native work keeps running in the process until it returns.
// Cancelling loadModel answers at once and stops the load before the model loads.
```

---

## Default parallel_tool_calls to true

PR: [#5283](https://github.com/tetherto/qvac/pull/5283)

`completion()` and `batchCompletion()` on llama.cpp models now default `generationParams.parallel_tool_calls` to `true`, so a response with tools may carry several tool calls. Set it to `false` to keep one call per response.

**BEFORE:**

```typescript
const run = completion({ modelId, history, tools })
// final.toolCalls: at most one call
```

**AFTER:**

```typescript
const run = completion({ modelId, history, tools })
// final.toolCalls: may hold several calls

const single = completion({
  modelId,
  history,
  tools,
  generationParams: { parallel_tool_calls: false }
})
// final.toolCalls: at most one call
```

---

## Declare tools loaded by tool_search in the tools block

PR: [#5346](https://github.com/tetherto/qvac/pull/5346)

`executeToolSearch` still returns a JSON string, but the parsed result no longer repeats loaded schemas in a top-level `tools` array. Use `tool_search.loaded` with your registered tool inventory. Loaded deferred tools are now declared in the prompt's tools block, `tool_choice` passes through unchanged after a load, and a deferred tool whose name clashes with another tool (after folding characters outside `A-Z a-z 0-9 -` to `-`) is no longer offered by the search. A saved result that still has a `tools` array still loads its tools.

**BEFORE:**

```typescript
JSON.parse(executeToolSearch(tools, { query: 'issue' }, []))
// { tool_search: { query, loaded, already_loaded }, tools: [{ ...schema }] }
```

**AFTER:**

```typescript
JSON.parse(executeToolSearch(tools, { query: 'issue' }, []))
// { tool_search: { query, loaded, already_loaded } }
```

---

## A missing registry model throws ModelRegistryModelNotFoundError

PR: [#5356](https://github.com/tetherto/qvac/pull/5356)

`modelRegistryGetModel()` now throws `ModelRegistryModelNotFoundError` (`QVAC_MODEL_REGISTRY_MODEL_NOT_FOUND`, code 53951) when the registry has no model at the given source and path. Other registry failures still throw `ModelRegistryQueryFailedError` (53950). The new class does not extend `ModelRegistryQueryFailedError`, so a handler that matched not-found by that class or by code 53950 must also match the new one.

**BEFORE:**

```typescript
try {
  await modelRegistryGetModel('org/missing.gguf', 'hf')
} catch (err) {
  if (err instanceof ModelRegistryQueryFailedError) {
    // handled "not found" and query failures together
  }
}
```

**AFTER:**

```typescript
import {
  ModelRegistryModelNotFoundError,
  ModelRegistryQueryFailedError
} from '@qvac/inference/surface'

try {
  await modelRegistryGetModel('org/missing.gguf', 'hf')
} catch (err) {
  if (err instanceof ModelRegistryModelNotFoundError) {
    console.log(err.registrySource, err.registryPath) // no such model
  } else if (err instanceof ModelRegistryQueryFailedError) {
    // the registry query itself failed
  }
}
```

---

## One image or video generation at a time per model

PR: [#5302](https://github.com/tetherto/qvac/pull/5302)

Image and video generation now admit one active request per model. A `diffusion()` or `video()` call on a model that already has a generation running is rejected immediately with `RequestRejectedByPolicyError`; it is not queued. Wait for the running generation to finish, or cancel it, before starting the next one on the same model.

**BEFORE:**

```typescript
// Two generations started together on one model
const a = diffusion({ modelId, prompt: 'a lighthouse at dusk' })
const b = diffusion({ modelId, prompt: 'a harbour at dawn' })
await Promise.all([a.outputs, b.outputs])
```

**AFTER:**

```typescript
// The second call would reject with RequestRejectedByPolicyError; run them in turn
const first = await diffusion({ modelId, prompt: 'a lighthouse at dusk' }).outputs
const second = await diffusion({ modelId, prompt: 'a harbour at dawn' }).outputs
```

---
