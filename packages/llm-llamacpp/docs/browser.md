# Browser (WebAssembly + WebGPU)

`@qvac/llm-llamacpp` ships browser engines next to the native prebuilds. The
shared model, generation-handler and utility sources are compiled with
Emscripten against Fabric's WebGPU backend and exposed through the same
`LlmLlamacpp` class.

## How it is selected

The package's `browser` field swaps these modules when a bundler targets the
browser:

| Module                    | Browser replacement                                        |
| ------------------------- | ---------------------------------------------------------- |
| `binding.js` (Bare addon) | `binding.browser.js` (WebAssembly build)                   |
| `@qvac/infer-base`        | `browser/infer-base.js` (browser-safe inference helpers)   |
| `bare-fs`                 | `browser/fs.js` (native-only filesystem operations reject) |
| `bare-path`               | `browser/path.js` (POSIX subset)                           |

`binding.browser.js` selects the 32-bit engine or the Memory64 engine at
runtime. A bundler emits both variants, but the browser fetches only the one
it selects. Each `.wasm` file must remain next to its matching `.mjs` loader.

Vite preserves that loader-to-Wasm layout automatically. Plain esbuild emits
the loader chunks but does not copy files referenced through `new URL()`.
After an esbuild bundle, copy both binaries from
`node_modules/@qvac/llm-llamacpp/prebuilds/web/` into the directory containing
the emitted loader chunks:

```sh
cp node_modules/@qvac/llm-llamacpp/prebuilds/web/llm-llamacpp.wasm dist/
cp node_modules/@qvac/llm-llamacpp/prebuilds/web/llm-llamacpp-64.wasm dist/
```

## Requirements

- Run it in a **Dedicated Worker**. Between GPU waits the engine runs on the
  calling thread.
- WebGPU with `shader-f16` is required for the GPU path. When no compatible
  adapter is available, the engine logs the fallback and runs on the CPU.
  Applications that require GPU execution should check WebGPU before loading
  and verify `backendDevice: 'gpu'` in the completion statistics.
- No cross-origin isolation is needed. The build uses no threads or
  `SharedArrayBuffer`.
- The wasm32 engine has a 4 GiB linear-memory ceiling. The Memory64 engine is
  configured for up to 16 GiB of linear memory. Model files are not copied
  whole into that memory; usable model size also depends on the model's CPU
  allocations, browser limits and available GPU memory.

## Model files

Model paths are absolute paths in the origin private file system (OPFS).
`/models/qwen.gguf` refers to `models/qwen.gguf` under
`navigator.storage.getDirectory()`. Files are mounted read-only into the
engine and read on demand; they are not copied whole into WebAssembly memory.

For a sharded GGUF, pass the first shard path only. Every shard must be in the
same OPFS directory with its original `*-00001-of-000NN.gguf` name. The
binding verifies that the set is complete before loading it.

`files.projectionModel`, `config.lora`, and
`config.spec_draft_model`/`config['spec-draft-model']` use the same absolute
OPFS path rules. Every path's form (absolute, first shard) is checked before
the engine starts; whether the file exists is checked when it is mounted. For a
sharded draft model, pass its first shard path. `config.lora` takes one adapter
path, which may contain commas; `lora-scaled`, `control-vector` and
`control-vector-scaled` are rejected at load.

```js
import LlmLlamacpp from '@qvac/llm-llamacpp'

const model = new LlmLlamacpp({
  files: { model: ['/models/qwen.gguf'] },
  config: { device: 'gpu', gpu_layers: '99', ctx_size: '4096', flash_attn: 'on' }
})
await model.load()
const response = await model.run([{ role: 'user', content: 'Hello' }])
response.onUpdate((text) => console.log(text))
await response.await()
await model.unload()
```

## Finetuning files

Browser finetuning dataset, chat-template, output, and checkpoint paths may be
safe relative or absolute OPFS paths. Paths of files mounted into the worker
are also accepted. Path segments must not be `.` or `..`; for example, use
`checkpoints/run-1` or `/checkpoints/run-1`, not `./checkpoints/run-1`.
NUL characters are rejected. Outputs and completed checkpoints are persisted
in OPFS, so finetuning requires OPFS support. A dataset or chat template
removed from OPFS is missing for the next run, as on native.

Without `checkpointSaveDir`, checkpoints go to `checkpoints` in the OPFS root,
the browser equivalent of the native `./checkpoints`. Every page of the origin
shares that directory, so a run can resume or remove another run's pause
checkpoint. Give each independent run its own `checkpointSaveDir`.

Non-ephemeral `cacheKey` runs and `saveCache()` also require OPFS because their
contract promises durable files. Inference without a cache key, an ephemeral
cache, and a read-only `baseCacheKey` can still run from mounted files when
OPFS is unavailable. Exact cache and checkpoint file commits use the browser's
cross-context Web Locks API when available. Writable cache,
output, and checkpoint paths must not be shared by simultaneous model workers;
without Web Locks, even file-commit serialization is limited to one worker.

## Current browser binding scope

Supported:

- Completion and streaming
- Batch completion and multiple concurrent `run()` calls when `parallel >= 2`
- Projection-backed multimodal inference from `Uint8Array` media
- Reasoning models
- Tool calling
- Generation parameters
- Per-job cancel during generation; a queued job can also be cancelled before it starts
- Runtime stats
- `saveCache`/`discardCache`; saved cache files are persisted in OPFS and restored after reload
- `calcTokens` while the engine is idle
- `finetune()`, including progress events, pause/resume checkpoints, cancellation,
  and final adapter output persisted in OPFS. Browser training may use CPU
  fallback for operations the WebGPU backend does not implement; GPU training
  acceleration is not guaranteed.
- `assessFit()` validates the request, complete GGUF metadata, and normalized
  load configuration, then returns `unknown`.
  WebGPU does not expose current free or total device memory, so the browser
  cannot produce an honest native-style fit verdict.
- Single-file and sharded GGUF models
- Mounting and forwarding projection, LoRA and external speculative model files
- Load and unload

| Outside the current binding scope                | Behaviour                                                   |
| ------------------------------------------------ | ----------------------------------------------------------- |
| `load_mode` other than `auto`/`none`             | Rejected at load; weights are read, never memory-mapped     |
| RPC servers and native backend/cache directories | Rejected at load                                            |
| `lora-scaled` and control vectors                | Rejected at load                                            |
| Multiple LoRAs                                   | Not supported; a comma-separated `lora` is read as one path |

With `parallel: 1`, one request runs at a time in the Worker. With
`parallel >= 2`, Fabric's continuous-batching scheduler advances multiple
requests cooperatively between browser event-loop turns. `rejectWhenBusy`
controls whether a request fails fast or waits when every configured slot is
occupied.
`calcTokens()` fails with `RUN_BUSY` instead of waiting behind another engine
operation.

The model's `backend` setting also accepts `webgpu`. The browser build ships
no other GPU backend.
