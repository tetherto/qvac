# decoder-audio

This decoder library leverages FFmpeg for efficient audio decoding. It simplifies processing of input audio, particularly as a preprocessing step for other addons.

## Table of Contents

- [Supported Platforms](#supported-platforms)
- [Installation](#installation)  
- [Usage](#usage)  
  - [1. Creating the Decoder Instance](#1-creating-the-decoder-instance)  
  - [2. Loading the Decoder](#2-loading-the-decoder)  
  - [3. Decoding Audio](#3-decoding-audio)  
  - [4. Handling Response Updates](#4-handling-response-updates)  
  - [5. Unloading the Decoder](#5-unloading-the-decoder)
- [Quickstart Example](#quickstart-example)  
- [Testing](#testing)  
  - [Running Unit Tests](#running-unit-tests)  
  - [Test Coverage](#test-coverage)  
- [Glossary](#glossary)  
- [Resources](#resources)  
- [License](#license)  

## Supported Platforms

| Platform | Architecture | Min Version | Status | GPU Support |
|----------|-------------|-------------|--------|-------------|
| macOS | arm64, x64 | 14.0+ | ✅ Tier 1 | N/A (CPU only) |
| iOS | arm64 | 17.0+ | ✅ Tier 1 | N/A (CPU only) |
| Linux | arm64, x64 | Ubuntu-22+ | ✅ Tier 1 | N/A (CPU only) |
| Android | arm64 | 12+ | ✅ Tier 1 | N/A (CPU only) |
| Windows | x64 | 10+ | ✅ Tier 1 | N/A (CPU only) |

**Dependencies:**
- qvac-lib-inference-addon-cpp: C++ addon framework
- FFmpeg: Audio decoding engine
- Bare Runtime (latest): JavaScript runtime

## Installation

### Prerequisites

Ensure that the [`Bare`](#glossary) Runtime is installed globally on your system. If it's not already installed, you can add it using:

```bash
npm install -g bare@latest
```

### Installing the Package

Install the latest version of the decoder addon with the following command:

```bash
npm install @qvac/decoder-audio@latest
```

## Usage

This library provides a simple workflow for decoding audio streams.

### 1. Creating the Decoder Instance

To get started, import the decoder and create an instance:

```javascript
const { FFmpegDecoder } = require('@qvac/decoder-audio')

const decoder = new FFmpegDecoder({
  config: {
    audioFormat: 's16le', // 's16le' | 'f32le'; default is 's16le'
    sampleRate: 16000 // in Hz; default is 16000
  }
})
```

The `config` object accepts the following parameters:

* **`audioFormat`**: Specifies the output format of the decoded audio. Supported values:

  * `'s16le'`: Signed 16-bit little-endian PCM — a widely used raw format.
  * `'f32le'`: 32-bit floating-point little-endian PCM — ideal for high-precision audio processing.

  Default: `'s16le'`.

* **`sampleRate`**: Sample rate of the output audio in Hertz (Hz).
  Default: `16000` (16 kHz), commonly used for speech processing.

### 2. Loading the Decoder

Initializes and activates the decoder with the provided or default configuration. This method must be called before decoding any audio input.

```javascript
try {
  await decoder.load()
} catch (err) {
  console.error('Failed to load decoder:', err)
}
```

### 3. Decoding Audio

In order to decode audio, we must create an audio stream and pass it to the `run()` method. This method returns a [`QVACResponse`](#glossary) object.

```javascript
const fs = require('bare-fs')
const audioFilePath = './sample.ogg'
const audioStream = fs.createReadStream(audioFilePath)

const response = await decoder.run(audioStream)
```

### 4. Handling Response Updates

The response supports real-time updates via `.onUpdate()`. Each update delivers a chunk of decoded audio data, which can be processed or saved as needed:

```javascript
await response
  .onUpdate(output => {
    // `output.outputArray` is a Uint8Array
    console.log('Decoded chunk:', new Uint8Array(output.outputArray))
  })
  .await() // wait for the stream to finish
```

You can append or otherwise process these frames as needed.

### 5. Unloading the decoder

Always unload the decoder when done to free memory:

```javascript
try {
  await decoder.unload()
} catch (err) {
  console.error('Failed to unload decoder:', err)
}
```

## Quickstart Example

The following example demonstrates how to use the decoder to decode a sample OGG file into a raw audio file. Follow these steps, to run the example:

### 1. Create a new project:
   
```bash
mkdir decoder-example
cd decoder-example
npm init -y
```

### 2. Install the required dependencies:
   
```bash
npm install bare-fs @qvac/decoder-audio
```

### 3. Create a file named `example.js` and paste the following code:

```javascript
'use strict'

const fs = require('bare-fs')
const { FFmpegDecoder } = require('@qvac/decoder-audio')

const audioFilePath = './path/to/audio/file.ogg'
const outputFilePath = './path/to/output/file.raw'

async function main () {
  const decoder = new FFmpegDecoder({
    config: {
      audioFormat: 's16le',
      sampleRate: 16000
    }
  })

  try {
    await decoder.load()

    const audioStream = fs.createReadStream(audioFilePath)
    const response = await decoder.run(audioStream)

    const decodedFileBuffer = []

    await response
      .onUpdate(output => {
        const bytes = new Uint8Array(output.outputArray)
        decodedFileBuffer.push(bytes)
      })
      .onFinish(() => {
        fs.writeFileSync(outputFilePath, Buffer.concat(decodedFileBuffer))
        console.log('Decoded file saved to', outputFilePath)
      })
      .await()
  } finally {
    await decoder.unload()
  }
}

main().catch(console.error)
```

### 4. Run the example:

Make sure to set the correct `audioFilePath` and `outputFilePath` before running the example with the following command:

```bash
bare example.js
```

## Testing

### Running Unit Tests

To run unit tests (using the 'brittle-bare' runner):

```sh
npm run test:unit
```

### Test Coverage

To generate a unit test coverage report (using 'brittle' and 'istanbul'):

```sh
npm run coverage:unit
```

Or simply:

```sh
npm run coverage
```

Coverage reports are generated in the 'coverage/unit/' directory. Open the corresponding `index.html` file in your browser to view the detailed report.

## Glossary

* [**Bare** ](https://bare.pears.com/) – A lightweight, modular JavaScript runtime for desktop and mobile.
* [**QVACResponse**](https://github.com/tetherto/qvac-lib-response) – the response object used by QVAC API
* **QVAC** – Our decentralized AI SDK for building runtime-portable inference apps.

## Resources

* GitHub Repo: [tetherto/qvac](https://github.com/tetherto/qvac/tree/main/packages/decoder-audio)

## License

This project is licensed under the Apache-2.0 License – see the [LICENSE](LICENSE) file for details.

*For questions or issues, please open an issue on the GitHub repository.*
