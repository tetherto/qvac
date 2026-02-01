# qvac-util-transcription

A flexible and modular transcription pipeline that combines audio decoding and Whisper inference capabilities. This utility provides a streamlined way to process audio streams through an optional chain of components, with Voice Activity Detection (VAD) integrated within the Whisper configuration.

## Table of Contents

- [Installation](#installation)
- [Component Overview](#component-overview)
- [Usage](#usage)
  - [1. Creating Transcription Pipeline Instance](#1-creating-transcription-pipeline-instance)
  - [2. Loading the Pipeline](#2-loading-the-pipeline)
  - [3. Running the Pipeline](#3-running-the-pipeline)
  - [4. Handling Response Updates](#4-handling-response-updates)
  - [5. Resource Management](#5-resource-management)
- [Quickstart Example](#quickstart-example)
- [API Reference](#api-reference)
- [Voice Activity Detection (VAD) Configuration](#voice-activity-detection-vad-configuration)
- [Testing](#testing)
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

Install the latest version of the transcription utility with the following command:

```bash
npm install @tetherto/qvac-util-transcription@latest
```

## Component Overview

This utility class creates a transcription pipeline that is designed to be flexible, allowing you to use any combination of its components based on your needs. The pipeline consists of two components that can be chained together:

- **Decoder**: Handles audio decoding (FFmpegDecoder)
- **Whisper Addon**: Executes the Whisper transcription model (with optional VAD support)

The pipeline automatically adapts based on which components you provide:
- Only Whisper: Streams directly to Whisper (VAD can be configured within whisper)
- Both decoder and Whisper: Streams through decoder → Whisper

## Usage

This utility class provides a simple and clear workflow to perform transcription on a given audio stream.

### 1. Creating Transcription Pipeline Instance

Firstly, we have to import the class from its package then we can proceed to create a new pipeline instance by providing the desired components:

```javascript
const TranscriptionPipeline = require('@tetherto/qvac-util-transcription')
const TranscriptionWhispercpp = require('@qvac/transcription-whispercpp')

// Configure Whisper with optional VAD
const whisperConfig = {
  modelFileName: 'ggml-tiny.bin',
  vadModelName: 'ggml-silero-v5.1.2.bin',  // Optional: include for VAD support
  whisperConfig: {
    vad_threshold: 0.6,
    vad_min_speech_duration_ms: 500,
    // ... other VAD and whisper settings
  }
}

const whisper = new TranscriptionWhispercpp(whisperArgs, whisperConfig)

// Create pipeline
const pipeline = new TranscriptionPipeline({
  whisperAddon: whisper 
}, {
  sampleRate: 16000,
  audioFormat: 'encoded' //If you select decoded we will not use FFmpegDecoder
})
```

### 2. Loading the Pipeline

Before we use the pipeline to transcript audio, we must load all its components, we can do so by invoking the following method:

```javascript
// Loads all supplied components
await pipeline.load()
```

### 3. Running the Pipeline

We can now process an audio stream through the pipeline by calling the `run()` method and passing the audio stream as an argument. This method returns a `QvacResponse` object that allows us to handle the transcription results.

```javascript
const audioStream = fs.createReadStream('input.ogg')
const response = await pipeline.run(audioStream)
```

### 4. Handling Response Updates

The response supports real-time updates via `.onUpdate()`. Each update delivers a partial transcription result.

```javascript
// Handle transcription updates
response.onUpdate(output => {
  console.log('Partial transcription:', output)
})

// Wait for completion
await response.await()
```

### 5. Resource Management

Always unload the pipeline when finished to free up resources:

```javascript
await pipeline.unload()
```

## Quickstart Example

This example demonstrates how to set up and use the transcription pipeline with decoder and Whisper addon. Please follow the steps below to run the example:

### 1. Clone the Repository & Install the dependencies

```bash
git clone https://github.com/tetherto/qvac-util-transcription.git
cd qvac-util-transcription
npm install
```

### 2. Run the `exampleDecoderWhisper.js` file inside examples folder

```bash
bare run examples/exampleDecoderWhisper.js
```

### 3. Code Walkthrough

```javascript
const fs = require('bare-fs')
const TranscriptionPipeline = require('@tetherto/qvac-util-transcription')
const TranscriptionWhispercpp = require('@qvac/transcription-whispercpp')
const { setupModelStore, createWhisperAddonWithVad } = require('./example/setupAddons')

async function main () {
  // Setup model store
  const { hdDL } = await setupModelStore({})
  
  // Create whisper with VAD support
  const whisper = createWhisperAddonWithVad(hdDL)

  // Initialize pipeline
  const pipeline = new TranscriptionPipeline({
    whisperAddon: whisper
  }, { audioFormat: 'encoded' })

  try {
    // Load components
    await pipeline.load()

    // Process audio
    const audioStream = fs.createReadStream('./example/sample.ogg')
    const response = await pipeline.run(audioStream)

    // Handle transcription updates
    response.onUpdate(output => {
      console.log('Partial transcription:', output)
    })
    await response.await()
  } finally {
    // Cleanup
    await pipeline.unload()
  }
}

main().catch(console.error)
```

## API Reference

### Constructor

**`new TranscriptionPipeline({ decoder, whisperAddon }, config)`**

- `decoder` (optional): Instance of FFmpegDecoder for audio decoding. If the format is not 'decoded', we will initialize an FFmpegDecoder.
- `whisperAddon` (required): Whisper addon instance for transcription. VAD can be configured within the whisper configuration by providing a `vadModelName` and VAD-related settings.
- `config` (optional): Additional configuration object.
- `config.audioFormat`: (passed down to decoder) It can be 'decoded' | 'encoded' | 's16le' | 'f32le' | 'mp3' | 'wav' | 'm4a' (default: 'encoded'), if you set it to 'decoded' we will not use the decoder addon to decode the audio,
- `config.sampleRate`: (passed down to decoder) sample rate passed to the decoder 

### Methods

**`async load(closeLoader = true, reportProgress = () => {})`**

- Loads all supplied components.
- `closeLoader` (boolean, default: `true`): Whether to close the loader after loading.
- `reportProgress` (function, default: `() => {}`): Callback for progress updates.
<br><br>

**`async unload()`**

- Unloads all components and frees associated resources.
<br><br>

**`run(audioStream)`**

- Processes an audio stream through the pipeline.
- `audioStream`: Readable stream containing audio data.
- _Returns_: `QvacResponse`

## Voice Activity Detection (VAD) Configuration

VAD is now integrated within the Whisper addon configuration rather than being a separate pipeline component. To enable VAD support:

### Basic VAD Setup

```javascript
const whisperConfig = {
  modelFileName: 'ggml-tiny.bin',
  vadModelName: 'ggml-silero-v5.1.2.bin',  // Include this for VAD support
  whisperConfig: {
    // VAD configuration options
    vad_threshold: 0.6,                      // Voice detection sensitivity (0.0-1.0)
    vad_min_speech_duration_ms: 500,         // Minimum speech duration in ms
    vad_min_silence_duration_ms: 300,        // Minimum silence duration in ms
    vad_max_speech_duration_s: 15.0,         // Maximum speech segment duration in seconds
    vad_speech_pad_ms: 100,                  // Padding around speech segments in ms
    vad_samples_overlap: 0.2,                // Overlap between VAD samples (0.0-1.0)
    
    // Whisper configuration options
    mode: 'batch',
    output_format: 'plaintext',
    min_seconds: 2,
    max_seconds: 6
  }
}

const whisper = new TranscriptionWhispercpp(whisperArgs, whisperConfig)
```

### VAD Configuration Options

- **`vadModelName`** (string, optional): Name of the VAD model file. When provided, enables VAD functionality.
- **`vad_threshold`** (number, 0.0-1.0): Sensitivity threshold for voice detection. Higher values are more strict.
- **`vad_min_speech_duration_ms`** (number): Minimum duration in milliseconds for a segment to be considered speech.
- **`vad_min_silence_duration_ms`** (number): Minimum silence duration required between speech segments.
- **`vad_max_speech_duration_s`** (number): Maximum duration in seconds for a single speech segment.
- **`vad_speech_pad_ms`** (number): Additional padding in milliseconds around detected speech segments.
- **`vad_samples_overlap`** (number, 0.0-1.0): Overlap ratio between consecutive VAD analysis windows.

## Testing

Run unit tests:

```bash
npm run test:unit
```

Generate coverage report:

```bash
npm run coverage
```

## Glossary

- **[Bare](https://bare.pears.com/)** – Small and modular JavaScript runtime for desktop and mobile.
- **[QVACResponse](https://github.com/tetherto/qvac-lib-response)** – the response object used by QVAC API
- **QVAC** – QVAC is our open-source AI-SDK for building decentralized AI applications.
- **Audio Decoder** – Converts encoded audio formats (like OGG, MP3) into raw audio.
- **VAD** – Voice Activity Detection, integrated within the Whisper addon to detect speech segments in audio.

## Resources

- GitHub Repo: [tetherto/qvac-util-transcription](https://github.com/tetherto/qvac-util-transcription)
- Decoder Addon: [tetherto/qvac-lib-decoder-audio](https://github.com/tetherto/qvac-lib-decoder-audio)
- Whisper Addon: [tetherto/qvac-lib-infer-whispercpp](https://github.com/tetherto/qvac-lib-infer-whispercpp)

## License

This project is licensed under the Apache-2.0 License – see the [LICENSE](LICENSE) file for details.

For questions or issues, please open an issue on the GitHub repository.
