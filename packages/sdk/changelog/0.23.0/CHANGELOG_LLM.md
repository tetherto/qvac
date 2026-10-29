# QVAC SDK v0.23.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.23.0

QVAC SDK 0.23.0 sits on `@qvac/inference@0.23.0`. It adds reranking with `rerank()` and a `llamacpp-rerank` model type, speculative decoding, prompt priming with `prefill`, finer prompt-cache control, TranscribePsy transcription, and Qwen-Image-2.1 generation and reference editing. Native addons move onto fabric 0.24, which changes the RPC protocol to 112, and bundling moves to bare-pack 3. The model fit runs inside the worker on every platform, and completions now allow parallel tool calls by default. The Python client gains `assess_model_fit` and `model_fit_policy` wrappers and pins `bare-rpc` below 0.1.

It depends on `@qvac/inference` `^0.23.0`, and `tetherto-qvac-sdk` publishes at the same version.

## Breaking Changes

### Fabric 0.24 addon set

The SDK now ships the fabric 0.24 addon set. It installs these addons itself; an app that also pins any of them must move to the same floor:

| Package                     | 0.22.0 floor | 0.23.0 floor |
| --------------------------- | ------------ | ------------ |
| `@qvac/inference`           | `^0.22.0`    | `^0.23.0`    |
| `@qvac/asr-ggml`            | `^0.10.0`    | `^0.11.1`    |
| `@qvac/audiogen-ggml`       | `^0.8.0`     | `^0.9.0`     |
| `@qvac/bci-whispercpp`      | `^0.12.0`    | `^0.14.0`    |
| `@qvac/classification-ggml` | `^0.31.1`    | `^0.34.0`    |
| `@qvac/diffusion-cpp`       | `^0.30.0`    | `^0.31.0`    |
| `@qvac/embed-llamacpp`      | `^0.48.1`    | `^0.53.0`    |
| `@qvac/ggml-rpc-server`     | `^0.5.1`     | `^0.7.0`     |
| `@qvac/llm-llamacpp`        | `^0.61.1`    | `^0.65.0`    |
| `@qvac/ocr-ggml`            | `^0.29.1`    | `^0.31.0`    |
| `@qvac/translation-nmtcpp`  | `^0.21.1`    | `^0.23.0`    |
| `@qvac/tts-ggml`            | `^0.13.0`    | `^0.14.0`    |
| `@qvac/turbovec-ggml` (new) | none         | `^0.3.0`     |
| `@qvac/vla-ggml`            | `^0.32.2`    | `^0.34.0`    |

`@qvac/turbovec-ggml` now provides vector indexing, which moved out of `@qvac/embed-llamacpp`. Fresh installs currently resolve `@qvac/llm-llamacpp` 0.65.1, `@qvac/embed-llamacpp` 0.53.1 and `@qvac/ggml-rpc-server` 0.7.1, patches within these floors that run Fabric 0.25 with the same RPC protocol 112. The fabric-based addons at these floors declare their optional mobile peers `@qvac/fabric-ios` and `@qvac/fabric-android-arm64` at `^0.24.0`, and the current 0.65.1 and 0.53.1 patches declare `^0.25.0`, so a mobile app that pins those packages must move them to match the addon versions it resolves.

RPC discovery now accepts only servers on protocol `112.0.x`; protocol 111 servers are no longer returned. Upgrade every remote RPC server together with the SDK.

**Before:**

```sh
npm install @qvac/ggml-rpc-server@^0.5.1 # protocol 111
```

**After:**

```sh
npm install @qvac/ggml-rpc-server@^0.7.0 # protocol 112
```

### Bundling with bare-pack 3

The SDK's bundler dependency moves from `bare-pack` `^2.0.1` to `^3.0.2`. `qvac bundle sdk`, the Expo plugin and the Electron Forge plugin run the bare-pack the SDK installs, with the same flags as before. A build that runs bare-pack 2 itself against SDK bundles, or pins it next to the SDK, should move to bare-pack 3.

**Before:**

```json
{ "dependencies": { "bare-pack": "^2.0.1" } }
```

**After:**

```json
{ "dependencies": { "bare-pack": "^3.0.2" } }
```

### An explicit BCI `backendsDir` is scanned as given

