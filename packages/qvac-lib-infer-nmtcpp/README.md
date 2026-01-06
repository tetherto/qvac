# Translation Addons

This library simplifies the process of running various translation models within [`QVAC`](#glossary) runtime applications. It provides a seamless interface to load, execute, and manage translation addons, offering support for multiple data sources (called data loaders).

## Table of Contents

- [Installation](#installation)
- [Usage](#usage)
  - [1. Create DataLoader](#1-create-dataloader)
  - [2. Create the `args` object](#2-create-the-args-object)
  - [3. Create the `config` object](#3-create-the-config-object)
  - [4. Create Model Instance](#4-create-model-instance)
  - [5. Load Model](#5-load-model)
  - [6. Run the Model](#6-run-the-model)
  - [7. Unload the Model](#7-unload-the-model)
- [Quickstart Example](#quickstart-example)
- [Model Registry](#model-registry)
- [Supported Languages](#supported-languages)
- [ModelClasses and Packages](#modelclasses-and-packages)
- [Other Examples](#other-examples)
- [Glossary](#glossary)
- [Resources](#resources)
- [License](#license)

## Installation

### Prerequisites

Ensure that the [`Bare`](#glossary) Runtime is installed globally on your system. If it's not already installed, you can add it using:

```bash
npm i -g bare
```

> **Note:** Bare version must be **1.17.3 or higher**. Verify your version with:

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

Depending on your translation needs please choose an appropriate package from the [ModelClasses and Packages](#modelclasses-and-packages) Section and install it through `npm`. For example: 

```bash
# For translating English to Italian
npm i @qvac/translation-nmtcpp

# For translation English to Hindi 
npm i @tetherto/qvac-lib-inference-addon-mlc-indictrans2-en-indic-dist-200m-q0f32
```

## Usage

The library provides a straightforward and intuitive workflow for translating text. Irrespective of the chosen model, the workflow remains the same:


### 1. Create `DataLoader`

In QVAC, the [`DataLoader`](#glossary) class provides an interface for fetching model weights and other resources crucial for running AI Models. A `DataLoader` instance is required to successfully instantiate a `ModelClass`. We can create a [`HyperdriveDataLoader`](#glossary) using the following code.

```javascript
const HyperdriveDL = require('@qvac/dl-hyperdrive')

const hdDL = new HyperdriveDL({
  key: 'hyperdrive-key-hex', // (Required) The Hyperdrive key containing model files.
  store: corestore // (Optional) A Corestore instance. If not provided, Hyperdrive will use an in-memory store.
})
```

> **Note**: It is extremely important that you provide the correct `key` when using a `HyperdriveDataLoader`. A `DataLoader` with model weights and settings for an `en-it` translation can obviously not be utilized for doing a `de-en` translation. Please ensure that the `key` being used aligns with the model(package) installed and the translation requirement.

### 2. Create the `args` object

The `args` object contains the `DataLoader` we created in the previous step and other translation parameters that control how the translation model operates, including which languages to translate between and what performance metrics to collect. 

```javascript
// Create arguments object with loader, translation parameters, and options
const args = {
  // Required: Data loader instance
  loader: hdDL, // or fsDL

  // Required: Translation parameters
  params: {
    mode: 'full', // Model loading mode (full is recommended)
    srcLang: 'en', // Source language (ISO 639-1 code)
    dstLang: 'it' // Target language (ISO 639-1 code)
  },

  // Optional: Additional configuration
  opts: {
    stats: true // Enable performance statistics
  }
}
```

> Note: The list of supported languages for the `srcLang` and `dstLang` parameters differ from one `ModelClass` to another. Please refer to the [Supported Languages](#supported-languages) section for more details.

### 3. Create the `config` object

This config expresses your “how to generate” policy for a run: it balances determinism (greedy/beam) and diversity (sampling) while enforcing simple constraints (length, repetition). 

```javascript
// Define files needed by the model
const config = {
  // Runtime decoding controls (can also be set later via model.setConfig)
  beamsize: 4,            // Beam search width (>=1). 1 disables beam search
  lengthpenalty: 0.6,     // Length normalization strength (>=0)
  maxlength: 128,         // Maximum generated tokens (>0)

  // Repetition and constraints
  repetitionpenalty: 1.2, // Penalize previously generated tokens (0..2)
  norepeatngramsize: 2,   // Disallow repeating n-grams of this size (0..10)

  // Sampling controls
  temperature: 0.8,       //[0..2]
  topk: 40,               // Keep top-K logits [0..vocab_size]
  topp: 0.9               // Nucleus sampling threshold (0< p <=1)
}
```

### 4. Create Model Instance

We first import the `ModelClass` from the installed package, then we instantiate the model by passing it the `args` and `config` objects. 

```javascript
const { ModelClass } = require('installed/package/name')
const model = new ModelClass(args, config)
```

For example:

```javascript
const { MLCMarianOpusQ4F16 } = require('@qvac/translation-nmtcpp-opus-q4f16')
const model = new MLCMarianOpusQ4F16(args, config)
```

### 5. Load Model

```javascript
try {
  // Basic usage
  await model.load()
} catch (error) {
  console.error('Failed to load model:', error)
}
```

### 6. Run the Model

We can perform inference on the input text using the `run()` method. This method returns a [`QVACResponse`](#glossary) object.

```javascript
try {
  // Execute translation on input text
  const response = await model.run('Hello world! Welcome to the internet of peers!')

  // Process streamed output using callback
  await response
    .onUpdate(outputChunk => {
      // Handle each new piece of translated text
      console.log(outputChunk)
    })
    .await() // Wait for translation to complete

  // Access performance statistics (if enabled with opts.stats)
  if (response.stats) {
    console.log('Translation completed in:', response.stats.totalTime, 'ms')
  }
} catch (error) {
  console.error('Translation failed:', error)
}
```

### 7. Unload the Model

```javascript
// Always unload the model when finished to free memory
try {
  await model.unload()
} catch (error) {
  console.error('Failed to unload model:', error)
}
```

### Additional Features

- **Pause and Resume:** Translation can be paused and resumed (see [`examples/pause.example.js`](examples/pause.example.js))
- **Progress Tracking:** Monitor loading progress with a callback function
- **Performance Stats:** Measure inference time with the `stats` option

For a complete working example that brings all these steps together, see the [Quickstart Example](#quickstart-example) below.

## Quickstart Example

Follow these steps to run the Quickstart Example:

### 1. Create a New Project

```bash
mkdir translation-example
cd translation-example
npm init -y 
```

### 2. Install Required Dependencies

```bash
npm i @qvac/translation-nmtcpp-opus-q4f16 @qvac/dl-hyperdrive
```

### 3. Create `example.js` and paste the following code into it

```bash
touch example.js
```

```javascript
// example.js

'use strict'

// Note: This import will depend on the addon package installed
const TranslationNmtcpp = require('..')
const HyperdriveDL = require('@qvac/dl-hyperdrive')

const text = 'La traduzione automatica ha rivoluzionato il modo in cui comunichiamo attraverso le barriere linguistiche nel mondo digitale moderno.'

async function main () {
  // 1. Create `DataLoader`
  const hdDL = new HyperdriveDL({
    // The hyperdrive key for en-it translation model weights and config
    key: 'hd://9ef58f31c20d5556722e0b58a5d262fd89801daf2e6cb28e3f21ac6e9228088f'
  })

  // 2. Create the `args` object
  const args = {
    loader: hdDL,
    params: { mode: 'full', dstLang: 'en', srcLang: 'it' },
    diskPath: './models',
    modelName: 'model.bin',
  }

  // 3. Optional : Create config object
  const config = {beamsize : 4}

  // 4. Create Model Instance
  const model = new TranslationNmtcpp(args, config)

  // 5. Load model
  await model.load()

  try {
    // 6. Run the Model
    const response = await model.run(text)

    await response
            .onUpdate(data => {
              console.log(data)
            })
            .await()

    console.log('translation finished!')
  } finally {
    // 7. Unload the model
    await model.unload()

    // Close the DataLoader
    await hdDL.close()
  }
}


main().catch(console.error)
```

### 4. Run the Example

```bash
bare example.js
```

You should see this output on successful execution

```bash
params_shard_0.bin has these many parameter records: 1
params_shard_1.bin has these many parameter records: 19
params_shard_2.bin has these many parameter records: 1
params_shard_3.bin has these many parameter records: 336
Ciao a tutti!
translation finished!
```

## Model Registry

The **Hyperbee key** for the model registry is:

```
7504626aaa534ac55d91b4b3067504774ae1457b03ddfbd86d817dd8cfbca8c8
```

Below is the section of the registry dedicated to **translation tasks**. Each entry maps a specific model and language pair (left-hand side) to the corresponding **Hyperdrive key** (right-hand side), which stores the model's weights and configuration settings.

```javascript
"translation:marian:opus-ggml:::q0f32:1.0.0:en-it": "9ef58f31c20d5556722e0b58a5d262fd89801daf2e6cb28e3f21ac6e9228088f"
"translation:marian:opus-ggml:::q0f32:1.0.0:en-de": "7b1d16235cd4dd9cc2c58d1fc1c41d65159aa4d2337169c6243a5bc8bf49689b"
"translation:marian:opus-ggml:::q0f32:1.0.0:en-es": "8aa823831cc55f5c1cba2c046e98b53a0d32376267ca73d653294b8b114459a2"
"translation:marian:opus-ggml:::q0f32:1.0.0:de-en": "b4d1ab62f885d9814acfddc565761b607bf86a307c38430ec1dabfe1a92532af"
"translation:marian:opus-ggml:::q0f32:1.0.0:de-es": "f432152db25ebd86fa0e48cd12f27e67e5c052c9af99c7662939dc1d84792c3e"
"translation:marian:opus-ggml:::q0f32:1.0.0:de-it": "06d26bdc965d548c156885ed105f8150618aaa11712579158e81f1d49735aaf6"
"translation:marian:opus-ggml:::q0f32:1.0.0:es-de": "ff6a02096c3e2f4e1aa7e4a75cb37aa851bc924c9d4af2b30b26431f1cb9d156"
"translation:marian:opus-ggml:::q0f32:1.0.0:es-en": "b96cf6c79119578b9f9a2206b19ce9686e95f31949ce62b24aef83fbdf4b0b08"
"translation:marian:opus-ggml:::q0f32:1.0.0:es-it": "b04ba8638fea5adff061aba9ccc671936ab8f7459346461f6c2010d4c7413254"
"translation:marian:opus-ggml:::q0f32:1.0.0:it-de": "438cbda449f1ac258a2fdea55cfd1f9f83dfb0ea20103c1e5113906081eec4f5"
"translation:marian:opus-ggml:::q0f32:1.0.0:it-en": "68778c8375fbb1e7f5c20b4e6087131206e9ddba1872655e20931b7e08fe3954"
"translation:marian:opus-ggml:::q0f32:1.0.0:it-es": "1b78d8309f80fcda61d0291ed5dc755e10e46b39d7e7484083a3c6d20b86c679"
"translation:ggml-indictrans:full:2:1B:q0f32:1.0.0:hi-en": "d46a9192b479fb5c982e60b84ae25bb5a61f3f090a41d45d5c5dda597973a9dd"
"translation:ggml-indictrans:full:2:1B:q0f32:1.0.0:en-hi": "61d1eb542956914ad2eadaf405b76a4dcc327fd6ccf1191bb17cd102a642691e"
"translation:ggml-indictrans:full:2:1B:q0f32:1.0.0:hi-hi": "cd8e441d1da68602e19a92f5d1ee794852e802ee234a638df2976bb1bc2493ad"
"translation:ggml-indictrans:dist:2:200M:q0f32:1.0.0:en-hi": "268c2e9b2a3420632e4b6649e32822f42d5dfbda4c7e96daec5b629ed20f99f7"
"translation:ggml-indictrans:dist:2:200M:q0f32:1.0.0:hi-en": "dfea395ffe1cb6d259029e5c81c290f8828981987855e23e7b66fd7c705901eb"
"translation:ggml-indictrans:dist:2:320M:q0f32:1.0.0:hi-hi": "9a66da960931c449b41e3315d9aea4d3925f2cda024e8a4c139b64d0a539ed41"
"translation:ggml-indictrans:full:2:1B:q0f16:1.0.0:en-hi": "be5bff40a002c627a992d096861c0e9b0be6ac7770300cee0bb09ccda87404cb"
"translation:ggml-indictrans:full:2:200M:q0f16:1.0.0:en-hi": "42ba45bbf4c24ff743890bc0cc65d8c23c91a14d26f760b3f814df76be8e036f"
"translation:ggml-indictrans:full:2:1B:q0f16:1.0.0:hi-en": "d06c487c56a36bb153d9d33bc1085bc90561d2a8dad5cd5701db782e1540a343"
"translation:ggml-indictrans:full:2:200M:q0f16:1.0.0:hi-en": "2e35d09ba69dd2b692c668862fdee43fa941859690b1e17aecc96c73474521b9"
"translation:ggml-indictrans:full:2:1B:q0f16:1.0.0:hi-hi": "f4edc8b072c34840c08aab2c8abdc288aa2dff8c2ed76fc96ad6604e322a038f"
"translation:ggml-indictrans:full:2:320M:q0f16:1.0.0:hi-hi": "1bb2ad463127325ca8daa801ec89ae6a2983ddeb90c5461a965e65fa295e3655"
"translation:ggml-indictrans:full:2:1B:q4_0:1.0.0:en-hi": "9fb5b7338504b24df0f3dd9ae8a1c280c6f00fd7f3295cca8f884514c5fa9713"
"translation:ggml-indictrans:full:2:200M:q4_0:1.0.0:en-hi": "8336d23073b2fd99723bf17d65ddc7b54b8ee886d6627659ba95c7a8fb932dc8"
"translation:ggml-indictrans:full:2:1B:q4_0:1.0.0:hi-en": "1fd66a6862776a92c7fae1962a1f07a5bc7369fb8be3dd9b76adf7c71855af7f"
"translation:ggml-indictrans:full:2:200M:q4_0:1.0.0:hi-en": "ba7db8c0dbcb6fc4276f86a27e3b9dd0f5e90b79f550a1666757f6074e2a4331"
"translation:ggml-indictrans:full:2:1B:q4_0:1.0.0:hi-hi": "0f03a3a06bc7006deb0da42643585dc0da49b897ba49e449ec67013ba4464e8a"
"translation:ggml-indictrans:full:2:320M:q4_0:1.0.0:hi-hi": "6cba73db82148a228bfdc586e2e565db6e6beb476575de3602d927ecb08b1a70"
```

Each key in this list follows the general pattern:

```
<model_family>:<version>:<size>:<quantization>:<release>:<source-lang>-<target-lang>
```

## Supported Languages

Here is the list of languages supported for the Marian models: 

<table>
  <tbody>
    <tr><td>English (en)</td></tr>
    <tr><td>German (de)</td></tr>
    <tr><td>Italian (it)</td></tr>
    <tr><td>Spanish (es)</td></tr>
  </tbody>
</table>

Here is the list of languages supported by the IndicTrans2 models:

<table>
<tbody>
  <tr>
    <td>Assamese (asm_Beng)</td>
    <td>Kashmiri (Arabic) (kas_Arab)</td>
    <td>Punjabi (pan_Guru)</td>
  </tr>
  <tr>
    <td>Bengali (ben_Beng)</td>
    <td>Kashmiri (Devanagari) (kas_Deva)</td>
    <td>Sanskrit (san_Deva)</td>
  </tr>
  <tr>
    <td>Bodo (brx_Deva)</td>
    <td>Maithili (mai_Deva)</td>
    <td>Santali (sat_Olck)</td>
  </tr>
  <tr>
    <td>Dogri (doi_Deva)</td>
    <td>Malayalam (mal_Mlym)</td>
    <td>Sindhi (Arabic) (snd_Arab)</td>
  </tr>
  <tr>
    <td>English (eng_Latn)</td>
    <td>Marathi (mar_Deva)</td>
    <td>Sindhi (Devanagari) (snd_Deva)</td>
  </tr>
  <tr>
    <td>Konkani (gom_Deva)</td>
    <td>Manipuri (Bengali) (mni_Beng)</td>
    <td>Tamil (tam_Taml)</td>
  </tr>
  <tr>
    <td>Gujarati (guj_Gujr)</td>
    <td>Manipuri (Meitei) (mni_Mtei)</td>
    <td>Telugu (tel_Telu)</td>
  </tr>
  <tr>
    <td>Hindi (hin_Deva)</td>
    <td>Nepali (npi_Deva)</td>
    <td>Urdu (urd_Arab)</td>
  </tr>
  <tr>
    <td>Kannada (kan_Knda)</td>
    <td>Odia (ory_Orya)</td>
    <td></td>
  </tr>
</tbody>
</table>


The Bergamot backend supports all language pairs that Bergamot (Firefox Translations) supports.

## Backends

This project supports multiple backends (e.g., Marian/OPUS, Bergamot/Firefox, IndicTrans2).

To build with the Bergamot backend, set the flag as follows during generation:

```bash
bare-make generate -D USE_BERGAMOT=OFF
```

## Benchmarking

We conduct comprehensive benchmarking of our translation models to evaluate their performance across different language pairs and metrics. Our benchmarking suite measures translation quality using BLEU and COMET scores, as well as performance metrics including load times and inference speeds.

### Benchmark Results

For detailed benchmark results across all supported language pairs and model configurations, see our [Benchmark Results Summary](benchmarks/results/results_summary.md).

The benchmarking covers:

- **Translation Quality**: BLEU and COMET scores for accuracy assessment
- **Performance Metrics**: Model loading times and inference speeds
- **Language Pairs**: All supported source-target language combinations
- **Model Variants**: Different quantization levels and model sizes

Results are updated regularly as new model versions are released.

## Testing

This project includes comprehensive testing capabilities for both JavaScript and C++ components.

### JavaScript Tests

```bash
# Run all JavaScript tests
npm test                   # Unit + integration tests
npm run test:unit          # Unit tests only
npm run test:integration   # Integration tests only
```

### C++ Tests

The project includes C++ tests using Google Test framework.

#### npm Commands (Recommended - Cross-Platform)

```bash
# Build and run C++ tests
npm run test:cpp:build     # Build C++ test suite (auto-detects platform)
npm run test:cpp:run       # Run all C++ unit tests
npm run test:cpp           # Build and run in one command

# C++ Code Coverage
npm run coverage:cpp:build # Build with coverage instrumentation  
npm run coverage:cpp:run   # Run tests and collect coverage data
npm run coverage:cpp:report # Generate HTML coverage report
npm run coverage:cpp       # Complete coverage workflow

# Combined Testing
npm run test:all           # Run both JavaScript and C++ tests
```

## Other Examples

- [Filesystem Data Loader](examples/example.fs.js): Demonstrates using the library with the Filesystem Data Loader for Marian model inference.
- [Pause Example](examples/pause.example.js): Demonstrates pausing and resuming the addon during inference.
- [IndicTrans2 en-hi Example](examples/indictrans.js): Demonstrates how to use the library for English-to-Hindi translation with the IndicTrans2 model, including setup, loading model weights, and running inference.

## Glossary

- **Bare** – Lightweight, modular JavaScript runtime for desktop and mobile. [Docs](https://docs.pears.com/bare-reference/overview)
- **Hyperdrive** – Secure, real-time distributed filesystem enabling P2P file sharing. [Docs](https://docs.pears.com/building-blocks/hyperdrive)
- **Hyperbee** – Decentralized B-tree built on Hypercores, with a key-value API. [Docs](https://docs.pears.com/building-blocks/hyperbee)
- **Corestore** – Factory for managing named collections of Hypercores. [Docs](https://docs.pears.com/helpers/corestore)
- **QVAC** – Open-source SDK for building decentralized AI applications.
- **QVACResponse** –  The response object used by the QVAC API. [GitHub](https://github.com/tetherto/qvac-lib-response)
- **DataLoader** – Abstraction for fetching model weights and resources. 
  Implementations include:
  - **`HyperdriveDL`** – Loads from a Hyperdrive instance [GitHub](https://github.com/tetherto/qvac-lib-dl-hyperdrive)
  - **`fsDL`** – Loads from the local filesystem [GitHub](https://github.com/tetherto/qvac-lib-dl-filesystem)

## Resources

- **Pear Platform** – Decentralized platform for deploying apps. [pears.com](https://pears.com/)
- **Bare Runtime Docs** – For running QVAC apps in a lightweight environment. [docs.pears.com/bare](https://docs.pears.com/bare-reference/overview)
- **IndicTrans2 Model** – Pretrained multilingual translation models. [AI4Bharat/IndicTrans2](https://github.com/AI4Bharat/IndicTrans2)
- **Translation App Example** – QVAC-based translation application. [qvac-examples/translation-app](https://github.com/tetherto/qvac-examples/tree/main/translation-app)

## License

This project is licensed under the Apache-2.0 License - see the [LICENSE](LICENSE) file for details.<br>
For any questions o issues, please open an issue on the GitHub repository.
Test mobile job visibility
