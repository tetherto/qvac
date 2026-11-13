# QVAC SDK v0.24.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.24.0

QVAC SDK 0.24.0 lets several callers share one runtime through sessions, with per-caller model leases and cancellation. It adds multimodal and image embeddings, chat seeding from an existing prompt cache, token counting, resumable downloads, and many new transcription, speech, music and image controls. The worker now runs on bare-stow, which changes how it is bundled and started. The Python and Kotlin clients ship at the same version and gain the same features.

## Breaking Changes

### The worker runs on bare-stow

The SDK worker is now packaged and started with bare-stow, on the Bare that ships with `bare-sidecar`. A Node.js or Electron app on the default worker, with no bundle step, needs no code change unless it uses one of the errors or settings below. Apps that bundle the worker must bundle again.

**All Node.js and Electron apps**

- A failed start rejects with `WORKER_STARTUP_FAILED` instead of `RPC_INIT_TIMEOUT`. `WorkerStartupError` is thrown directly, and its `workerExited` field is replaced by `exitCode`, `exitSignal` and `timedOut`.
- `rpcInitTimeoutMs` covers the whole start and defaults to 60 seconds. It used to cover the handshake only, at 30 seconds. `QVAC_RPC_INIT_TIMEOUT_MS` and `bareRuntimeVersion` are removed.
- The worker runs on `bare-sidecar`'s Bare, not `bare-runtime`. Move any override that pinned `bare-runtime`.

**Apps that bundle the worker** (`qvac bundle sdk`, `bundleSdk`, the Electron Forge plugin)

- Bundle again after upgrading. The output is now the `qvac/worker/` folder. The Forge plugin and `npx expo prebuild` do this for you.
- Bundling needs Node.js `^22.21.0 || >=24.9.0`. Bundling for another desktop host needs that host's addon packages, for example `@qvac/fabric-darwin-x64`.
- With pnpm or bun's isolated linker, add `bare-stow-runtime` and `bare-stow-host` to the app's dependencies, plus `bare-sidecar` for desktop, `react-native-bare-kit` for React Native or `bare-path` for Pear. Yarn needs `nodeLinker: node-modules`.
- `bundleSdk` drops `checkEngines` and returns `entryPath`, `outputDir` and `verification` instead of `entryPaths` and `manifestPath`. In `@qvac/sdk/commands`, `RuntimeGroup` is `PlatformRuntime` and `EnginesUpgrade` is removed. `verifyBundle` drops the `bareRuntimeVersion` and `configPath` options and returns `runtimes`, one per platform, instead of `runtime`.

**Before:**

```typescript
// Custom worker entry
import { initializeWorker, ensureRPCSetup } from '@qvac/sdk/worker-lifecycle'

// bundleSdk callers
const result = await bundleSdk({ hosts, checkEngines: false })
result.entryPaths.worker
```

**After:**

```typescript
// Custom worker entry
import { startWorker } from '@qvac/sdk/worker'
export default (ipc, ready) => startWorker(ipc, ready, { plugins: [llmPlugin] })

// bundleSdk callers
const result = await bundleSdk({ target: 'bare-sidecar', hosts })
result.entryPath
```

**Expo and React Native.** Expo SDK 58 or newer is required (was 54). The peer ranges are `>=58.0.0` for `expo-build-properties`, `expo-device`, `expo-file-system` and `expo-modules-core`, and `^0.17.1` for `react-native-bare-kit`. Run `npx expo prebuild` again. `@qvac/sdk/worker.mobile.bundle` is now `@qvac/sdk/worker.mobile`.

**Pear.** Install `bare-stow-target-pear-runtime`, bundle with `--target pear-runtime`, and call `usePearRuntime(pear)` from `@qvac/sdk/pear` instead of importing `@qvac/sdk/pear-pre`. `pear-pipe` is no longer a peer dependency.

**Removed error codes.** `RPC_INIT_TIMEOUT` (50204), `PEAR_WORKER_ENTRY_REQUIRED` (50606), `WORKER_PLUGINS_NOT_REGISTERED` (50608), `BARE_PACK_NOT_INSTALLED` (50610), `BARE_PACK_ERROR` (50611) and `BARE_RUNTIME_BINARY_NOT_FOUND` (50614).

### No system message unless you configure one

The SDK no longer adds "You are a helpful assistant." to a completion that carries no system message. The model now sees exactly the history you send, which changes the output of every completion that relied on the default.

