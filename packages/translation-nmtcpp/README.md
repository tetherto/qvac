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
    - [1. Obtain Model Files](#1-obtain-model-files)
    - [2. Create the constructor arguments](#2-create-the-constructor-arguments)
      - [IndicTrans2 Model](#indictrans2-model)
      - [Bergamot Model](#bergamot-model)
    - [3. Create the `config` object](#3-create-the-config-object)
      - [Model-Specific Parameters](#model-specific-parameters)
      - [Generation/Decoding Parameters (IndicTrans Only)](#generationdecoding-parameters-indictrans-only)
      - [Backend & GPU Settings](#backend--gpu-settings)
    - [4. Create Model Instance](#4-create-model-instance)
      - [IndicTrans2](#indictrans2)
      - [Bergamot](#bergamot)
    - [5. Load Model](#5-load-model)
    - [6. Run the Model](#6-run-the-model)
    - [7. Batch Translation](#7-batch-translation)
    - [8. Unload the Model](#8-unload-the-model)
    - [9. Pivot Translation (Bergamot)](#9-pivot-translation-bergamot)
    - [Additional Features](#additional-features)
  - [API Reference](#api-reference)
    - [Methods](#methods)
    - [RuntimeStats](#runtimestats)
    - [Errors](#errors)
    - [Subpath exports](#subpath-exports)
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
    - [IndicTrans2 Language Pairs](#indictrans2-language-pairs)
    - [Bergamot Models (Firefox Translations)](#bergamot-models-firefox-translations-1)
  - [ModelClasses and Packages](#modelclasses-and-packages)
    - [ModelClass](#modelclass)
    - [Available Packages](#available-packages)
      - [Main Package](#main-package)
  - [Backends](#backends)
    - [Translation backend build flags](#translation-backend-build-flags)
    - [Compute backend selection](#compute-backend-selection)
    - [Compute backend build flag](#compute-backend-build-flag)
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


### 1. Obtain Model Files

Before creating a model instance, you need the model files on disk. There are two options:

- **Bergamot models:** Use `ensureBergamotModelFiles()` from `lib/bergamot-model-fetcher` to auto-download from Firefox CDN, or provide a local path.
- **IndicTrans2 models:** Provide a local path to the GGML model file.

See the [Quickstart Example](#quickstart-example) for a complete working example.

### 2. Create the constructor arguments

The constructor accepts a single object with `files`, `params`, `config`, and an optional `logger`. The structure varies slightly depending on which backend you're using:

---

#### IndicTrans2 Model

For Indic language translations (English ↔ Hindi, Bengali, Tamil, etc.):

```javascript
const model = new TranslationNmtcpp({
  files: { model: './models/ggml-indictrans2-en-indic-dist-200M.bin' },
  params: {
    srcLang: 'eng_Latn',   // Source language (ISO 15924 code)
    dstLang: 'hin_Deva'    // Target language (ISO 15924 code)
  },
  config: {
    modelType: TranslationNmtcpp.ModelTypes.IndicTrans
  }
})
```

**Key Parameters:**
| Parameter | Description | Example |
|-----------|-------------|---------|
| `files.model` | Path to GGML model file | `'./models/ggml-indictrans2-en-indic-dist-200M.bin'` |
| `params.srcLang` | Source language (ISO 15924) | `'eng_Latn'`, `'hin_Deva'`, `'ben_Beng'` |
| `params.dstLang` | Target language (ISO 15924) | `'eng_Latn'`, `'hin_Deva'`, `'tam_Taml'` |
| `config.modelType` | **Required**: `TranslationNmtcpp.ModelTypes.IndicTrans` | - |

**IndicTrans2 model naming pattern:**
- `ggml-indictrans2-{direction}-{size}.bin` for q0f32 quantization
- `ggml-indictrans2-{direction}-{size}-q0f16.bin` for q0f16 quantization
- `ggml-indictrans2-{direction}-{size}-q4_0.bin` for q4_0 quantization

Where `direction` is `en-indic`, `indic-en`, or `indic-indic`, and `size` is `dist-200M`, `dist-320M`, or `1B`.

---

#### Bergamot Model

Bergamot models (Firefox Translations) are downloaded automatically or provided as local files. Use `ensureBergamotModelFiles()` to handle download from Firefox CDN:

```javascript
const TranslationNmtcpp = require('@qvac/translation-nmtcpp')
const path = require('bare-path')

const { ensureBergamotModelFiles, getBergamotFileNames } = require('@qvac/translation-nmtcpp/lib/bergamot-model-fetcher')

const srcLang = 'en'
const dstLang = 'it'
const modelDir = await ensureBergamotModelFiles(srcLang, dstLang, './models/bergamot-en-it')
const fileNames = getBergamotFileNames(srcLang, dstLang)

const model = new TranslationNmtcpp({
  files: {
    model: path.join(modelDir, fileNames.modelName),
    srcVocab: path.join(modelDir, fileNames.srcVocabName),
    dstVocab: path.join(modelDir, fileNames.dstVocabName)
  },
  params: {
    srcLang,   // Source language (ISO 639-1 code)
    dstLang    // Target language (ISO 639-1 code)
  },
  config: {
    modelType: TranslationNmtcpp.ModelTypes.Bergamot
  }
})
```

**Bergamot Model Files by Language Pair:**

| Language Pair | Model File | Vocab File(s) |
|---------------|------------|---------------|
| en→it | `model.enit.intgemm.alphas.bin` | `vocab.enit.spm` |
| it→en | `model.iten.intgemm.alphas.bin` | `vocab.iten.spm` |
| en→es | `model.enes.intgemm.alphas.bin` | `vocab.enes.spm` |
| es→en | `model.esen.intgemm.alphas.bin` | `vocab.esen.spm` |
| en→fr | `model.enfr.intgemm.alphas.bin` | `vocab.enfr.spm` |
| fr→en | `model.fren.intgemm.alphas.bin` | (see registry) |
| en→de | `model.ende.intgemm.alphas.bin` | `vocab.ende.spm` |
| en→ru | `model.enru.intgemm.alphas.bin` | `vocab.enru.spm` |
| ru→en | `model.ruen.intgemm.alphas.bin` | `vocab.ruen.spm` |
| en→zh | `model.enzh.intgemm.alphas.bin` | `srcvocab.enzh.spm`, `trgvocab.enzh.spm` |
| zh→en | `model.zhen.intgemm.alphas.bin` | `vocab.zhen.spm` |
| en→ja | `model.enja.intgemm.alphas.bin` | `srcvocab.enja.spm`, `trgvocab.enja.spm` |
| ja→en | `model.jaen.intgemm.alphas.bin` | `vocab.jaen.spm` |

**Key Parameters:**
| Parameter | Description | Example |
|-----------|-------------|---------|
| `params.srcLang` | Source language (ISO 639-1) | `'en'`, `'es'`, `'de'` |
| `params.dstLang` | Target language (ISO 639-1) | `'it'`, `'fr'`, `'de'` |
| `files.model` | Path to model weights file | `'./models/bergamot-en-it/model.enit.intgemm.alphas.bin'` |
| `files.srcVocab` | Path to source vocab file | `'./models/bergamot-en-it/vocab.enit.spm'` |
| `files.dstVocab` | Path to target vocab file | `'./models/bergamot-en-it/vocab.enit.spm'` |
| `config.modelType` | **Required**: `TranslationNmtcpp.ModelTypes.Bergamot` | - |

**Bergamot model file naming convention:**
- `model.{srctgt}.intgemm.alphas.bin` - Model weights (e.g., `model.enit.intgemm.alphas.bin`)
- `vocab.{srctgt}.spm` - Shared vocabulary for most language pairs
- `srcvocab.{srctgt}.spm` + `trgvocab.{srctgt}.spm` - Separate vocabs for CJK languages (zh, ja)

---

> **Note:** The list of supported languages for the `srcLang` and `dstLang` parameters differ by model type. Please refer to the [Supported Languages](#supported-languages) section for details.

### 3. Create the `config` object

The `config` object is passed inside the constructor arguments (see step 2). It contains:

1. **Model-specific parameters** (required for some backends)
2. **Generation/decoding parameters** (optional, controls output quality)

#### Model-Specific Parameters

| Parameter | IndicTrans2 | Bergamot |
|-----------|-------------|----------|
| `config.modelType` | **Required** | **Required** |
| `files.srcVocab` | Not needed | **Required** (path to source vocab) |
| `files.dstVocab` | Not needed | **Required** (path to target vocab) |

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

#### Backend & GPU Settings

These config keys control which compute backend the native addon picks at load time. They are read once at `load()`; changing them after load has no effect (call `unload()` + `load()` to re-select a backend).

```javascript
const backendSettings = {
  use_gpu: true,              // Enable GPU inference (default: false → CPU-only)
  gpu_backend: 'vulkan',      // Optional: pick a specific backend by name substring
  gpu_device: 0,              // Optional: ordinal within matching devices (default: 0)
  backendsDir: './prebuilds', // Optional: dir where libqvac-ggml-*.so / *.dll live
  openclCacheDir: '/path/ok'  // Optional (Android only): OpenCL kernel-cache dir
}
```

The three GPU control keys each accept a camelCase alias alongside the snake_case primary. Snake_case mirrors the C-struct field names; camelCase matches the sibling addon convention. When both forms are present in the same config object, **snake_case takes precedence**.

| Key | Alias | Type | Description |
|-----|-------|------|-------------|
| `use_gpu` | `useGPU` | boolean | Enable GPU inference. When `false` (default), only the CPU backend is used. Bergamot is CPU-only by design — this flag is effectively a no-op for Bergamot. |
| `gpu_backend` | `gpuBackend` | string | Case-insensitive **substring** match against the ggml device name (e.g. `"vulkan"`, `"vulkan0"`, `"opencl"`, `"metal"`). When set, the selector runs a single explicit pass and picks the first non-CPU device whose name contains the substring. When unset, the default gated selection runs (see [Backends](#backends)). Explicit `"opencl"` bypasses the build-time `USE_OPENCL` guard — an informed opt-in. |
| `gpu_device` | `gpuDevice` | int | Ordinal within the matching devices. Defaults to `0` (first match). Example: `{gpu_backend: "vulkan", gpu_device: 1}` picks the second Vulkan adapter. |
| `backendsDir` | — | string | Path to the directory containing the runtime backend shared libraries (`libqvac-ggml-vulkan.so`, etc.). Defaults to `<package>/prebuilds` when unset, which is where `npm install` places the shipped prebuilds. Must be an absolute path; paths with `..` segments or unresolvable symlinks are rejected with a warning and fall back to the default prebuilds directory. |
| `openclCacheDir` | — | string | **Android only.** Writable directory the OpenCL backend uses for its JIT kernel cache (forwarded via `GGML_OPENCL_CACHE_DIR`). Must be an absolute path; paths with `..` segments are rejected. The OpenCL backend falls back to a non-writable relative path if this is unset, which `ggml_abort()`s during init inside the app sandbox — always provide an app-writable path when exercising OpenCL on Android. |

> **Tip:** Use `model.getActiveBackendName()` after `load()` to confirm which backend actually took the request — see [Additional Features](#additional-features). The GGML scheduler silently falls back to CPU when no usable GPU ICD is registered, and this is the only way to detect that.

### 4. Create Model Instance

Import `TranslationNmtcpp` and create an instance by combining `args` (from Step 2) with `config` parameters (from Step 3):

```javascript
const TranslationNmtcpp = require('@qvac/translation-nmtcpp')
```

#### IndicTrans2

```javascript
const model = new TranslationNmtcpp({
  files: { model: './models/ggml-indictrans2-en-indic-dist-200M.bin' },
  params: { srcLang: 'eng_Latn', dstLang: 'hin_Deva' },
  config: {
    modelType: TranslationNmtcpp.ModelTypes.IndicTrans,
    ...generationParams,
    maxlength: 256
  }
})
```

#### Bergamot

```javascript
const model = new TranslationNmtcpp({
  files: {
    model: './models/bergamot-en-it/model.enit.intgemm.alphas.bin',
    srcVocab: './models/bergamot-en-it/vocab.enit.spm',
    dstVocab: './models/bergamot-en-it/vocab.enit.spm'
  },
  params: { srcLang: 'en', dstLang: 'it' },
  config: {
    modelType: TranslationNmtcpp.ModelTypes.Bergamot,
    beamsize: 4
  }
})
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
    console.log('Translation completed in:', response.stats.totalTime, 's')
  }
} catch (error) {
  console.error('Translation failed:', error)
}
```

### 7. Batch Translation

For translating multiple texts efficiently, use the `runBatch()` method instead of calling `run()` multiple times. It is supported by **both backends**: Bergamot processes the batch natively in a single call, and IndicTrans2 runs the batch through the GGML pipeline with per-text pre/post-processing.

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
| `runBatch(texts)` | Array of strings | Array of strings | All (IndicTrans, Bergamot) |

> **Note:** `runBatch()` is significantly faster when translating multiple texts as it processes them in a single batch operation. `run()` and `runBatch()` share one exclusive queue — a batch waits for an in-flight `run()` to finish and vice versa. See [`examples/batch.example.js`](examples/batch.example.js) for a complete Bergamot example; the IndicTrans2 batch path is exercised end-to-end by [`test/integration/indictrans.test.js`](test/integration/indictrans.test.js).

### 8. Unload the Model

```javascript
// Always unload the model when finished to free memory
try {
  await model.unload()
} catch (error) {
  console.error('Failed to unload model:', error)
}
```

### 9. Pivot Translation (Bergamot)

Bergamot models are trained per language pair, mostly to/from English. For a
pair with no direct model (e.g. Spanish → Italian), chain two models through
an English pivot: the **primary** model translates source → pivot (es→en) and
the **pivot** model translates pivot → target (en→it). Both stages run inside
the native `PivotTranslationModel` — a single `run()`/`runBatch()` call spans
the whole chain.

```javascript
const model = new TranslationNmtcpp({
  files: {
    // primary model: source → pivot (es → en)
    model: './models/bergamot-es-en/model.esen.intgemm.alphas.bin',
    srcVocab: './models/bergamot-es-en/vocab.esen.spm',
    dstVocab: './models/bergamot-es-en/vocab.esen.spm',
    // pivot model: pivot → target (en → it)
    pivotModel: './models/bergamot-en-it/model.enit.intgemm.alphas.bin',
    pivotSrcVocab: './models/bergamot-en-it/vocab.enit.spm',
    pivotDstVocab: './models/bergamot-en-it/vocab.enit.spm'
  },
  params: { srcLang: 'es', dstLang: 'it' },
  config: {
    modelType: TranslationNmtcpp.ModelTypes.Bergamot,
    // Optional generation parameters for the pivot (en→it) stage; the
    // top-level config keys apply to the primary (es→en) stage.
    pivotConfig: { beamsize: 4 }
  }
})
```

- **Files.** `pivotModel` (plus `pivotSrcVocab` / `pivotDstVocab`) select the
  second-stage model. When they are omitted the instance translates directly
  with the primary model only.
- **Configuration.** `config.pivotConfig` carries per-stage options for the
  pivot model; the remaining `config` keys configure the primary model.
- **Lifecycle.** `load()` loads both stages and `unload()` frees both — there
  is no separate pivot lifecycle to manage.
- **Batch behavior.** `runBatch()` pivots the whole array: the batch is
  translated source → pivot, then the intermediate batch pivot → target, and
  the final array is returned in input order.

See [`examples/pivot.example.js`](examples/pivot.example.js) for a complete
runnable example (es→en→it with auto-downloaded models).

### Additional Features

- **Cancellation:** an in-flight translation can be cancelled through the
  response returned by `run()`. `response.cancel()` asks the native runner to
  stop the current job and fires the `onCancel` callbacks; the response then
  settles once the native side acknowledges — depending on timing, `await()`
  may reject or resolve with the output produced so far. The model stays
  loaded and reusable after a cancel:

  ```javascript
  const response = await model.run(longText)
  response.onCancel(() => console.log('translation cancelled'))

  // e.g. cancel when the user navigates away
  await response.cancel()

  try {
    await response.await()
  } catch (err) {
    // a cancelled job may settle as an error — no final result
  }

  // the instance is still usable:
  const next = await model.run('Thank you')
  ```

  Note: `runBatch()` resolves with the final array only and does not expose a
  cancellation handle.

- **Performance Stats:** construct the model with `opts: { stats: true }` to
  receive [`RuntimeStats`](#runtimestats) on `response.stats` once the
  translation finishes (see the [API Reference](#api-reference)).

- **Active Backend Inspection:** `model.getActiveBackendName()` returns the name of the backend that `load()` actually selected for inference, or a sentinel when no GPU backend is active. Useful for confirming `use_gpu` / `gpu_backend` selection actually took effect (the GGML scheduler silently falls back to CPU when no usable GPU ICD is registered):

  ```javascript
  await model.load()
  const backend = model.getActiveBackendName()
  console.log(`inference backend: ${backend}`)
  // → "Vulkan0" | "OpenCL" | "Metal" | "CPU" | "Bergamot-CPU" | "Unloaded"
  ```

  Sentinels: `"Unloaded"` (not yet loaded), `"Bergamot-CPU"` (Bergamot backend — CPU-only by design, independent of `use_gpu`), `"CPU"` (GGML backend but only the CPU device registered).

  `model.getActiveBackendDescription()` complements the name with the
  human-readable device description of the active GPU backend (e.g.
  `'NVIDIA GeForce RTX 5070'`), or `''` when no GPU backend is loaded.

For a complete working example that brings all these steps together, see the [Quickstart Example](#quickstart-example) below.

## API Reference

The package's CommonJS default export is the `TranslationNmtcpp` class.
TypeScript declarations ship with the package (`index.d.ts`).

### `new TranslationNmtcpp({ files, params, config, logger?, opts? })`

| Field | Type | Required | Description |
|---|---|:-:|---|
| `files.model` | `string` | ✓ | path to the model weights file |
| `files.srcVocab` / `files.dstVocab` | `string` | Bergamot | vocabulary file paths |
| `files.pivotModel` / `files.pivotSrcVocab` / `files.pivotDstVocab` | `string` | | second-stage model for [pivot translation](#9-pivot-translation-bergamot) |
| `params.srcLang` / `params.dstLang` | `string` | ✓ | language codes (ISO 639-1 for Bergamot, ISO 15924 for IndicTrans2) |
| `config.modelType` | `'IndicTrans'` \| `'Bergamot'` | ✓ | backend selection (`TranslationNmtcpp.ModelTypes`) |
| `config.pivotConfig` | `object` | | per-stage options for the pivot model |
| `config.*` | | | generation + [backend/GPU settings](#backend--gpu-settings) |
| `logger` | `object \| null` | | `{ info, warn, error, debug }` — receives C++ log lines (see [Logging](#logging)) |
| `opts.stats` | `boolean` | | populate `response.stats` with [`RuntimeStats`](#runtimestats) after each run (default `false`) |

### Methods

- `load(): Promise<void>` — loads the model (both stages for pivot setups);
  reloads if already loaded. Rejects after `destroy()`.
- `run(input: string): Promise<TranslationResponse>` — translates one text.
  Jobs are serialized through completion: the next `run()`/`runBatch()`
  starts only after the previous response has settled.
- `runBatch(texts: string[]): Promise<string[]>` — translates an array in one
  native batch; shares the serialization queue with `run()`.
- `unload(): Promise<void>` — frees the native instance; the model can be
  `load()`ed again.
- `destroy(): Promise<void>` — unloads and marks the instance permanently
  destroyed (`load()` afterwards rejects; create a new instance instead).
- `getState(): { configLoaded, weightsLoaded, destroyed }` — lifecycle flags;
  `configLoaded`/`weightsLoaded` are both `true` after a successful `load()`.
- `getActiveBackendName(): string` — resolved compute backend or a sentinel
  (see [Additional Features](#additional-features)).
- `getActiveBackendDescription(): string` — human-readable GPU device
  description, `''` when not on a GPU backend.

### `TranslationResponse`

`run()` resolves with a `TranslationResponse` — the streaming
[`QVACResponse`](#glossary) surface (`onUpdate`, `onFinish`, `onError`,
`onCancel`, `iterate`, `await`, `cancel`) plus a typed `stats` property.

### `RuntimeStats`

Populated on `response.stats` when the model was constructed with
`opts: { stats: true }` (otherwise `stats` stays `{}`):

| Field | Unit | Backends |
|---|---|---|
| `totalTokens` | count | all |
| `totalTime` | **seconds** | all |
| `decodeTime` | **seconds** | all |
| `encodeTime` | **seconds** | GGML/IndicTrans only |
| `TTFT` | **milliseconds** | GGML/IndicTrans only |
| `TPS` | tokens/second | all |

> Pivot translations may emit keys prefixed with the model name
> (e.g. `"BERGAMOT : ->TPS"`); the table above models the non-pivot shape.

### Errors

Native-facing failures reject with a structured `QvacErrorAddonMarian`
(extends `QvacErrorBase` from `@qvac/error`; the original error is preserved
as `cause`). The class and the `ERR_CODES` map are exported from the
`lib/error` subpath:

```javascript
const { QvacErrorAddonMarian, ERR_CODES } = require('@qvac/translation-nmtcpp/lib/error')
```

Allocated code range `8001..9000`:

| Code | Name | Thrown when |
|---|---|---|
| 8001 | `FAILED_TO_LOAD_WEIGHTS` | loading weights into the native instance failed |
| 8002 | `FAILED_TO_CANCEL` | cancelling an in-flight job failed |
| 8003 | `FAILED_TO_APPEND` | submitting a job to the native runner failed |
| 8004 | `FAILED_TO_GET_STATUS` | reserved |
| 8005 | `FAILED_TO_DESTROY` | releasing the native instance failed |
| 8006 | `FAILED_TO_ACTIVATE` | native activation (model load) failed |
| 8007 | `FAILED_TO_RESET` | reserved |
| 8008 | `FAILED_TO_PAUSE` | reserved |
| 8009 | `FAILED_TO_GET_BACKEND_NAME` | querying the active backend name failed |

Parameter/lifecycle misuse (missing `load()`, `load()` after `destroy()`,
non-array `runBatch` input) rejects with a plain `Error` carrying an
explanatory message.

### Subpath exports

| Import | Purpose |
|---|---|
| `@qvac/translation-nmtcpp` | the `TranslationNmtcpp` class (default export) |
| `@qvac/translation-nmtcpp/marian` | low-level `TranslationInterface` wrapper over the native binding (advanced use) |
| `@qvac/translation-nmtcpp/addonLogging` | `setLogger` / `releaseLogger` — process-wide C++ log bridge shared by all instances |
| `@qvac/translation-nmtcpp/lib/error` | `QvacErrorAddonMarian` + `ERR_CODES` |
| `@qvac/translation-nmtcpp/lib/bergamot-model-fetcher` | Firefox CDN model downloader (see [Model Registry](#model-registry)) |
| `@qvac/translation-nmtcpp/lib/indictrans-model-fetcher` | QVAC-registry model downloader (see [Model Registry](#model-registry)) |

## Quickstart Example

This quickstart demonstrates **Bergamot model** inference (English → Italian translation).

> **Other Model Types:** For IndicTrans2 models, refer to [Section 2: Create the constructor arguments](#2-create-the-constructor-arguments) for model-specific configuration.

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
npm i @qvac/translation-nmtcpp
```

### 3. Create `quickstart.js` and paste the following code into it

```bash
touch quickstart.js
```

```javascript
// quickstart.js

'use strict'

const TranslationNmtcpp = require('@qvac/translation-nmtcpp')
const path = require('bare-path')

const text = 'Machine translation has revolutionized the way we communicate across language barriers in the modern digital world.'

async function main () {
  const { ensureBergamotModelFiles, getBergamotFileNames } = require('@qvac/translation-nmtcpp/lib/bergamot-model-fetcher')

  const srcLang = 'en'
  const dstLang = 'it'

  // 1. Ensure model files are present (downloads from Firefox CDN if needed)
  const modelDir = await ensureBergamotModelFiles(srcLang, dstLang, './model/bergamot/enit')
  const fileNames = getBergamotFileNames(srcLang, dstLang)

  // 2. Create Model Instance with resolved file paths
  const model = new TranslationNmtcpp({
    files: {
      model: path.join(modelDir, fileNames.modelName),
      srcVocab: path.join(modelDir, fileNames.srcVocabName),
      dstVocab: path.join(modelDir, fileNames.dstVocabName)
    },
    params: { srcLang, dstLang },
    config: { modelType: TranslationNmtcpp.ModelTypes.Bergamot }
  })

  // 3. Load model
  await model.load()

  try {
    // 4. Run the Model
    const response = await model.run(text)

    await response
      .onUpdate(data => {
        console.log(data)
      })
      .await()

    console.log('translation finished!')
  } finally {
    // 5. Unload the model
    await model.unload()
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

To use **IndicTrans2** models instead, modify the constructor arguments as shown in [Section 2: Create the constructor arguments](#2-create-the-constructor-arguments) and [Section 4: Create Model Instance](#4-create-model-instance).

**Quick Reference:**

| Model Type | Key Changes |
|------------|-------------|
| **IndicTrans2** | Use ISO 15924 language codes (`eng_Latn`, `hin_Deva`), provide `files.model` path, set `config.modelType: IndicTrans` |
| **Bergamot** | Use `ensureBergamotModelFiles()` or local paths, provide `files.model`/`files.srcVocab`/`files.dstVocab`, set `config.modelType: Bergamot` |

## Other Examples

For more detailed examples covering different use cases, refer to the `examples/` directory:

| Example | Description | Model Type |
|---------|-------------|------------|
| [indictrans.js](examples/indictrans.js) | English-to-Hindi translation with IndicTrans2 | IndicTrans2 |
| [batch.example.js](examples/batch.example.js) | Batch translation with `runBatch()` method | Bergamot |
| [pivot.example.js](examples/pivot.example.js) | Pivot translation (e.g., es→en→it) via Bergamot | Bergamot |
| [quickstart.js](examples/quickstart.js) | Bergamot backend quickstart | Bergamot |

## Model Registry

Model weights are plain local files as far as this addon is concerned — you
pass paths via `files`. Two helper modules (and the higher-level
[`@qvac/inference`](../inference) package) obtain those files for you:

### Bergamot Models (Firefox Translations)

Bergamot weights are published by Mozilla's
[firefox-translations-models](https://github.com/mozilla/firefox-translations-models)
project. `lib/bergamot-model-fetcher` resolves and downloads a language pair
from the Firefox CDN (using Remote Settings metadata) into a local directory:

```javascript
const {
  ensureBergamotModelFiles,   // download (or reuse) the files for a pair
  getBergamotFileNames,       // expected file names for a pair
  hasBergamotModelFiles       // check a directory for a usable model
} = require('@qvac/translation-nmtcpp/lib/bergamot-model-fetcher')

const dir = await ensureBergamotModelFiles('en', 'it', './models/bergamot-en-it')
const names = getBergamotFileNames('en', 'it')
// → { modelName: 'model.enit.intgemm.alphas.bin', srcVocabName: 'vocab.enit.spm', … }
```

Pinned snapshots of the same Bergamot artifacts (plus metadata) are also
hosted in the QVAC model registry for CI and `@qvac/inference` consumption.

### IndicTrans2 Models

IndicTrans2 GGML weights are hosted in the QVAC model registry.
`lib/indictrans-model-fetcher` downloads them through `@qvac/registry-client`
(peer-to-peer, checksum-verified):

```javascript
const {
  INDICTRANS_MODELS,           // registry catalog keyed by model key
  ensureIndicTransModelFile,   // download (or reuse) a model file
  getIndicTransFileName        // filename for a model key
} = require('@qvac/translation-nmtcpp/lib/indictrans-model-fetcher')

const modelPath = await ensureIndicTransModelFile('en-indic-200M-q4_0', './models')
```

### Key Pattern

IndicTrans2 fetcher keys follow `{direction}-{size}-{quantization}` — e.g.
`en-indic-200M-q4_0` → `ggml-indictrans2-en-indic-dist-200M-q4_0.bin`. The
underlying registry paths follow
`qvac_models_compiled/ggml/indictrans2/{quant}/{model}/{date}/{file}`.

Applications that prefer not to manage files at all can use
[`@qvac/inference`](../inference), which loads registry-hosted NMT models
(engine `nmtcpp-translation`) and drives this addon internally.

## Supported Languages

### IndicTrans2 Language Pairs

IndicTrans2 supports translation between English and 22 Indic languages. The following directions are available:

| Direction | Registry Keys | Sizes |
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

**Language pairs available in the registry:**

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

The Bergamot backend supports all language pairs available in [Firefox Translations](https://github.com/mozilla/firefox-translations-models). See the Firefox Translations models repository for the complete and up-to-date list of supported language pairs. Use `ensureBergamotModelFiles()` to auto-download models from the Firefox CDN.

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

This project supports multiple **translation backends** (Bergamot/Firefox and IndicTrans2) and, for IndicTrans2 at runtime, multiple **compute backends** (CPU, Vulkan, Metal, OpenCL).

### Translation backend build flags

The Bergamot backend is included in the build by default. To build without Bergamot support (reduces build time and dependencies):

```bash
bare-make generate -D USE_BERGAMOT=OFF
```

### Compute backend selection

At runtime, the addon picks a ggml compute device using the `use_gpu`, `gpu_backend`, and `gpu_device` config keys described in [Backend & GPU Settings](#backend--gpu-settings). When `use_gpu` is true and `gpu_backend` is **not** set, the selector falls back to a default gated pass:

1. If built with `USE_OPENCL=ON`, prefer an OpenCL device first.
2. Otherwise (and as a fallback in the `ON` case) pick any non-CPU device. When `USE_OPENCL=OFF` (the default), OpenCL-named devices are also excluded from the fallback — the OpenCL backend still loads as a shared library but is never selected automatically.

An explicit `config.gpu_backend: 'opencl'` always bypasses the `USE_OPENCL` guard and selects OpenCL directly. The flag gates *automatic* selection only; caller-explicit requests are honored.

### Compute backend build flag

| Flag | Default | Purpose |
|------|---------|---------|
| `USE_OPENCL` | `OFF` | When `ON`, the runtime selector prefers OpenCL over other non-CPU devices when `use_gpu` is true and `gpu_backend` is unset. Off by default because the Adreno 830 q4_0 transpose path in `ggml-opencl` aborts on NMT tensors whose second dimension isn't a multiple of 4. Callers that still want OpenCL can opt in per model via `config.gpu_backend: 'opencl'` regardless of this flag. |

```bash
# Default build (OpenCL not auto-selected)
bare-make generate

# Restore OpenCL-preferred selection (once the upstream ggml fix ships)
bare-make generate -D USE_OPENCL=ON
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

const model = new TranslationNmtcpp({
  files: { model: './models/bergamot-en-it/model.enit.intgemm.alphas.bin', srcVocab: '...', dstVocab: '...' },
  params: { srcLang: 'en', dstLang: 'it' },
  config: { modelType: TranslationNmtcpp.ModelTypes.Bergamot },
  logger
})
```

### Disabling C++ Logs

To suppress all C++ logs, either omit the `logger` parameter or set it to `null`:

```javascript
const model = new TranslationNmtcpp({
  files: { model: './models/bergamot-en-it/model.enit.intgemm.alphas.bin', srcVocab: '...', dstVocab: '...' },
  params: { srcLang: 'en', dstLang: 'it' },
  config: { modelType: TranslationNmtcpp.ModelTypes.Bergamot }
})
```

### Using Environment Variables (Recommended for Examples)

All examples support the `VERBOSE` environment variable:

```bash
# Run with C++ logging disabled (default)
bare examples/quickstart.js

# Run with C++ logging enabled
VERBOSE=1 bare examples/quickstart.js
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
- **Registry** – QVAC model registry for distributing AI model weights and configuration.
- **Hyperbee** – Decentralized B-tree built on Hypercores, with a key-value API. [Docs](https://docs.pears.com/building-blocks/hyperbee)
- **Corestore** – Factory for managing named collections of Hypercores. [Docs](https://docs.pears.com/helpers/corestore)
- **QVAC** – Open-source SDK for building decentralized AI applications.
- **QVACResponse** –  The response object used by the QVAC API. [GitHub](https://github.com/tetherto/qvac-lib-response)
- **Model Files** – Local model weight files passed directly to the constructor via `files`. Models can be obtained from the registry, Firefox CDN, or provided locally.

## Resources

- **Architecture Documentation** – Layered architecture, components, and design decisions. [docs/architecture.md](docs/architecture.md)
- **Detailed Data Flows** – Loading/translation/batch sequence diagrams. [docs/data-flows-detailed.md](docs/data-flows-detailed.md)
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
cd qvac/packages/translation-nmtcpp

# 2. Install dependencies
npm install

# 3. Build the native addon
npm run build
```

> **Note:** Building requires CMake, a C++ compiler (GCC/Clang), and vcpkg. See the build prerequisites in the CI workflow for full system requirements.

### Development Workflow

1. **Fork** the monorepo
2. **Clone** your fork: `git clone https://github.com/YOUR_USERNAME/qvac.git`
3. **Navigate**: `cd qvac/packages/translation-nmtcpp`
4. **Install and build**: `npm install && npm run build`
5. **Create a branch**: `git checkout -b feature/your-feature-name`
6. **Make changes** and ensure tests pass: `npm test`
7. **Commit** with a descriptive message: `git commit -m "feat: add your feature"`
8. **Push** to your fork: `git push origin feature/your-feature-name`
9. **Open a Pull Request** against the `main` branch

### Code Style

JavaScript is checked with [Prettier](https://prettier.io/)
(`prettier-config-holepunch`) and [lunte](https://www.npmjs.com/package/lunte);
the TypeScript sources under `src/` are linted with ESLint. The published
JavaScript (`index.js`, `marian.js`, `addonLogging.js`, `lib/`) is generated
from `src/` — edit the TypeScript and regenerate:

```bash
npm run lint            # prettier --check + lunte + eslint + type checks
npm run lint:ts:fix     # auto-fix ESLint issues in src/**/*.ts
npm run format          # prettier --write for JS files
npm run build:ts        # regenerate the published JS + .d.ts from src/
npm run check:generated # verify generated output is committed and in sync
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
