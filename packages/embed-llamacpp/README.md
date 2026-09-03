# embed-llamacpp

This native C++ addon, built using the `Bare` Runtime, simplifies running text embedding models to enable efficient generation of high-quality contextual text embeddings. It provides an easy interface to load, execute, and manage embedding model instances.

## Table of Contents

- [Supported platforms](#supported-platforms)
- [Installation](#installation)
- [Building from Source](#building-from-source)
- [Usage](#usage)
  - [1. Import the Model Class](#1-import-the-model-class)
  - [2. Create the `args` obj](#2-create-the-args-obj)
  - [3. Create `config`](#3-create-config)
  - [4. Instanstiate the model](#4-instanstiate-the-model)
  - [5. Load the model](#5-load-the-model)
  - [6. Generate embeddings for input sequence](#6-generate-embeddings-for-input-sequence)
  - [7. Release Resources](#7-release-resources)
- [API behavior by state](#api-behavior-by-state)
- [IdMapIndex vector database](#idmapindex-vector-database)
- [Quickstart Example](#quickstart-example)
- [Other Examples](#other-examples)
- [Benchmarking](#benchmarking)
- [Tests](#tests)
- [Glossary](#glossary)
- [License](#license)

## Supported platforms

| Platform | Architecture | Min Version | Status | GPU Support |
|----------|-------------|-------------|--------|-------------|
| macOS | arm64, x64 | 14.0+ | ✅ Tier 1 | Metal |
| iOS | arm64 | 17.0+ | ✅ Tier 1 | Metal |
| Linux | arm64, x64 | Ubuntu-22+ | ✅ Tier 1 | CUDA (NVIDIA), Vulkan |
| Android | arm64 | 12+ | ✅ Tier 1 | Vulkan, OpenCL (Adreno 700+) |
| Windows | x64 | 10+ | ✅ Tier 1 | Vulkan |

**Note on CUDA (Linux, NVIDIA):**
On Linux the CUDA backend ships as a dynamically loaded module alongside Vulkan, and is preferred
over Vulkan when an NVIDIA device is present. Windows is Vulkan-only because it has no dynamic
backend loading.

- If the CUDA module or the NVIDIA driver is missing, the device never registers and selection
  falls through to Vulkan, then CPU. Nothing needs configuring for that.
- `backend: "vulkan"` forces Vulkan on an NVIDIA machine. Setting `CUDA_VISIBLE_DEVICES=-1` in the
  environment has the same effect without touching the load config.
- `main-gpu` as an integer indexes ggml's full device list, so adding CUDA shifts the indices an
  existing config was written against.

**Dependencies:**
- inference-addon-cpp (≥1.1.2): C++ addon framework
- qvac-fabric-llm.cpp (≥7248.2.3): Inference engine
- Bare Runtime (≥1.24.0): JavaScript runtime
- Linux requires Clang/LLVM 22 with libc++


## Installation

### Prerequisites

Ensure that the `Bare` Runtime is installed globally on your system. If it's not already installed, you can install it using:

```bash
npm install -g bare@latest
```

### Installing the Package

```bash
npm install @qvac/embed-llamacpp@latest
```

## Building from Source

See [build.md](./build.md) for detailed instructions on how to build the addon from source.

## Usage

### 1. Import the Model Class

```js
const GGMLBert = require('@qvac/embed-llamacpp')
```

### 2. Create the `args` obj

```js
const path = require('bare-path')

const args = {
  files: { model: [path.join(dirPath, modelName)] },
  config: {
    device: 'gpu',
    gpu_layers: '99',
    batch_size: '1024',
    ctx_size: '512'
  },
  logger: console,
  opts: { stats: true }
}
```

The `args` obj contains the following properties:

* `files.model`: An array of absolute paths to the model file(s) on disk. For sharded models, provide all shard paths.
* `config`: A dictionary of hyper-parameters used to tweak the behaviour of the model (see [Create `config`](#3-create-config) below).
* `logger`: This property is used to create a [`QvacLogger`](../logging) instance, which handles all logging functionality.
* `opts.stats`: This flag determines whether to calculate inference stats.

#### Sharded model usage

The addon does not discover companion files on disk — the caller MUST pass every file the model needs, in order, via `files.model`. For sharded GGUF models this includes the `.tensors.txt` companion file followed by each `.gguf` shard in numerical order.

```js
const path = require('bare-path')

const dir = '/path/to/models'
const model = new GGMLBert({
  files: {
    model: [
      path.join(dir, 'gte-large.Q2_K.tensors.txt'),
      path.join(dir, 'gte-large.Q2_K-00001-of-00005.gguf'),
      path.join(dir, 'gte-large.Q2_K-00002-of-00005.gguf'),
      path.join(dir, 'gte-large.Q2_K-00003-of-00005.gguf'),
      path.join(dir, 'gte-large.Q2_K-00004-of-00005.gguf'),
      path.join(dir, 'gte-large.Q2_K-00005-of-00005.gguf')
    ]
  },
  config: { device: 'gpu', gpu_layers: '99' },
  logger: console,
  opts: { stats: true }
})
```

Rules for the `files.model` array:

* **Order matters.** The `.tensors.txt` file must come first, then shards in ascending numerical order (`00001-of-00005`, `00002-of-00005`, ...).
* **All shards are required.** Missing any shard or the `.tensors.txt` companion will fail loading.
* **Non-sharded models** pass a single absolute path: `files: { model: [modelPath] }`.
* **Absolute paths only.** The addon reads each file directly via `bare-fs` during `load()`.

### 3. Create `config`

The `config` is a plain JS object whose keys are forwarded directly to the native backend. All values must be strings (the native layer parses them with `getSubmap`).

| Key              | Range / Type                                  | Default       | Description                                                                              |
|------------------|-----------------------------------------------|---------------|------------------------------------------------------------------------------------------|
| `device`         | `"gpu"` \| `"cpu"`                            | `"gpu"`       | Device to run inference on                                                               |
| `gpu_layers`     | string of integer                             | `"0"`         | Number of model layers to offload to GPU                                                 |
| `batch_size`     | string of integer                             | `"2048"`      | Tokens processed per batch (input throughput)                                            |
| `ctx_size`       | string of integer                             | model's trained context size (`n_ctx_train`) | Runtime context window in tokens (llama.cpp `n_ctx`); oversized values are capped to the model's trained context |
| `pooling`        | `"none"` \| `"mean"` \| `"cls"` \| `"last"` \| `"rank"` | model default | Pooling strategy used to collapse token embeddings into a single sequence vector        |
| `attention`      | `"causal"` \| `"non-causal"`                  | model default | Attention type                                                                            |
| `embd_normalize` | string of integer                             | `"2"`         | Embedding normalization (`-1` = none, `0` = max abs int16, `1` = taxicab, `2` = euclidean, `>2` = p-norm) |
| `flash_attn`     | `"on"` \| `"off"` \| `"auto"`                 | `"auto"`      | Enable / disable flash attention                                                         |
| `main-gpu`       | string of integer \| `"integrated"` \| `"dedicated"` | —      | GPU selection for multi-GPU systems                                                      |
| `backend`        | comma-separated list of `cuda`, `vulkan`, `metal`, `opencl`, `hip`, `rocm`, `sycl`, or `auto` | — | Overrides which GPU backend is used, in priority order (e.g. `"cuda,vulkan"`). `auto` means no preference. An unrecognised name is rejected; a recognised one with no device present is skipped. Use `device: "cpu"` to run on CPU |
| `verbosity`      | string of `"0"`–`"3"` (0=ERROR, 1=WARNING, 2=INFO, 3=DEBUG) | `"0"` | Native logging verbosity. The `addonLogging.setLogger` callback receives only messages at or above this threshold. Use `"2"` for llama.cpp INFO logs and `"3"` for DEBUG logs. The verbosity level is process-global and is updated each time a model is constructed, so the most recently constructed model's `config.verbosity` wins for all subsequent native log dispatch. |

#### Native addon logging

`@qvac/embed-llamacpp/addonLogging` exposes the native C++ logger:

```js
const { setLogger, releaseLogger } = require('@qvac/embed-llamacpp/addonLogging')

setLogger((priority, message) => {
  console.log(priority, message)
})
```

The callback is wired before model load, but it still follows `config.verbosity`.
With the default `"0"` setting, only native `ERROR` messages are delivered. Set
`config.verbosity` to `"2"` to receive llama.cpp `INFO` diagnostics, or `"3"` for
`DEBUG` messages. The verbosity level is process-global and is updated each
time a model is constructed, so when multiple models are loaded the most
recently constructed model's `config.verbosity` wins for all subsequent
native log dispatch. Some startup diagnostics printed directly by llama.cpp
may still appear on `stderr` before the addon installs its callback.

#### IGPU/GPU  selection logic:

| Scenario                       | main-gpu not specified                | main-gpu: `"dedicated"`             | main-gpu: `"integrated"`           |
|---------------------------------|---------------------------------------|-------------------------------------|-------------------------------------|
| Devices considered              | All GPUs (dedicated + integrated)     | Only dedicated GPUs                 | Only integrated GPUs                |
| System with iGPU only           | ✅ Uses iGPU                          | ❌ Falls back to CPU                | ✅ Uses iGPU                        |
| System with dedicated GPU only  | ✅ Uses dedicated GPU                 | ✅ Uses dedicated GPU               | ❌ Falls back to CPU                |
| System with both                | ✅ Uses dedicated GPU (preferred)     | ✅ Uses dedicated GPU               | ✅ Uses integrated GPU              |


### 4. Instantiate the model

```js
const model = new GGMLBert(args)
```

### 5. Load the model

```js
await model.load()
```

`load()` takes no arguments. The addon streams each file listed in `files.model` directly from disk via `bare-fs` and then activates the model. There is no data loader, no progress callback, and no download step — the caller is responsible for ensuring the files already exist at the paths passed to the constructor.

### 6. Generate embeddings for input sequence

The model outputs a vector for the input sequence.

```js
const query = 'Hello, can you suggest a game I can play with my 1 year old daughter?'
const response = await model.run(query)
const embeddings = await response.await()
```

When `opts.stats` is enabled, `response.stats` includes runtime metrics such as `total_tokens`, `total_time_ms`, `tokens_per_second`, `context_size`, `trained_context_size`, and `backendDevice` (`"cpu"` or `"gpu"`). `context_size` is the active runtime llama context size, while `trained_context_size` is the model's trained context size. `backendDevice` reflects the resolved device used at runtime after backend selection/fallback logic, not only the requested config.

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

The following table describes the expected behavior of `run` and `cancel` depending on the current state (idle vs a job running). `cancel` can be called on the model (`model.cancel()`) or on the response (`response.cancel()`); both target the same underlying job.

| Current state | Action called | What happens |
|---------------|----------------|----------------------------------------------------------------|
| idle          | run            | **Allowed** — starts inference, returns `QvacResponse`        |
| idle          | cancel         | **Allowed** — no-op (no job to cancel); Promise resolves       |
| run           | run            | **Throw** — second `run()` throws `"Cannot set new job: a job is already set or being processed"` once it reaches the head of the queue; previous response must settle first. |
| run           | cancel         | **Allowed** — cancels current job; Promise resolves when job has stopped      |

A second `run()` while a job is active is serialized by `exclusiveRunQueue` — it waits in the queue until the previous `_runInternal` returns, then enters the busy guard. Because the busy flag (`_hasActiveResponse`) is only cleared when the previous `response.await()` settles, the second call rejects with `"Cannot set new job: a job is already set or being processed"`. The queue eliminates race conditions but does not retry or buffer results; callers must wait for the previous `response.await()` to settle (or call `model.cancel()`) before issuing the next request.

**Cancellation API:** Prefer cancelling from the model: `await model.cancel()`. This cancels the current job and the Promise resolves when the job has actually stopped (future-based in C++). You can also call `await response.cancel()` on the value returned by `run()`; it is equivalent and targets the same job. Both are no-op when idle.

## IdMapIndex vector database

`IdMapIndex` is a synchronous CPU vector index with stable unsigned 64-bit IDs. Vector-only consumers should use the subpath export so importing the index does not load the embedding-model runtime:

```javascript
const IdMapIndex = require('@qvac/embed-llamacpp/idMapIndex')

const index = new IdMapIndex({ dim: 768, storage: 'turbovec-q4' })
try {
  index.addWithIds(vectors, new BigUint64Array([1n, 2n]))
  index.prepare()
  const { ids, scores } = index.search(query, 2)
} finally {
  index.dispose()
}
```

`vectors` contains row-major `Float32Array` data with one `dim`-sized row per ID. Queries use the same layout and may contain multiple rows. Search uses dot-product similarity; L2-normalize indexed vectors and queries first when cosine similarity is required. Results are ordered by descending score and then ascending ID.

### Storage modes

| Storage | Effective bits | Snapshot | Mmap | Delta log |
|---------|---------------:|----------|------|-----------|
| `f32` | 32 | v2 | Yes | Yes |
| `q8` | 8 | v2 | Yes | Yes |
| `q4` | 4 | v2 | Yes | Yes |
| `turbovec-q4` | 4 | v3 | No | No |
| `turbovec-q2` | 2 | v3 | No | No |

The default storage is `q8`. `bitWidth: 2` selects `turbovec-q2`, while `bitWidth: 4` selects generic `q4`; use `storage: 'turbovec-q4'` explicitly for TurboVec Q4.

TurboVec requires a 64-bit target and dimensions divisible by 8 and no greater than 1,024. It provides approximate rotated/quantized dot-product search. TurboVec snapshots support `write()` and `load()`, but reject mmap loading, delta-log loading, logged mutations, and delta compaction.

### Operations and lifecycle

- `addWithIds()`, `remove()`, `contains()`, and `compact()` mutate or inspect the index.
- `search()`, `searchFiltered()`, and `prepareFilter()` perform full-scan retrieval.
- `buildIvf()` enables approximate `searchIvf()` retrieval. IVF state is in-memory only and must be rebuilt after a mutation or snapshot load.
- `write()` and `load()` persist all storage modes. Generic `f32`, `q8`, and `q4` additionally support `loadMmap()`, `loadWithDelta()`, `addLogged()`, `removeLogged()`, and `compactDelta()`.
- Mutations invalidate prepared filters and IVF state.
- Call `dispose()` on indexes and prepared filters when finished. Disposal is idempotent.

See [RAG with TurboVec](./examples/ragWithTurboVec.js) for an end-to-end embedding and retrieval example.

## Quickstart Example

Clone the repository and navigate to it:
```bash
cd embed-llamacpp
```

Install dependencies:
```bash
npm install
```

Run the quickstart example (uses examples/quickstart.js):
```bash
npm run quickstart
```

## Other Examples

- [Batch Inference](./examples/batchInference.js) – Demonstrates running multiple prompts at once using batch inference.
- [Native Logging](./examples/nativelog.js) – Demonstrates C++ addon logging integration.
- [RAG with TurboVec](./examples/ragWithTurboVec.js) – Embeds document chunks, retrieves relevant context with `IdMapIndex`, and prepares it for an LLM.

Run the TurboVec RAG retrieval example on a 64-bit desktop:
```bash
bare examples/ragWithTurboVec.js
```

## Benchmarking

We conduct rigorous benchmarking of our embedding models to evaluate their retrieval effectiveness and computational efficiency across diverse tasks and datasets. Our evaluation framework incorporates standard information retrieval metrics and system performance indicators to provide a holistic view of model quality.

### Running Benchmarks

For instructions on running benchmarks yourself, see the [Benchmark Runner Documentation](./benchmarks/README.md).

The benchmarking covers:

* **Retrieval Quality**:

  * **nDCG\@k**: Quality of ranked results based on relevance and position
  * **MRR\@k**: Position of the first relevant result per query
  * **Recall\@k**: Coverage of relevant results in the top *k*
  * **Precision\@k**: Proportion of top *k* results that are relevant

Results are continuously updated with new releases to ensure up-to-date performance insights.

## Tests

Integration tests are located in [`test/integration/`](./test/integration/) and cover core embed functionality: single-file model load → embed → unload, multi-instance concurrency (two embed instances running simultaneously, repeated load/unload cycles, unloading one instance while another processes), and the public `run()` / `cancel()` lifecycle. These tests help prevent regressions and ensure the library remains stable as contributions are made to the project.

C++ unit tests live under [`addon/test/`](./addon/test/) and exercise the native components at a lower level, including backend selection, single-step inference, end-to-end embedding generation, and pooling. These tests validate the native implementation and help catch issues early in development.

> **Note:** This package is *embeddings only*. There is no tool-calling, multimodal, KV-cache, or chat-template support — those features belong to the LLM addon ([`@qvac/llm-llamacpp`](../llm-llamacpp/)).

## Glossary

* **Bare Runtime** - Small and modular JavaScript runtime for desktop and mobile. [Learn more](https://docs.pears.com/reference/bare-overview).

## License

This project is licensed under the Apache-2.0 [License](./LICENSE) – see the LICENSE file for details.

_For questions or issues, please open an issue on the GitHub repository._