**Before:**

```typescript
const modelId = await loadModel({ modelSrc, modelType: 'llm' })

completion({ modelId, history: [{ role: 'user', content: 'What is the capital of France?' }] })
// payload: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', ... }]
```

**After:**

```typescript
// payload: [{ role: 'user', ... }]

// To keep the previous prompt, set it at load:
await loadModel({
  modelSrc,
  modelType: 'llm',
  modelConfig: { system_prompt: 'You are a helpful assistant.' }
})
```

### A prefill needs at least one message

`prefill: true` with an empty history used to prime the default system message. With that default gone there is nothing to prime, so the request is rejected.

**Before:**

```typescript
await completion({ modelId, history: [], tools, kvCache: true, prefill: true }).final
// primed "You are a helpful assistant." + tools
```

**After:**

```typescript
// throws RequestValidationFailedError: prefill needs at least one message
await completion({ modelId, history: [], tools, kvCache: true, prefill: true }).final

// supply the message in history...
await completion({ modelId, history: [{ role: 'system', content: '...' }], tools, kvCache: true, prefill: true }).final
// ...or set it at load
await loadModel({ ...options, modelConfig: { tools: true, system_prompt: '...' } })
```

### Model fit reports per-device memory

`assessModelFit` now returns what each engine addon measured: the memory every model takes on each device, and the pools the verdict was judged on. The `execution` and `policy` inputs are gone, the verdict values are renamed, and the estimator fields are removed. `@qvac/inference/model-resource-profiles` is removed.

**Before:**

```typescript
const fit = await assessModelFit({ models, execution: 'concurrent', policy })
// {
//   verdict: 'likely-fits' | 'likely-too-large' | 'unknown',
//   basis, execution, evidence, budget, floorBytes, reasons, assumptions,
//   models: [{ name, verdict, evidence, floorBytes, estimatorVersion, device, reasons }]
// }

const { fitProbe } = await getLoadedModelInfo({ modelId })
// { verdict: 'fit' | 'does-not-fit' | 'unknown', basis, engine, reason, message, plan, projection }
```

**After:**

```typescript
const fit = await assessModelFit({ models })
// {
//   verdict: 'fits' | 'does-not-fit' | 'unknown',
//   pools: [{ id, unified, usedBytes, freeBytes?, totalBytes? }],
//   models: [{
//     status: 'fits' | 'does-not-fit' | 'unknown',
//     devices: [{ id, name, unified, usedBytes, freeBytes?, totalBytes? }], // host last; [] when unknown
//     stats: { ctxSize, gpuLayers } | {}
//   }]
// }

const { fitProbe } = await getLoadedModelInfo({ modelId })
// { verdict, pools, models } for that one load
```

A custom plugin with a fitter must return the new per-model shape from `assessFit`.

**Remote RPC servers.** The engine now depends on `@qvac/ggml-rpc-server` `^0.9.0`, and the RPC protocol changed since 0.23. Upgrade every remote RPC server together with this release.

```bash
npm install @qvac/ggml-rpc-server@^0.9.0
```

### `unloadModel` resolves with a result, and stale model handles throw

With caller sessions, unloading releases the caller's hold on a model and reports whether the model actually left memory. Code that typed the call as `Promise<void>`, or mocked `diffusion`, `ocr` or `upscale` results, needs the new members.

**Before:**

```typescript
const unload = (modelId: string): Promise<void> => unloadModel({ modelId })

const diffusionMock: typeof diffusion = () => ({ progressStream, outputs, stats })
```

**After:**

```typescript
const unload = async (modelId: string): Promise<void> => {
  await unloadModel({ modelId }) // resolves with UnloadModelResult { released, unloaded }
}

const diffusionMock: typeof diffusion = () => ({ requestId: 'r-1', progressStream, outputs, stats })
```

After `close()` or a worker crash, a call that names a `modelId` loaded on the stopped runtime throws `ModelHandleInvalidatedError` (50209). In 0.23 the SDK restarted the worker and returned its not-found error. Load the model again and use the new id.

### EmbeddingGemma-300M constants point at the Dense-layer models

`EMBEDDINGGEMMA_300M_F32` is removed. `EMBEDDINGGEMMA_300M_BF16`, `EMBEDDINGGEMMA_300M_Q4_0` and `EMBEDDINGGEMMA_300M_Q8_0` keep their names but now resolve to the Dense-layer model files. Embeddings from the updated constants differ from those of the old files, so re-ingest any RAG workspace that was built with an earlier EmbeddingGemma-300M constant.

