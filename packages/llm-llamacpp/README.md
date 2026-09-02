# llm-llamacpp

This native C++ addon, built using the `Bare` Runtime, simplifies running Large Language Models (LLMs) within QVAC runtime applications. It provides an easy interface to load, execute, and manage LLM instances.

## Table of Contents
- [Supported platforms](#supported-platforms)
- [Installation](#installation)
- [Building from Source](#building-from-source)
- [Usage](#usage)
  - [1. Import the Model Class](#1-import-the-model-class)
  - [2. Create the `args` obj](#2-create-the-args-obj)
    - [Sharded models](#sharded-models)
  - [3. Create the `config` obj](#3-create-the-config-obj)
  - [4. Create Model Instance](#4-create-model-instance)
  - [5. Load Model](#5-load-model)
  - [6. Run Inference](#6-run-inference)
  - [7. Release Resources](#7-release-resources)
- [API behavior by state](#api-behavior-by-state)
- [Fine-tuning](#fine-tuning)
- [Quickstart Example](#quickstart-example)
- [Other Examples](#other-examples)
- [Architecture](#architecture)
- [Benchmarking](#benchmarking)
- [Tests](#tests)
- [Glossary](#glossary)
- [License](#license)

## Supported platforms

| Platform | Architecture | Min Version | Status | GPU Support |
|----------|-------------|-------------|--------|-------------|
| macOS | arm64, x64 | 14.0+ | ✅ Tier 1 | Metal |
| iOS | arm64 | 17.0+ | ✅ Tier 1 | Metal |
| Linux | arm64, x64 | Ubuntu-22+ | ✅ Tier 1 | Vulkan |
| Android | arm64 | 12+ | ✅ Tier 1 | Vulkan, OpenCL (Adreno 700+) |
| Windows | x64 | 10+ | ✅ Tier 1 | Vulkan |


**Note — BitNet models (TQ1_0 / TQ2_0 quantization):**
BitNet models require special backend handling on Adreno GPUs. When a BitNet model is detected and no explicit `main-gpu` is set:
- **Adreno 800+** (e.g. Adreno 830): Vulkan is used instead of OpenCL.
- **Adreno < 800** (e.g. Adreno 740): Falls back to CPU, as TQ kernels are not yet optimized for older Adreno OpenCL/Vulkan.
- **Non-Adreno GPUs**: Normal GPU selection applies (no special behavior).

**Dependencies:**
- inference-addon-cpp (≥1.3.3): C++ addon framework (multi-job scheduler)
- qvac-fabric-llm.cpp (≥9840.1.1): Inference engine
- Bare Runtime (≥1.24.0): JavaScript runtime
- Linux requires Clang/LLVM 22 with libc++
## Installation

### Prerequisites

Ensure that the Bare Runtime is installed globally on your system. If it's not already installed, you can install it using:

```bash
npm install -g bare@latest
```
### Installing the Package

```bash
npm install @qvac/llm-llamacpp@latest
```

## Building from Source

See [build.md](./build.md) for detailed instructions on how to build the addon from source.

## Usage

### 1. Import the Model Class

```js
const LlmLlamacpp = require('@qvac/llm-llamacpp')
const path = require('bare-path')
```

### 2. Create the `args` obj

```js
const dirPath = path.resolve('./models')
const modelName = 'Llama-3.2-1B-Instruct-Q4_0.gguf'

const args = {
  files: {
    model: [path.join(dirPath, modelName)]
    // projectionModel: path.join(dirPath, 'mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf') // for multimodal support pass the projection model path
  },
  config,
  opts: { stats: true },
  logger: console
}
```

The `args` obj contains the following properties:

* `files.model`: Required. An array of absolute paths to the GGUF model file(s) to load. The caller is responsible for passing the complete set of files for the model, including every shard and the `.tensors.txt` companion for multi-shard models (see [Sharded models](#sharded-models) below).
* `files.projectionModel`: Optional. Absolute path to the projection model file. This is required for multimodal support.
* `config`: The model configuration object (see next section).
* `logger`: This property is used to create a [`QvacLogger`](../logging) instance, which handles all logging functionality.
* `opts.stats`: This flag determines whether to calculate inference stats.

#### Sharded models

The addon no longer expands sharded models internally. If you are loading a multi-shard GGUF model, **the caller MUST pass every file** — including the `.tensors.txt` companion file that lives alongside the shards — in `files.model`. Anything missing will cause the addon to fail during weight streaming.

**Required ordering for multi-shard models:**
1. The `.tensors.txt` companion file **first**.
2. Each `*-NNNNN-of-MMMMM.gguf` shard in **numerical order** (shard `00001` before `00002`, and so on).

Example — loading a 5-shard model:

```js
const path = require('bare-path')
const LlmLlamacpp = require('@qvac/llm-llamacpp')

const dir = path.resolve('./models')
const modelBase = 'my-big-model-Q4_K_M'

const model = new LlmLlamacpp({
  files: {
    model: [
      path.join(dir, `${modelBase}.tensors.txt`),
      path.join(dir, `${modelBase}-00001-of-00005.gguf`),
      path.join(dir, `${modelBase}-00002-of-00005.gguf`),
      path.join(dir, `${modelBase}-00003-of-00005.gguf`),
      path.join(dir, `${modelBase}-00004-of-00005.gguf`),
      path.join(dir, `${modelBase}-00005-of-00005.gguf`)
    ]
  },
  config,
  logger: console,
  opts: { stats: true }
})

await model.load()
```

For single-file GGUF models, pass a one-element array:

```js
files: { model: [path.join(dir, 'Llama-3.2-1B-Instruct-Q4_0.gguf')] }
```

### 3. Create the `config` obj

The `config` obj consists of a set of hyper-parameters which can be used to tweak the behaviour of the model.  
*All parameters must by strings.*

```js
// an example of possible configuration
const config = {
  gpu_layers: '99', // number of model layers offloaded to GPU.
  ctx_size: '1024', // context length
  device: 'cpu', // must be specified: 'gpu' or 'cpu' else it will throw an error
  load_mode: 'none' // read fully into memory: no mmap, mlock or direct I/O
}
```

| Parameter         | Range / Type                                | Default                      | Description                                           |
|-------------------|---------------------------------------------|------------------------------|-------------------------------------------------------|
| device            | `"gpu"` or `"cpu"`                          | — (required)                 | Device to run inference on                            |
| gpu_layers        | integer                                     | 0                            | Number of model layers to offload to GPU              |
| ctx_size          | 0 – model-dependent                         | 4096 (0 = loaded from model) | Context window size                                   |
| lora              | string                                      | —                            | Path to LoRA adapter file                             |
| temp              | 0.00 – 2.00                                 | 0.8                          | Sampling temperature                                  |
| top_p             | 0 – 1                                       | 0.9                          | Top-p (nucleus) sampling                              |
| top_k             | 0 – 128                                     | 40                           | Top-k sampling                                        |
| predict         | integer (-1 = infinity)                     | -1                           | Maximum tokens to predict                             |
| seed              | integer                                     | -1 (random)                  | Random seed for sampling                              |
| load_mode         | `"none"`, `"mmap"`, `"mlock"`, `"mmap+mlock"`, or `"dio"` | `"mmap"`                     | Select the model loading mode                          |
| reverse_prompt    | string (comma-separated)                    | —                            | Stop generation when these strings are encountered    |
| repeat_penalty    | float                                       | 1.1                          | Repetition penalty                                    |
| presence_penalty  | float                                       | 0                            | Presence penalty for sampling                         |
| frequency_penalty | float                                       | 0                            | Frequency penalty for sampling                        |
| tools             | `"true"` or `"false"`                       | `"false"`                    | Enable tool calling with jinja templating             |
| verbosity         | 0 – 3 (0=ERROR, 1=WARNING, 2=INFO, 3=DEBUG) | 0                            | Logging verbosity level                               |
| main-gpu          | integer, `"integrated"`, or `"dedicated"`   | —                            | GPU selection for multi-GPU systems                   |
| split-mode        | `"none"`, `"layer"`, `"row"`, or `"tensor"` | `"none"`                     | How to split the model across GPUs. `"tensor"` is EXPERIMENTAL and desktop-only ([details](./docs/multi-gpu.md)) |
| tensor-split      | comma-separated proportions (e.g. `"1,1"`)  | —                            | GPU split ratios for the multi-GPU split modes ([details](./docs/multi-gpu.md)) |
| parallel          | integer                                     | 1                            | Concurrent sequence slots for continuous batching. Values `>= 2` enable batch `run()` and split the KV cache uniformly across slots ([details](./docs/continuous-batching.md)) |
| flash-attn        | `"on"`/`"enabled"`/`"true"`/`"1"`, `"off"`/`"disabled"`/`"false"`/`"0"`, or `"auto"` | `"on"` | Flash attention. The four truthy and four falsey spellings are equivalent; `"auto"` is a third state that defers to qvac-fabric's runtime capability probe. Lower-case only. Affects the KV-cache auto-default — see below. Also accepted as `flash_attn` |
| cache-type-k      | `f16`, `f32`, `bf16`, `q8_0`, `q4_0`, …      | auto (see below)             | KV-cache **key** quantization type. Unset = auto-default (see KV-cache type below) |
| cache-type-v      | `f16`, `f32`, `bf16`, `q8_0`, `q4_0`, …      | auto (see below)             | KV-cache **value** quantization type. Quantizing V requires `flash-attn` on |
| mmproj-use-gpu    | `"true"`/`"on"`/`"1"` or `"false"`/`"off"`/`"0"` | auto (see below)         | Run the multimodal projector (mmproj / vision encoder) on the GPU. Only honoured when a GPU backend is selected (ignored with a warning on CPU / GPU-fallback). Unset = auto-default (see mmproj backend below) |


#### KV-cache type & auto-default

The addon picks a safe KV-cache type when `cache-type-k`/`cache-type-v` are unset, and validates any explicit choice per backend:

- **Auto-default:** on a **Metal / Vulkan GPU** (with flash attention on) both K and V default to **`q8_0`** — quality-neutral vs `f16` and ~47% smaller KV cache. **CPU** and **OpenCL (Adreno)** keep **`f16`** (ARM CPU `q8_0` has a quality/throughput cost; quantized KV is unsafe on OpenCL — see below). Finetuning manages its own KV types and is left untouched.
- **`flash-attn: 'auto'` keeps `f16`.** "Flash attention on" above means a truthy `flash-attn` — `on`, `enabled`, `true` or `1`, or the `on` default when the key is unset. `'auto'` is deliberately excluded: quantizing the V cache forces qvac-fabric to promote AUTO to ENABLED, which skips the runtime capability probe that `'auto'` exists to run. So `'auto'` trades the ~47% KV-cache saving for letting qvac-fabric decide. To get both, set `cache-type-k`/`-v` explicitly alongside `'auto'`, or use `'on'`.
- **OpenCL (Adreno) accepts only `f16`/`f32`/`bf16`:** any other cache type — quantized (`q8_0`, `q4_0`, `q4_1`, `q5_0`, …) or unrecognized — throws a `StatusError`. A quantized K or V cache aborts in `llama_kv_cache::update` on cache management (reasoning-block compaction, state restore) because ggml-opencl has no `F32→quantized` requantize kernel. Use `f16`/`f32`/`bf16`, or a Vulkan GPU / CPU.
- **Mixed K≠V is a warning, not an error:** if K and V differ and at least one is quantized, the addon logs a warning (asymmetric quantized K/V falls off the fused flash-attention path — a notable GPU decode penalty — for no quality benefit, and is unsupported on Adreno OpenCL) but proceeds. Prefer a symmetric type. (This may be relaxed once qvac-fabric handles asymmetric quantized K/V efficiently.)


#### IGPU/GPU  selection logic:

| Scenario                       | main-gpu not specified                | main-gpu: `"dedicated"`             | main-gpu: `"integrated"`           |
|---------------------------------|---------------------------------------|-------------------------------------|-------------------------------------|
| Devices considered              | All GPUs (dedicated + integrated)     | Only dedicated GPUs                 | Only integrated GPUs                |
| System with iGPU only           | ✅ Uses iGPU                          | ❌ Falls back to CPU                | ✅ Uses iGPU                        |
| System with dedicated GPU only  | ✅ Uses dedicated GPU                 | ✅ Uses dedicated GPU               | ❌ Falls back to CPU                |
| System with both                | ✅ Uses dedicated GPU (preferred)     | ✅ Uses dedicated GPU               | ✅ Uses integrated GPU              |

For multi-GPU setups using `split-mode` and `tensor-split`, see the **[Multi-GPU Inference guide](./docs/multi-gpu.md)**.


#### Multimodal projector (mmproj) backend & auto-default

For vision (VLM) models, the projector / image-encoder backend is auto-selected per device class when
`mmproj-use-gpu` is unset (QVAC-21867):

| Device class | Projector default | Why |
|---|---|---|
| Desktop & iOS | **GPU** | Metal / Vulkan projector encode is faster than CPU. |
| Android — Adreno 800+ (e.g. Adreno 830) | **GPU** | The only mobile GPU class benchmarked (QVAC-21257) to encode the projector faster than on CPU. |
| Android — Arm Mali | **CPU** | Projector encode measured slower on the Mali GPU than on CPU (QVAC-21257). |
| Android — Adreno < 800 (e.g. Adreno 740) | **CPU** | Weaker tiers not yet benchmarked; conservative default (may be relaxed once benchmarked). |
| Android — undetectable Adreno tier | **CPU** | Conservative default when the GPU's Adreno version can't be parsed. |

In every Android **CPU** case above the LLM layers still run on the GPU — only the projector stays on CPU.

An explicit `mmproj-use-gpu` value always wins over the auto-default, in either direction. When the model
itself runs on the CPU backend (`device: "cpu"` or GPU fallback), the key is ignored with a warning and the
projector runs on CPU. The resolved choice is logged at verbosity ≥ 2 as
`[LlamaModel] multimodal projector backend: …`.

### 4. Create Model Instance

```js
const model = new LlmLlamacpp(args)
```

### 5. Load Model

```js
await model.load()
```

Loads the model file(s) passed in `files.model` and activates the native addon. If a projection model was provided (`files.projectionModel`), it is loaded as part of the same step.

### 6. Run Inference

Pass an array of messages (following the chat completion format) to the `run` method. Process the generated tokens asynchronously:

```javascript
try {
  const messages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'What is the capital of France?' }
  ]

  const response = await model.run(messages)
  const buffer = []

  // Option 1: Process streamed output using async iterator
  for await (const token of response.iterate()) {
    process.stdout.write(token) // Write token directly to output
    buffer.push(token)
  }

  // Option 2: Process streamed output using callback
  await response.onUpdate(token => { /* ... */ }).await()

  console.log('\n--- Full Response ---\n', buffer.join(''))

} catch (error) {
  console.error('Inference failed:', error)
}
```

When `opts.stats` is enabled, `response.stats` includes runtime metrics such as `TTFT`, `TPS`, token counters, and `backendDevice` (`"cpu"` or `"gpu"`). `backendDevice` reflects the resolved device used at runtime after backend selection/fallback logic, not only the requested config.

#### Batch inference

Load the model with `parallel >= 2`, then pass an array of prompts. Each chunk arrives tagged with the id of the sequence that produced it; `await()` returns results in input order.

```javascript
const model = new LlmLlamacpp({
  files: { model: ['/path/to/model.gguf'] },
  config: { device: 'gpu', gpu_layers: '99', ctx_size: '8192', parallel: '4' }
})
await model.load()

const prompts = [
  [{ role: 'user', content: 'Name a fruit.' }],
  [{ role: 'user', content: 'Name a country.' }],
  [{ role: 'user', content: 'Name a color.' }]
]

const response = await model.run(prompts)

// Stream tokens as they arrive, tagged by sequence id
response.onUpdate(({ id, chunk }) => {
  process.stdout.write(`[${id}] ${chunk}`)
})

// Ordered results once all sequences finish
const results = await response.await()
// Prompts passed as plain Message[] arrays get auto-minted ids: batch-1, batch-2, batch-3
// results: [ { id: 'batch-1', output: 'Apple' }, { id: 'batch-2', output: 'France' }, { id: 'batch-3', output: 'Blue' } ]
```

Pass `BatchPrompt` objects to supply a caller-assigned id or per-prompt `runOptions`. The `batch-` prefix is reserved for auto-minted ids and rejected on caller-assigned ones:

```javascript
const response = await model.run([
  { id: 'fruit',   prompt: [{ role: 'user', content: 'Name a fruit.' }] },
  { id: 'country', prompt: [{ role: 'user', content: 'Name a country.' }], runOptions: { generationParams: { temp: 0.2 } } }
])
```

### 7. Release Resources

Unload the model when finished:

```javascript
try {
  await model.unload()
} catch (error) {
  console.error('Failed to unload model:', error)
}
```

### API behavior by state

The following table describes the expected behavior of `run` and `cancel` depending on the current state (idle vs jobs running). The two cancel entry points have different scopes:

- `response.cancel()` — **targeted**: cancels only the job (or batch group) that `run()` call produced, leaving other concurrent jobs running.
- `model.cancel()` — **global**: cancels every live job (in-flight and queued) at the moment of the call, plus any finetuning in progress.

| Current state | Action called | What happens |
|---------------|----------------|----------------------------------------------------------------|
| idle          | run            | **Allowed** — starts inference, returns `QvacResponse`        |
| idle          | cancel         | **Allowed** — no-op (no job to cancel); Promise resolves      |
| busy, `parallel: 1` (or `rejectWhenBusy: true`) | run | **Throw** — an `Error` with `code === 'RUN_BUSY'` (message `"Cannot set new job: a job is already set or being processed"`) the moment the slot pool is full. Branch on the code; the message is prose and may change |
| busy, `parallel >= 2` (default `rejectWhenBusy: false`) | run | **Allowed** — the job is admitted concurrently (continuous batching) or queued until a slot frees; each call gets its own independent `QvacResponse` |
| busy          | `response.cancel()` | **Allowed** — cancels only that response's job/group; Promise resolves when it has stopped |
| busy          | `model.cancel()`    | **Allowed** — cancels all live jobs; Promise resolves when they have stopped |

Admission is controlled by `rejectWhenBusy` (instance-level `opts.rejectWhenBusy`, overridable per call via `runOptions.rejectWhenBusy`). Its default follows `parallel`: `true` for `parallel: 1` (busy runs fail fast, preserving the historical single-job contract) and `false` for `parallel >= 2` (busy runs queue behind the pool and start as slots free). With `parallel >= 2`, separate top-level `run()` calls are batched together into the same decode loop — see [Continuous Batching](./docs/continuous-batching.md).

"Full" is counted in slots, not calls: a batch run of N prompts is one job that occupies up to N slots, so with `parallel: 4` a single in-flight `run([p, p, p, p])` is enough to fail-fast a following run. An active finetune counts as full at any `parallel`, since it holds the model exclusively.

#### Prefill (cache warming) with `parallel >= 2`

A prefill-only run (`runOptions.prefill: true`) is admitted on a parallel model only when its product survives the slot teardown, i.e. it is *persistable*: `saveCacheToDisk: true` plus a `cacheKey`. A live-only prefill (no persistence) warms context state that no concurrent job could ever reach, so it is rejected with `InvalidArgument`; run it on a `parallel: 1` model instead. The same rule applies per item in batch runs. See [cache-api.md](./docs/cache-api.md).

#### Cancelling a batch

`response.cancel()` on a `BatchResponse` cancels only that batch group — other concurrent runs (single or batch) keep going; `model.cancel()` cancels every live job. Within the cancelled group, when more prompts were submitted than the configured `parallel` slots the overflow prompts wait in an internal queue until a slot frees up, and cancel treats the two subsets differently, mirroring how cancelling a single request behaves:

- **In-flight prompts** (already decoding in a slot) are cancelled gracefully: they keep whatever they generated so far and the call resolves normally — no error.
- **Queued prompts** (still waiting, never admitted to a slot) had no chance to run and produced nothing. These are surfaced as an error rather than silent empty results: the batch call rejects with a `Cancelled` `StatusError`.

So a cancelled batch that contained queued prompts rejects with `Cancelled`; callers should handle that rejection rather than expecting empty strings for the un-run prompts. A single (non-batch) run resolves with an empty string once it has started, but rejects with `Cancelled` if it was still waiting in the scheduler's queue and so never ran at all — see [Cancellation semantics](./docs/continuous-batching.md#cancellation-semantics). Either way the rejection is an `Error` carrying the native **message** with no `code`: a job's asynchronous terminal is forwarded through addon-cpp's `Output::Error`, which keeps only the text, so `err.code` is not available here (unlike `RUN_BUSY`, which is built in JS and does carry one). Match on `err.message` for now.

Cancelling a queued job resolves immediately, whether or not the slots it was waiting for are held by an unrelated run — you never wait out someone else's generation to cancel your own queued work.


## Fine-tuning

The library supports **LoRA finetuning** of GGUF models: train small adapter weights on top of a base model, then save the adapter and load it at inference time via the `lora` config option. You can pause and resume training from checkpoints.

For the full API, dataset format, parameters, and examples, see the **[Finetuning guide](docs/finetuning.md)**.

### Smart Home Showcase

A hands-on example that finetunes Qwen3-0.6B to act as a smart home tool-calling specialist. The base model tends to drift into conversational text or exhaust its token budget on reasoning — the finetuned adapter fixes both problems.

1. **Train** — [`smart-home-finetune.js`](./examples/finetune/showcase/smart-home-finetune.js) runs a 1-epoch causal LoRA finetune on a [215-sample dataset](./examples/input/smart_home_specialist_train.jsonl) of user requests paired with `<tool_call>` responses.
2. **Evaluate** — [`smart-home-finetuned-test.js`](./examples/finetune/showcase/smart-home-finetuned-test.js) runs the same prompts against the base model and the finetuned model, then prints a side-by-side comparison report (strictness, accuracy, thinking token usage, multi-turn stability).

> **Note on dataset diversity:** The training dataset intentionally includes tool-calling samples from many domains (medical, irrigation, quantum, etc.), not just the 4 smart-home tools used in evaluation. The goal is to teach the model the general *behavioral pattern* — produce structured `<tool_call>` output instead of conversational text — rather than memorize specific tool names. The evaluation then tests whether that pattern transfers to smart-home prompts the model wasn't explicitly drilled on.

```bash
# Train the adapter
bare examples/finetune/showcase/smart-home-finetune.js

# Compare baseline vs finetuned
bare examples/finetune/showcase/smart-home-finetuned-test.js
```


## Quickstart Example

Clone the repository and navigate to it:
```bash
cd llm-llamacpp
```

Install dependencies:
```bash
npm install
```

Run the quickstart example (uses examples/quickstart.js):
```bash
npm run quickstart
```


## Other examples

-   [SalamandraTA](./examples/salamandraTA.js) – Demonstrates SalamandraTA model usage.
-   [Multimodal](./examples/multiModal.js) – Demonstrates how to run multimodal inference.
-   [Multi-Cache](./examples/multiCache.js) – Demonstrates session handling and caching capabilities.
-   [Native Logging](./examples/nativelog.js) – Demonstrates C++ addon logging integration.
-   [Tool Calling](./examples/toolCalling.js) – Demonstrates tool calling capabilities.
-   [LoRA Finetuning](./examples/finetune/simple-lora-finetune.js) – Basic LoRA finetuning.
-   [LoRA Finetuning Pause/Resume](./examples/finetune/simple-lora-finetune-pause-resume.js) – Pause and resume finetuning.
-   [LoRA Inference](./examples/simple-lora-inference.js) – Inference with a finetuned LoRA adapter.
-   [Smart Home Finetune Showcase](./examples/finetune/showcase/smart-home-finetune.js) – Train a smart home tool-calling specialist, then [evaluate](./examples/finetune/showcase/smart-home-finetuned-test.js) baseline vs finetuned.
-   [Multi-GPU Benchmark](./examples/multiGpuBenchmark.js) – Compares single-GPU, layer-parallel, and tensor-parallel split modes.

## OCR with Vision-Language Models

In addition to pipeline-based OCR (`@qvac/ocr-ggml`), you can use vision-language models through `@qvac/llm-llamacpp` for OCR tasks. This is useful for structured document understanding (tables, forms, multi-column layouts) where traditional OCR pipelines struggle.

### Supported OCR Models

| Model | Params | Quantization | Description |
|-------|--------|-------------|-------------|
| LightON OCR-2 1B | 0.6B (LLM) + ~550M (vision) | Q4_K_M | OCR-specialized, full-page transcription, 11 languages |
| Unlimited-OCR | 3B (DeepseekV2 MoE) + SAM+CLIP vision | Q4_K_M | OCR-specialized, full-page document parsing with layout boxes + HTML tables |
| SmolVLM2-500M | 500M | Q8_0 | General vision-language, can follow targeted extraction prompts |

### LightON OCR-2

[LightON OCR-2](https://huggingface.co/noctrex/LightOnOCR-2-1B-ocr-soup-GGUF) is an OCR-specialized vision-language model (Apache 2.0) that produces detailed markdown/HTML output with tables. It supports 11 languages: English, French, German, Spanish, Italian, Dutch, Portuguese, Polish, Romanian, Czech, and Swedish.

**Characteristics:**
- Always does full-page transcription regardless of prompt
- Produces detailed structured output (markdown tables, HTML)
- Requires `--jinja` flag / jinja chat template in llama.cpp
- Requires both LLM model and F16 mmproj (vision projector)

**Performance (Pixel 10 Pro, CPU-only, Q4_K_M + F16 mmproj):**
- Image encode: ~30s (768x1024 image)
- Prompt eval: 26.6 t/s
- Generation: 4.14 t/s

**Usage Example:**

```js
const LlmLlamacpp = require('@qvac/llm-llamacpp')
const fs = require('bare-fs')
const path = require('bare-path')

const dirPath = path.resolve('./models')

const model = new LlmLlamacpp({
  files: {
    model: [path.join(dirPath, 'LightOnOCR-2-1B-ocr-soup-Q4_K_M.gguf')],
    projectionModel: path.join(dirPath, 'mmproj-F16.gguf')
  },
  config: {
    device: 'cpu',
    gpu_layers: '0',
    ctx_size: '4096',
    temp: '0.1',
    predict: '2048'
  },
  logger: console
})

await model.load()

const imageBytes = new Uint8Array(fs.readFileSync('./document.png'))

const messages = [
  { role: 'user', type: 'media', content: imageBytes },
  { role: 'user', content: 'Extract all text from this image and format it as markdown.' }
]

const response = await model.run(messages)
const output = []

response.onUpdate(token => {
  output.push(token)
})

await response.await()

console.log(output.join(''))

await model.unload()
```

### Unlimited-OCR

[Unlimited-OCR](https://huggingface.co/baidu/Unlimited-OCR) is a 3B OCR-specialized vision-language model (Apache 2.0), an advancement of DeepSeek-OCR. It parses full-page documents into text with layout regions (`<|det|>` boxes) and reconstructs tables as HTML — useful for invoices, forms, and scanned reports.

**Characteristics:**
- DeepEncoder vision tower (SAM ViT-B + CLIP-L) + DeepseekV2 MoE decoder
- Emits `<|det|>type [x0,y0,x1,y1]<|/det|>` layout regions and `<table>…</table>` structure
- Requires both the LLM model and the **F16** mmproj (keep the vision projector at F16 — quantizing it hurts OCR accuracy)
- Requires `qvac-fabric >= 9840` (ships the `deepseek2-ocr` engine + `deepseekocr` clip projector)
- **Prompt matters:** use `document parsing.` (layout + tables), `Multi page parsing.` (long docs), or `Free OCR. ` (plain text). A generic "extract the text" prompt yields near-empty output.

**Usage Example:**

```js
const LlmLlamacpp = require('@qvac/llm-llamacpp')
const fs = require('bare-fs')
const path = require('bare-path')

const dirPath = path.resolve('./models')

const model = new LlmLlamacpp({
  files: {
    model: [path.join(dirPath, 'unlimited-ocr-Q4_K_M.gguf')],
    projectionModel: path.join(dirPath, 'mmproj-unlimited-ocr-F16.gguf')
  },
  config: {
    device: 'cpu',
    gpu_layers: '0',
    ctx_size: '8192',
    temp: '0',
    predict: '2048'
  },
  logger: console
})

await model.load()

const imageBytes = new Uint8Array(fs.readFileSync('./document.png'))

const messages = [
  { role: 'user', type: 'media', content: imageBytes },
  { role: 'user', content: 'document parsing.' }
]

const response = await model.run(messages)
const output = []

response.onUpdate(token => {
  output.push(token)
})

await response.await()

console.log(output.join(''))

await model.unload()
```

## Architecture

See [docs/](./docs) for a detailed explanation of the architecture and data flow logic.


## Benchmarking

Comprehensive benchmarking suite for evaluating **@qvac/llm-llamacpp addon** (native C++ GGUF) on reasoning, comprehension, and knowledge tasks. Supports single-model evaluation and comparative analysis vs **HuggingFace Transformers** (Python).

**Supported Datasets:**
- **SQuAD** (Reading Comprehension) - F1 Score
- **ARC** (Scientific Reasoning) - Accuracy
- **MMLU** (Knowledge) - Accuracy
- **GSM8K** (Math Reasoning) - Accuracy

```bash
# Single model evaluation
npm run benchmarks -- \
  --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" \
  --samples 10

# Compare addon vs transformers
npm run benchmarks -- \
  --compare \
  --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" \
  --transformers-model "meta-llama/Llama-3.2-1B-Instruct" \
  --hf-token YOUR_TOKEN \
  --samples 10
```

**Platform Support**: Unix/Linux/macOS (bash), Windows (PowerShell, Git Bash)

**→ For detailed guide, see [benchmarks/README.md](./benchmarks/README.md)**

## Tests

Integration tests are located in [`test/integration/`](./test/integration/) and cover core functionality including model loading, inference, tool calling, multimodal capabilities, and configuration parameters.  
These tests help prevent regressions and ensure the library remains stable as contributions are made to the project.

Unit tests are located in [`test/unit/`](./test/unit/) and test the C++ addon components at a lower level, including backend selection, cache management, chat templates, context handling, and UTF8 token processing.  
These tests validate the native implementation and help catch issues early in development.

**C++ unit test models** live under `models/unit-test/` (resolved from the test binary via `../../../models/unit-test`). `npm run test:cpp:run` downloads missing files automatically (cross-platform Node script). To prefetch or refresh without running tests:

```bash
npm run test:cpp:models      # every fixture referenced by test/unit (includes
                             # the optional 8-shard Llama set that CI skips)
npm run test:cpp:models:ci   # exactly what .github/workflows/cpp-tests-llm.yml
                             # downloads; matches what CI exercises
```

First-run downloads pull several GB from Hugging Face. Every fixture is SHA256-verified against a digest pinned in `scripts/download-unit-test-models.js`; mismatched or partial files are re-downloaded automatically. Set `HF_TOKEN` if a repo requires authentication. Override paths with env vars such as `SHARDED_MODEL_FIRST_SHARD_PATH` (see `test/unit/test_common.hpp`).

## Glossary

• **Bare Runtime** – Small and modular JavaScript runtime for desktop and mobile. [Learn more](https://docs.pears.com/reference/bare-overview).

## License

This project is licensed under the Apache-2.0 [License](./LICENSE) – see the LICENSE file for details.

_For questions or issues, please open an issue on the GitHub repository._