With `@qvac/bci-whispercpp` `^0.14.0`, an explicit `backendsDir` is the directory scanned for the ggml backend modules on Android and Linux; the addon no longer appends `<host>/<module name>`. Without `backendsDir`, it scans the directory next to the loaded addon module, so loads that do not set it are unaffected.

**Before:**

```typescript
await loadModel({
  modelType: 'bci-whispercpp-transcription',
  modelSrc,
  modelConfig: { backendsDir: '/path/to/prebuilds' } // scanned /path/to/prebuilds/<host>/<module name>
})
```

**After:**

```typescript
await loadModel({
  modelType: 'bci-whispercpp-transcription',
  modelSrc,
  modelConfig: { backendsDir: '/path/to/prebuilds/<host>/<module name>' } // scanned as given
})
```

### Rank pooling is gone from embedding configs

`pooling: 'rank'` never produced valid embeddings, and the embedding addon now refuses it. It fails validation with `REQUEST_VALIDATION_FAILED` (50010) in `loadModel()` and in `qvac.config` `deviceDefaults`. Use `'none'`, `'mean'`, `'cls'` or `'last'`, and load reranker models with the new `llamacpp-rerank` model type.

**Before:**

```typescript
await loadModel({ modelSrc: MODEL, modelType: 'embeddings', modelConfig: { pooling: 'rank' } })
```

**After:**

```typescript
await loadModel({ modelSrc: MODEL, modelType: 'embeddings', modelConfig: { pooling: 'mean' } })
```

### The model fit runs inside the worker

The engine fitter now runs in the SDK's Bare worker on every platform, so there is no separate fit process to bundle or locate. A fitter that crashes takes the worker down with it; restart the worker and reload the models it held. The next fit of the same request runs again; if that one does not finish either, later fits skip the fitter and answer `crashed` for 7 days. A fitter that hangs still answers `unknown` with reason `timeout` after 30 seconds, while its native work keeps running in the worker until it returns. Cancelling `loadModel` answers at once and stops the load before the model loads. `fitProbe.reason` no longer reports `unsupported-platform`, `spawn-failed` or `invalid-response`; without a fitter result it is `cancelled`, `crashed`, `invocation-error` or `timeout`.

**Before:**

```typescript
await loadModel({ modelSrc, modelFitPolicy: 'log' })
// Desktop: a crashing fitter killed only its child process; the load continued.
```

**After:**

```typescript
await loadModel({ modelSrc, modelFitPolicy: 'log' })
// A crashing fitter takes down the worker; restart it and reload its models.
```

### Parallel tool calls are on by default

`completion()` and `batchCompletion()` on llama.cpp models now default `generationParams.parallel_tool_calls` to `true`, matching `qvac serve`, so a response with tools may carry several tool calls. Set it to `false` to keep one.

**Before:**

```typescript
const run = completion({ modelId, history, tools })
// final.toolCalls: at most one call
```

**After:**

```typescript
const single = completion({
  modelId,
  history,
  tools,
  generationParams: { parallel_tool_calls: false }
})
// final.toolCalls: at most one call; leave it unset to allow several
```

### `executeToolSearch` no longer repeats loaded schemas

Tools loaded by `tool_search` are now declared in the prompt's tools block, which is where the model looks for callable tools. The parsed `executeToolSearch` result therefore no longer carries a top-level `tools` array; read `tool_search.loaded` and look the tools up in your own inventory. After a load, `tool_choice` passes through unchanged and the tool grammar stays on. A deferred tool whose name clashes with another tool once characters outside `A-Z a-z 0-9 -` fold to `-` is no longer offered by the search, so give tools distinct names. A saved result that still has a `tools` array still loads its tools.

**Before:**

```typescript
JSON.parse(executeToolSearch(tools, { query: 'issue' }, []))
// { tool_search: { query, loaded, already_loaded }, tools: [{ ...schema }] }
```

**After:**

```typescript
JSON.parse(executeToolSearch(tools, { query: 'issue' }, []))
// { tool_search: { query, loaded, already_loaded } }
```

### A missing registry model has its own error

`modelRegistryGetModel()` now throws `ModelRegistryModelNotFoundError` (`QVAC_MODEL_REGISTRY_MODEL_NOT_FOUND`, code 53951) when the registry has no model at the given source and path. Query failures still throw `ModelRegistryQueryFailedError` (53950). The new class does not extend the old one, so code that caught not-found through `ModelRegistryQueryFailedError` or code 53950 must handle the new class too.