**Before:**

```typescript
import { EMBEDDINGGEMMA_300M_F32 } from '@qvac/sdk'
```

**After:**

```typescript
import { EMBEDDINGGEMMA_300M_BF16 } from '@qvac/sdk'
```

### The MobileNet classifier loads from the registry

The classifier weights are no longer bundled with the addon. Name the model when you load it.

**Before:**

```typescript
const modelId = await loadModel({ modelType: 'ggml-classification' })
```

**After:**

```typescript
import { MOBILENETV3_3CLASS_V3_FP16 } from '@qvac/sdk'

const modelId = await loadModel({ modelSrc: MOBILENETV3_3CLASS_V3_FP16, modelType: 'ggml-classification' })
```

### Text and media reach the model in the order you wrote them

A user turn that mixed text and media used to be reordered: every image first, then the text joined together. The parts now reach the model in their original order, which changes the prompt of any turn that interleaves them.

**Before:** a turn with `[text A, image A, text B, image B]` reached the model as `[image A, image B, text A + text B]`.

**After:** the same turn reaches the model as `[text A, image A, text B, image B]`.

### Streaming timeouts are enforced

`rpcOptions.timeout` on a streaming call now applies to each chunk and throws `OperationTimeoutError`. In 0.23 it never fired on streams. A timeout on a unary call now also cancels the request on the worker. Raise or remove a timeout that was sized for the old behaviour.

### Python client

Every section above applies to Python as well, since it drives the same worker. These are specific to the client.

**`assess_model_fit` drops `execution` and `policy`.**

```python
# Before
result = await assess_model_fit(t, models=models, execution="concurrent", policy=policy)
result.models[0].verdict  # 'likely-fits' | 'likely-too-large' | 'unknown'

# After: execution= and policy= raise TypeError
result = await assess_model_fit(t, models=models)
result.verdict  # 'fits' | 'does-not-fit' | 'unknown'
result.pools
result.models[0].status
```

**`EmbedRequest` fields move under `.root`.** The keyword constructor is unchanged; `request.model_id` becomes `request.root.model_id`.

**Worker start.** The client needs Linux with glibc 2.34 or newer (not musl), macOS 13 or newer, or Windows. A worker that fails to start raises `WorkerStartupError`, and a rejected config raises `SetConfigFailedError`; `connect()` no longer raises `RuntimeError` or `asyncio.TimeoutError` for these. The start timeout follows `rpcInitTimeoutMs` and defaults to 60 seconds. `QVAC_BARE_PATH` takes `bare-sidecar`'s Bare.

**The MobileNet classifier needs a source.**

```python
from tetherto.qvac_sdk.models import MOBILENETV3_3CLASS_V3_FP16

model_id = await load_model(t, model_src=MOBILENETV3_3CLASS_V3_FP16, model_type="ggml-classification")
```

**Raw text-to-speech frames carry `pcm`.** `text_to_speech` and `text_to_speech_stream` still return samples in `buffer`. Code that reads raw frames gets an empty `buffer` and the samples as base64 16-bit PCM in `pcm`.

### Kotlin client

**Android.** `AndroidBareKitTransport.connect(context, assetName)` is now `connect(context)`; the second positional parameter is `homeDirectory`, so pass it by name. The app needs `compileSdk` 36 or newer and `ndk { abiFilters += "arm64-v8a" }`. The MobileNet weights are no longer packaged in the runtime: load `Models.MOBILENETV3_3CLASS_V3_FP16`.

**Desktop JVM.** `JvmBareRpcTransport` and its worker helpers are removed, and the published JVM zip no longer runs a worker. Build the experimental `:jvm-barekit` module and use `JvmBareKitTransport.connect()`.

**Generated request types.** `EmbedRequest` is a sealed type, and history content is a union:

```kotlin
// Before
EmbedRequest(modelId = "m", text = EmbedRequestText.Variant1("hi"), requestId = "embed-1")
CompletionStreamRequestHistoryItem(role = "user", content = "Hello")

// After
EmbedRequest.EmbedTextRequest(
    EmbedTextRequest(modelId = "m", text = EmbedTextRequestText.Variant1("hi"), requestId = "embed-1"),
)
CompletionStreamRequestHistoryItem(
    role = "user",
    content = CompletionStreamRequestHistoryItemContent.Variant1("Hello"),
)
```

