# qvac-lib-infer-llamacpp-llm


This native C++ addon, built using the `Bare` Runtime, simplifies running Large Language Models (LLMs) within QVAC runtime applications. It provides an easy interface to load, execute, and manage LLM instances.

## Table of Contents
- [Supported platforms](#supported-platforms)
- [Installation](#installation)
- [Building from Source](#building-from-source)
- [Usage](#usage)
  - [1. Import the Model Class](#1-import-the-model-class)
  - [2. Create a Data Loader](#2-create-a-data-loader)
  - [3. Create the `args` obj](#3-create-the-args-obj)
  - [4. Create the `config` obj](#4-create-the-config-obj)
  - [5. Create Model Instance](#5-create-model-instance)
  - [6. Load Model](#6-load-model)
  - [7. Run Inference](#7-run-inference)
  - [8. Release Resources](#8-release-resources)
- [API behavior by state](#api-behavior-by-state)
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
- qvac-lib-inference-addon-cpp (≥1.1.2): C++ addon framework (single-job runner)
- qvac-fabric-llm.cpp (≥7248.1.4): Inference engine
- Bare Runtime (≥1.24.0): JavaScript runtime
- Linux requires Clang/LLVM 19 with libc++

## Installation

### Prerequisites

Ensure that the Bare Runtime is installed globally on your system. If it's not already installed, you can install it using:

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
npm install @qvac/llm-llamacpp@latest
```

## Building from Source

See [build.md](./build.md) for detailed instructions on how to build the addon from source.

## Usage

### 1. Import the Model Class

```js
const LlmLlamacpp = require('@qvac/llm-llamacpp')
```

### 2. Create a Data Loader

Data Loaders abstract the way model files are accessed. Use a [`FileSystemDataLoader`](../qvac-lib-dl-filesystem) to load model files from your local file system. Models can be downloaded directly from HuggingFace.

```js
const FilesystemDL = require('@qvac/dl-filesystem')

// Download model from HuggingFace (see examples/utils.js for downloadModel helper)
const [modelName, dirPath] = await downloadModel(
  'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf',
  'Llama-3.2-1B-Instruct-Q4_0.gguf'
)

const fsDL = new FilesystemDL({ dirPath })
```

### 3. Create the `args` obj

```js
const args = {
  loader: fsDL,
  opts: { stats: true },
  logger: console,
  diskPath: dirPath,
  modelName,
  // projectionModel: 'mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf' // for multimodal support you need to pass the projection model name
}
```

The `args` obj contains the following properties:

* `loader`: The Data Loader instance from which the model file will be streamed.
* `logger`: This property is used to create a [`QvacLogger`](../logging) instance, which handles all logging functionality. 
* `opts.stats`: This flag determines whether to calculate inference stats.
* `diskPath`: The local directory where the model file will be downloaded to.
* `modelName`: The name of model file in the Data Loader.
* `projectionModel`: The name of the projection model file in the Data Loader. This is required for multimodal support.

### 4. Create the `config` obj

The `config` obj consists of a set of hyper-parameters which can be used to tweak the behaviour of the model.  
*All parameters must by strings.*

```js
// an example of possible configuration
const config = {
  gpu_layers: '99', // number of model layers offloaded to GPU.
  ctx_size: '1024', // context length
  device: 'cpu' // must be specified: 'gpu' or 'cpu' else it will throw an error
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
| no_mmap           | "" (passing empty string sets the flag)     | —                            | Disable memory mapping for model loading              |
| reverse_prompt    | string (comma-separated)                    | —                            | Stop generation when these strings are encountered    |
| repeat_penalty    | float                                       | 1.1                          | Repetition penalty                                    |
| presence_penalty  | float                                       | 0                            | Presence penalty for sampling                         |
| frequency_penalty | float                                       | 0                            | Frequency penalty for sampling                        |
| tools             | `"true"` or `"false"`                       | `"false"`                    | Enable tool calling with jinja templating             |
| verbosity         | 0 – 3 (0=ERROR, 1=WARNING, 2=INFO, 3=DEBUG) | 0                            | Logging verbosity level                               |
| n_discarded       | integer                                     | 0                            | Tokens to discard in sliding window context           |
| main-gpu          | integer, `"integrated"`, or `"dedicated"`   | —                            | GPU selection for multi-GPU systems                   |


#### IGPU/GPU  selection logic:

| Scenario                       | main-gpu not specified                | main-gpu: `"dedicated"`             | main-gpu: `"integrated"`           |
|---------------------------------|---------------------------------------|-------------------------------------|-------------------------------------|
| Devices considered              | All GPUs (dedicated + integrated)     | Only dedicated GPUs                 | Only integrated GPUs                |
| System with iGPU only           | ✅ Uses iGPU                          | ❌ Falls back to CPU                | ✅ Uses iGPU                        |
| System with dedicated GPU only  | ✅ Uses dedicated GPU                 | ✅ Uses dedicated GPU               | ❌ Falls back to CPU                |
| System with both                | ✅ Uses dedicated GPU (preferred)     | ✅ Uses dedicated GPU               | ✅ Uses integrated GPU              |


### 5. Create Model Instance

```js
const model = new LlmLlamacpp(args, config)
```

### 6. Load Model

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

### 7. Run Inference

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
| idle          | cancel         | **Allowed** — no-op (no job to cancel); Promise resolves      |
| run           | run            | **Throw** — second `run()` throws "a job is already set or being processed" (can wait very briefly for previous job completion) |
| run           | cancel         | **Allowed** — cancels current job; Promise resolves when job has stopped |

When `run()` is called while another job is active, the implementation first waits briefly for the previous job to settle. This preserves single-job behavior while still failing fast when the instance is busy. If the second run cannot be accepted (timeout or addon busy rejection), it throws:
- `"Cannot set new job: a job is already set or being processed"`

## Quickstart Example

Clone the repository and navigate to it:
```bash
cd qvac-lib-infer-llamacpp-llm
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

## OCR with Vision-Language Models

In addition to ONNX-based OCR (`@qvac/ocr-onnx`), you can use vision-language models through `@qvac/llm-llamacpp` for OCR tasks. This is useful for structured document understanding (tables, forms, multi-column layouts) where traditional OCR pipelines struggle.

### Supported OCR Models

| Model | Params | Quantization | Description |
|-------|--------|-------------|-------------|
| LightON OCR-2 1B | 0.6B (LLM) + ~550M (vision) | Q4_K_M | OCR-specialized, full-page transcription, 11 languages |
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
const FilesystemDL = require('@qvac/dl-filesystem')
const fs = require('bare-fs')

const dirPath = './models'
const loader = new FilesystemDL({ dirPath })

const model = new LlmLlamacpp({
  modelName: 'LightOnOCR-2-1B-ocr-soup-Q4_K_M.gguf',
  loader,
  logger: console,
  diskPath: dirPath,
  projectionModel: 'mmproj-F16.gguf'
}, {
  device: 'cpu',
  gpu_layers: '0',
  ctx_size: '4096',
  temp: '0.1',
  predict: '2048'
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
await loader.close()
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

## Glossary

• **Bare Runtime** – Small and modular JavaScript runtime for desktop and mobile. [Learn more](https://docs.pears.com/reference/bare-overview).

## License

This project is licensed under the Apache-2.0 [License](./LICENSE) – see the LICENSE file for details.

_For questions or issues, please open an issue on the GitHub repository._