**Before:**

```typescript
try {
  await modelRegistryGetModel('org/missing.gguf', 'hf')
} catch (err) {
  if (err instanceof ModelRegistryQueryFailedError) handleMissing()
}
```

**After:**

```typescript
import { modelRegistryGetModel, ModelRegistryModelNotFoundError } from '@qvac/sdk'

try {
  await modelRegistryGetModel('org/missing.gguf', 'hf')
} catch (err) {
  if (err instanceof ModelRegistryModelNotFoundError)
    handleMissing(err.registrySource, err.registryPath)
}
```

### One image or video generation at a time per model

Image and video generation now admit one active request per model. A `diffusion()` or `video()` call on a model that already has a generation running is rejected immediately with `RequestRejectedByPolicyError` rather than queued. Wait for the running generation, or cancel it, before starting the next one on the same model.

**Before:**

```typescript
const a = diffusion({ modelId, prompt: 'a lighthouse at dusk' })
const b = diffusion({ modelId, prompt: 'a harbour at dawn' })
await Promise.all([a.outputs, b.outputs])
```

**After:**

```typescript
const first = await diffusion({ modelId, prompt: 'a lighthouse at dusk' }).outputs
const second = await diffusion({ modelId, prompt: 'a harbour at dawn' }).outputs
```

### Python client

#### `assess_model_fit` is now the keyword wrapper

`tetherto.qvac_sdk.assess_model_fit` is now `assess_model_fit(transport, *, models, execution=None, policy=None)`, mirroring JS `assessModelFit`, so passing a request object positionally fails. Each candidate is a dict of `load_model`'s snake_case arguments (`model_src`, `model_type`, `model_config`, `transcription_workload`, `tts_workload`); any other key, including camelCase `modelSrc`, raises `RequestValidationError`, and a missing `model_type` is inferred from the source. The raw generated stub is still available as `tetherto.qvac_sdk.methods.assess_model_fit`.

**Before:**

```python
request = AssessModelFitRequest.model_validate({"type": "assessModelFit", "models": [...]})
result = await assess_model_fit(t, request)
```

**After:**

```python
result = await assess_model_fit(t, models=[{"model_src": QWEN3_600M_INST_Q4}])

# The raw stub is still available:
from tetherto.qvac_sdk.methods import assess_model_fit as assess_model_fit_stub
```

#### `pooling: "rank"` is rejected

The Python client validates embedding configs before sending them, so `pooling: "rank"` raises `RequestValidationError` without reaching the worker. Use `"none"`, `"mean"`, `"cls"` or `"last"`, and load rerankers with `model_type="llamacpp-rerank"`.

**Before:**

```python
await load_model(t, model_src=MODEL, model_type="llamacpp-embedding", model_config={"pooling": "rank"})
```

**After:**

```python
await load_model(t, model_src=MODEL, model_type="llamacpp-embedding", model_config={"pooling": "mean"})
```

#### `parallel_tool_calls` defaults to true

The worker applies the new default, so Python completions with tools may also return several tool calls. Opt out per call with `generation_params`.

**Before:**

```python
run = completion(t, model_id=model_id, history=history, tools=tools)
# (await run.final).tool_calls: at most one call
```

**After:**

```python
run = completion(
    t,
    model_id=model_id,
    history=history,
    tools=tools,
    generation_params={"parallel_tool_calls": False},
)
# (await run.final).tool_calls: at most one call
```

## New APIs

### Reranking

The new `llamacpp-rerank` model type runs reranker GGUFs, and `rerank()` scores documents against a query. It returns one raw score per document in input order, so compare scores within one model only. The model registry has no reranker yet: supply your own reranker GGUF as a path or URL. Each model runs one rerank at a time and queues up to 64 calls, and the returned promise carries a `requestId` for `cancel()`. The worker plugin is `@qvac/sdk/llamacpp-rerank/plugin` (`PLUGIN_RERANK`, part of `SDK_DEFAULT_PLUGINS`). The types `RerankParams`, `RerankScores` and `RerankConfig` are exported, as are `llamacppRerankConfigSchema` and `LlamacppRerankConfig` from `@qvac/sdk/schemas`. `qvac serve` has no rerank route yet.

