# Translation Addons

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Bare](https://img.shields.io/badge/Bare-%3E%3D1.19.0-green.svg)](https://docs.pears.com/reference/bare-overview.html)

This library simplifies the process of running various translation models within [`QVAC`](#glossary) runtime applications. It provides a seamless interface to load, execute, and manage translation addons, offering support for multiple data sources (called data loaders).

## Table of Contents

- [Translation Addons](#translation-addons)
  - [Table of Contents](#table-of-contents)
  - [Supported Platforms](#supported-platforms)
  - [Installation](#installation)
    - [Prerequisites](#prerequisites)
    - [Installing the Package](#installing-the-package)
  - [Usage](#usage)
    - [1. Create `DataLoader`](#1-create-dataloader)
    - [2. Create the `args` object](#2-create-the-args-object)
      - [IndicTrans2 Model](#indictrans2-model)
      - [Bergamot Model](#bergamot-model)
    - [3. Create the `config` object](#3-create-the-config-object)
      - [Model-Specific Parameters](#model-specific-parameters)
      - [Generation/Decoding Parameters (IndicTrans Only)](#generationdecoding-parameters-indictrans-only)
    - [4. Create Model Instance](#4-create-model-instance)
      - [IndicTrans2](#indictrans2)
      - [Bergamot](#bergamot)
    - [5. Load Model](#5-load-model)
    - [6. Run the Model](#6-run-the-model)
    - [7. Batch Translation (Bergamot Only)](#7-batch-translation-bergamot-only)
    - [8. Unload the Model](#8-unload-the-model)
    - [Additional Features](#additional-features)
  - [Quickstart Example](#quickstart-example)
    - [1. Create a New Project](#1-create-a-new-project)
    - [2. Install Required Dependencies](#2-install-required-dependencies)
    - [3. Create `quickstart.js` and paste the following code into it](#3-create-quickstartjs-and-paste-the-following-code-into-it)
    - [4. Run the Example](#4-run-the-example)
    - [Adapting for Other Model Types](#adapting-for-other-model-types)
  - [Other Examples](#other-examples)
  - [Model Registry](#model-registry)
    - [Bergamot Models (Firefox Translations)](#bergamot-models-firefox-translations)
    - [IndicTrans2 Models](#indictrans2-models)
    - [Key Pattern](#key-pattern)
  - [Supported Languages](#supported-languages)
    - [IndicTrans2 Models (Hyperdrive)](#indictrans2-models-hyperdrive)
    - [Bergamot Models (Firefox Translations)](#bergamot-models-firefox-translations-1)
  - [ModelClasses and Packages](#modelclasses-and-packages)
    - [ModelClass](#modelclass)
    - [Available Packages](#available-packages)
      - [Main Package](#main-package)
  - [Backends](#backends)
  - [Benchmarking](#benchmarking)
    - [Benchmark Results](#benchmark-results)
  - [Logging](#logging)
    - [Enabling C++ Logs](#enabling-c-logs)
    - [Disabling C++ Logs](#disabling-c-logs)
    - [Using Environment Variables (Recommended for Examples)](#using-environment-variables-recommended-for-examples)
    - [Log Levels](#log-levels)
  - [Testing](#testing)
    - [JavaScript Tests](#javascript-tests)
    - [C++ Tests](#c-tests)
      - [npm Commands (Recommended - Cross-Platform)](#npm-commands-recommended---cross-platform)
  - [Glossary](#glossary)
  - [Resources](#resources)
  - [Contributing](#contributing)
    - [Building from Source](#building-from-source)
    - [Development Workflow](#development-workflow)
    - [Code Style](#code-style)
    - [Running Tests](#running-tests)
  - [License](#license)

## Supported Platforms

| Platform | Architecture | Min Version | Status |
|----------|-------------|-------------|--------|
| macOS | arm64, x64 | 14.0+ | Tier 1 |
| iOS | arm64 | 17.0+ | Tier 1 |
| Linux | arm64, x64 | Ubuntu 22+ | Tier 1 |
| Android | arm64 | 12+ | Tier 1 |
| Windows | x64 | 10+ | Tier 1 |

## Installation

### Prerequisites

Ensure that the [`Bare`](#glossary) Runtime is installed globally on your system. If it's not already installed, you can add it using:

```bash
npm i -g bare
```

> **Note:** Bare version must be **1.19.0 or higher**. Verify your version with:

```bash
bare -v
```

### Installing the Package

Install the main translation package via npm: 

```bash
# Main package - supports Bergamot and IndicTrans backends (all languages)
npm i @qvac/translation-nmtcpp
```

## Usage

The library provides a straightforward and intuitive workflow for translating text. Irrespective of the chosen model, the workflow remains the same:


### 1. Create `DataLoader`

In QVAC, the [`DataLoader`](#glossary) class provides an interface for fetching model weights and other resources crucial for running AI Models. A `DataLoader` instance is required to successfully instantiate a `ModelClass`. We can create a [`HyperdriveDL`](#glossary) using the following code.

```javascript
const HyperdriveDL = require('@qvac/dl-hyperdrive')

const hdDL = new HyperdriveDL({
  key: 'hd://528eb43b34c57b0fb7116e532cd596a9661b001870bdabf696243e8d079a74ca' // (Required) Hyperdrive key with 'hd://' prefix (raw hex also works)
  // store: corestore // (Optional) A Corestore instance for persistent storage. See Glossary for details.
})
```

> **Note**: It is extremely important that you provide the correct `key` when using a `HyperdriveDataLoader`. A `DataLoader` with model weights and settings for an `en-it` translation can obviously not be utilized for doing a `de-en` translation. Please ensure that the `key` being used aligns with the model (package) installed and the translation requirement. See the [Model Registry](#model-registry) section to find the correct Hyperdrive key for your language pair.

### 2. Create the `args` object

The `args` object contains the `DataLoader` we created in the previous step and other translation parameters that control how the translation model operates, including which languages to translate between and what performance metrics to collect.

The structure varies slightly depending on which backend you're using:

---

#### IndicTrans2 Model

For Indic language translations (English ↔ Hindi, Bengali, Tamil, etc.):

```javascript
const HyperdriveDL = require('@qvac/dl-hyperdrive')

const hdDL = new HyperdriveDL({
  key: 'hd://8c0f50e7c75527213a090d2f1dcd9dbdb8262e5549c8cbbb74cb7cb12b156892' // en-hi IndicTrans2 200M model
})

const args = {
  loader: hdDL,
  params: {
    mode: 'full',
    srcLang: 'eng_Latn',   // Source language (ISO 15924 code)
    dstLang: 'hin_Deva'    // Target language (ISO 15924 code)
  },
  diskPath: './models/indic-en-hi-200M',              // Unique directory per model
  modelName: 'ggml-indictrans2-en-indic-dist-200M.bin' // Must match exact filename in Hyperdrive
}
```

**Key Parameters:**
| Parameter | Description | Example |
|-----------|-------------|---------|
| `srcLang` | Source language (ISO 15924) | `'eng_Latn'`, `'hin_Deva'`, `'ben_Beng'` |
| `dstLang` | Target language (ISO 15924) | `'eng_Latn'`, `'hin_Deva'`, `'tam_Taml'` |
| `modelName` | Specific filename per model | `'ggml-indictrans2-en-indic-dist-200M.bin'` |
| `modelType` | **Required**: `TranslationNmtcpp.ModelTypes.IndicTrans` | - |

**IndicTrans2 model naming pattern:**
- `ggml-indictrans2-{direction}-{size}.bin` for q0f32 quantization
- `ggml-indictrans2-{direction}-{size}-q0f16.bin` for q0f16 quantization
- `ggml-indictrans2-{direction}-{size}-q4_0.bin` for q4_0 quantization

Where `direction` is `en-indic`, `indic-en`, or `indic-indic`, and `size` is `dist-200M`, `dist-320M`, or `1B`.

---

#### Bergamot Model

Bergamot models (Firefox Translations) are available via **Hyperdrive** or as local files.

**Option 1: Using Hyperdrive (Recommended)**

```javascript
const HyperdriveDL = require('@qvac/dl-hyperdrive')

const hdDL = new HyperdriveDL({
  key: 'hd://a8811fb494e4aee45ca06a011703a25df5275e5dfa59d6217f2d430c677f9fa6' // en-it Bergamot (BERGAMOT_ENIT)
})

const args = {
  loader: hdDL,
  params: {
    mode: 'full',
    srcLang: 'en',    // Source language (ISO 639-1 code)
    dstLang: 'it'     // Target language (ISO 639-1 code)
  },
  diskPath: './models/bergamot-en-it',           // Unique directory per model
  modelName: 'model.enit.intgemm.alphas.bin'     // Model file from Hyperdrive
}
```

**Option 2: Using Local Files**

```javascript
const fs = require('bare-fs')
const path = require('bare-path')

// Path to your locally downloaded Bergamot model directory
const bergamotPath = './models/bergamot-en-it'

const localLoader = {
  ready: async () => {},
  close: async () => {},
  download: async (filename) => {
    return fs.readFileSync(path.join(bergamotPath, filename))
  },
  getFileSize: async (filename) => {
    const stats = fs.statSync(path.join(bergamotPath, filename))
    return stats.size
  }
}

const args = {
  loader: localLoader,
  params: {
    mode: 'full',
    srcLang: 'en',
    dstLang: 'it'
  },
  diskPath: bergamotPath,
  modelName: 'model.enit.intgemm.alphas.bin'
}
```

**Bergamot Model Files by Language Pair:**

> **Note:** Hyperdrive keys shown are truncated. See [Model Registry](#model-registry) for full keys.

| Language Pair | Hyperdrive Key | Model File | Vocab File(s) |
|---------------|----------------|------------|---------------|
| en→it | `a8811fb494e4aee4...` | `model.enit.intgemm.alphas.bin` | `vocab.enit.spm` |
| it→en | `3b4be93d19dd9e9e...` | `model.iten.intgemm.alphas.bin` | `vocab.iten.spm` |
| en→es | `bf46f9b51d04f561...` | `model.enes.intgemm.alphas.bin` | `vocab.enes.spm` |
| es→en | `c3e983c8db3f64fa...` | `model.esen.intgemm.alphas.bin` | `vocab.esen.spm` |
| en→fr | `0a4f388c0449b777...` | `model.enfr.intgemm.alphas.bin` | `vocab.enfr.spm` |
| fr→en | `7a9b38b0c4637b2e...` | `model.fren.intgemm.alphas.bin` | (see registry) |
| en→de | (see Bergamot section in registry) | `model.ende.intgemm.alphas.bin` | `vocab.ende.spm` |
| en→ru | `404279d9716f3191...` | `model.enru.intgemm.alphas.bin` | `vocab.enru.spm` |
| ru→en | `dad7f99c8d8c1723...` | `model.ruen.intgemm.alphas.bin` | `vocab.ruen.spm` |
| en→zh | `15d484200acea8b1...` | `model.enzh.intgemm.alphas.bin` | `srcvocab.enzh.spm`, `trgvocab.enzh.spm` |
| zh→en | `17eb4c3fcd23ac3c...` | `model.zhen.intgemm.alphas.bin` | `vocab.zhen.spm` |
| en→ja | `ac0b883d176ea3b1...` | `model.enja.intgemm.alphas.bin` | `srcvocab.enja.spm`, `trgvocab.enja.spm` |
| ja→en | `85012ed3c3ff5c2b...` | `model.jaen.intgemm.alphas.bin` | `vocab.jaen.spm` |

**Key Parameters:**
| Parameter | Description | Example |
|-----------|-------------|---------|
| `srcLang` | Source language (ISO 639-1) | `'en'`, `'es'`, `'de'` |
| `dstLang` | Target language (ISO 639-1) | `'it'`, `'fr'`, `'de'` |
| `modelName` | Model weights file | `'model.enit.intgemm.alphas.bin'` |
| `srcVocabName` | **Required in config**: Source vocab file | `'vocab.enit.spm'` or `'srcvocab.enja.spm'` |
| `dstVocabName` | **Required in config**: Target vocab file | `'vocab.enit.spm'` or `'trgvocab.enja.spm'` |
| `modelType` | **Required in config**: `TranslationNmtcpp.ModelTypes.Bergamot` | - |

**Bergamot model file naming convention:**
- `model.{srctgt}.intgemm.alphas.bin` - Model weights (e.g., `model.enit.intgemm.alphas.bin`)
- `vocab.{srctgt}.spm` - Shared vocabulary for most language pairs
- `srcvocab.{srctgt}.spm` + `trgvocab.{srctgt}.spm` - Separate vocabs for CJK languages (zh, ja)

---

> **Important: diskPath Configuration**
>
> Use a **unique directory per model** to avoid file conflicts when using multiple models:
> - `./models/indic-en-hi-200M` for IndicTrans English→Hindi
> - `./models/bergamot-en-it` for Bergamot English→Italian

> **Note:** The list of supported languages for the `srcLang` and `dstLang` parameters differ by model type. Please refer to the [Supported Languages](#supported-languages) section for details.

### 3. Create the `config` object

The `config` object contains two types of parameters:

1. **Model-specific parameters** (required for some backends)
2. **Generation/decoding parameters** (optional, controls output quality)

#### Model-Specific Parameters

| Parameter | IndicTrans2 | Bergamot |
|-----------|-------------|----------|
| `modelType` | **Required** | **Required** |
| `srcVocabName` | Not needed | **Required** |
| `dstVocabName` | Not needed | **Required** |

#### Generation/Decoding Parameters (IndicTrans Only)

These parameters control how the model generates output. **Note:** Full parameter support is only available for IndicTrans2 models. Bergamot has limited parameter support.

```javascript
// Generation parameters for IndicTrans2
const generationParams = {
  beamsize: 4,            // Beam search width (>=1). 1 disables beam search
  lengthpenalty: 0.6,     // Length normalization strength (>=0)
  maxlength: 128,         // Maximum generated tokens (>0)
  repetitionpenalty: 1.2, // Penalize previously generated tokens (0..2)
  norepeatngramsize: 2,   // Disallow repeating n-grams of this size (0..10)
  temperature: 0.8,       // Sampling temperature [0..2]
  topk: 40,               // Keep top-K logits [0..vocab_size]
  topp: 0.9               // Nucleus sampling threshold (0 < p <= 1)
}
```

### 4. Create Model Instance

Import `TranslationNmtcpp` and create an instance by combining `args` (from Step 2) with `config` parameters (from Step 3):

```javascript
const TranslationNmtcpp = require('@qvac/translation-nmtcpp')
```

#### IndicTrans2

```javascript
// IndicTrans - must specify modelType + generation parameters
const config = {
  modelType: TranslationNmtcpp.ModelTypes.IndicTrans,
  ...generationParams,  // Spread generation params from Step 3
  maxlength: 256        // Override for longer outputs
}

const model = new TranslationNmtcpp(args, config)
```

#### Bergamot

```javascript
// Bergamot - must specify modelType, vocab files (limited generation params support)
const config = {
  modelType: TranslationNmtcpp.ModelTypes.Bergamot,
  srcVocabName: 'vocab.enit.spm',    // Required: source vocabulary file
  dstVocabName: 'vocab.enit.spm',    // Required: target vocabulary file
  beamsize: 4                        // Only beamsize supported for Bergamot
}

const model = new TranslationNmtcpp(args, config)
```

**Available Model Types:**

```javascript
TranslationNmtcpp.ModelTypes = {
  IndicTrans: 'IndicTrans',
  Bergamot: 'Bergamot'
}
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

### 7. Batch Translation (Bergamot Only)

For translating multiple texts efficiently, use the `runBatch()` method instead of calling `run()` multiple times.

> **Important:** `runBatch()` is only available with the **Bergamot backend**. IndicTrans2 models should use sequential `run()` calls.

```javascript
// Array of texts to translate (English)
const textsToTranslate = [
  'Hello world!',
  'How are you today?',
  'Machine translation has revolutionized communication.'
]

try {
  // Batch translation - returns array of translated strings
  const translations = await model.runBatch(textsToTranslate)

  // Output each translation
  translations.forEach((translatedText, index) => {
    console.log(`Original: ${textsToTranslate[index]}`)
    console.log(`Translated: ${translatedText}\n`)
  })
} catch (error) {
  console.error('Batch translation failed:', error)
}
```

**`runBatch()` vs `run()`:**

| Method | Input | Output | Backend Support |
|--------|-------|--------|-----------------|
| `run(text)` | Single string | `QVACResponse` with streaming | All (IndicTrans, Bergamot) |
| `runBatch(texts)` | Array of strings | Array of strings | **Bergamot only** |

> **Note:** `runBatch()` is significantly faster when translating multiple texts as it processes them in a single batch operation. See [`examples/batch.example.js`](examples/batch.example.js) for a complete example with Bergamot.

### 8. Unload the Model

```javascript
// Always unload the model when finished to free memory
try {
  await model.unload()
} catch (error) {
  console.error('Failed to unload model:', error)
}
```

### Additional Features

- **Cancel:** Translation can be cancelled mid-inference (see [`examples/pause.example.js`](examples/pause.example.js) for long-text translation with cancellation)
- **Progress Tracking:** Monitor loading progress with a callback function
- **Performance Stats:** Measure inference time with the `stats` option

For a complete working example that brings all these steps together, see the [Quickstart Example](#quickstart-example) below.

## Quickstart Example

This quickstart demonstrates **Bergamot model** inference (English → Italian translation).

> **Other Model Types:** For IndicTrans2 models, refer to [Section 2: Create the args object](#2-create-the-args-object) for model-specific configuration.

Follow these steps to run the Quickstart Example:

### 1. Create a New Project

```bash
mkdir translation-example
cd translation-example
npm init -y 
```

### 2. Install Required Dependencies

> **Note:** Ensure you've completed the [Prerequisites](#prerequisites) setup (Bare runtime installed).

```bash
npm i @qvac/translation-nmtcpp @qvac/dl-hyperdrive
```

### 3. Create `quickstart.js` and paste the following code into it

```bash
touch quickstart.js
```

```javascript
// quickstart.js

'use strict'

const TranslationNmtcpp = require('@qvac/translation-nmtcpp')
const HyperdriveDL = require('@qvac/dl-hyperdrive')

const text = 'Machine translation has revolutionized the way we communicate across language barriers in the modern digital world.'

async function main () {
  // 1. Create DataLoader
  const hdDL = new HyperdriveDL({
    key: 'hd://a8811fb494e4aee45ca06a011703a25df5275e5dfa59d6217f2d430c677f9fa6'
  })

  // 2. Create the args object
  const args = {
    loader: hdDL,
    params: { mode: 'full', srcLang: 'en', dstLang: 'it' },
    diskPath: './models/bergamot-en-it',
    modelName: 'model.enit.intgemm.alphas.bin'
  }

  // 3. Create config object
  const config = {
    modelType: TranslationNmtcpp.ModelTypes.Bergamot,
    srcVocabName: 'vocab.enit.spm',
    dstVocabName: 'vocab.enit.spm',
    beamsize: 4
  }

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
bare quickstart.js
```

You should see this output on successful execution

```bash
La traduzione automatica ha rivoluzionato il modo in cui comunichiamo attraverso le barriere linguistiche nel mondo digitale moderno.
translation finished!
```

### Adapting for Other Model Types

To use **IndicTrans2** models instead, modify the `args` and `config` objects as shown in [Section 2: Create the args object](#2-create-the-args-object) and [Section 4: Create Model Instance](#4-create-model-instance).

**Quick Reference:**

| Model Type | Key Changes |
|------------|-------------|
| **IndicTrans2** | Use ISO 15924 language codes (`eng_Latn`, `hin_Deva`), specific `modelName`, add `modelType: IndicTrans` |
| **Bergamot** | Use Bergamot hyperdrive key (or local files), specific `modelName` (e.g., `model.enit.intgemm.alphas.bin`), add `srcVocabName`, `dstVocabName`, `modelType: Bergamot` |

## Other Examples

For more detailed examples covering different use cases, refer to the `examples/` directory:

| Example | Description | Model Type |
|---------|-------------|------------|
| [example.hd.js](examples/example.hd.js) | Hyperdrive Data Loader with GGML backend | IndicTrans |
| [indictrans.js](examples/indictrans.js) | English-to-Hindi translation with IndicTrans2 | IndicTrans2 |
| [batch.example.js](examples/batch.example.js) | Batch translation with `runBatch()` method | Bergamot |
| [pause.example.js](examples/pause.example.js) | Long-text translation with cancel support | Any |
| [pivot.example.js](examples/pivot.example.js) | Pivot translation (e.g., es→en→it) via Bergamot | Bergamot |
| [quickstart.js](examples/quickstart.js) | Bergamot backend quickstart | Bergamot |

## Model Registry

The **Hyperbee key** for the model registry is:

```
7504626aaa534ac55d91b4b3067504774ae1457b03ddfbd86d817dd8cfbca8c8
```

Below is the section of the registry dedicated to **translation tasks**. Each entry maps a specific model and language pair (left-hand side) to the corresponding **Hyperdrive key** (right-hand side), which stores the model's weights and configuration settings.

> **Note:** Keys are sourced from [qvac-sdk/models/hyperdrive/models.ts](https://github.com/tetherto/qvac-sdk/blob/dev/models/hyperdrive/models.ts)

### Bergamot Models (Firefox Translations)

```javascript
// Bergamot models - use with ModelTypes.Bergamot
"translation:bergamot:nmt::::1.0.0:aren": "152125b9e579de7897bffddc2756a712f1c8e6fcbda162d1a821aab135c8ad7e"
"translation:bergamot:nmt::::1.0.0:csen": "41df2dadab7db9a8258d1520ae5815601f5690e0d96ab1e61f931427a679d32d"
"translation:bergamot:nmt::::1.0.0:enar": "c9ae647365e18d8c51eb21c47721544ee3daaaec375913e5ccb7a8d11d493a0c"
"translation:bergamot:nmt::::1.0.0:encs": "c7ccfc55618925351f32b00265375c66309240af9e90f0baf7f460ebc5ba34de"
"translation:bergamot:nmt::::1.0.0:enes": "bf46f9b51d04f5619eea1988499d81cd65268d9b0a60bea0fb647859ffe98a3c"
"translation:bergamot:nmt::::1.0.0:enfr": "0a4f388c0449b7774043e5ba8a1a2f735dc22a0a8e01d8bcd593e28db2909abf"
"translation:bergamot:nmt::::1.0.0:enit": "a8811fb494e4aee45ca06a011703a25df5275e5dfa59d6217f2d430c677f9fa6"
"translation:bergamot:nmt::::1.0.0:enja": "ac0b883d176ea3b1d304790efe2d4e4e640a474b7796244c92496fb9d660f29d"
"translation:bergamot:nmt::::1.0.0:enpt": "21f12262b8b0440b814f2e57e8224d0921c6cf09e1da0238a4e83789b57ab34f"
"translation:bergamot:nmt::::1.0.0:enru": "404279d9716f31913cdb385bef81e940019134b577ed64ae3333b80da75a80bf"
"translation:bergamot:nmt::::1.0.0:enzh": "15d484200acea8b19b7eeffd5a96b218c3c437afbed61bfef39dafbae6edfec0"
"translation:bergamot:nmt::::1.0.0:esen": "c3e983c8db3f64faeef8eaf1da9ea4aeb8d5c020529f83957d63c19ed7710651"
"translation:bergamot:nmt::::1.0.0:fren": "7a9b38b0c4637b2eab9c11387b8c3f254db64da47cc5a7eecda66513176f7757"
"translation:bergamot:nmt::::1.0.0:iten": "3b4be93d19dd9e9e6ee38b528684028ac03c7776563bc0e5ca668b76b0964480"
"translation:bergamot:nmt::::1.0.0:jaen": "85012ed3c3ff5c2bfe49faa60ebafb86306e6f2a97f49796374d3069f505bfd3"
"translation:bergamot:nmt::::1.0.0:pten": "a5da4ee5f5817033dee6ed4489d1d3cadcf3d61e99fd246da7e0143c4b7439a4"
"translation:bergamot:nmt::::1.0.0:ruen": "dad7f99c8d8c17233bcfa005f789a0df29bb4ae3116381bdb2a63ffc32c97dfe"
"translation:bergamot:nmt::::1.0.0:zhen": "17eb4c3fcd23ac3c93cbe62f08ecb81d70f561f563870ea42494214d6886dd66"
```

### IndicTrans2 Models

```javascript
// IndicTrans2 - 200M distilled models (q0f32)
"translation:ggml-indictrans:dist:2:200M:q0f32:1.0.0:en-hi": "8c0f50e7c75527213a090d2f1dcd9dbdb8262e5549c8cbbb74cb7cb12b156892"
"translation:ggml-indictrans:dist:2:200M:q0f32:1.0.0:hi-en": "51ee5910cb8cef000de2acfff5b3b72b866d0eb08a34193a40d9a18c0e5df642"
"translation:ggml-indictrans:dist:2:320M:q0f32:1.0.0:hi-hi": "073d52c8d36e0df96bc30a7aa1fb5671d29268d2fe1dbca418768aa61d941925"

// IndicTrans2 - 1B full models (q0f32)
"translation:ggml-indictrans:full:2:1B:q0f32:1.0.0:en-hi": "106ba7af36622420089c6a38fbf4e7a48f50436dfc841c7166660d85b7978905"
"translation:ggml-indictrans:full:2:1B:q0f32:1.0.0:hi-en": "2c77ee91053c3d6d4804d60d87bf8d59fc46296fb32dd4a35f9096e803ed32d2"
"translation:ggml-indictrans:full:2:1B:q0f32:1.0.0:hi-hi": "3e72a3cd967fc723d6643503deca1d7de332ba488e02fbcb81910b4b7ac0024c"

// IndicTrans2 - 1B full models (q0f16)
"translation:ggml-indictrans:full:2:1B:q0f16:1.0.0:en-hi": "be5bff40a002c627a992d096861c0e9b0be6ac7770300cee0bb09ccda87404cb"
"translation:ggml-indictrans:full:2:1B:q0f16:1.0.0:hi-en": "d06c487c56a36bb153d9d33bc1085bc90561d2a8dad5cd5701db782e1540a343"
"translation:ggml-indictrans:full:2:1B:q0f16:1.0.0:hi-hi": "f4edc8b072c34840c08aab2c8abdc288aa2dff8c2ed76fc96ad6604e322a038f"

// IndicTrans2 - 200M distilled models (q0f16)
"translation:ggml-indictrans:full:2:200M:q0f16:1.0.0:en-hi": "42ba45bbf4c24ff743890bc0cc65d8c23c91a14d26f760b3f814df76be8e036f"
"translation:ggml-indictrans:full:2:200M:q0f16:1.0.0:hi-en": "2e35d09ba69dd2b692c668862fdee43fa941859690b1e17aecc96c73474521b9"
"translation:ggml-indictrans:full:2:320M:q0f16:1.0.0:hi-hi": "1bb2ad463127325ca8daa801ec89ae6a2983ddeb90c5461a965e65fa295e3655"

// IndicTrans2 - 1B full models (q4_0)
"translation:ggml-indictrans:full:2:1B:q4_0:1.0.0:en-hi": "9fb5b7338504b24df0f3dd9ae8a1c280c6f00fd7f3295cca8f884514c5fa9713"
"translation:ggml-indictrans:full:2:1B:q4_0:1.0.0:hi-en": "1fd66a6862776a92c7fae1962a1f07a5bc7369fb8be3dd9b76adf7c71855af7f"
"translation:ggml-indictrans:full:2:1B:q4_0:1.0.0:hi-hi": "0f03a3a06bc7006deb0da42643585dc0da49b897ba49e449ec67013ba4464e8a"

// IndicTrans2 - 200M/320M distilled models (q4_0)
"translation:ggml-indictrans:full:2:200M:q4_0:1.0.0:en-hi": "8336d23073b2fd99723bf17d65ddc7b54b8ee886d6627659ba95c7a8fb932dc8"
"translation:ggml-indictrans:full:2:200M:q4_0:1.0.0:hi-en": "ba7db8c0dbcb6fc4276f86a27e3b9dd0f5e90b79f550a1666757f6074e2a4331"
"translation:ggml-indictrans:full:2:320M:q4_0:1.0.0:hi-hi": "6cba73db82148a228bfdc586e2e565db6e6beb476575de3602d927ecb08b1a70"
```

### Key Pattern

Each key in this list follows the general pattern:

```
<task>:<model_family>:<type>:<variant>:<size>:<quantization>:<version>:<source-lang>-<target-lang>
```

For example, `translation:bergamot:nmt::::1.0.0:enit` means:
- **task**: translation
- **model_family**: bergamot
- **type**: nmt
- **version**: 1.0.0
- **languages**: enit (English to Italian)

## Supported Languages

### IndicTrans2 Models (Hyperdrive)

IndicTrans2 supports translation between English and 22 Indic languages. The following directions are available via Hyperdrive:

| Direction | Hyperdrive Keys | Sizes |
|-----------|-----------------|-------|
| English → Indic | Yes | 200M, 1B |
| Indic → English | Yes | 200M, 1B |
| Indic → Indic | Yes | 320M, 1B |

**Supported Indic Languages:**

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

### Bergamot Models (Firefox Translations)

**Language pairs available via Hyperdrive:**

| Language | Code | en→X | X→en |
|----------|------|------|------|
| Arabic | ar | Yes | Yes |
| Czech | cs | Yes | Yes |
| Spanish | es | Yes | Yes |
| French | fr | Yes | Yes |
| Italian | it | Yes | Yes |
| Japanese | ja | Yes | Yes |
| Portuguese | pt | Yes | Yes |
| Russian | ru | Yes | Yes |
| Chinese | zh | Yes | Yes |

The Bergamot backend supports all language pairs available in [Firefox Translations](https://github.com/mozilla/firefox-translations-models). See the Firefox Translations models repository for the complete and up-to-date list of supported language pairs. **Download Firefox Translations models locally only if your language pair is not available via Hyperdrive.**

## ModelClasses and Packages

### ModelClass

The main class exported by this library is `TranslationNmtcpp`, which supports multiple translation backends:

```javascript
const TranslationNmtcpp = require('@qvac/translation-nmtcpp')

// Available model types
TranslationNmtcpp.ModelTypes = {
  IndicTrans: 'IndicTrans',
  Bergamot: 'Bergamot'
}
```

### Available Packages

#### Main Package

| Package | Description | Backends | Languages |
|---------|-------------|----------|-----------|
| `@qvac/translation-nmtcpp` | Main translation package | Bergamot, IndicTrans | See [Supported Languages](#supported-languages) |

The main package supports both backends and all their respective languages. See [Supported Languages](#supported-languages) for the complete list.

## Backends

This project supports multiple backends (Bergamot/Firefox and IndicTrans2).

The Bergamot backend is included in the build by default. To build without Bergamot support (reduces build time and dependencies):

```bash
bare-make generate -D USE_BERGAMOT=OFF
```

## Benchmarking

We conduct comprehensive benchmarking of our translation models to evaluate their performance across different language pairs and metrics. Our benchmarking suite measures translation quality using BLEU and COMET scores, as well as performance metrics including load times and inference speeds.

### Benchmark Results

Benchmarks are run via CI for all supported language pairs and model configurations.

The benchmarking covers:

- **Translation Quality**: BLEU, chrF++, and COMET scores for accuracy assessment
- **Performance Metrics**: Inference speed measured in tokens per second, total load time, and total inference time
- **Language Pairs**: All supported source-target language combinations
- **Model Variants**: Different quantization levels and model sizes

Results are updated regularly as new model versions are released.

## Logging

The library supports configurable logging for both JavaScript and C++ (native) components. By default, C++ logs are suppressed for cleaner output.

### Enabling C++ Logs

To enable verbose C++ logging, pass a `logger` object in the `args` parameter:

```javascript
// Enable C++ logging
const logger = {
  info: (msg) => console.log('[C++ INFO]', msg),
  warn: (msg) => console.warn('[C++ WARN]', msg),
  error: (msg) => console.error('[C++ ERROR]', msg),
  debug: (msg) => console.log('[C++ DEBUG]', msg)
}

const args = {
  loader: hdDL,
  params: { mode: 'full', srcLang: 'en', dstLang: 'it' },
  diskPath: './models/bergamot-en-it',
  modelName: 'model.enit.intgemm.alphas.bin',
  logger
}
```

### Disabling C++ Logs

To suppress all C++ logs, either omit the `logger` parameter or set it to `null`:

```javascript
const args = {
  loader: hdDL,
  params: { mode: 'full', srcLang: 'en', dstLang: 'it' },
  diskPath: './models/bergamot-en-it',
  modelName: 'model.enit.intgemm.alphas.bin'
}
```

### Using Environment Variables (Recommended for Examples)

All examples support the `VERBOSE` environment variable:

```bash
# Run with C++ logging disabled (default)
bare examples/example.hd.js

# Run with C++ logging enabled
VERBOSE=1 bare examples/example.hd.js
```

### Log Levels

The C++ backend supports these log levels (mapped from native priority):

| Priority | Level | Description |
|----------|-------|-------------|
| 0 | `error` | Critical errors |
| 1 | `warn` | Warnings |
| 2 | `info` | Informational messages |
| 3 | `debug` | Debug/trace messages |

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

## Glossary

- **Bare** – Lightweight, modular JavaScript runtime for desktop and mobile. [Docs](https://docs.pears.com/reference/bare-overview.html)
- **Hyperdrive** – Secure, real-time distributed filesystem enabling P2P file sharing. [Docs](https://docs.pears.com/building-blocks/hyperdrive)
- **Hyperbee** – Decentralized B-tree built on Hypercores, with a key-value API. [Docs](https://docs.pears.com/building-blocks/hyperbee)
- **Corestore** – Factory for managing named collections of Hypercores. [Docs](https://docs.pears.com/helpers/corestore)
- **QVAC** – Open-source SDK for building decentralized AI applications.
- **QVACResponse** –  The response object used by the QVAC API. [GitHub](https://github.com/tetherto/qvac-lib-response)
- **DataLoader** – Abstraction for fetching model weights and resources. 
  Implementations include:
  - **`HyperdriveDL`** – Loads from a Hyperdrive instance [GitHub](https://github.com/tetherto/qvac/tree/main/packagesdl-hyperdrive)
  - **`fsDL`** – Loads from the local filesystem [GitHub](https://github.com/tetherto/qvac/tree/main/packages/dl-filesystem)

## Resources

- **Pear Platform** – Decentralized platform for deploying apps. [pears.com](https://pears.com/)
- **Bare Runtime Docs** – For running QVAC apps in a lightweight environment. [docs.pears.com/bare](https://docs.pears.com/reference/bare-overview.html)
- **IndicTrans2 Model** – Pretrained multilingual translation models. [AI4Bharat/IndicTrans2](https://github.com/AI4Bharat/IndicTrans2)
- **Translation App Example** – QVAC-based translation application. [qvac-examples/translation-app](https://github.com/tetherto/qvac-examples/tree/main/translation-app)

## Contributing

We welcome contributions! Here's how to get started:

### Building from Source

This project contains C++ native addons that must be built before running tests.

```bash
# 1. Clone the monorepo
git clone https://github.com/tetherto/qvac.git
cd qvac/packages/qvac-lib-infer-nmtcpp

# 2. Install dependencies
npm install

# 3. Build the native addon
npm run build
```

> **Note:** Building requires CMake, a C++ compiler (GCC/Clang), and vcpkg. See the build prerequisites in the CI workflow for full system requirements.

### Development Workflow

1. **Fork** the monorepo
2. **Clone** your fork: `git clone https://github.com/YOUR_USERNAME/qvac.git`
3. **Navigate**: `cd qvac/packages/qvac-lib-infer-nmtcpp`
4. **Install and build**: `npm install && npm run build`
5. **Create a branch**: `git checkout -b feature/your-feature-name`
6. **Make changes** and ensure tests pass: `npm test`
7. **Commit** with a descriptive message: `git commit -m "feat: add your feature"`
8. **Push** to your fork: `git push origin feature/your-feature-name`
9. **Open a Pull Request** against the `main` branch

### Code Style

This project uses [StandardJS](https://standardjs.com/) for JavaScript linting:

```bash
npm run lint        # Check for lint errors
npm run lint:fix    # Auto-fix lint errors
```

### Running Tests

```bash
npm test            # Run all tests (lint + unit + integration)
npm run test:unit   # Unit tests only
npm run test:cpp    # C++ tests only (requires build first)
```

## License

This project is licensed under the Apache-2.0 License - see the [LICENSE](LICENSE) file for details.<br>
For any questions or issues, please open an issue on the GitHub repository.
