# Browser examples

A multi-page app that runs `@qvac/sdk` in the browser: the public SDK API, a Dedicated Worker, the
inference engine, the browser build of `@qvac/llm-llamacpp` and WebGPU. Each page shows one
feature and is complete on its own: its `index.html` and `main.js` hold every SDK call and helper.
`shared/style.css` holds only the styles.

## Run it

Install and activate the Emscripten version pinned in
[`@qvac/llm-llamacpp`'s browser guide](../../../llm-llamacpp/docs/browser.md), then from the
repository root:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @qvac/llm-llamacpp build:web
corepack pnpm --filter @qvac/inference build
corepack pnpm --filter @qvac/sdk build
corepack pnpm dlx vite@7.3.8 packages/sdk/examples/browser --host 127.0.0.1
```

Open the printed URL in a browser with WebGPU and `shader-f16`. No cross-origin isolation or
unsafe browser flags are needed. If Chrome on Linux exposes no compatible adapter, the
index page explains how to enable Vulkan; without WebGPU the engine runs on the CPU.

Models download once into the browser's private storage (OPFS) and every page reuses them. Most
pages default to Qwen3.5 0.8B Q8_0 (about 0.8 GB). Every page except `kv-cache/` and `fit-finetune/` also takes local files: picked files
are mounted in the worker with `mountBrowserFiles` and read in place, never copied.

## Pages

| Page            | Shows                                                                                      | Default model                            |
| --------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------- |
| `completion/`   | Streaming, generation parameters, stats, and `backendDevice` (`gpu` or `cpu`)              | Qwen3.5 0.8B Q8_0                        |
| `cancel/`       | `cancel({ requestId })` while generating, `InferenceCancelledError`, then a normal run     | Qwen3.5 0.8B Q8_0                        |
| `tools/`        | A tool round trip with `tools: true`, with the model's thinking shown separately           | Qwen3.5 0.8B Q8_0                        |
| `sharded/`      | A split GGUF from its first shard's URL, or from every picked shard                        | Qwen3 0.6B IQ1_S, 3 shards               |
| `multimodal/`   | An image question with `projectionModelSrc`; the picked image is passed by its path        | Qwen3.5 0.8B Q8_0 and its F16 mmproj     |
| `lora/`         | The same prompt with and without `lora`, an adapter path in OPFS or a picked file          | Qwen3.5 0.8B Q8_0, adapter from finetune |
| `speculative/`  | `spec_type: 'draft-mtp'` with an external `draftModelSrc`, and accepted-token stats        | Qwen3.5 0.8B Q8_0 and an MTP build       |
| `batch/`        | `batchCompletion` over three prompts with `parallel: 2`, merged stream and ordered results | Qwen3.5 0.8B Q8_0                        |
| `kv-cache/`     | `kvCache: true` turn 1, a page reload, then turn 2 reusing the saved cache                 | Qwen3.5 0.8B Q8_0                        |
| `fit-finetune/` | `assessModelFit`, then `finetune` saving a LoRA adapter to OPFS                            | Qwen3.5 0.8B Q8_0                        |

Run `fit-finetune/` before `lora/`: it saves `/qvac-examples/finetune/trained-lora-adapter.gguf`,
which the LoRA page loads by default. Any adapter trained for the loaded model works there too.

`assessModelFit` returns `unknown` in the browser, with a `reason`: it sizes a model from its
registry description, which a URL source does not have, and WebGPU does not expose free GPU memory.
Show `unknown` as "can't say", never as "no". Finetuning may use the CPU for operations the
WebGPU backend lacks, so it is slow.

## Files the engine reads

Paths the engine reads are absolute paths in OPFS, or paths returned by `mountBrowserFiles`.
Mount related files in one call, so that GGUF shards stay siblings:

```js
import { loadModel, mountBrowserFiles } from '@qvac/sdk'

const files = Array.from(document.querySelector('#model-files').files)
const paths = await mountBrowserFiles(files)
const modelId = await loadModel({ modelSrc: paths[0], modelType: 'llamacpp-completion' })
```

The same paths work for `projectionModelSrc`, `draftModelSrc`, `lora`, media parts
(`{ type: 'media', path }`) and finetuning datasets.
