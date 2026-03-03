# qvac-lib-infer-llamacpp-embed

This native C++ addon, built using the `Bare` Runtime, simplifies running text embedding models to enable efficient generation of high-quality contextual text embeddings. It provides an easy interface to load, execute, and manage embedding model instances.

## Table of Contents

- [Supported platforms](#supported-platforms)
- [Installation](#installation)
- [Building from Source](#building-from-source)
- [Usage](#usage)
  - [1. Import the Model Class](#1-import-the-model-class)
  - [2. Create a Data Loader](#2-create-a-data-loader)
  - [3. Create the `args` obj](#3-create-the-args-obj)
  - [4. Create `config`](#4-create-config)
  - [5. Instanstiate the model](#5-instanstiate-the-model)
  - [6. Load the model](#6-load-the-model)
  - [7. Generate embeddings for input sequence](#7-generate-embeddings-for-input-sequence)
  - [8. Unload the model](#8-unload-the-model)
- [API behavior by state](#api-behavior-by-state)
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
| Linux | arm64, x64 | Ubuntu-22+ | ✅ Tier 1 | Vulkan |
| Android | arm64 | 12+ | ✅ Tier 1 | Vulkan, OpenCL (Adreno 700+) |
| Windows | x64 | 10+ | ✅ Tier 1 | Vulkan |

**Dependencies:**
- qvac-lib-inference-addon-cpp (≥1.1.2): C++ addon framework
- qvac-fabric-llm.cpp (≥7248.1.2): Inference engine
- Bare Runtime (≥1.24.0): JavaScript runtime
- Linux requires Clang/LLVM 19 with libc++


## Installation

### Prerequisites

Ensure that the `Bare` Runtime is installed globally on your system. If it's not already installed, you can install it using:

```bash
npm install -g bare@latest
```

Before proceeding with the installation, please generate a **granular Personal Access Token (PAT)** with the `read-only` scope. Once generated, add the token to your environment variables using the name `NPM_TOKEN`.

```bash
export NPM_TOKEN=your_personal_access_token
```

Next, create a `.npmrc` file in the root of your project with the following content:

```ini
@qvac:registry=https://registry.npmjs.org/
//registry.npmjs.org/:_authToken={NPM_TOKEN}
```

This configuration ensures secure access to NPM Packages when installing scoped packages.

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

### 2. Create a Data Loader

Data Loaders abstract the way model files are accessed. Use a [`FileSystemDataLoader`](../qvac-lib-dl-filesystem) to load model files from your local file system. Models can be downloaded directly from HuggingFace.

```js
const FilesystemDL = require('@qvac/dl-filesystem')

// Download model from HuggingFace (see examples/utils.js for downloadModel helper)
const [modelName, dirPath] = await downloadModel(
  'https://huggingface.co/ChristianAzinn/gte-large-gguf/resolve/main/gte-large_fp16.gguf',
  'gte-large_fp16.gguf'
)

const fsDL = new FilesystemDL({ dirPath })
```

### 3. Create the `args` obj

```js
const args = {
  loader: fsDL,
  logger: console,
  opts: { stats: true },
  diskPath: dirPath,
  modelName
}
```

The `args` obj contains the following properties:

* `loader`: The Data Loader instance from which the model file will be streamed.
* `logger`: This property is used to create a [`QvacLogger`](../logging) instance, which handles all logging functionality. 
* `opts.stats`: This flag determines whether to calculate inference stats.
* `diskPath`: The local directory where the model file will be downloaded to.
* `modelName`: The name of model file in the Data Loader.

### 4. Create `config`

The `config` is a dictionary (object) consisting of hyper-parameters which can be used to tweak the behaviour of the model.  
All parameter values should be strings.

```js
const config = {
  device: 'gpu',
  gpu_layers: '99',
  batch_size: '1024',
  ctx_size: '512'
}
```

| Parameter         | Range / Type                                | Default                      | Description                                           |
|-------------------|---------------------------------------------|------------------------------|-------------------------------------------------------|
| -dev    | `"gpu"` or `"cpu"`                          | `"gpu"`                      | Device to run inference on                            |
| -ngl | integer                                    | 0            | Number of model layers to offload to GPU              |
|--batch-size  | integer                                     | 2048                         | Tokens for processing multiple prompts together             |
| --pooling         | `{none,mean,cls,last,rank}`                 | model default                | Pooling type for embeddings                           |
| --attention       | `{causal,non-causal}`                       | model default                | Attention type for embeddings                         |
| --embd-normalize  | integer                                     | 2                            | Embedding normalization (-1=none, 0=max abs int16, 1=taxicab, 2=euclidean, >2=p-norm) |
| -fa               | `"on"`, `"off"`, or `"auto"`                | `"auto"`                     | Enable/disable flash attention                        |
| --main-gpu        | integer, `"integrated"`, or `"dedicated"`   | —                            | GPU selection for multi-GPU systems                   |
| verbosity         | 0 – 3 (0=ERROR, 1=WARNING, 2=INFO, 3=DEBUG) | 0                            | Logging verbosity level                               |

#### IGPU/GPU  selection logic:

| Scenario                       | main-gpu not specified                | main-gpu: `"dedicated"`             | main-gpu: `"integrated"`           |
|---------------------------------|---------------------------------------|-------------------------------------|-------------------------------------|
| Devices considered              | All GPUs (dedicated + integrated)     | Only dedicated GPUs                 | Only integrated GPUs                |
| System with iGPU only           | ✅ Uses iGPU                          | ❌ Falls back to CPU                | ✅ Uses iGPU                        |
| System with dedicated GPU only  | ✅ Uses dedicated GPU                 | ✅ Uses dedicated GPU               | ❌ Falls back to CPU                |
| System with both                | ✅ Uses dedicated GPU (preferred)     | ✅ Uses dedicated GPU               | ✅ Uses integrated GPU              |


### 5. Instantiate the model

```js
const model = new GGMLBert(args, config)
```

### 6. Load the model

```js
await model.load()
```

_Optionally_ you can pass the following parameters to tweak the loading behaviour.
* `close?`: This boolean value determines whether to close the Data Loader after loading. Defaults to `true`
* `reportProgressCallback?`: A callback function which gets called periodically with progress updates. It can be used to display overall progress percentage.

_For example:_

```js
await model.load(false, progress => process.stdout.write(`\rOverall Progress: ${progress.overallProgress}%`))
```

**Progress Callback Data**

The progress callback receives an object with the following properties:

| Property            | Type   | Description                             |
|---------------------|--------|-----------------------------------------|
| `action`            | string | Current operation being performed       |
| `totalSize`         | number | Total bytes to be loaded                |
| `totalFiles`        | number | Total number of files to process        |
| `filesProcessed`    | number | Number of files completed so far        |
| `currentFile`       | string | Name of file currently being processed  |
| `currentFileProgress` | string | Percentage progress on current file     |
| `overallProgress`   | string | Overall loading progress percentage     |

### 7. Generate embeddings for input sequence

The model outputs a vector for the input sequence.

```js
const query = 'Hello, can you suggest a game I can play with my 1 year old daughter?'
const response = await model.run(query)
const embeddings = await response.await()
```

### 8. Release Resources

Unload the model when finished:

```javascript
try {
  await model.unload()
  await fsDL.close()
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
| run           | run            | **Throw** — second `run()` throws "a job is already set or being processed" (can wait very briefly for previous job completion) |
| run           | cancel         | **Allowed** — cancels current job; Promise resolves when job has stopped      |

When `run()` is called while another job is active, the implementation first waits briefly for the previous job to settle. This preserves single-job behavior while still failing fast when the instance is busy. If the second run cannot be accepted (timeout or addon busy rejection), it throws:
- `"Cannot set new job: a job is already set or being processed"`

**Cancellation API:** Prefer cancelling from the model: `await model.cancel()`. This cancels the current job and the Promise resolves when the job has actually stopped (future-based in C++). You can also call `await response.cancel()` on the value returned by `run()`; it is equivalent and targets the same job. Both are no-op when idle.

## Quickstart Example

Clone the repository and navigate to it:
```bash
cd qvac-lib-infer-llamacpp-embed
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

Integration tests are located in [`test/integration/`](./test/integration/) and cover core functionality including model loading, inference, tool calling, multimodal capabilities, and configuration parameters.  
These tests help prevent regressions and ensure the library remains stable as contributions are made to the project.

Unit tests are located in [`test/unit/`](./test/unit/) and test the C++ addon components at a lower level, including backend selection, cache management, chat templates, context handling, and UTF8 token processing.  
These tests validate the native implementation and help catch issues early in development.

## Glossary

* **Bare Runtime** - Small and modular JavaScript runtime for desktop and mobile. [Learn more](https://docs.pears.com/reference/bare-overview).

## License

This project is licensed under the Apache-2.0 [License](./LICENSE) – see the LICENSE file for details.

_For questions or issues, please open an issue on the GitHub repository._

