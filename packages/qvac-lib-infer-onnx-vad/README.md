# qvac-lib-infer-onnx-vad

This addon simplifies running voice-activity detection (VAD) with the Silero VAD model within QVAC runtime applications. It provides an easy interface to load, execute, and manage Silero VAD inference instances over audio streams.

## Table of Contents

- [Installation](#installation)
- [Usage](#usage)
  - [1. Creating Model Instance](#1-creating-model-instance)
  - [2. Loading the Model](#2-loading-the-model)
  - [3. Running VAD](#3-running-vad)
  - [4. Handling Response Updates](#4-handling-response-updates)
  - [5. Unloading the Model](#5-unloading-the-model)
- [Quickstart Example](#quickstart-example)
- [Building from Source](#building-from-source)
- [Testing](#testing)
- [Benchmarking](#benchmarking)
- [Glossary](#glossary)
- [Resources](#resources)
- [License](#license) 

## Installation

### Prerequisites

Ensure that the [`Bare`](#glossary) Runtime is installed globally on your system. If it's not already installed, you can add it using:

```bash
npm install -g bare
```

> **Note:** Bare version must be **1.17.3 or higher**. Verify your version with:

```bash
bare -v
```

Before proceeding with the installation, please generate a **classic GitHub Personal Access Token (PAT)** with the `read:packages` scope. Once generated, add the token to your environment variables using the name `NPM_TOKEN`.

```bash
export NPM_TOKEN=your_personal_access_token
```

Next, create a `.npmrc` file in the root of your project with the following content:

```ini
@tetherto:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NPM_TOKEN}
```

This configuration ensures secure access to GitHub Packages when installing scoped packages.

### Installing the Package

Install the latest version of the Silero VAD addon with the following command:

```bash
npm install @tetherto/vad-onnx@latest
```

## Usage

The library provides a simple workflow for loading and running the Silero VAD model on audio streams.

### 1. Creating Model Instance

Import the Silero VAD addon and instantiate it:

```javascript
const { VAD } = require('@tetherto/vad-onnx')
const model = new VAD()
```

Optionally if you want to run your own custom ONNX Silero VAD model, you can pass the model file path to the constructor:

```javascript
const model = new VAD({
  params: {
    modelFilePath: 'path/to/your/silero-vad.onnx'
  }
})
```

### 2. Loading the Model

Load model weights and initialize the inference engine:

```javascript
try {
  await model.load()
} catch (err) {
  console.error('Failed to load Silero VAD model:', err)
}
```

### 3. Running VAD

Stream audio into the model and receive a [`QVACResponse`](#glossary) object:

```javascript
const fs = require('bare-fs')
const bitRate = 128000
const audioFile = 'example/sample.bin'

const bytesPerSecond = bitRate / 8
const audioStream = fs.createReadStream(audioFile, {
  highWaterMark: bytesPerSecond
})

const response = await model.run(audioStream)
```

### 4. Handling Response Updates

The response supports real-time updates via `.onUpdate()`. Each update delivers a typed array buffer indicating speech/silence flags or probabilities:

```javascript
await response
  .onUpdate(output => {
    // output.tsArrayBuffer is a Float32Array or Uint8Array
    console.log('VAD frame result:', new Uint8Array(output.tsArrayBuffer))
  })
  .await() // wait for the stream to finish
```

You can append or otherwise process these frames as needed.

### 5. Unloading the Model

Always unload the model when done to free memory:

```javascript
try {
  await model.unload()
} catch (err) {
  console.error('Failed to unload model:', err)
}
```

## Quickstart Example

The following example demonstrates how to use the Silero VAD addon to get the VAD flags from an audio file. Follow these steps, to run the example:

### 1. Create a new project:
   
```bash
mkdir silero-vad-example
cd silero-vad-example
npm init -y
```

### 2. Install the required dependencies:
   
```bash
npm install bare-fs @tetherto/vad-onnx
```

### 3. Create a file named `example.js` and paste the following code:

```javascript
'use strict'

const fs = require('bare-fs')
const { VAD } = require('@tetherto/vad-onnx')

const bitRate = 128000
const audioFile = 'path/to/audio/file.ext'

async function main () {
  // 1. Instantiate with default params
  const model = new VAD({ params: {} })

  // 2. Load the model
  await model.load()

  try {
    // 3. Prepare audio stream
    const bytesPerSecond = bitRate / 8
    const audioStream = fs.createReadStream(audioFile, {
      highWaterMark: bytesPerSecond
    })

    // 4. Run VAD
    const response = await model.run(audioStream)

    // 5. Handle updates
    await response
      .onUpdate(output => {
        // e.g. save raw VAD flags
        const flags = new Uint8Array(output.tsArrayBuffer)
        fs.appendFileSync('example/output.bin', Buffer.from(flags))
        console.log('VAD flags:', flags)
      })
      .await()
  } finally {
    // 6. Clean up
    await model.unload()
  }

  console.log('VAD processing completed.')
}

main().catch(console.error)
```

### 4. Run the example:

Make sure to set the correct `bitRate` and provide the actual path to your audio file before running the example with the following command:

```bash
bare example.js
```

## Building from Source

See [build.md](./build.md) for more instructions on how to build the addon locally.

## Testing

See [tests.md](./tests.md).

## Benchmarking

We conduct rigorous benchmarking of our Voice Activity Detection (VAD) models to assess their accuracy, responsiveness, and effectiveness across a wide variety of real-world audio samples. Our benchmarking suite includes both classification metrics and efficiency measures to evaluate model reliability under typical deployment scenarios.

### Benchmark Results

For full evaluation details see our [VAD Benchmark Results Summary](./benchmarks/client/results/results_summary.md).

The benchmarking covers:

* **Detection Metrics**:

  * **Speech Detection**: Precision, Recall, and F1-Score for identifying spoken segments
  * **Silence Detection**: Precision, Recall, and F1-Score for identifying non-speech segments
  * **Overall Accuracy** and **ROC-AUC**: General classification performance

* **Efficiency Metrics**:

  * **Model Load Time** and **Total Processing Time** for the entire evaluation
  * Performance consistency across varying audio lengths and characteristics

* **Data Statistics**:

  * **Speech Ratio** (predicted vs reference) to evaluate label distribution bias
  * **Confusion Matrix** to understand speech/silence classification patterns

Benchmark results are kept up to date to reflect improvements in model architecture, dataset coverage, and tuning practices.

## Glossary

* [**Bare** ](https://bare.pears.com/) – A lightweight, modular JavaScript runtime for desktop and mobile.
* [**QVACResponse**](https://github.com/tetherto/qvac-lib-response) – the response object used by QVAC API
* **QVAC** – Our decentralized AI SDK for building runtime-portable inference apps.
* **VAD** (Voice Activity Detection) – A model to detect regions of speech vs. silence in audio streams.

## Resources

* GitHub Repo: [tetherto/qvac-lib-infer-onnx-vad](https://github.com/tetherto/qvac-lib-infer-onnx-vad)
* Silero VAD Paper & Model: [snakers4/silero-vad](https://github.com/snakers4/silero-vad)

## License

This project is licensed under the Apache-2.0 License – see the [LICENSE](LICENSE) file for details.

*For questions or issues, please open an issue on the GitHub repository.*