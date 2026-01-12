# qvac-lib-infer-llamacpp-embed

This native C++ addon, built using the `Bare` Runtime, implements the BERT GTE-Large (355M) model to enable efficient generation of high-quality contextual text embeddings. It supports a range of NLP tasks, including semantic similarity, text classification, and information retrieval.

## Table of Contents

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
- [Quickstart example](#quickstart-example)
- [Benchmarking](#benchmarking)
- [Tests](#tests)
- [Glossary](#glossary)
- [License](#license)

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

Data Loaders abstract the way model files are accessed. It is recommended to utilize a [`HyperdriveDataLoader`](https://github.com/tetherto/qvac-lib-dl-hyperdrive) to stream the model file(s) from a `hyperdrive`. Optionally, you could use a [`FileSystemDataLoader`](https://github.com/tetherto/qvac-lib-dl-filesystem) to stream the model file(s) from your local file system.

```js
const store = new Corestore('./store')
const hdStore = store.namespace('hd')

const hdDL = new HyperDriveDL({
  key: 'hd://d1896d9259692818df95bd2480e90c2d057688a4f7c9b1ae13ac7f5ee379d03e',
  store: hdStore
})
```

### 3. Create the `args` obj

```js
const args = {
  loader: hdDL,
  logger: console,
  opts: { stats: true },
  diskPath: './models',
  modelName: 'gte-large_fp16.gguf'
}
```

The `args` obj contains the following properties:

* `loader`: The Data Loader instance from which the model file will be streamed.
* `logger`: This property is used to create a [`QvacLogger`](https://github.com/tetherto/qvac-lib-logging) instance, which handles all logging functionality. 
* `opts.stats`: This flag determines whether to calculate inference stats.
* `diskPath`: The local directory where the model file will be downloaded to.
* `modelName`: The name of model file in the Data Loader.

### 4. Create `config`

```js
const config = '-ngl\t25'
```

### 5. Instanstiate the model

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


### 7. Generate embeddings for input sequence

The model outputs a sequence of vectors, one for each token in the input sequence.

```js
const query = 'Hello, can you suggest a game I can play with my 1 year old daughter?'
const response = await model.run(query)
const embeddings = await response.await()
```

### 8. Unload the model

Unloads the model after inference, to free up resources.

```js
await model.unload()
```

## Quickstart example

```js
'use strict'

const Corestore = require('corestore')
const HyperDriveDL = require('@qvac/dl-hyperdrive')
const GGMLBert = require('../index.js')
const process = require('bare-process')

async function main () {
  console.log('Quickstart Example: Basic model loading and inference demonstration')
  console.log('===================================================================')

  // 1. Initializing data loader
  const store = new Corestore('./store')
  const hdStore = store.namespace('hd')

  const hdKey = 'd1896d9259692818df95bd2480e90c2d057688a4f7c9b1ae13ac7f5ee379d03e'
  const hdDL = new HyperDriveDL({
    key: `hd://${hdKey}`,
    store: hdStore
  })

  // 2. Configuring model settings
  const args = {
    loader: hdDL,
    logger: console,
    opts: { stats: true },
    diskPath: './models',
    modelName: 'gte-large_fp16.gguf'
  }
  const config = '-ngl\t25'

  // 3. Loading model
  await hdDL.ready()
  const model = new GGMLBert(args, config)
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
    // 4. Generating embeddings
    const query = "Hello, can you suggest a game I can play with my 1 year old daughter?"
    const response = await model.run(query)
    const embeddings = await response.await()

    console.log('Embeddings shape:', embeddings.length, 'x', embeddings[0].length)
    console.log('First few values of first embedding:')
    console.log(embeddings[0].slice(0, 5))
  } catch (error) {
    const errorMessage = error?.message || error?.toString() || String(error)
    console.error('Error occurred:', errorMessage)
    console.error('Error details:', error)
  } finally {
    // 5. Cleaning up resources
    await model.unload()
    await hdDL.close()
    await store.close()
  }
}

main().catch(console.error)
```

## Benchmarking

We conduct rigorous benchmarking of our embedding models to evaluate their retrieval effectiveness and computational efficiency across diverse tasks and datasets. Our evaluation framework incorporates standard information retrieval metrics and system performance indicators to provide a holistic view of model quality.

### Benchmark Results

For detailed benchmark results see our [Embedding Benchmark Results Summary](./benchmarks/results/results_summary.md).

The benchmarking covers:

* **Retrieval Quality**:

  * **nDCG\@k**: Quality of ranked results based on relevance and position
  * **MRR\@k**: Position of the first relevant result per query
  * **Recall\@k**: Coverage of relevant results in the top *k*
  * **Precision\@k**: Proportion of top *k* results that are relevant

Results are continuously updated with new releases to ensure up-to-date performance insights.

## Tests

Integration tests are located in [`test/integration/`](test/integration/) and cover core functionality including model loading, inference, tool calling, multimodal capabilities, and configuration parameters.  
These tests help prevent regressions and ensure the library remains stable as contributions are made to the project.

Unit tests are located in [`test/unit/`](test/unit/) and test the C++ addon components at a lower level, including backend selection, cache management, chat templates, context handling, and UTF8 token processing.  
These tests validate the native implementation and help catch issues early in development.

## Glossary

* **Bare Runtime** - Small and modular JavaScript runtime for desktop and mobile. [Learn more](https://docs.pears.com/reference/bare-overview). 
* **BERT GTE‑Large (355M)** - A BERT‑based general text embedding model with 1024‑dimensional embeddings (~355 M parameters). [See on HuggingFace](https://huggingface.co/thenlper/gte-large).
* **CoreStore** - A manager for multiple Hypercores, handling storage, replication, and key derivation. Simplifies working with many Hypercores in peer-to-peer applications. [Learn more](https://docs.pears.com/helpers/corestore).
* **Hyperdrive** - A peer-to-peer filesystem built on Hypercore, supporting real-time file sharing, versioning, and sparse downloading. Ideal for decentralized apps and data syncing. [Learn more](https://docs.pears.com/building-blocks/hyperdrive).
* **DataLoader** - Provides a common interface for loading data from various sources.
* **HyperdriveDataLoader** - A data loading library designed to load model weights and other resources from a `Hyperdrive` instance. [See on Github](https://github.com/tetherto/qvac-lib-dl-hyperdrive).
* **FileSystemDataLoader** - A data loading library designed to load model weights and other resources from a local filesystem.  [See on Github](https://github.com/tetherto/qvac-lib-dl-filesystem).

## License

This project is licensed under the Apache-2.0 [License](./LICENSE) – see the LICENSE file for details.

_For questions or issues, please open an issue on the GitHub repository._
