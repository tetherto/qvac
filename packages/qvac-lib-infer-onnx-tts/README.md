# qvac-lib-infer-onnx-tts

This library simplifies running Text-to-Speech (TTS) models within QVAC runtime applications. It provides an easy interface to load, execute, and manage TTS instances, supporting multiple data sources (called data loaders) and leveraging ONNX Runtime for efficient inference.

The package supports two TTS engines:
- **Chatterbox** - Neural TTS with voice cloning from reference audio (24 kHz)
- **Supertonic** - Diffusion-based TTS with pre-trained voice styles (44.1 kHz)

The engine is auto-detected based on the arguments you provide.

## Table of Contents

- [Supported Platforms](#supported-platforms)
- [TTS Engines](#tts-engines)
- [Installation](#installation)
- [Building from Source](#building-from-source)
- [Downloading Models](#downloading-models)
- [Usage: Chatterbox](#usage-chatterbox)
  - [1. Import the Model Class](#1-import-the-model-class)
  - [2. Create a Data Loader](#2-create-a-data-loader)
  - [3. Create the `args` obj](#3-create-the-args-obj)
  - [4. Create the `config` obj](#4-create-the-config-obj)
  - [5. Create Model Instance](#5-create-model-instance)
  - [6. Load Model](#6-load-model)
  - [7. Run TTS Synthesis](#7-run-tts-synthesis)
  - [8. Release Resources](#8-release-resources)
- [Usage: Supertonic](#usage-supertonic)
  - [Model Directory Setup](#model-directory-setup)
  - [Basic Usage (modelDir)](#basic-usage-modeldir)
  - [Explicit Paths Usage](#explicit-paths-usage)
  - [Supertonic Args Reference](#supertonic-args-reference)
  - [Available Voices](#available-voices)
  - [Supported Languages](#supported-languages)
- [Output Format](#output-format)
- [Other Examples](#other-examples)
- [Tests](#tests)
- [Glossary](#glossary)
- [Resources](#resources)
- [Contributing](#contributing)
- [License](#license)

## Supported Platforms

| Platform | Architecture | Min Version | Status | GPU Support |
|----------|-------------|-------------|--------|-------------|
| macOS | arm64, x64 | 14.0+ | ✅ Tier 1 | CoreML |
| iOS | arm64 | 17.0+ | ✅ Tier 1 | CoreML |
| Linux | arm64, x64 | Ubuntu-22+ | ✅ Tier 1 | CPU only |
| Android | arm64 | 12+ | ✅ Tier 1 | NNAPI |
| Windows | x64 | 10+ | ✅ Tier 1 | DirectML |

**Dependencies:**
- qvac-lib-inference-addon-cpp: C++ addon framework
- ONNX Runtime: Inference engine
- Chatterbox TTS: Neural text-to-speech engine with voice cloning
- Supertonic TTS: Diffusion-based text-to-speech engine with pre-trained voices
- Bare Runtime (>=1.17.3): JavaScript runtime
- Linux requires Clang/LLVM 19 with libc++

## TTS Engines

This package supports two TTS engines. The engine is auto-detected based on the arguments you provide:

- If you pass `modelDir` + `voiceName`, or `textEncoderPath`, the **Supertonic** engine is used.
- Otherwise, the **Chatterbox** engine is used.

| Feature | Chatterbox | Supertonic |
|---------|-----------|------------|
| Architecture | Transformer-based language model | Diffusion-based latent denoising |
| Sample Rate | 24,000 Hz | 44,100 Hz |
| Voice Method | Voice cloning from reference audio | Pre-trained voice styles (`.bin` files) |
| ONNX Models | 5 (tokenizer, speech_encoder, embed_tokens, conditional_decoder, language_model) | 3 (text_encoder, latent_denoiser, voice_decoder) |
| Languages | English (en), Spanish (es), French (fr), German (de), Italian (it), Portuguese (pt), Russian (ru), Arabic (ar), Danish (da), Greek (el), Finnish (fi), Hebrew (he), Hindi (hi), Korean (ko), Malay (ms), Dutch (nl), Norwegian (no), Polish (pl), Swedish (sv), Swahili (sw), Turkish (tr) | English (en), Korean (ko), Spanish (es), Portuguese (pt), French (fr) |
| Speed Control | N/A | Configurable via `speed` parameter |
| Inference Steps | Single-pass | Configurable via `numInferenceSteps` (default: 5) |
| Use Case | Voice cloning from a reference audio sample | General-purpose TTS with selectable voice presets |
| Real Time Factor | Usually >1.0 | <1.0 |

Note: though Chatterbox models support up to 23 languages, this implementation still only support 7 due to onnx models limitations. We are actively working to provide new onnx models that support all 23 langauges from the original implementation. 

## Installation

### Prerequisites

Install [Bare](#glossary) Runtime:
```bash
npm install -g bare
```
Note : Make sure the Bare version is `>= 1.17.3`. Check this using: 

```bash
bare -v
```

### Installing the Package

Install the latest TTS package:
```bash
npm install @qvac/tts-onnx@latest
```

## Building from Source

If you want to build the addon from source (for development or customization), follow these steps:

### Prerequisites

Before building, ensure you have the following installed:

1. **vcpkg** - Cross-platform C++ package manager
   ```bash
   git clone https://github.com/microsoft/vcpkg.git
   cd vcpkg && ./bootstrap-vcpkg.sh -disableMetrics
   export VCPKG_ROOT=/path/to/vcpkg
   export PATH=$VCPKG_ROOT:$PATH
   ```

2. **Build tools** for your platform:
   - **Linux**:
     ```bash
     sudo apt install clang libc++-dev libc++abi-dev build-essential autoconf automake libtool pkg-config
     ```
   - **macOS**: Xcode command line tools
   - **Windows**: Visual Studio with C++ build tools

3. **Node.js and npm** (version 18+ recommended)

4. **Bare runtime and build tools**:
   ```bash
   npm install -g bare-runtime bare-make
   ```

### Building the Addon

1. **Clone the repository**:
   ```bash
   git clone https://github.com/tetherto/qvac
   cd qvac/packages/qvac-lib-infer-onnx-tts
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Build the addon**:
   ```bash
   npm run build
   ```

This command will:
- Generate CMake build files (`bare-make generate`)
- Build the native addon (`bare-make build`) 
- Install the addon to the prebuilds directory (`bare-make install`)

### Verifying the Build

After building, you can run the tests to verify everything works:

```bash
npm run test:unit
npm run test:integration  # Requires model files
```

**Note**: Integration tests require model files to be present in the `models/` directory. See the [Downloading Models](#downloading-models) section below.

## Downloading Models

Model files must be present locally before running examples or integration tests. Download scripts fetch models from Hugging Face.

```bash
# Chatterbox only (English q4 by default)
npm run models:ensure:chatterbox

# Chatterbox with a specific variant
CHATTERBOX_VARIANT=fp32 npm run models:ensure:chatterbox

# Supertonic only (English by default)
npm run models:ensure:supertonic

# Multilingual models
TTS_LANGUAGE=multilingual npm run models:ensure:chatterbox
TTS_LANGUAGE=multilingual npm run models:ensure:supertonic

# Both English and multilingual for a single engine
TTS_LANGUAGE=all npm run models:ensure:chatterbox

# Both Chatterbox + Supertonic (English by default)
npm run models:ensure

# Both Chatterbox + Supertonic multilingual
TTS_LANGUAGE=multilingual npm run models:ensure

# Everything (both engines, both languages)
TTS_LANGUAGE=all npm run models:ensure
```

### Environment Variables

| Variable | Default | Values | Description |
|----------|---------|--------|-------------|
| `CHATTERBOX_VARIANT` | `q4` | `fp32`, `fp16`, `q4`, `q4f16` | Chatterbox model quantization variant |
| `TTS_LANGUAGE` | `en` | `en`, `multilingual`, `all` | Language set for model downloads (`all` downloads both) |

Models are saved to `models/chatterbox/` (English), `models/chatterbox-multilingual/`, `models/supertonic/`, and `models/supertonic-multilingual/`.

## Usage: Chatterbox

### 1. Import the Model Class

```js
const { ONNXTTS } = require('@qvac/tts-onnx')
// or if importing directly:
// const ONNXTTS = require('./')
```

### 2. Create a Data Loader

Data Loaders abstract the way model files are accessed. You can use a [`FileSystemDataLoader`](https://github.com/tetherto/qvac/tree/main/packages/dl-filesystem) to stream the model file(s) from your local file system.

```js
const FilesystemDL = require('@qvac/dl-filesystem')
const fsDL = new FilesystemDL({
  dirPath: './path/to/model/files'
})
```

### 3. Create the `args` obj

```js
const args = {
  loader: fsDL,
  opts: { stats: true },
  logger: console,
  cache: './models/',
  tokenizerPath: 'chatterbox/tokenizer.json',
  speechEncoderPath: 'chatterbox/speech_encoder.onnx',
  embedTokensPath: 'chatterbox/embed_tokens.onnx',
  conditionalDecoderPath: 'chatterbox/conditional_decoder.onnx',
  languageModelPath: 'chatterbox/language_model.onnx',
  referenceAudio: referenceAudioFloat32Array
}
```

The `args` obj contains the following properties:

* `loader`: The Data Loader instance from which the model files will be streamed.
* `logger`: This property is used to create logging functionality. 
* `opts.stats`: This flag determines whether to calculate inference stats.
* `cache`: The local directory where the model files will be downloaded to.
* `tokenizerPath`: Path to the Chatterbox tokenizer JSON file.
* `speechEncoderPath`: Path to the speech encoder ONNX model.
* `embedTokensPath`: Path to the embed tokens ONNX model.
* `conditionalDecoderPath`: Path to the conditional decoder ONNX model.
* `languageModelPath`: Path to the language model ONNX model.
* `referenceAudio`: Float32Array of reference audio samples for voice cloning. See [Reference Audio Guidelines](#reference-audio-guidelines) below.
* `lazySessionLoading`: (optional) Boolean to defer ONNX session creation until first use. Defaults to `true` on iOS and Android, `false` on all other platforms.

#### Reference Audio Guidelines

The quality of the reference audio directly affects voice cloning results. Poor recordings can cause the model to repeat the reference content instead of synthesizing the target text.

**Recommended specs:**

| Property | Recommendation |
|----------|---------------|
| Format | WAV (16-bit PCM, mono) |
| Sample rate | 24,000 Hz (other rates are resampled automatically) |
| Duration | 3--6 seconds of clear speech |
| Quality | Uncompressed or high-bitrate source; avoid low-bitrate AAC (e.g. Voice Memos at 64 kbps) |
| Content | A single continuous sentence; minimize silence and background noise |

**Common pitfalls:**

- Lossy compression artifacts (AAC, MP3) surviving WAV conversion degrade the speech encoder output
- Long recordings (>10s) dilute the voice embedding and slow inference
- Background noise or multiple speakers confuse the encoder
- Reference content that overlaps with the target text can cause the model to reproduce the reference verbatim

### 4. Create the `config` obj

The `config` obj consists of a set of parameters which can be used to tweak the behaviour of the TTS model.

```js
const config = {
  language: 'en',
  useGPU: true,
}
```

| Parameter        | Type    | Default | Description                                    |
|------------------|---------|---------|------------------------------------------------|
| language         | string  | 'en'    | Language code (ISO 639-1 format)               |
| useGPU           | boolean | false   | Enable GPU acceleration based on EP provider   |

### 5. Create Model Instance

```js
const model = new ONNXTTS(args, config)
```

### 6. Load Model

```js
await model.load()
```

_Optionally_ you can pass the following parameters to tweak the loading behaviour.
* `closeLoader?`: This boolean value determines whether to close the Data Loader after loading. Defaults to `true`
* `reportProgressCallback?`: A callback function which gets called periodically with progress updates. It can be used to display overall progress percentage.

_For example:_

```js
await model.load(false, progress => process.stdout.write(`\rOverall Progress: ${progress.overallProgress}%`))
```

**Progress Callback Data**

The progress callback receives an object with the following properties:

| Property              | Type   | Description                             |
|-----------------------|--------|-----------------------------------------|
| `action`              | string | Current operation being performed       |
| `totalSize`           | number | Total bytes to be loaded                |
| `totalFiles`          | number | Total number of files to process        |
| `filesProcessed`      | number | Number of files completed so far        |
| `currentFile`         | string | Name of file currently being processed  |
| `currentFileProgress` | string | Percentage progress on current file     |
| `overallProgress`     | string | Overall loading progress percentage     |

### 7. Run TTS Synthesis

Pass the text to synthesize to the `run` method. Process the generated audio output asynchronously:

```javascript
try {
  const textToSynthesize = 'Hello world! This is a test of the TTS system.'
  let audioSamples = []

  const response = await model.run({
    input: textToSynthesize,
    type: 'text'
  })

  // Process output using callback to collect audio samples
  await response
    .onUpdate(data => {
      if (data.outputArray) {
        // Collect raw PCM audio samples
        const samples = Array.from(data.outputArray)
        audioSamples = audioSamples.concat(samples)
        console.log(`Received ${samples.length} audio samples`)
      }
      if (data.event === 'JobEnded') {
        console.log('TTS synthesis completed:', data.stats)
      }
    })
    .await() // Wait for the entire process to complete

  console.log(`Total audio samples generated: ${audioSamples.length}`)
    
  // audioSamples now contains the complete audio as PCM data (16-bit, 16kHz, mono)
  // You can create WAV files, stream to audio APIs, etc.

  // Access performance stats if enabled
  if (response.stats) {
    console.log(`Inference stats: ${JSON.stringify(response.stats)}`)
  }

} catch (error) {
  console.error('TTS synthesis failed:', error)
}
```

### 8. Release Resources

Unload the model when finished:

```javascript
try {
  await model.unload()
} catch (error) {
  console.error('Failed to unload model:', error)
}
```

## Usage: Supertonic

Supertonic is a diffusion-based TTS engine that uses pre-trained voice styles instead of voice cloning. It produces high-quality speech at 44.1 kHz.

### Model Directory Setup

Supertonic expects the following directory layout:

```
models/supertonic/
├── tokenizer.json
├── onnx/
│   ├── text_encoder.onnx
│   ├── text_encoder.onnx_data
│   ├── latent_denoiser.onnx
│   ├── latent_denoiser.onnx_data
│   ├── voice_decoder.onnx
│   └── voice_decoder.onnx_data
└── voices/
    ├── F1.bin
    ├── F2.bin
    ├── ...
    └── M5.bin
```

Models can be downloaded from the [Hugging Face repository](https://huggingface.co/onnx-community/Supertonic-TTS-ONNX).

### Basic Usage (modelDir)

The simplest way to use Supertonic is by passing a `modelDir` and `voiceName`. All model file paths are derived automatically from the directory structure.

```js
const path = require('bare-path')
const { ONNXTTS } = require('@qvac/tts-onnx')

const SUPERTONIC_SAMPLE_RATE = 44100

const args = {
  modelDir: path.join(__dirname, 'models', 'supertonic'),
  voiceName: 'F1',
  speed: 1,
  numInferenceSteps: 5,
  opts: { stats: true },
  logger: console
}

const config = {
  language: 'en'
}

const model = new ONNXTTS(args, config)

await model.load()

const response = await model.run({
  input: 'Hello world! This is Supertonic TTS.',
  type: 'text'
})

let audioSamples = []
await response
  .onUpdate(data => {
    if (data && data.outputArray) {
      audioSamples = audioSamples.concat(Array.from(data.outputArray))
    }
  })
  .await()

// audioSamples contains PCM data (16-bit, 44100 Hz, mono)

await model.unload()
```

### Explicit Paths Usage

Alternatively, you can provide explicit paths to each model file instead of using `modelDir`:

```js
const args = {
  tokenizerPath: '/path/to/tokenizer.json',
  textEncoderPath: '/path/to/onnx/text_encoder.onnx',
  latentDenoiserPath: '/path/to/onnx/latent_denoiser.onnx',
  voiceDecoderPath: '/path/to/onnx/voice_decoder.onnx',
  voicesDir: '/path/to/voices',
  voiceName: 'M1',
  speed: 1.2,
  numInferenceSteps: 10,
  opts: { stats: true },
  logger: console
}

const model = new ONNXTTS(args, { language: 'es' })
```

### Supertonic Args Reference

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `modelDir` | string | - | Base directory containing tokenizer, onnx/, and voices/ subdirectories |
| `tokenizerPath` | string | - | Path to `tokenizer.json` (auto-derived from `modelDir`) |
| `textEncoderPath` | string | - | Path to `text_encoder.onnx` (auto-derived from `modelDir`) |
| `latentDenoiserPath` | string | - | Path to `latent_denoiser.onnx` (auto-derived from `modelDir`) |
| `voiceDecoderPath` | string | - | Path to `voice_decoder.onnx` (auto-derived from `modelDir`) |
| `voicesDir` | string | - | Path to directory containing voice `.bin` files (auto-derived from `modelDir`) |
| `voiceName` | string | `'F1'` | Voice preset name (e.g., `'F1'`, `'M1'`) |
| `speed` | number | `1` | Speech speed multiplier (1.0 = normal speed) |
| `numInferenceSteps` | number | `5` | Number of diffusion denoising steps (higher = better quality, slower) |
| `loader` | Loader | - | Optional data loader for streaming model files |
| `cache` | string | `'.'` | Local directory for caching model files |
| `opts.stats` | boolean | `false` | Enable inference performance statistics |
| `logger` | object | - | Logger instance for debug output |

### Available Voices

Supertonic includes 10 pre-trained voice styles:

| Voice | Gender | Description |
|-------|--------|-------------|
| `F1` | Female | Female voice style 1 (default) |
| `F2` | Female | Female voice style 2 |
| `F3` | Female | Female voice style 3 |
| `F4` | Female | Female voice style 4 |
| `F5` | Female | Female voice style 5 |
| `M1` | Male | Male voice style 1 |
| `M2` | Male | Male voice style 2 |
| `M3` | Male | Male voice style 3 |
| `M4` | Male | Male voice style 4 |
| `M5` | Male | Male voice style 5 |

## Output Format

The output is received via the `onUpdate` callback of the response object. The TTS system provides raw audio data in the form of PCM samples.

### Output Events

The system generates different types of events during TTS synthesis:

#### 1. Audio Output Events
When audio data is available, the callback receives raw PCM samples:

```javascript
// Audio output event - contains only the raw PCM data
{
  outputArray: Int16Array([1234, -567, 890, -123, ...]) // 16-bit PCM samples
}
```

#### 2. Job Completion Events
When synthesis completes, performance statistics are provided:

```javascript
// Job completion event - contains performance statistics
{
  totalTime: 0.624621926,              // Total processing time in seconds
  tokensPerSecond: 219.33267837286903, // Processing speed
  realTimeFactor: 0.05818013468703428, // Real-time performance factor. Less than 1 means that streaming is possible
  audioDurationMs: 10736,              // Generated audio duration in milliseconds
  totalSamples: 171776                 // Total number of audio samples generated
}
```

**Audio Format Specifications:**
- **Sample Rate:** 24,000 Hz (Chatterbox) or 44,100 Hz (Supertonic)
- **Format:** 16-bit signed PCM, mono channel
- **Data Type:** Int16Array containing raw audio samples

### Working with Audio Data

Here's how to collect and process the audio output:

```javascript
let audioSamples = []

const response = await model.run({
  input: 'Your text to synthesize',
  type: 'text'
})

await response
  .onUpdate(data => {
    if (data.outputArray) {
      // Check if this is an audio output event
      const samples = Array.from(data.outputArray)
      audioSamples = audioSamples.concat(samples)
      console.log(`Received ${samples.length} audio samples`)
    } else {
      // This is a completion event with statistics
      console.log('TTS completed with stats:', data)
    }
  })
  .await()

// audioSamples now contains all PCM samples as 16-bit integers
// Sample rate: 24000 Hz (Chatterbox) or 44100 Hz (Supertonic), mono PCM
console.log(`Total audio samples generated: ${audioSamples.length}`)
```

## Other Examples

-   [Chatterbox TTS](examples/chatterbox-tts.js) - Voice cloning from reference audio (English or multilingual).
-   [Chatterbox Langdetect TTS](examples/chatterbox-langdetect-tts.js) - Detects the input language with `@qvac/langdetect-text`, selects the English or multilingual Chatterbox bundle, and synthesizes terminal text.
-   [Supertonic TTS](examples/supertonic-tts.js) - Pre-trained voice styles (English or multilingual).

```bash
# Chatterbox English (uses bundled jfk.wav as reference audio)
bare examples/chatterbox-tts.js english

# Chatterbox English with custom reference audio
bare examples/chatterbox-tts.js english path/to/reference.wav

# Chatterbox Multilingual
bare examples/chatterbox-tts.js multilingual

# Chatterbox with automatic language detection
bare examples/chatterbox-langdetect-tts.js "Hola mundo. Esta demo detecta el idioma automaticamente."

# Supertonic English
bare examples/supertonic-tts.js english

# Supertonic Multilingual
bare examples/supertonic-tts.js multilingual
```

## Tests

```bash
# js integration tests
npm run test:integration

# C++ unit tests
npm run test:cpp

# C++ unit tests to collect code coverage
npm run coverage:cpp
```

**Note**: Integration tests require model files to be present in the `models/` directory.

## Glossary

- **Bare** - Small and modular JavaScript runtime for desktop and mobile. [Learn more](https://docs.pears.com/bare-reference/overview).  
- **QVAC** - QVAC is our open-source AI-SDK for building decentralized AI applications.  
- **ONNX** - Open Neural Network Exchange is an open format built to represent machine learning models. [Learn more](https://onnx.ai/).  
- **Chatterbox** - A neural text-to-speech system with voice cloning capabilities. [Learn more](https://github.com/ResembleAI/chatterbox).  
- **Supertonic** - A diffusion-based text-to-speech system with pre-trained voice styles. [Learn more](https://huggingface.co/onnx-community/Supertonic-TTS-ONNX).  
- **Corestore** - Corestore is a Hypercore factory that makes it easier to manage large collections of named Hypercores. [Learn more](https://docs.pears.com/helpers/corestore).

## Resources

*   **QVAC Examples Repo:** [https://github.com/tetherto/qvac-examples](https://github.com/tetherto/qvac-examples)
*   **ONNX Runtime:** [https://onnxruntime.ai/](https://onnxruntime.ai/)
*   **Base ONNX Addon:** [https://github.com/tetherto/qvac/tree/main/packages/qvac-lib-infer-onnx-base](https://github.com/tetherto/qvac/tree/main/packages/qvac-lib-infer-onnx-base)
*   **Chatterbox TTS:** [https://github.com/ResembleAI/chatterbox](https://github.com/ResembleAI/chatterbox)
*   **Supertonic TTS:** [https://huggingface.co/onnx-community/Supertonic-TTS-ONNX](https://huggingface.co/onnx-community/Supertonic-TTS-ONNX)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

## License

This project is licensed under the Apache-2.0 License - see the [LICENSE](./LICENSE) file for details.

_For questions or issues, please open an issue on the GitHub repository._
