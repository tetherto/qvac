# Browser (WebAssembly + WebGPU)

`@qvac/llm-llamacpp` ships a browser build next to the native prebuilds, in
`prebuilds/web/`. It is the same engine (the
`addon/src/model-interface` and `utils` sources) compiled with Emscripten
against Fabric's WebGPU backend, behind the same `LlmLlamacpp` class. Code
that runs on Bare runs unchanged in the browser, within the limits below.

## How it is selected

The package's `browser` field swaps three modules when a bundler targets the
browser:

| Module | Browser replacement |
|--------|---------------------|
| `binding.js` (Bare addon) | `binding.browser.js` (WebAssembly build) |
| `bare-fs` | `browser/fs.js` (sharded loading and finetune are unsupported) |
| `bare-path` | `browser/path.js` (POSIX subset) |

The build ships two engines. `binding.browser.js` loads the one the browser
supports with a dynamic `import()`, and each loader fetches its `.wasm` from its
own URL:

| Engine | Runs in | Model files |
|--------|---------|-------------|
| `llm-llamacpp.{mjs,wasm}` (32-bit) | every browser with WebGPU | up to 4 GiB of tensor data (32-bit `size_t`) |
| `llm-llamacpp-64.{mjs,wasm}` (Memory64) | Chrome 133+, Firefox 134+ | no file-size limit |

Most bundlers (Vite, webpack) emit both as assets; a browser downloads only
one. A prebuilt bundle can instead leave the loaders external as
`@qvac/llm-llamacpp/prebuilds/web/*`, a subpath the package exports for that
purpose.

## Requirements

- Run it in a **Dedicated Worker**. Between GPU waits the engine runs on the
  calling thread.
- WebGPU with `shader-f16` gives GPU offload. Without a usable adapter the
  engine falls back to the CPU backend. That works, but it's slow.
- No cross-origin isolation is needed. The build uses no threads or
  `SharedArrayBuffer`.

## Model files

Model paths are absolute paths in the origin private file system (OPFS):
`/models/qwen.gguf` is `models/qwen.gguf` under
`navigator.storage.getDirectory()`. A path can also name a browser `File`
registered in place under `globalThis[Symbol.for('qvac.browser.mountedFiles')]`
(a `Map` from path to `File`), which is how `@qvac/sdk`'s `mountBrowserFile`
loads a user's file without copying it. Either way the file is mounted
read-only into the engine and read on demand, so it's never copied whole into
WebAssembly memory.

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

## Supported and unsupported features

Supported:
- Completion and streaming
- Reasoning models
- Tool calling
- Generation parameters
- Per-job cancel, also on the CPU fallback. It takes effect at the next
  generated token, so a long prompt evaluation on the CPU finishes first.
- Runtime stats
- `saveCache`/`discardCache` (cache files live in memory)
- Load and unload

| Not supported in the browser | Behaviour |
|------------------------------|-----------|
| `parallel` > 1 and batch `run()` | Rejected at load/run |
| Sharded models (`files.model` with more than one file) | Rejected at load |
| `load_mode` other than `auto`/`none` | Rejected at load; weights are read, never memory-mapped |
| Media (image/audio) messages | Rejected at run |
| `finetune()` | Throws: not exposed by the browser binding |
| `assessFit()` | Rejects |

Requests run one at a time per page (worker). A second `run()` either fails
fast (`rejectWhenBusy`, the default) or waits its turn.

The model's `backend` setting also accepts `webgpu`. The browser build ships
no other GPU backend.
