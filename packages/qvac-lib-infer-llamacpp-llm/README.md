# qvac-lib-infer-llamacpp-llm

This library simplifies running Large Language Models (LLMs) within QVAC runtime applications. It provides an easy interface to load, execute, and manage LLM instances, supporting multiple data sources (called data loaders).

## Table of Contents

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
- [Quickstart Example](#quickstart-example)
- [Model Registry](#model-registry)
- [Other Examples](#other-examples)
- [Benchmarking](#benchmarking)
- [Tests](#tests)
- [Glossary](#glossary)
- [License](#license)

## Installation

### Prerequisites

Install [Bare](#glossary) Runtime:
```bash
npm install -g bare-runtime
```
Note : Make sure the Bare version is `>= 1.19.0`. Check this using : 

```bash
bare -v
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

Check the [Model registry](#model-registry) for the list of supported models.

Install the desired Llama model package (adjust name for model/quantization):
```bash
npm install @qvac/llm-llamacpp@latest
```
Or install a specific known stable version:
```bash
npm install @qvac/llm-llamacpp@0.6.0
```

## Building from Source

See [build.md](./build.md) for detailed instructions on how to build the addon from source.

## Usage

### 1. Import the Model Class

```js
const LlmLlamacpp = require('@qvac/llm-llamacpp')
```

### 2. Create a Data Loader

Data Loaders abstract the way model files are accessed. It is recommended to utilize a [`HyperdriveDataLoader`](https://github.com/tetherto/qvac-lib-dl-hyperdrive) to stream the model file(s) from a `hyperdrive`. Optionally, you could use a [`FileSystemDataLoader`](https://github.com/tetherto/qvac-lib-dl-filesystem) to stream the model file(s) from your local file system.

```js
const store = new Corestore('./store')
const hdStore = store.namespace('hd')

const hdDL = new HyperDriveDL({
  key: 'hd://afa79ee07c0a138bb9f11bfaee771fb1bdfca8c82d961cff0474e49827bd1de3',
  store: hdStore
})
```

### 3. Create the `args` obj

```js
const args = {
  loader: hdDL,
  opts: { stats: true },
  logger: console,
  diskPath: './models',
  modelName: 'SmolVLM2-500M-Video-Instruct-Q8_0.gguf',
  // projectionModel: 'mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf' // for multimodal support you need to pass the projection model name
}
```

The `args` obj contains the following properties:

* `loader`: The Data Loader instance from which the model file will be streamed.
* `logger`: This property is used to create a [`QvacLogger`](https://github.com/tetherto/qvac-lib-logging) instance, which handles all logging functionality. 
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
| system_prompt     | string                                      | —                            | System prompt to prepend to conversations             |
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
  // Close P2P resources if applicable
} catch (error) {
  console.error('Failed to unload model:', error)
}
```

## Quickstart Example

Follow these simple steps to run the Quickstart demo using the Hyperdrive loader:

### 0. Install Bare

```bash
npm install -g bare
```

### 1. Create a new Project

```bash
mkdir qvac-llm-quickstart
cd qvac-llm-quickstart
npm init -y
```

### 2. Install Dependencies

```bash
npm install hyperswarm corestore @qvac/dl-hyperdrive @qvac/llm-llamacpp bare-process
```

### 3. Copy Quickstart code into `index.js`
```js
'use strict'

const Corestore = require('corestore')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const LlmLlamacpp = require('../index')
const process = require('bare-process')

async function main () {
  console.log('Quickstart Example: Basic model loading and inference demonstration')
  console.log('===================================================================')

  // 1. Initializing data loader
  const store = new Corestore('./store')
  const hdStore = store.namespace('hd')

  const hdKey = 'afa79ee07c0a138bb9f11bfaee771fb1bdfca8c82d961cff0474e49827bd1de3'
  const hdDL = new HyperDriveDL({
    key: `hd://${hdKey}`,
    store: hdStore
  })

  // 2. Configuring model settings
  const args = {
    loader: hdDL,
    opts: { stats: true },
    logger: console,
    modelName: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
    diskPath: './models'
  }

  const config = {
    device: 'gpu',
    gpu_layers: '999',
    ctx_size: '1024'
  }

  // 3. Loading model
  await hdDL.ready()
  const model = new LlmLlamacpp(args, config)
  const closeLoader = true
  let totalProgress = 0
  const reportProgressCallback = (report) => {
    if (typeof report === 'object' && Number(report.overallProgress) > totalProgress) {
      process.stdout.write(
        `\r${report.overallProgress}%: ${report.action} [${report.filesProcessed}/${report.totalFiles}] ${report.currentFileProgress}% ${report.currentFile}`
      )
      if (Number(report.currentFileProgress) === 100) {
        process.stdout.write('\n')
      }
      totalProgress = Number(report.overallProgress)
    }
  }
  await model.load(closeLoader, reportProgressCallback)

  try {
    // 4. Running inference with conversation prompt
    const prompt = [
      {
        role: 'system',
        content: 'You are a helpful, respectful and honest assistant.'
      },
      {
        role: 'user',
        content: 'what is bitcoin?'
      },
      {
        role: 'assistant',
        content: "It's a digital currency."
      },
      {
        role: 'user',
        content: 'Can you elaborate on the previous topic?'
      }
    ]

    const response = await model.run(prompt)
    let fullResponse = ''

    await response
      .onUpdate(data => {
        process.stdout.write(data)
        fullResponse += data
      })
      .await()

    console.log('\n')
    console.log('Full response:\n', fullResponse)
    console.log(`Inference stats: ${JSON.stringify(response.stats)}`)
  } finally {
    // 5. Cleaning up resources
    await store.close()
    await hdDL.close()
    await model.unload()
  }
}

main().catch(error => {
  console.error('Fatal error in main function:', {
    error: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString()
  })
  process.exit(1)
})
```

### 4. Run `index.js`

```bash
bare index.js
```


## Model registry

In the QVAC ecosystem, a model registry is simply a Hyperbee that stores Hyperdrive keys as its values. Each of these keys points to a Hyperdrive containing the `.gguf` files for a specific model. The Hyperbee key for the model registry is `7504626aaa534ac55d91b4b3067504774ae1457b03ddfbd86d817dd8cfbca8c8`.

| Key (The key inside the hyperbee)                               | Value (Hyperdrive Key)                                           | `.gguf` File Name                                                                    |
| --------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| generation:llama-ggml:instruct:3.2:1B:q4_0:1.0.0                | afa79ee07c0a138bb9f11bfaee771fb1bdfca8c82d961cff0474e49827bd1de3 | Llama-3.2-1B-Instruct-Q4_0.gguf                                                      |
| generation:qwen3:instruct::600M:q4:1.0.0                        | 211874c9885f6b88b9926904420e365f5e74e1b6ac47207b7536408539bef4b7 | Qwen3-0.6B-Q4_0.gguf                                                                 |
| generation:qwen:instruct:3:1.7B:q4:1.0.0                        | 05d3d7ad9cd650f53c28f85e312ef09a645dd487845897958b3be8a19cb3aab9 | Qwen3-1.7B-Q4_0.gguf                                                                 |
| generation:smolVLM2:multimodal:2:500M:q8_0:1.0.0:video-instruct | 73b1bc01d01e25fa27be7d7f434337d14f054b0315e8463766ca31e778ac6576 | SmolVLM2-500M-Video-Instruct-Q8_0.gguf+mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf |
| generation:salamandrata:instruct::2B:q4:1.0.0                   | 1610d81772a9e7c37660666dbdfdcef915b6b83c522ea1ad31c19cab0075811d | salamandrata_2b_inst_q4.gguf                                                         |
| generation:medgemma:it::4B:q4_1:1.0.0:shard                     | 1839dcabe1df8fdf1c83cd3d7a306c6e01e3c67e8542b0dd1e78cdfc86e75e2d | medgemma-4b-it-Q4_1-00001-of-00005.gguf                                              |


## Other examples

-   [SalamandraTA](examples/salamandraTA.js) – Demonstrates SalamandraTA model usage.
-   [Multimodal](examples/multiModal.js) – Demonstrates how to run multimodal inference.
-   [Multi-Cache](examples/multiCache.js) – Demonstrates session handling and caching capabilities.
-   [Native Logging](examples/nativeLog.js) – Demonstrates C++ addon logging integration.
-   [FileSystem](examples/filesystem.js) – Demonstrates loading a model from the local filesystem using @qvac/dl-filesystem.
-   [Sharded Loading](examples/shardedLoading.js) – Demonstrates loading sharded model files.
-   [Tool Calling](examples/toolCalling.js) – Demonstrates tool calling capabilities.

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

# P2P Hyperdrive models
npm run benchmarks -- \
  --gguf-model "hd://key/model.gguf" \
  --samples 10
```

**Platform Support**: Unix/Linux/macOS (bash), Windows (PowerShell, Git Bash)

**→ For detailed guide, see [benchmarks/README.md](benchmarks/README.md)**

## Tests

Integration tests are located in [`test/integration/`](test/integration/) and cover core functionality including model loading, inference, tool calling, multimodal capabilities, and configuration parameters.  
These tests help prevent regressions and ensure the library remains stable as contributions are made to the project.

Unit tests are located in [`test/unit/`](test/unit/) and test the C++ addon components at a lower level, including backend selection, cache management, chat templates, context handling, and UTF8 token processing.  
These tests validate the native implementation and help catch issues early in development.

## Glossary

• **Bare Runtime** – Small and modular JavaScript runtime for desktop and mobile. [Learn more](https://docs.pears.com/reference/bare-overview).  
• **QVAC** – QVAC is our open-source AI-SDK for building decentralized AI applications. [Learn more](https://qvac.tether.io/).  
• **Hyperdrive** – Hyperdrive is a secure, real-time distributed file system designed for easy P2P file sharing. [Learn more](https://docs.pears.com/building-blocks/hyperdrive).  
• **Hyperbee** – A decentralized B-tree built on top of Hypercores, and exposes a key-value API to store values. [Learn more](https://docs.pears.com/building-blocks/hyperbee).  
• **Corestore** – Corestore is a Hypercore factory that makes it easier to manage large collections of named Hypercores. [Learn more](https://docs.pears.com/helpers/corestore).

## License

This project is licensed under the Apache-2.0 [License](./LICENSE) – see the LICENSE file for details.

_For questions or issues, please open an issue on the GitHub repository._
