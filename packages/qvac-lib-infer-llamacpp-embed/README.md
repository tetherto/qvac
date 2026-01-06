# qvac-lib-infer-llamacpp-embed

This native C++ addon, built using the `Bare` Runtime, implements the BERT GTE-Large (355M) model to enable efficient generation of high-quality contextual text embeddings. It supports a range of NLP tasks, including semantic similarity, text classification, and information retrieval.

## Table of Contents

- [Installation](#installation)
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
- [Additional Documents](#additional-documents)
- [Glossary](#glossary)
- [Resources](#resources)

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
  diskPath: './models/',
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
const embeddings = await resposne.await()
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

// 1. Import the Model Class
const GGMLBert = require('@qvac/embed-llamacpp')

async function main () {
  const store = new Corestore('./store')

  // 2. Create a Data Loader
  const hdStore = store.namespace('hd')
  const hdDL = new HyperDriveDL({
    key: 'hd://d1896d9259692818df95bd2480e90c2d057688a4f7c9b1ae13ac7f5ee379d03e',
    store: hdStore
  })

  // 3. Create the args obj
  const args = {
    loader: hdDL,
    logger: console,
    opts: { stats: true },
    diskPath: './models/',
    modelName: 'gte-large_fp16.gguf'
  }

  // 4. Create config
  const config = '-ngl\t25'

  // 5. Instanstiate the model
  const model = new GGMLBert(args, config)

  // 6. Load the model
  await model.load()

  try {
    const query =
      'Hello, can you suggest a game I can play with my 1 year old daughter?'

  // 7. Generate embeddings for input sequence
  const response = await model.run(query)
  const embeddings = await resposne.await()
  console.log('Embeddings shape:', embeddings.length, 'x', embeddings[0].length)
  console.log('First few values of first embedding:')
  console.log(embeddings[0].slice(0, 5))
  
  // 8. Unload the model
  await model.unload()
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

## Additional Documents

* [Build BERT CLI](./build_cli.md)
* [Generation of Mobile Addon](./build_mobile.md)
* [Testing on Android with Termux](./testing_mobile_termux.md)

## Glossary

* **Bare Runtime** - Small and modular JavaScript runtime for desktop and mobile.
* **BERT GTE‑Large (355M)** - A BERT‑based general text embedding model with 1024‑dimensional embeddings (~355 M parameters).
* **CoreStore** - A manager for multiple Hypercores, handling storage, replication, and key derivation. Simplifies working with many Hypercores in peer-to-peer applications.
* **Hyperdrive** - A peer-to-peer filesystem built on Hypercore, supporting real-time file sharing, versioning, and sparse downloading. Ideal for decentralized apps and data syncing.
* **DataLoader** - Provides a common interface for loading data from various sources.
* **HyperdriveDataLoader** - A data loading library designed to load model weights and other resources from a `Hyperdrive` instance. 
* **FileSystemDataLoader** - A data loading library designed to load model weights and other resources from a local filesystem. 

## Resources

* [Bare Runtime Reference](https://docs.pears.com/bare-reference/overview)
* [BERT GTE‑Large](https://huggingface.co/thenlper/gte-large)
* [Corestore Documentation](https://docs.pears.com/helpers/corestore)
* [Hyperdrive Documentation](https://docs.pears.com/building-blocks/hyperdrive)
* [HyperdriveDataLoader](https://github.com/tetherto/qvac-lib-dl-hyperdrive)
* [FileSystemDataLoader](https://github.com/tetherto/qvac-lib-dl-filesystem)
