# qvac-lib-infer-whispercpp

This library simplifies running inference with the Whisper transcription model within QVAC runtime applications. It provides an easy interface to load, execute, and manage Whisper inference instances, supporting multiple data sources (data loaders).

**Note: This library now uses whisper.cpp for improved performance and compatibility. The previous MLC-based implementation has been replaced.**

## Table of Contents

- [Supported Platforms](#supported-platforms)
- [Installation](#installation)
- [Development](#development)
- [Usage](#usage)
  - [1. Choose a Data Loader](#1-choose-a-data-loader)
  - [2. Configure Transcription Parameters](#2-configure-transcription-parameters)
  - [3. Define Model Files Configuration](#3-define-model-files-configuration)
  - [4. Create Model Instance](#4-create-model-instance)
  - [5. Load Model](#5-load-model)
  - [6. Run Transcription](#6-run-transcription)
  - [7. Release Resources](#7-release-resources)
- [Usage Whisper with GSTDecoder and SileroVAD](#decoder--vad--whisper-integration-addon)
- [Quickstart example](#quickstart-example)
- [Model registry](#model-registry)
- [Other examples](#other-examples)
- [Resources](#resources)
- [License](#license)

## Supported Platforms

| Platform | Architecture | Min Version | Status | GPU Support |
|----------|-------------|-------------|--------|-------------|
| macOS | arm64, x64 | 14.0+ | ✅ Tier 1 | Metal |
| iOS | arm64 | 17.0+ | ✅ Tier 1 | Metal |
| Linux | arm64, x64 | Ubuntu-22+ | ✅ Tier 1 | Vulkan |
| Android | arm64 | 12+ | ✅ Tier 1 | Vulkan |
| Windows | x64 | 10+ | ✅ Tier 1 | Vulkan |

**Dependencies:**
- qvac-lib-inference-addon-cpp (=0.12.2): C++ addon framework
- qvac-fabric-whisper.cpp (latest): Inference engine
- Bare Runtime (≥1.24.2): JavaScript runtime
- Ubuntu-22 requires g++-13 installed

## Installation

### Prerequisites

Make sure [Bare](#glossary) Runtime is installed:
```bash
npm install -g bare bare-make
```

Note : Make sure the Bare version is `>= 1.24.2`. Check this using :

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

Install the latest development version (adjust package name based on desired model/quantization):
```bash
npm install @qvac/transcription-whispercpp@latest
```

## Development

### Building the AddOn Locally

For local development, you'll need to build the native addon that interfaces with the Whisper model. Follow these steps:

### Prerequisites

First, make sure you have the prerequisites installed as described in the [Installation](#installation) section.

#### System Requirements

**Supported Platforms:**
- **Linux** (x64, ARM64)
- **macOS** (x64, ARM64)
- **Windows** (x64)

#### Required Tools

**All Platforms:**
- **CMake** (>= 3.25)
- **Git** with submodule support
- **C++ Compiler** with C++20 support
  - Linux: GCC 9+ or Clang 10+
  - macOS: Xcode 12+ (provides Clang 12+)
  - Windows: Visual Studio 2019+ or MinGW-w64

#### vcpkg Setup

This project uses [vcpkg](https://vcpkg.io/) for C++ dependency management. You need to install and configure vcpkg before building:

**1. Install vcpkg:**

```bash
# Clone vcpkg
git clone https://github.com/Microsoft/vcpkg.git
cd vcpkg

# Bootstrap vcpkg
# On Linux/macOS:
./bootstrap-vcpkg.sh
# On Windows:
.\bootstrap-vcpkg.bat
```

**2. Set Environment Variable:**

```bash
# Linux/macOS (add to your shell profile):
export VCPKG_ROOT=/path/to/vcpkg

# Windows (PowerShell):
$env:VCPKG_ROOT = "C:\path\to\vcpkg"
# Or set permanently via System Properties > Environment Variables
```

**3. Integrate vcpkg (optional but recommended):**

```bash
# This makes vcpkg available to all CMake projects
./vcpkg integrate install
```

#### Platform-Specific Setup

**Linux:**
```bash
# Ubuntu/Debian
sudo apt update
sudo apt install build-essential cmake git pkg-config

# CentOS/RHEL/Fedora
sudo yum groupinstall "Development Tools"
sudo yum install cmake git pkgconfig
# or for newer versions:
sudo dnf groupinstall "Development Tools"
sudo dnf install cmake git pkgconfig
```

**macOS:**
```bash
# Install Xcode Command Line Tools
xcode-select --install

# Using Homebrew (recommended)
brew install cmake git

# Using MacPorts
sudo port install cmake git
```

**Windows:**
- Install [Visual Studio 2019+](https://visualstudio.microsoft.com/) with C++ development tools
- Or install [Build Tools for Visual Studio](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2019)
- Install [CMake](https://cmake.org/download/) (3.25+)
- Install [Git for Windows](https://git-scm.com/download/win)

#### GPU Acceleration (Optional)

**Metal (macOS):**
- Automatically available on macOS 10.13+ with Metal-capable hardware
- No additional setup required

**Vulkan (Linux/Windows):**
- Install Vulkan SDK from [LunarG](https://vulkan.lunarg.com/)
- Ensure your GPU drivers support Vulkan 1.1+

**Linux Vulkan Setup:**
```bash
# Ubuntu/Debian
sudo apt install vulkan-tools libvulkan-dev vulkan-utility-libraries-dev spirv-tools

# CentOS/RHEL/Fedora
sudo yum install vulkan-tools vulkan-devel vulkan-validation-layers-devel spirv-tools
```

**Windows Vulkan Setup:**
- Download and install the [Vulkan SDK](https://vulkan.lunarg.com/sdk/home#windows)
- Ensure your graphics drivers are up to date

#### Clone and Setup

```bash
git clone https://github.com/tetherto/qvac-lib-infer-whispercpp.git
cd qvac-lib-infer-whispercpp

# Initialize submodules (required for native dependencies)
git submodule update --init --recursive

# Install dependencies
npm install
```

#### Build the Native AddOn

```bash
# Build the native addon
npm run build
```

This command runs the complete build sequence:
1. `bare-make generate` - Generates build configuration
2. `bare-make build` - Compiles the native C++ addon
3. `bare-make install` - Installs the built addon

#### Running Tests

After building, you can run the test suite:
```bash
# Run all tests (lint + unit + integration)
npm test

# Or run tests individually
npm run test:unit
npm run test:integration
```

Integration tests cover both the chunked reload flow (`test/integration/audio-ctx-chunking.test.js`) and the live streaming flow (`test/integration/live-stream-simulation.test.js`), so running them is the quickest way to verify those end-to-end scenarios after changes.

#### Development Workflow

For ongoing development, the typical workflow is:
```bash
npm install && npm run build && npm run test:integration
```

## Usage

The library provides a straightforward workflow for audio transcription:

> **Heads up:** the package is intended to be used through `index.js`’s `TranscriptionWhispercpp` class. Advanced sections below document the native addon for completeness, but you rarely need them when integrating the published npm package.

### 1. Choose a Data Loader

Data loaders abstract the way model files are accessed, whether from the filesystem, a network drive, or any other storage mechanism. More info about model registry and model builds in [resources](#resources).

- [Hyperdrive Data Loader](https://github.com/tetherto/qvac-lib-dl-hyperdrive)
- [Filesystem Data Loader](https://github.com/tetherto/qvac-lib-dl-filesystem)

First, select and instantiate a data loader that provides access to model files:

```javascript
// Option A: Filesystem Data Loader - for local model files
const FilesystemDL = require('@qvac/dl-filesystem')
const fsDL = new FilesystemDL({
  dirPath: './path/to/model/files' // Directory containing model weights and settings
})

// Option B: Hyperdrive Data Loader - for peer-to-peer distributed models
const HyperDriveDL = require('@qvac/dl-hyperdrive')
// Key comes from the Model Registry (see below)
const hdDL = new HyperDriveDL({
  key: 'hd://<driveKey>',  // Hyperdrive key containing model files
  store: corestore        // (Optional) A Corestore instance, If not provided, the Hyperdrive will use an in-memory store.
})
```

### 2. Configure Transcription Parameters

Most users interact with the addon exclusively through `index.js`. From that entrypoint we surface a small, safe subset of options; everything else keeps whisper.cpp defaults.

#### What index.js accepts

| Section | Key | Description |
| --- | --- | --- |
| `contextParams` | `model` | Absolute or relative path to the `.bin` whisper model |
| | | *(all other context keys keep their defaults because changing them forces a full reload, see below)* |
| `whisperConfig` | *(any `whisper_full_params` key)* | Forwarded untouched. We surface convenience defaults in `index.js`, but every whisper.cpp flag is accepted—see [Advanced configuration](#advanced-configuration). |
| `miscConfig` | `caption_enabled` | Formats segments with `<\|start\|>..<\|end\|>` markers |

#### Context keys that force a full reload

Internally `WhisperModel::configContextIsChanged()` watches `model`, `use_gpu`, `flash_attn` and `gpu_device`. If any of these change we must:

1. Call `unload()` (destroys the current `whisper_context` and `whisper_state`).
2. Recreate the context via `whisper_init_from_file_with_params`.
3. Warm up the model again before the next job.

Depending on model size this can take several seconds. Everything else in `whisperConfig`—language, temperatures, VAD settings, etc.—is applied in place and does **not** trigger a reload. If you are seeing unexpected pauses, double-check that you are not mutating these four context keys between jobs.

#### Advanced configuration

Need more than the handful of options exposed in `index.js`? The upstream whisper.cpp documentation lists every flag available through `whisper_full_params`. Rather than duplicating that matrix here, refer to:

- The official parameter reference: [`whisper_full_params`](https://github.com/ggerganov/whisper.cpp/blob/master/examples/stream/stream.cpp#L30-L96)
- Our longer examples for concrete shapes:
  - `examples/example.audio-ctx-chunking.js` (shows `offset_ms`, `duration_ms`, `audio_ctx`, and reload loops)
  - `examples/example.live-transcription.js` (shows streaming chunks into a single job)

Those scripts stay in sync with the codebase and are the best place to copy from when you need the raw addon surface.

### 3. Configuration Example

Quick JS-level configuration (what you typically pass to `new TranscriptionWhispercpp(...)`):

```javascript
const config = {
  contextParams: {
    model: './models/ggml-tiny.bin'
  },
  whisperConfig: {
    language: 'en',
    duration_ms: 0,
    temperature: 0.0,
    suppress_nst: true,
    n_threads: 0,
    vad_model_path: './models/ggml-silero-v5.1.2.bin',
    vadParams: {
      threshold: 0.6,
      min_speech_duration_ms: 250,
      min_silence_duration_ms: 200
    }
  },
  miscConfig: {
    caption_enabled: false
  }
}
```

Between this minimal configuration and the example scripts you should have everything needed, whether you are wiring the addon by hand or just instantiating `TranscriptionWhispercpp`.

**Available Whisper Models:**

- `ggml-tiny.bin` - Smallest, fastest (39MB)
- `ggml-base.bin` - Balanced size/accuracy (142MB)
- `ggml-small.bin` - Better accuracy (466MB)
- `ggml-medium.bin` - High accuracy (1.5GB)
- `ggml-large.bin` - Best accuracy (3.1GB)

**VAD Model:**
- `ggml-silero-v5.1.2.bin` - Silero VAD model for voice activity detection

Ensure model files are available in your chosen data loader source.

### 4. Create Model Instance

Import the specific Whisper model class based on the installed package and instantiate it:

```javascript
const TranscriptionWhispercpp = require('@qvac/transcription-whispercpp')

const model = new TranscriptionWhispercpp(args, config)
```

Note : This import changes depending on the package installed.

### 5. Load Model

Load the model weights and initialize the inference engine. Optionally provide a callback for progress updates:

```javascript
try {
  // Basic usage
  await model.load()

  // Advanced usage with progress tracking
  await model.load(
          false,  // Don't close loader after loading
          (progress) => console.log(`Loading: ${progress.overallProgress}% complete`)
  )
} catch (error) {
  console.error('Failed to load model:', error)
}
```

**Progress Callback Data**

The progress callback receives an object with the following properties:

| Property | Type | Description |
|----------|------|-------------|
| `action` | string | Current operation being performed |
| `totalSize` | number | Total bytes to be loaded |
| `totalFiles` | number | Total number of files to process |
| `filesProcessed` | number | Number of files completed so far |
| `currentFile` | string | Name of file currently being processed |
| `currentFileProgress` | string | Percentage progress on current file |
| `overallProgress` | string | Overall loading progress percentage |

### 6. Run Transcription

Pass an audio stream (e.g., from `bare-fs.createReadStream`) to the `run` method. Process the transcription results asynchronously.

There are two ways to receive transcription results:

#### Option 1: Real-time Streaming with `onUpdate()`

The `onUpdate()` callback receives each transcription segment **in real-time** as whisper.cpp generates them during processing. This is ideal for live transcription display or progressive updates.

```javascript
try {
  const audioStream = fs.createReadStream('path/to/your/audio.ogg', {
    highWaterMark: 16000 // Adjust based on bitrate (e.g., 128000 / 8)
  })

  const response = await model.run(audioStream)

  // Receive segments as they are transcribed (real-time streaming)
  await response
          .onUpdate(segment => {
            console.log('New segment transcribed:', segment)
            // Each segment arrives immediately after whisper.cpp processes it
          })
          .await() // Wait for transcription to complete

  console.log('Transcription finished!')

} catch (error) {
  console.error('Transcription failed:', error)
}
```

#### Option 2: Complete Result with `iterate()`

The `iterate()` method returns all transcription segments **after the entire transcription completes**. This is useful when you need the full result before processing.

```javascript
try {
  const audioStream = fs.createReadStream('path/to/your/audio.ogg', {
    highWaterMark: 16000
  })

  const response = await model.run(audioStream)

  // Wait for complete transcription, then iterate over all segments
  for await (const transcriptionChunk of response.iterate()) {
    console.log('Transcription chunk:', transcriptionChunk)
  }

  console.log('Transcription finished!')

} catch (error) {
  console.error('Transcription failed:', error)
}
```

**Key Differences:**
- **`onUpdate()`**: Real-time streaming - segments arrive as they are generated by whisper.cpp's `new_segment_callback`
- **`iterate()`**: Batch processing - all segments available after transcription completes

#### Chunking long recordings with reload()

[`examples/example.audio-ctx-chunking.js`](examples/example.audio-ctx-chunking.js) shows the production pattern: reuse a model instance, call `reload()` with `{ offset_ms, duration_ms, audio_ctx }` per chunk (first chunk uses `audio_ctx = 0`, subsequent ones clamp to ~1500), then run the full audio stream. The matching integration test (`test/integration/audio-ctx-chunking.test.js`) exercises exactly the same flow.

#### Live streaming a single job

[`examples/example.live-transcription.js`](examples/example.live-transcription.js) feeds tiny PCM buffers into a pushable `Readable`, keeps a single `model.run(...)` open, and relies on `onUpdate()` for incremental text. `test/integration/live-stream-simulation.test.js` covers both the streaming case and a segmented loop without any `reload()` calls.

### 7. Release Resources

Always unload the model when finished to free up memory and resources:

```javascript
try {
  await model.unload()
  // If using Hyperdrive/Hyperbee, close the db instance if applicable
  await db.close()
} catch (error) {
  console.error('Failed to unload model:', error)
}
```

## Decoder + VAD + Whisper Integration AddOn

This package combines audio decoding, optional VAD trimming, and Whisper transcription into a single `TranscriptionFfmpegAddon`. It automatically:

1. Decodes or ingests raw PCM/encoded audio
2. (Optionally) applies Silero VAD to drop non-speech
3. Feeds speech segments to Whisper for transcription

The principles are the same than for the single Whisper addon but with some differences in the configuration interface.

### Usage

Import `TranscriptionFfmpegAddon` from the `transcription-ffmpeg.js` module:

```javascript
const TranscriptionFfmpegAddon = require('@qvac/transcription-whispercpp/transcription-ffmpeg')
```

### Configuration

When you instantiate `TranscriptionFfmpegAddon`, pass:

* `loader`: your data loader instance
* `params.decoder.audioFormat`: one of
  * `'decoded'` (raw PCM input - for pre-decoded audio files)
  * `'encoded'` | `'s16le'` | `'f32le'` | `'mp3'` | `'wav'` | `'m4a'` (for encoded audio files)
* `params.decoder.streamIndex`: stream index of the media file (default: 0)
* `params.decoder.inputBitrate`: bitrate of the media file in bps (used to calculate buffer size)

### Usage Example

See `examples/example.ffmpeg.js` for a full working script that demonstrates the FFmpeg decoder + Whisper transcription pipeline with encoded audio files (MP3, etc.).

### Additional Features

- **Progress Tracking:** Monitor loading progress with callbacks
- **Performance Stats:** Measure inference time with the `stats` option

For a complete working example that brings all these steps together, see the [Quickstart Example](#quickstart-example) below.

## Quickstart example

Follow these steps to run the Quickstart demo using the Hyperdrive loader:

### 1. Clone the repo & Install the dependencies
```bash
git clone git@github.com:tetherto/qvac-lib-infer-whispercpp.git
cd qvac-lib-infer-whispercpp
npm install
```

### 2. Run the Hyperdrive example file inside `examples` folder
```bash
bare examples/transcription.hd.js
```
Note: It might take a few seconds for the add-on to be created and for the weights to be downloaded from HyperDrive.

### 3. Code Walkthrough

See `examples/quickstart.js` for the full Hyperdrive workflow (`HyperDriveDL` + `TranscriptionWhispercpp`), including streaming audio and cleanup. For VAD-enabled transcription, see `examples/exampleVad.hd.js`.

## Model registry

We use [Hyperbee](#glossary) as the model registry, mapping model identifiers (like `whisper-tiny`) to their corresponding [Hyperdrive](#glossary) keys, which point to the storage location of the model files.

*   **Hyperbee key for Whisper models registry:** `d4d762d2070f1285d012941a76f8314b243ddc99be20a4f2c72c4f2aae09070d`

The registry contains entries like:
```json
{
  "whisper-tiny":    "ebfb94b378276da139554668f1ff737644eadff529c2ea0f2662d7df61fd86ca",
}
```
Supported keys:
- whisper-tiny

## Benchmarking

We conduct comprehensive benchmarking of our Whisper transcription models to evaluate their performance across different audio conditions and metrics. The evaluations are performed using the LibriSpeech dataset, a standard benchmark for speech recognition tasks.

Our benchmarking suite measures transcription accuracy using Word Error Rate (WER) and Character Error Rate (CER), along with performance metrics such as model load times and inference speeds.

### Benchmark Results

For detailed benchmark results across all supported audio conditions and model configurations, see our [Benchmark Results Summary](benchmarks/results/results_summary.md).

The benchmarking covers:

- **Transcription Accuracy**: WER and CER scores for accuracy assessment
- **Performance Metrics**: Model loading times and inference speeds
- **Audio Conditions**: Clean speech, noisy environments and varied accents
- **Model Variants**: Different quantization levels and model sizes

Results are updated regularly as new model versions are released.

## Other examples

-   [Quickstart](examples/quickstart.js) – Basic transcription example using HyperDrive loader.
-   [HyperDrive Transcription](examples/transcription.hd.js) – Transcribes pre-decoded raw audio files using HyperDrive model loading.
-   [VAD with HyperDrive](examples/exampleVad.hd.js) – Demonstrates Voice Activity Detection (VAD) with HyperDrive model loading.
-   [FFmpeg Decoder](examples/example.ffmpeg.js) – Transcribes encoded audio files (MP3, WAV, etc.) using the FFmpeg decoder pipeline.
-   [Standalone Decoder](examples/example.decoder.js) – Demonstrates the FFmpeg decoder independently for audio format conversion.
-   [Model Reload](examples/example.reload.js) – Shows how to reload models with different configurations (language, temperature).
-   [Audio ctx chunking](examples/example.audio-ctx-chunking.js) – Processes long recordings by reloading with `offset_ms`, `duration_ms`, and `audio_ctx` per chunk (mirrors the `audio-ctx-chunking` integration test).
-   [Live transcription](examples/example.live-transcription.js) – Streams small chunks into a single job while maintaining Whisper state between updates (mirrors the `live-stream-simulation` integration test).

## Glossary

• **Bare** – Small and modular JavaScript runtime for desktop and mobile. [Learn more](https://docs.pears.com/bare-reference/overview).  
• **QVAC** – QVAC is our open-source AI-SDK for building decentralized AI applications.  
• **Hyperdrive** – Hyperdrive is a secure, real-time distributed file system designed for easy P2P file sharing. [Learn more](https://docs.pears.com/building-blocks/hyperdrive).  
• **Hyperbee** – A decentralized B-tree built on top of Hypercores, and exposes a key-value API to store values. [Learn more](https://docs.pears.com/building-blocks/hyperbee).  
• **Corestore** – Corestore is a Hypercore factory that makes it easier to manage large collections of named Hypercores. [Learn more](https://docs.pears.com/helpers/corestore).

## Error Range
All the errors from this library are in the range of 6001-7000

## Resources

*   PoC Repo: [tetherto/qvac-transcription-poc](https://github.com/tetherto/qvac-transcription-poc)
*   Pear app (Desktop): TBD

## License

This project is licensed under the Apache-2.0 License – see the LICENSE file for details.

For questions or issues, please open an issue on the GitHub repository.