The `QvacEmbeddings.embed(...)` and `QvacMessage` convenience APIs are unchanged.

**Model fit.** `AssessModelFitRequest` takes only `models`, the verdict values are `FITS`, `DOESNOTFIT` and `UNKNOWN`, and the result carries `pools` and, per model, `status`, `devices` and `stats`.

**Errors and dependencies.** The `QvacKnownException` subclasses for the removed error codes are gone; catch `QvacWorkerStartException`. The transitive `bare-rpc-kotlin` moves to v0.6.0 and its package is `to.holepunch.bare.rpc` (was `to.holepunch.barerpc`). An exhaustive `when` over `QvacCapability`, `ModelType`, `PluginId` or a generated request union needs a branch for the new values.

## New APIs

### Caller sessions, model leases and scoped cancellation

Several independent callers can now share one runtime without stepping on each other. `openSession()` returns a session with the same API as the top-level functions. Each session holds its own lease on the models it loads and can cancel only its own requests. A model leaves memory when its last lease is released.

```typescript
import { openSession, close } from '@qvac/sdk'

const a = openSession({ name: 'harness' })
const b = openSession({ name: 'skill-runner' })

const modelId = await a.loadModel({ modelSrc: QWEN3_600M_INST_Q4 })
await b.loadModel({ modelSrc: QWEN3_600M_INST_Q4 }) // same modelId, second lease

const run = a.completion({ modelId, history, stream: true })
await b.cancel({ requestId: run.requestId }) // cancelled: 0, run continues
await a.cancel({ requestId: run.requestId }) // cancels

await a.unloadModel({ modelId }) // { released: true, unloaded: false }, model stays for b
await a.close() // releases a's remaining leases
await close() // owner shutdown, ends b
```

More calls can be cancelled: `diffusion`, `classify`, `ocr`, `upscale`, `vla`, `invokePlugin`, `invokePluginStream` and every `VectorIndex` method now expose a `requestId`. `LoadedModelInfo` reports `leaseCount`. Session misuse has its own errors, among them `SessionNotOpenError`, `ModelLeasedError` and `OwnerOnlyError`.

### Multimodal and image embeddings

EmbeddingGemma 2 embeds text, images and audio into one space, and MegaLoc embeds images for place recognition. `embedBatch` returns one vector per input, and `embed({ modelId, input })` embeds a single input.

```typescript
import { embedBatch, loadModel, EMBEDDINGGEMMA_2_Q8_0, MMPROJ_EMBEDDINGGEMMA_2_Q8_0 } from '@qvac/sdk'

const modelId = await loadModel({
  modelType: 'llamacpp-embedding',
  modelSrc: EMBEDDINGGEMMA_2_Q8_0,
  modelConfig: { projectionModelSrc: MMPROJ_EMBEDDINGGEMMA_2_Q8_0 }
})

const { embedding } = await embedBatch({
  modelId,
  inputs: [
    'task: search result | query: an elephant',
    [{ media: { type: 'filePath', value: '/path/to/elephant.jpg' } }]
  ]
})
```

```typescript
// MegaLoc: one image, one vector
const megalocId = await loadModel({ modelSrc: MEGALOC_F16, modelType: ModelType.ggmlImageEmbedding })
const { embedding } = await embed({ modelId: megalocId, input: { image: jpegOrPngBytes } })
```

`embed({ text: string[] })` and `embed({ inputs })` still work but are deprecated in favour of `embedBatch`.

### Seeding a chat from an existing cache

A new conversation can start from the prompt cache of another one, so a long shared prefix such as a system prompt and tool list is evaluated once. Enable prefix sharing at load, prime a base cache, then name it with `seedFrom`.

```typescript
const modelId = await loadModel({ modelSrc, modelType: 'llm', modelConfig: { cache_share_across_keys: true } })

await completion({ modelId, history: systemAndTools, stream: false, kvCache: 'base', prefill: true }).final

completion({
  modelId,
  history: [...systemAndTools, { role: 'user', content: 'First question' }],
  stream: true,
  kvCache: 'chat-2',
  seedFrom: 'base'
})
```

### Counting tokens and limiting tool search

`calcTokens` returns how many tokens a history and tool list take on a loaded model, before you send it. Completion requests can also cap how many tool definitions one `tool_search` call loads.