```typescript
import { loadModel, rerank, unloadModel } from '@qvac/sdk'

const modelId = await loadModel({ modelSrc: '/models/reranker.gguf', modelType: 'llamacpp-rerank' })
const scores = await rerank({
  modelId,
  query: 'What is the capital of France?',
  documents: ['Paris is the capital of France.', 'Plants convert sunlight into energy.']
})
await unloadModel({ modelId })
```

An app that lists its plugins in `qvac.config` adds the rerank plugin:

```json
{ "plugins": ["@qvac/sdk/llamacpp-rerank/plugin"] }
```

### Speculative decoding

LLM loads can draft tokens with the model's own multi-token-prediction head, an external MTP head, or a DFlash draft model, and the model verifies every draft, so output keeps the distribution of plain decoding. The keys are `spec_type`, `spec_draft_n_max`, `spec_draft_n_min`, `spec_draft_p_min` and `draftModelSrc`, and completion stats report `draftTokens` and `draftAcceptedTokens`. The catalog adds MTP heads and DFlash draft models to pair with Qwen models.

```typescript
const modelId = await loadModel({
  modelSrc: QWEN3_5_4B_MULTIMODAL_Q4_K_M,
  modelType: 'llm',
  modelConfig: {
    spec_type: 'draft-dflash',
    draftModelSrc: QWEN3_5_4B_DFLASH_Q8_0,
    spec_draft_n_max: 15
  }
})

const { stats } = await completion({ modelId, history }).final
console.log(stats?.draftTokens, stats?.draftAcceptedTokens)
```

### Priming a prompt with `prefill`

`prefill: true` evaluates the system prompt, history and tools into the KV cache without generating an answer, so the real question only processes its own tokens. It needs an enabled `kvCache` and cannot be combined with a forced `tool_choice`. Await `final` before sending the question.

```typescript
await completion({ modelId, history, tools, kvCache: 'chat', prefill: true }).final

const answer = await completion({
  modelId,
  history: [...history, { role: 'user', content: 'What is the weather in Lugano?' }],
  tools,
  kvCache: 'chat'
}).final
```

### Prompt-cache checkpoints and RAM cache

LLM loads control how hybrid, recurrent and sliding-window models keep prompt-cache checkpoints, and how much host RAM holds conversations the model has switched away from: `cache_checkpoints`, `cache_checkpoints_max_bytes`, `cache_checkpoint_storage` (`'memory'` or `'disk'`), `cache_checkpoint_dir` and `cache_ram_mib`. Unset keys keep the addon defaults.

```typescript
await loadModel({
  modelSrc: QWEN3_5_0_8B_MULTIMODAL_Q8_0,
  modelConfig: {
    cache_checkpoints: 2,
    cache_checkpoint_storage: 'disk',
    cache_checkpoint_dir: appCacheDir,
    cache_ram_mib: 1024
  }
})
```

### TranscribePsy transcription

Parakeet loads can run TranscribePsy, with a Core ML distribution that runs the encoder and decoder on the Neural Engine on macOS and iOS. Elsewhere the Core ML constant is refused before download and the error names the GGUF constant to use. `longFormWindowFrames` and `longFormContextFrames` (80 ms encoder frames) control how long recordings are split into overlapping windows.

```typescript
import { loadModel, transcribe, PARAKEET_TRANSCRIBEPSY_250M_Q8_0 } from '@qvac/sdk'

const modelId = await loadModel({
  modelSrc: PARAKEET_TRANSCRIBEPSY_250M_Q8_0,
  modelType: 'parakeet-transcription',
  modelConfig: { longFormWindowFrames: 375, longFormContextFrames: 47 }
})
const text = await transcribe({ modelId, audioChunk: 'session.wav' })
```

### Qwen-Image-2.1 generation and reference editing

Diffusion loads accept `projectionModelSrc`, the vision projector for the LLM encoder, which Qwen-Image-2.1 reference editing requires alongside `llmModelSrc`. `init_images` takes ordered reference images for models that support reference editing, including FLUX.2 and Qwen-Image-2.1. Qwen-Image-2.1 needs width and height in multiples of 32, and the registry has no Qwen-Image-2.1 constants, so load the files from your own paths.

