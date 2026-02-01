# Translation Addons

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Bare](https://img.shields.io/badge/Bare-%3E%3D1.19.0-green.svg)](https://docs.pears.com/bare-reference/overview)

This library simplifies the process of running various translation models within [`QVAC`](#glossary) runtime applications. It provides a seamless interface to load, execute, and manage translation addons, offering support for multiple data sources (called data loaders).

## Table of Contents

- [Supported Platforms](#supported-platforms)
- [Installation](#installation)
- [Usage](#usage)
  - [1. Create DataLoader](#1-create-dataloader)
  - [2. Create the `args` object](#2-create-the-args-object)
  - [3. Create the `config` object](#3-create-the-config-object)
  - [4. Create Model Instance](#4-create-model-instance)
  - [5. Load Model](#5-load-model)
  - [6. Run the Model](#6-run-the-model)
  - [7. Batch Translation (Bergamot Only)](#7-batch-translation-bergamot-only)
  - [8. Unload the Model](#8-unload-the-model)
- [Quickstart Example](#quickstart-example)
- [Other Examples](#other-examples)
- [Model Registry](#model-registry)
- [Supported Languages](#supported-languages)
- [ModelClasses and Packages](#modelclasses-and-packages)
- [Backends](#backends)
- [Benchmarking](#benchmarking)
- [Logging](#logging)
- [Testing](#testing)
- [Glossary](#glossary)
- [Resources](#resources)
- [Contributing](#contributing)
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

> **Note:** Bare version must be **1.17.3 or higher**. Verify your version with:

```bash
bare -v
```

### Installing the Package

Install the main translation package via npm: 

```bash
# Main package - supports OPUS, Bergamot, and IndicTrans backends (all languages)
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

#### OPUS/Marian Model (Default)

For European language translations using OPUS models from Hyperdrive:

```javascript
const HyperdriveDL = require('@qvac/dl-hyperdrive')

const hdDL = new HyperdriveDL({
  key: 'hd://528eb43b34c57b0fb7116e532cd596a9661b001870bdabf696243e8d079a74ca' // en-it model (MARIAN_OPUS_EN_IT)
})

const args = {
  loader: hdDL,
  params: {
    mode: 'full',      // Model loading mode (full is recommended)
    srcLang: 'en',     // Source language (ISO 639-1 code)
    dstLang: 'it'      // Target language (ISO 639-1 code)
  },
  diskPath: './models/opus-en-it',  // Unique directory per model
  modelName: 'model.bin'            // Always 'model.bin' for OPUS models
}
```

**Key Parameters:**
| Parameter | Description | Example |
|-----------|-------------|---------|
| `srcLang` | Source language (ISO 639-1) | `'en'`, `'de'`, `'it'`, `'es'`, `'fr'` |
| `dstLang` | Target language (ISO 639-1) | `'en'`, `'de'`, `'it'`, `'es'`, `'fr'` |
| `modelName` | Always `'model.bin'` | `'model.bin'` |

---

#### IndicTrans2 Model

For Indic language translations (English ↔ Hindi, Bengali, Tamil, etc.):

```javascript
const HyperdriveDL = require('@qvac/dl-hyperdrive')

const hdDL = new HyperdriveDL({
  key: 'hd://8c0f50e7c75527213a090d2f1dcd9dbdb8262e5549c8cbbb74cb7cb12b156892' // en-hi 200M model (MARIAN_EN_HI_INDIC_200M_Q0F32)
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
> - `./models/opus-en-it` for OPUS English→Italian
> - `./models/indic-en-hi-200M` for IndicTrans English→Hindi
> - `./models/bergamot-en-it` for Bergamot English→Italian

> **Note:** The list of supported languages for the `srcLang` and `dstLang` parameters differ by model type. Please refer to the [Supported Languages](#supported-languages) section for details.

### 3. Create the `config` object

The `config` object contains two types of parameters:

1. **Model-specific parameters** (required for some backends)
2. **Generation/decoding parameters** (optional, controls output quality)

#### Model-Specific Parameters

| Parameter | OPUS/Marian | IndicTrans2 | Bergamot |
|-----------|-------------|-------------|----------|
| `modelType` | Not needed (default) | **Required** | **Required** |
| `srcVocabName` | Not needed | Not needed | **Required** |
| `dstVocabName` | Not needed | Not needed | **Required** |

#### Generation/Decoding Parameters (OPUS/IndicTrans Only)

These parameters control how the model generates output. **Note:** Full parameter support is only available for OPUS/Marian and IndicTrans2 models. Bergamot has limited parameter support.

```javascript
// Generation parameters for OPUS/Marian and IndicTrans2
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

#### OPUS/Marian (Default)

```javascript
// OPUS - combine generation parameters (modelType defaults to Opus)
const config = {
  ...generationParams,  // Spread generation params from Step 3
  beamsize: 4,          // Or override specific values
  maxlength: 128
}

const model = new TranslationNmtcpp(args, config)
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
  Opus: 'Opus',           // Default - Marian OPUS models
  IndicTrans: 'IndicTrans', // Indic language models  
  Bergamot: 'Bergamot'    // Firefox Translations models
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

> **Important:** `runBatch()` is only available with the **Bergamot backend**. OPUS/Marian and IndicTrans2 models should use sequential `run()` calls.

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
| `run(text)` | Single string | `QVACResponse` with streaming | All (OPUS, IndicTrans, Bergamot) |
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

- **Pause and Resume:** Translation can be paused and resumed (see [`examples/pause.example.js`](examples/pause.example.js))
- **Progress Tracking:** Monitor loading progress with a callback function
- **Performance Stats:** Measure inference time with the `stats` option

For a complete working example that brings all these steps together, see the [Quickstart Example](#quickstart-example) below.

## Quickstart Example

This quickstart demonstrates **OPUS/Marian model** inference (Italian → English translation).

> **Other Model Types:** For IndicTrans2 or Bergamot models, refer to [Section 2: Create the args object](#2-create-the-args-object) for model-specific configuration.

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

### 3. Create `example.js` and paste the following code into it

```bash
touch example.js
```

```javascript
// example.js

'use strict'

// Note: This import will depend on the addon package installed
const TranslationNmtcpp = require('@qvac/translation-nmtcpp')
const HyperdriveDL = require('@qvac/dl-hyperdrive')

const text = 'La traduzione automatica ha rivoluzionato il modo in cui comunichiamo attraverso le barriere linguistiche nel mondo digitale moderno.'

async function main () {
  // 1. Create `DataLoader`
  const hdDL = new HyperdriveDL({
    // The hyperdrive key for it-en translation model weights and config
    // From qvac-sdk models.ts: MARIAN_OPUS_IT_EN_Q0F32
    key: 'hd://ee90217a3b0039b48865ec23af102e8a8afafb964ebb45f56f1bed63ac4a0633'
  })

  // 2. Create the `args` object
  const args = {
    loader: hdDL,
    params: { mode: 'full', dstLang: 'en', srcLang: 'it' },
    diskPath: './models/opus-it-en', // Unique path for this model
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
Machine translation has revolutionized the way we communicate across language barriers in the modern digital world.
translation finished!
```

### Adapting for Other Model Types

To use **IndicTrans2** or **Bergamot** models instead, modify the `args` and `config` objects as shown in [Section 2: Create the args object](#2-create-the-args-object) and [Section 4: Create Model Instance](#4-create-model-instance).

**Quick Reference:**

| Model Type | Key Changes |
|------------|-------------|
| **IndicTrans2** | Use ISO 15924 language codes (`eng_Latn`, `hin_Deva`), specific `modelName`, add `modelType: IndicTrans` |
| **Bergamot** | Use Bergamot hyperdrive key (or local files), specific `modelName` (e.g., `model.enit.intgemm.alphas.bin`), add `srcVocabName`, `dstVocabName`, `modelType: Bergamot` |

## Other Examples

For more detailed examples covering different use cases, refer to the `examples/` directory:

| Example | Description | Model Type |
|---------|-------------|------------|
| [example.hd.js](examples/example.hd.js) | Hyperdrive Data Loader for Marian model inference | OPUS/Marian |
| [indictrans.js](examples/indictrans.js) | English-to-Hindi translation with IndicTrans2 | IndicTrans2 |
| [batch.example.js](examples/batch.example.js) | Batch translation with `runBatch()` method | Bergamot |
| [pause.example.js](examples/pause.example.js) | Pausing and resuming during inference | Any |
| [quickstart.js](examples/quickstart.js) | Both GGML and Bergamot backends | Multiple |

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

### OPUS/Marian Models

```javascript
// OPUS models - q0f32 (32-bit float)
"translation:marian:opus-ggml:::q0f32:1.0.0:en-it": "528eb43b34c57b0fb7116e532cd596a9661b001870bdabf696243e8d079a74ca"
"translation:marian:opus-ggml:::q0f32:1.0.0:de-en": "f60e55fb7859536ea4e2361c5168ce175cb34b251e0ae00b7c8f68ecc0571d0c"
"translation:marian:opus-ggml:::q0f32:1.0.0:de-es": "cd8e6a6b0c306c2594fb2ec80d27d40a749dc9cf49102f0aa9b4f2496568ac53"
"translation:marian:opus-ggml:::q0f32:1.0.0:de-fr": "390d1b4164b46d332a82220d83867e1aa19058fb0ccff6d841de792066f992e5"
"translation:marian:opus-ggml:::q0f32:1.0.0:de-it": "0d534e862018e00a472ba80b5a0a931e5cccc0637578bbe36ce97682fe6a5412"
"translation:marian:opus-ggml:::q0f32:1.0.0:en-de": "7f23b4736a1428b60ae665f558ef48d6c70dc2642a4901d3336e02438ea5e752"
"translation:marian:opus-ggml:::q0f32:1.0.0:en-es": "53760abc441457efbb27047798683723962c9cdb825d645649d50351be326f55"
"translation:marian:opus-ggml:::q0f32:1.0.0:en-fr": "2957a3e18426d09335d0068efac0726f9945fe72ebbf4161dbc65111c85f6631"
"translation:marian:opus-ggml:::q0f32:1.0.0:en-pt": "9eb7a478a6e14aef61f618e531061900a2d9a2d55e693dc464560db92861cba4"
"translation:marian:opus-ggml:::q0f32:1.0.0:es-de": "b1029d997c3dc4df757fa7093780e26742297ec093e0fa0c951d49d06f7b7037"
"translation:marian:opus-ggml:::q0f32:1.0.0:es-en": "73fb3a48ecf2f113710765ba28dd5d5723622f43955d88acbe7f0ec7c7b4d5e2"
"translation:marian:opus-ggml:::q0f32:1.0.0:es-fr": "f43966d16f04b108641de97050563515f699c7426c6aa08f54ee28cbea07a1dd"
"translation:marian:opus-ggml:::q0f32:1.0.0:es-it": "d41c61697c19a2b771439101569935129eb39c324e259a6865f825242e60c212"
"translation:marian:opus-ggml:::q0f32:1.0.0:fr-de": "d4defd18e51d55eb20957169b2fdfef18627ce01e06d56d40735c429c980a149"
"translation:marian:opus-ggml:::q0f32:1.0.0:fr-en": "c1226000901bf7e25507b414ffb60e0c8f5cf198de115559dc6bd68826033f20"
"translation:marian:opus-ggml:::q0f32:1.0.0:fr-es": "6ecc35234eafa3578323591a0872d812479b3937c1a10e303475c9d4614f4ac0"
"translation:marian:opus-ggml:::q0f32:1.0.0:it-de": "6827f57d0aab9dd0194d06bc94cf12ccafe2a5d4d18e72b4bbaa2c3eb30aeea7"
"translation:marian:opus-ggml:::q0f32:1.0.0:it-en": "ee90217a3b0039b48865ec23af102e8a8afafb964ebb45f56f1bed63ac4a0633"
"translation:marian:opus-ggml:::q0f32:1.0.0:it-es": "d6c7482d24e0e24af399151e22f233e86ca3ced411d5fb892772567b4f625ff5"

// OPUS models - q0f16 (16-bit float)
"translation:marian:opus-ggml:::q0f16:1.0.0:de-fr": "55fe6cf0f6f57e4e5b7ca2b1c544e95f91eb8429d7f056c455e9a8c2677a08fb"
"translation:marian:opus-ggml:::q0f16:1.0.0:en-fr": "5b9b65bd8735f91d45103c0b44530823274534230623957db5839c748ba30bf0"
"translation:marian:opus-ggml:::q0f16:1.0.0:en-pt": "098cc786de52e61b8b543f0e0c2e16e054ff19b9f9aef41ec931191c939f8e12"
"translation:marian:opus-ggml:::q0f16:1.0.0:es-fr": "2313996f5c2a6265c202c90d07fcbd7f324d166428109abdb16ca11f66305510"
"translation:marian:opus-ggml:::q0f16:1.0.0:fr-de": "14dbccb2c678d45dbd3bd3d0676be9d869b2b6f2ac3fca870f0dcd5a75a0d0d0"
"translation:marian:opus-ggml:::q0f16:1.0.0:fr-en": "bd1fe00d165a2da2bfb5ea67485602ede700986e40ddd7698b7c37412af01065"
"translation:marian:opus-ggml:::q0f16:1.0.0:fr-es": "710aeacb0e1a0c938478b1e065b06c58be210a8ddb0bc25edb98a809997d2d14"
"translation:marian:opus-ggml:::q0f16:1.0.0:pt-en": "821af2699a40bbec2f2fce6276f59c714285f13780cacae3f023cb44c6c6cad1"
"translation:marian:opus:::q0f16:1.0.0:en-ru": "65f1ae4ae53764d7f9ae2d1581819b4b3dd6011d30079f4445c5db74c40dd533"
"translation:marian:opus:::q0f16:1.0.0:ru-en": "e42148ee7181f908ac2e6ba979d02de96faf330e4f7bad3bf766415657931d48"

// OPUS models - q4_0 (4-bit quantized)
"translation:marian:opus-ggml:::q4_0:1.0.0:de-fr": "3782fc852215514aee043e095c041933bf915f618057035a467f461d844476d3"
"translation:marian:opus-ggml:::q4_0:1.0.0:en-fr": "9cf4a27c1ba14f73d1287dc161b7fd9594253b8e8758bddc961984c1e93d6f5e"
"translation:marian:opus-ggml:::q4_0:1.0.0:en-pt": "a58825b2dcde4c4701889c20050e025df4d69f1161c9d2d2e6106712d70b2ace"
"translation:marian:opus-ggml:::q4_0:1.0.0:es-fr": "446daa51a5f037795fce6b0f9b245f53f3f5e601d4dd942b707073bed3586ac4"
"translation:marian:opus-ggml:::q4_0:1.0.0:fr-de": "a85185a5747e16cff9db0b2c8ab92b63fbe3c4abc5201c6afa4fd426fabd1cb5"
"translation:marian:opus-ggml:::q4_0:1.0.0:fr-en": "688b8d7e82d33c8dd18e156282a1b11e97247d04327e0f7549694f4433861262"
"translation:marian:opus-ggml:::q4_0:1.0.0:fr-es": "07c3d283e1d22b7a44cb16ed3c733d958885502e293ca75a0b4d87d1aecfc653"
"translation:marian:opus:::q4_0:1.0.0:ar-en": "b92b8b3c369a18d3b7b787848b75a0bec6ec76e585b38dc6d7b0d443cd38a25c"
"translation:marian:opus:::q4_0:1.0.0:de-en": "b7f74bad18de10f86237b2bf523daad7e8274b5ae4a56c072a416311032fe5ba"
"translation:marian:opus:::q4_0:1.0.0:en-ar": "b407eed23bce20b10f84697ba4582e46bf6ea382afb93f7d6fe00c93d7d4d4a0"
"translation:marian:opus:::q4_0:1.0.0:en-de": "396f08beaec748cc5ff167ee5d568beda32cef09f6b20658a05e1472185c71c0"
"translation:marian:opus:::q4_0:1.0.0:en-es": "3e7ccb4270032fea10a4697fa68ebaf6771ce8f05488dcc679e462276794b53c"
"translation:marian:opus:::q4_0:1.0.0:en-it": "4aa1a3960f33d6bda61be4810c5e337729daef9f18e0a5e18de135e5be838d7c"
"translation:marian:opus:::q4_0:1.0.0:en-ja": "12fd8ee6fd0b69797f21909aeaf27d8dc68ee0ea8894658a3efca9a43291dbc2"
"translation:marian:opus:::q4_0:1.0.0:en-roa": "ed894bfc0e3ceb90f35c417283fcdcb191eca5973334cc6691344ecc813f444f"
"translation:marian:opus:::q4_0:1.0.0:en-ru": "1a09d02d589f030b0f63e545c1f20bc6b7f2f7bfda25fdb9dc9370a7f576d09d"
"translation:marian:opus:::q4_0:1.0.0:en-zh": "b4d1198162fdc96f303e41046076543ae181a7c87d7ecc05fe98eae2f00481fe"
"translation:marian:opus:::q4_0:1.0.0:es-en": "9442ba70fea93cb85f55c44e2859b10c5cc621686ed8a414fb4591bc9634fe47"
"translation:marian:opus:::q4_0:1.0.0:it-en": "925c7e041fc536f4bcd0047e5aca594d49650c6e855b3dfb567e20f08db78262"
"translation:marian:opus:::q4_0:1.0.0:ja-en": "abe44f20b5acd6c7b6f581109c6d2e23fe1888ef16494c609e86f44e23055035"
"translation:marian:opus:::q4_0:1.0.0:roa-en": "fca28b2c128f20292b8c978be88515d9880c35914bae9df2511f4dcb07ad9b6e"
"translation:marian:opus:::q4_0:1.0.0:ru-en": "47b2ec9c205a8624bb7460d9a7def7806cb368401d556454992c73d8fbffc423"
"translation:marian:opus:::q4_0:1.0.0:zh-en": "4773c185a8fe1f2a63c686996d1817b0c052e17a8aa6488a39d85c81bb726ef4"

// OPUS models - q4f16_1 (mixed precision)
"translation:marian:opus:::q4f16_1:1.0.0:en-ja": "2e6e274e9bb86774a64880ccd89660d3d5d5901f0bf39116d460350b06adb3a3"
"translation:marian:opus:::q4f16_1:1.0.0:ja-en": "0e795244ad5cf38dac6fe28deec8f97b37c95907d734a50f620670dc9d0a8e5b"

// OPUS models - q0f32 for Russian
"translation:marian:opus:::q0f32:1.0.0:en-ru": "c009326acc2c3eeb5d557489370cf7b6de07d35335cb47e9a3e90909f9ac6c44"
"translation:marian:opus:::q0f32:1.0.0:ru-en": "12d0af03637c3902beff9bf6e2d854f103ef4745694587c9a67044ff6accb493"
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

For example, `translation:marian:opus-ggml:::q0f32:1.0.0:en-it` means:
- **task**: translation
- **model_family**: marian
- **type**: opus-ggml
- **quantization**: q0f32 (32-bit float)
- **version**: 1.0.0
- **languages**: en-it (English to Italian)

## Supported Languages

### Marian/OPUS Models (Hyperdrive)

The following language pairs are available via Hyperdrive. See [Model Registry](#model-registry) for hyperdrive keys.

**Core European Languages (with cross-language support):**
| Language | Code | Supported Pairs | Hyperdrive |
|----------|------|-----------------|------------|
| English | en | ↔ de, es, it, fr, pt, ru, ar, ja, zh | Yes |
| German | de | ↔ en, es, it, fr | Yes |
| Spanish | es | ↔ en, de, it, fr | Yes |
| Italian | it | ↔ en, de, es | Yes |
| French | fr | ↔ en, de, es | Yes |

**Other Languages (English ↔ X):**
| Language | Code | Hyperdrive |
|----------|------|------------|
| Portuguese | pt | Yes |
| Russian | ru | Yes |
| Arabic | ar | Yes |
| Japanese | ja | Yes |
| Chinese | zh | Yes |

> **Legend:** `↔` = bidirectional support available in Hyperdrive

> **Note:** The OPUS project supports many more language pairs. Only the pairs listed above are currently available via Hyperdrive. Additional models may be added in future updates.

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
  IndicTrans: 'IndicTrans',  // For Indic language translations
  Opus: 'Opus',              // For Marian OPUS models
  Bergamot: 'Bergamot'       // For Bergamot/Firefox translations
}
```

### Available Packages

#### Main Package

| Package | Description | Backends | Languages |
|---------|-------------|----------|-----------|
| `@qvac/translation-nmtcpp` | Main translation package | OPUS, Bergamot, IndicTrans | See [Supported Languages](#supported-languages) |

The main package supports all three backends and all their respective languages. See [Supported Languages](#supported-languages) for the complete list.

## Backends

This project supports multiple backends (e.g., Marian/OPUS, Bergamot/Firefox, IndicTrans2).

Bergamot backend is enabled by default.

```bash
bare-make generate
```

To disable it, set the flag as follows during generation:

```bash
bare-make generate -D USE_BERGAMOT=OFF
```

## Benchmarking

We conduct comprehensive benchmarking of our translation models to evaluate their performance across different language pairs and metrics. Our benchmarking suite measures translation quality using BLEU and COMET scores, as well as performance metrics including load times and inference speeds.

### Benchmark Results

For detailed benchmark results across all supported language pairs and model configurations, see our [Benchmark Results Summary](benchmarks/results/marian/results_summary.md).

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
  diskPath: './models/opus-en-it',
  modelName: 'model.bin',
  logger  // Pass logger to enable C++ logs
}
```

### Disabling C++ Logs

To suppress all C++ logs, either omit the `logger` parameter or set it to `null`:

```javascript
const args = {
  loader: hdDL,
  params: { mode: 'full', srcLang: 'en', dstLang: 'it' },
  diskPath: './models/opus-en-it',
  modelName: 'model.bin'
  // No logger = suppress C++ logs
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

## Contributing

We welcome contributions! Here's how to get started:

### Building from Source

This project contains C++ native addons that must be built before running tests.

```bash
# 1. Clone with submodules
git clone --recursive https://github.com/tetherto/qvac-lib-infer-nmtcpp.git
cd qvac-lib-infer-nmtcpp

# Or if already cloned, initialize submodules:
git submodule update --init --recursive

# 2. Install dependencies
npm install

# 3. Build the native addon
npm run build
```

> **Note:** Building requires CMake, a C++ compiler (GCC/Clang), and vcpkg. See the build prerequisites in the CI workflow for full system requirements.

### Development Workflow

1. **Fork** the repository
2. **Clone** your fork with submodules: `git clone --recursive https://github.com/YOUR_USERNAME/qvac-lib-infer-nmtcpp.git`
3. **Install and build**: `npm install && npm run build`
4. **Create a branch**: `git checkout -b feature/your-feature-name`
5. **Make changes** and ensure tests pass: `npm test`
6. **Bump version** in `package.json` if your changes require a release (bug fixes, features, breaking changes)
7. **Commit** with a descriptive message: `git commit -m "feat: add your feature"`
8. **Push** to your fork: `git push origin feature/your-feature-name`
9. **Open a Pull Request**
   * Use `/prepare_release_notes` in Cursor to generate release notes for your changes (creates `release-notes/vX.Y.Z.md`)
   * Use `/prepare_pr` in Cursor to automatically generate a PR description and create the pull request
   * The PR description will be populated based on `PULL_REQUEST_TEMPLATE.md`

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