```typescript
const tokens = await calcTokens({
  modelId,
  history: [{ role: 'user', content: 'Summarize this document.' }],
  tools
})

const run = completion({ modelId, tools, toolSearch: { defaultLimit: 1, maxLimit: 2 }, history, stream: true })
```

### Ordered text and media content

History content can be a list of text and media parts.

```typescript
import { completion, type HistoryContentPart } from '@qvac/sdk'

const content: HistoryContentPart[] = [
  { type: 'text', text: 'Image A: ' },
  { type: 'media', path: '/images/a.jpg' },
  { type: 'text', text: '\nImage B: ' },
  { type: 'media', path: '/images/b.jpg' },
  { type: 'text', text: '\nWhich image is a newspaper?' }
]

completion({ modelId, history: [{ role: 'user', content }], stream: true })
```

### Transcription controls and metadata

Whisper exposes prompt, GPU and diarization controls at load, and its segments report language, no-speech probability, speaker turns and token timings.

```typescript
const modelId = await loadModel({
  modelSrc: './ggml-small.bin',
  modelType: 'whisper',
  modelConfig: {
    language: 'auto',
    token_timestamps: true,
    tdrz_enable: true,
    initial_prompt: 'QVAC',
    carry_initial_prompt: true,
    contextParams: { use_gpu: true, 'main-gpu': 'dedicated' }
  }
})

for (const segment of await transcribe({ modelId, audioChunk: 'meeting.wav', metadata: true })) {
  console.log(segment.language, segment.noSpeechProb, segment.speakerTurnNext, segment.tokens)
}
```

Parakeet gains backend selection, speaker attribution, an encoder prewarm at load, and an energy-based voice activity detector that can be tuned at load or per streaming session.

```typescript
const modelId = await loadModel({
  modelSrc: PARAKEET_UNIFIED_0_6B_Q8_0,
  modelType: 'parakeet-transcription',
  modelConfig: {
    backend: 'cpu',
    prewarm: true,
    streamingEnergyVad: true,
    speakerAttribution: { modelSrc: PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0, padSegmentMs: 250 }
  }
})

for (const { speakerId, startMs, endMs, text } of await transcribe({ modelId, audioChunk, metadata: true })) {
  console.log(speakerId, startMs, endMs, text)
}
```

MOSS transcription accepts an explicit `backend` and reports encoder, prefill and decode timings with token counts. Voice activity events carry a `timestamp`. TranscribePsy-250M-EU (`PARAKEET_TRANSCRIBEPSY_250M_EU_Q8_0`) covers 25 European languages; set `language` to `'en'`, `'other'` or `'auto'`.

### Text-to-speech: chunked output and engine controls

`textToSpeech` results expose `chunkStream`, which yields `Int16Array` chunks as the engine produces them.

```typescript
const result = textToSpeech({ modelId, text })
for await (const chunk of result.chunkStream) {
  const sampleRate = await result.sampleRate
  play(chunk, sampleRate)
}
```

Every engine can name its backend (`backend: 'CUDA0'`) instead of asking for "the GPU". Chatterbox exposes sampling and prosody controls, Supertonic exposes chunk streaming, precision and external voices, Parler and the LavaSR enhancer can run on Core ML, CosyVoice3 takes a per-request `instruct` and returns `speechTokenIds` for replay, Audio8 can switch the cloned voice per request, and MOSS exposes token budgets and separate text and audio samplers. Stats report `firstAudioMs` and the engines' stage timings.

### Music generation: streamed and encoded output

`audioGen` results expose `chunkStream` next to the existing `audio` promise, and can return the run as an encoded file.

```typescript
const run = audioGen({ modelId, caption: 'ambient electronic music', outputFormat: 'flac' })

for await (const samples of run.chunkStream) player.write(samples)

const file = await run.encoded // undefined when no outputFormat was named
if (file) await writeFile(`track.${file.extension}`, file.data)
```

ACE-Step can name its pipeline backend and its language-model backend independently, MiniMax-Music3 can run through Core ML on macOS, and stats report `gpuFallbackReason` so a GPU fallback can be told apart from a slow run.

### Image generation

Qwen-Image-2.1-Turbo is supported, with `custom_sigmas` on the request. MOSS-Image renders from a JSON layout prompt and takes its text encoder's tokenizer through `tokenizerSrc`. FLUX.3 Image Klein is supported.