```typescript
const modelId = await loadModel({
  modelSrc: '/models/qwen_image_2.1-Q4_K.gguf',
  modelType: 'sdcpp-generation',
  modelConfig: {
    llmModelSrc: '/models/Qwen3VL-8B-Instruct-Q4_K_M.gguf',
    projectionModelSrc: '/models/mmproj-Qwen3VL-8B-Instruct-F16.gguf',
    vaeModelSrc: '/models/qwen_image_2.1_vae_bf16.safetensors'
  }
})

const { outputs } = diffusion({
  modelId,
  prompt: 'Place the two referenced people together in one office.',
  init_images: [refA, refB],
  width: 512,
  height: 512
})
```

### CPU polling controls

Completion, embedding, decision and rerank configs accept `poll` and `pollBatch`, integers from 0 to 100. The llama.cpp addons now default to sleeping CPU workers, so GPU inference no longer busy-spins CPU threads; raise the values to trade CPU for lower wake latency.

These addon versions also change how CPU threads are split. `threads-batch` now applies only to steps that process several tokens (prompt processing, parallel decoding and speculative verification), and single-sequence generation uses `threads`. `cpu-mask` always applies to generation, and `cpu-mask-batch` inherits it when the batch thread count is unset. A config that set only `threads-batch` to size generation should set `threads` as well.

```typescript
await loadModel({
  modelSrc: '/path/to/model.gguf',
  modelType: 'llamacpp-completion',
  modelConfig: { poll: 50, pollBatch: 0 }
})
```

### Closing a log stream

`loggingStream()` takes a `signal`. Aborting it ends the stream without an error, and the worker releases the subscription at once, even for a model that logs nothing more. `subscribeServerLogs()`'s `unsubscribe()` and `unloadModel()` release their subscriptions the same way. Other operations still stop with `cancel`.

```typescript
import { loggingStream } from '@qvac/sdk'

const controller = new AbortController()
for await (const log of loggingStream({ id: modelId }, { signal: controller.signal })) {
  console.log(log.message)
}

// elsewhere
controller.abort()
```

### Memory fit for ESRGAN and ABot-World

The diffusion fitter now assesses ESRGAN upscalers and ABot-World loads. `world.fitSteps` (default 100) sets the walk length the fit covers; it does not limit generation or retained history.

```typescript
await loadModel({
  modelSrc: ABOT_WORLD_0_5B_Q8_0,
  modelConfig: {
    mode: 'world',
    taehvModelSrc: ABOT_WORLD_0_5B_LF_TAEHV_VAE,
    sceneSrc: '/path/to/scene.safetensors',
    world: { fitSteps: 200 }
  }
})
```

### Python client

`assess_model_fit` now takes the same candidates as `load_model`, and `load_model` takes `model_fit_policy` (`"log"`, `"refuse"` or `"off"`) for a single load.

```python
from tetherto.qvac_sdk import assess_model_fit, load_model
from tetherto.qvac_sdk.models import GPT_OSS_20B_INST_Q4_K_M, QWEN3_600M_INST_Q4

result = await assess_model_fit(
    t,
    models=[{"model_src": QWEN3_600M_INST_Q4}, {"model_src": GPT_OSS_20B_INST_Q4_K_M}],
    execution="concurrent",
)
model_id = await load_model(t, model_src=QWEN3_600M_INST_Q4, model_fit_policy="refuse")
```

Reranking is available only as the generated raw stub `rerank(transport, RerankRequest)`; there is no ergonomic wrapper yet. `RerankRequest` and `RerankResponse` are exported, and `load_model` accepts `model_type="llamacpp-rerank"`. Set `type="rerank"` on the request, as with the other generated requests.

```python
from tetherto.qvac_sdk import RerankRequest, load_model, rerank

model_id = await load_model(t, model_src="/models/reranker.gguf", model_type="llamacpp-rerank")
response = await rerank(
    t,
    RerankRequest(
        type="rerank",
        model_id=model_id,
        query="What is the capital of France?",
        documents=["Paris is the capital of France.", "Plants convert sunlight into energy."],
    ),
)
print(response.scores)
```

`completion()` and `completion_orchestrate()` take `prefill`, with the same rules as JS.

```python
from tetherto.qvac_sdk import completion

await completion(
    t, model_id=model_id, history=history, tools=tools, kv_cache="chat", prefill=True
).final
```

`model_registry_get_model()` raises `ModelRegistryModelNotFoundError` (code 53951, with `registry_source` and `registry_path`) when the registry has no such model.

```python
from tetherto.qvac_sdk import ModelRegistryModelNotFoundError, model_registry_get_model

try:
    await model_registry_get_model(t, "org/missing.gguf", "hf")
except ModelRegistryModelNotFoundError as error:
    print(error.registry_source, error.registry_path)
```

`load_model(model_config=...)` accepts the same new keys as JS: the prompt-cache keys, the speculative-decoding keys, `poll` and `pollBatch`, the TranscribePsy long-form keys, `projectionModelSrc` and `world.fitSteps`. Model constants are accepted wherever a config takes a model source.

```python
model_id = await load_model(
    t,
    model_src=QWEN3_5_4B_MULTIMODAL_Q4_K_M,
    model_type="llamacpp-completion",
    model_config={"spec_type": "draft-dflash", "draftModelSrc": QWEN3_5_4B_DFLASH_Q8_0},
)
```

## Features

The tool-call dialect is now detected from the model name first, then from the GGUF `general.architecture`, then falls back to `hermes`. A fine-tune whose name matches no known pattern gets the dialect of its architecture, so its tool calls parse; KAT-Coder-V2.5-Dev (`MOE_35B_INST_*`) moves from `hermes` to `qwen35`. The dialect is resolved once at load, `getLoadedModelInfo().toolDialect` reports it, and an explicit `toolDialect` still overrides it.

Vector indexing runs on the standalone `@qvac/turbovec-ggml` addon, which the worker loads only when an index is created or loaded, so applications that never index do not load it.

## Bug Fixes

`TTS_COSYVOICE3_LLM_COSYVOICE_Q4_0` no longer needs its companion files staged by hand. It now resolves a complete companion set (Q4 LLM, Q4 flow and F16 HiFT weights, plus the shared tokenizer and English voice), downloading 0.985 GiB instead of the 2.230 GiB of the Q8 set, which is unchanged.

On Linux and other Unix systems, the Node client now creates its worker socket inside a fresh owner-only (0700) temp directory, so another local user can no longer connect to it before the worker does, whatever the umask. The directory is removed with the socket on every shutdown path. Windows keeps its named pipe.

Loading a cached model again no longer rehashes every artifact. A digest is reused while the file's path, device, inode, size and timestamps are unchanged, and changed or replaced files are hashed again.

Decoding audio input for transcription and audio generation no longer keeps a full copy of the decoded PCM in the decoder's response.

After `tool_search` loads a deferred tool, small models such as Qwen3.5 0.8B and 4B now call the loaded tool instead of searching again, because the tool is declared in the tools block.

The Expo config plugins no longer check whether `build.gradle` or `expo-device-info.js` exists before rewriting it, which removes a file-system race; the files they write are unchanged.

### Python client

`tetherto-qvac-sdk` 0.23.0 pins `bare-rpc>=0.0.1,<0.1`. `bare-rpc` 0.1.0, released on PyPI on 2026-10-28, removed `RPC(send=...)`, so a fresh install of `tetherto-qvac-sdk` 0.22.0, which required `bare-rpc>=0.0.1`, fails on connect with `TypeError: RPC.__init__() got an unexpected keyword argument 'send'`. Upgrade to 0.23.0, or on 0.22.0 install `bare-rpc<0.1` yourself.

## Model Changes

### Added

Speculative-decoding draft models:

```
QWEN3_5_0_8B_MTP_Q4_K_M
QWEN3_5_2B_MTP_Q4_K_M
QWEN3_5_4B_MTP_Q4_K_M
QWEN3_5_9B_MTP_Q4_K_M
QWEN3_5_4B_DFLASH_Q8_0
QWEN3_8_27B_DFLASH2_Q8_0
QWEN3_8_FLASH_NEXT_177B_DFLASH2_Q8_0
```

Speech recognition (TranscribePsy):

```
PARAKEET_TRANSCRIBEPSY_250M_Q8_0
PARAKEET_TRANSCRIBEPSY_250M_COREML_Q8_0
```

### Updated

```
TTS_COSYVOICE3_LLM_COSYVOICE_Q4_0
```

No model constants were removed. The Python catalog carries the same constants.