```typescript
const { outputs } = diffusion({
  modelId,
  prompt: 'A red ceramic teapot on a wooden table.',
  width: 512,
  height: 512,
  sampling_method: 'euler',
  cfg_scale: 1,
  custom_sigmas: [1, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0],
  seed: 42
})
```

### Downloads resume, and processes share the registry

Cancelling a registry download now pauses it: the blocks already fetched are kept and the next load resumes. `deleteCache({ modelSrc })` discards a paused or cached download.

```typescript
cancel({ requestId }) // pause: blocks kept, next load resumes
await deleteCache({ modelSrc: QWEN3_600M_INST_Q4.src })
```

Separate QVAC processes can share the model registry store. A registry query exposes a `requestId` so it can be cancelled, and rejects with `ModelRegistryBusyError` when another process holds the store for too long.

```typescript
import { modelRegistrySearch, cancel, ModelRegistryBusyError } from '@qvac/sdk'

const search = modelRegistrySearch({ addon: 'llm' })
stopButton.onclick = () => cancel({ requestId: search.requestId })

try {
  const models = await search
} catch (err) {
  if (err instanceof ModelRegistryBusyError) console.log(err.holder, err.waitedMs)
}
```

### Hardware: AMD NPU and integrated GPU memory

`device: 'npu'` runs an LLM on the AMD XDNA NPU, and completion stats report `backendDevice: 'npu'`. `getSystemResources` reports `dedicatedMemoryTotalBytes` and `dedicatedMemoryUsedBytes` per GPU, which for an integrated GPU is its carve-out of system memory.

```typescript
const modelId = await loadModel({ modelSrc: QWEN3_5_0_8B_MULTIMODAL_Q4_K_M, modelType: 'llm', modelConfig: { device: 'npu' } })
```

### Vector index calibration and staged search

```typescript
import { createVectorIndex, VectorIndexStorage } from '@qvac/sdk'

await using index = await createVectorIndex({ dim: 2048, storage: VectorIndexStorage.TURBOVEC_Q4 })
console.log(index.calibrated)
await index.setStagedSearch({ enabled: true })
```

The TurboVec maximum dimension is 16384, up from 1024.

### Bundling for more targets

`bundleSdk` and `qvac bundle sdk` take a `target` (`bare-sidecar`, `react-native`, `pear-runtime` or `bare-kit`) and a `language` (`javascript`, `python` or `kotlin`), so one command packages the worker for a desktop app, a phone app, a Pear app, a Python app or a Kotlin app.

```typescript
const result = await bundleSdk({ target: 'bare-sidecar', hosts })
// { target, hosts, language, entryPath, outputDir, bundlePath, plugins, addons, verification, ... }
```

### Python client

`Client.open_session()` brings caller sessions to Python. Pass `session.transport` wherever a function takes a transport.

```python
from tetherto.qvac_sdk import Client, cancel, completion, load_model, unload_model
from tetherto.qvac_sdk.models import QWEN3_600M_INST_Q4

async with Client() as client:
    harness = await client.open_session(name="harness")
    skill_runner = await client.open_session(name="skill-runner")

    model_id = await load_model(harness.transport, model_src=QWEN3_600M_INST_Q4)
    await load_model(skill_runner.transport, model_src=QWEN3_600M_INST_Q4)  # same id, second lease

    run = completion(
        harness.transport,
        model_id=model_id,
        history=[{"role": "user", "content": "Write a long essay about the history of Rome."}],
    )
    await cancel(skill_runner.transport, request_id=run.request_id)  # not its request: the run continues
    await cancel(harness.transport, request_id=run.request_id)  # cancels

    await unload_model(harness.transport, model_id)  # the model stays for skill_runner
    await skill_runner.close()
    await harness.close()
```

Also new:

- `completion(seed_from=...)` and `completion(tool_search={"default_limit": 1, "max_limit": 2})`.
- `calc_tokens` and `embed_batch` as generated stubs, and `EmbedRequest(inputs=[...])` for text and media parts.
- `delete_cache(model_src=...)` and `ModelRegistryBusyError`.
- History `content` as a list of `{"type": "text"}` and `{"type": "media"}` parts.
- Typed worker errors: `WorkerStartupError`, `WorkerCrashedError`, `WorkerShutdownError` and `SetConfigFailedError`.
- `Client(worker_path=...)` accepts a folder written by `qvac bundle sdk --language python`.
- Generated stubs always send their constant labels, so `HeartbeatRequest()` needs no `type=`.

### Kotlin client

`client.openSession()` brings caller sessions to Kotlin. A session has the same `models`, `completion`, `speech`, `vision`, `media` and `embeddings` accessors as the client.

```kotlin
val harness = client.openSession(name = "harness")
val skillRunner = client.openSession(name = "skill-runner")

val model = Models.QWEN3_600M_INST_Q4
val loaded = harness.models.load(source = model.src, modelType = model.engine, modelName = model.name)
val modelId = loaded.modelId ?: error(loaded.error ?: "loadModel failed")
skillRunner.models.load(source = model.src, modelType = model.engine, modelName = model.name) // second lease

val run = harness.completion.run(
    modelId = modelId,
    history = listOf(QvacMessage.user("Write a long essay about the history of Rome.")),
)
run.cancel()

val unloaded = harness.models.unload(modelId) // released = true, unloaded = false
skillRunner.close()
harness.close()
```

Also new:

- Ordered content with `QvacMessage.user(listOf(QvacContentPart.Text(...), QvacContentPart.Media(...)))`.
- `QvacCompletionOptions.seedFrom` and `toolSearch`, and `QvacTool.deferLoading` and `group` for deferred tools with `orchestrate()`.
- `calcTokens`, `embedBatch` and the multimodal `EmbedRequest` variants. Of the published Android profiles, only the all-in-one `qvac-sdk-android` carries the image-embedding plugin.
- `requestId` on media and vision runs.
- An experimental desktop JVM host, `JvmBareKitTransport`, built from the repository's `:jvm-barekit` module.
- About 100 runnable examples in `packages/sdk-kotlin/examples/`.

Each `sdk-v<version>` GitHub release carries one Maven repository zip per Android runtime profile plus the JVM client. Extract a zip and point a `maven { url = uri(...) }` repository at the folder.

## Bug Fixes

- **Completion output.** A model's stop reason is preserved, an open `<think>` block ends at a tool call, a reasoning-only answer is returned as content, and the framing newlines around reasoning and the answer are dropped.
- **Tools.** UTF-8 in tool callback results is preserved. `tool_search` loads only strong matches, and an exact tool name loads that tool alone.
- **Downloads.** Separate processes no longer corrupt or delete each other's model downloads, and `deleteCache` waits for a download the same process just cancelled. Sharded GGUF models load without a `tensors.txt` file.
- **Platforms.** Reranking runs on the CPU on Pixel phones, mobile bundles stay on Bare 1.36, and the `bare-fs` floor is raised so Windows can reopen on-disk stores.
- **Model fit.** Crash markers left by a fitter now expire.
- **Worker.** Close, bundle, verify and host-transport defects in the bare-stow worker are fixed, and the Electron Forge plugin supports Electron Forge 8.
- **Python client.** Generated methods send their default constant labels.

## Model Changes

### Added

- **Embeddings:** `EMBEDDINGGEMMA_2_Q8_0`, `MMPROJ_EMBEDDINGGEMMA_2_Q8_0`, `MEGALOC_F16`, `MEGALOC_MIXED`
- **LLM:** `GLM_5_3_FLASH_320B_A18B_MULTIMODAL_Q4_K_M_SHARD`, `MMPROJ_GLM_5_3_FLASH_320B_A18B_MULTIMODAL_BF16`
- **Transcription:** `PARAKEET_TRANSCRIBEPSY_250M_EU_Q8_0`, `PARAKEET_MOSAIC_Q4_0_Q8_0`, `PARAKEET_MOSAIC_COMPACT_Q4_0_Q8_0_Q3_K_IQ3_S`, `PARAKEET_NEMOTRON_3_DIARIZATION_Q4_K`
- **Text-to-speech:** `TTS_LM_MULTILINGUAL_AUDIO8_Q4_0`
- **Music generation:** `AUDIOGEN_ACESTEP_V15_TURBO_BF16`, `AUDIOGEN_ACESTEP_V15_TURBO_F16`
- **Classification:** `MOBILENETV3_3CLASS_V3_FP16`

### Updated

- `EMBEDDINGGEMMA_300M_BF16`, `EMBEDDINGGEMMA_300M_Q4_0` and `EMBEDDINGGEMMA_300M_Q8_0` now resolve to the Dense-layer model files. Re-ingest RAG workspaces built with the earlier files.

### Removed

- `EMBEDDINGGEMMA_300M_F32`. Use `EMBEDDINGGEMMA_300M_BF16`.
