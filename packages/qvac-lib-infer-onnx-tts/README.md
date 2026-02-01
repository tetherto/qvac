# qvac-lib-infer-onnx-tts

This library simplifies running Text-to-Speech (TTS) models within QVAC runtime applications. It provides an easy interface to load, execute, and manage TTS instances, supporting multiple data sources (called data loaders) and leveraging ONNX Runtime for efficient inference.

The TTS system uses the Piper neural text-to-speech model to convert text into natural-sounding speech audio files.

## Table of Contents

- [Supported Platforms](#supported-platforms)
- [Installation](#installation)
- [Building from Source](#building-from-source)
- [Usage](#usage)
  - [1. Import the Model Class](#1-import-the-model-class)
  - [2. Create a Data Loader](#2-create-a-data-loader)
  - [3. Create the `args` obj](#3-create-the-args-obj)
  - [4. Create the `config` obj](#4-create-the-config-obj)
  - [5. Create Model Instance](#5-create-model-instance)
  - [6. Load Model](#6-load-model)
  - [7. Run TTS Synthesis](#7-run-tts-synthesis)
  - [8. Release Resources](#8-release-resources)
- [Quickstart Example](#quickstart-example)
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
| Linux | arm64, x64 | Ubuntu-22+ | ✅ Tier 1 | CUDA, ROCm |
| Android | arm64 | 12+ | ✅ Tier 1 | NNAPI |
| Windows | x64 | 10+ | ✅ Tier 1 | DirectML, CUDA |

**Dependencies:**
- qvac-lib-inference-addon-cpp: C++ addon framework
- ONNX Runtime: Inference engine
- Piper TTS: Neural text-to-speech model
- Bare Runtime (≥1.17.3): JavaScript runtime
- Ubuntu-22 requires g++-13 installed

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
   - **Linux**: `sudo apt install build-essential autoconf automake libtool pkg-config`
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
   git clone git@github.com:tetherto/qvac-lib-infer-onnx-tts.git
   cd qvac-lib-infer-onnx-tts
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

**Note**: Integration tests require model files to be present in the `model/` directory. See the [CI integration test script](.github/workflows/integration-test.yaml) for details on model requirements.

## Usage

### 1. Import the Model Class

```js
const { ONNXTTS } = require('@qvac/tts-onnx')
// or if importing directly:
// const ONNXTTS = require('./')
```

### 2. Create a Data Loader

Data Loaders abstract the way model files are accessed. It is recommended to utilize a [`HyperdriveDataLoader`](https://github.com/tetherto/qvac-lib-dl-hyperdrive) to stream the model file(s) from a `hyperdrive`. Optionally, you could use a [`FileSystemDataLoader`](https://github.com/tetherto/qvac-lib-dl-filesystem) to stream the model file(s) from your local file system.

```js
const store = new Corestore('./store')
const hdStore = store.namespace('hd')

// see examples folder for existing keys
const hdDL = new HyperDriveDL({
  key: 'hd://your-hyperdrive-key-here',
  store: hdStore
})
```

### 3. Create the `args` obj

```js
const args = {
  loader: hdDL,                              // Data loader instance
  opts: { stats: true },                     // Enable performance statistics
  logger: console,                           // Logger instance
  cache: './models/',                        // Local cache directory
  mainModelUrl: 'en_US-amy-low.onnx',        // Main ONNX model file
  configJsonPath: 'en_US-amy-low.onnx.json', // Model configuration file
  eSpeakDataPath: 'espeak-ng-data'           // eSpeak data directory
}
```

The `args` obj contains the following properties:

* `loader`: The Data Loader instance from which the model files will be streamed.
* `logger`: This property is used to create logging functionality. 
* `opts.stats`: This flag determines whether to calculate inference stats.
* `cache`: The local directory where the model files will be downloaded to.
* `mainModelUrl`: The name of the main TTS ONNX model file in the Data Loader (the model used for inference).
* `configJsonPath`: The name of the model configuration JSON file in the Data Loader (the file used to configure the ONNX model).
* `eSpeakDataPath`: The name of the espeak-ng-data directory in the Data Loader (which contains language data such as dictionaries, phonemes, voices, etc.)

### 4. Create the `config` obj

The `config` obj consists of a set of parameters which can be used to tweak the behaviour of the TTS model.

```js
// an example of possible configuration
const config = {
  language: 'en',                    // Language code (ISO 639-1 format)
  engine: 'piper',                   // TTS engine to use (currently supports 'piper')
  useGPU: true,                   // Boolean to useGPU and it selects EP as per platform otherwise fallbacks to CPU from version 0.3.4 for both Android / iOS
}
```

| Parameter        | Type    | Default | Description                                    |
|------------------|---------|---------|------------------------------------------------|
| language         | string  | 'en'    | Language code (ISO 639-1 format)               |
| engine           | string  | 'piper' | TTS engine to use (currently supports 'piper') |
| useGPU           | boolean | true    | Enable Piper to use GPU based on EP provider   |

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
  // Close P2P resources if applicable
} catch (error) {
  console.error('Failed to unload model:', error)
}
```

## Quickstart Example

Follow these simple steps to run the Quickstart demo:

### 0. Install Bare

```bash
npm install -g bare
```

### 1. Create a new Project

```bash
mkdir qvac-tts-quickstart
cd qvac-tts-quickstart
npm init -y
```

### 2. Install Dependencies

```bash
npm install @qvac/tts-onnx
```

### 3. Copy Quickstart code into `index.js`
```js
'use strict'

const { ONNXTTS } = require('@qvac/tts-onnx')

async function main () {
  // Configure TTS parameters
  const args = {
    mainModelUrl: './path/to/your/model.onnx',
    configJsonPath: './path/to/your/model.onnx.json',
    eSpeakDataPath: './path/to/espeak-ng-data',
    opts: { stats: true }
  }

  const config = {
    language: 'en',
    engine: 'piper',
    streamingEnabled: false
  }

  const model = new ONNXTTS(args, config)

  try {
    console.log('Loading TTS model...')
    await model.load()
    console.log('Model loaded successfully.')

    const textToSynthesize = 'Hello world! This is a test of the TTS system using ONNX.'
    console.log(`Running TTS on: "${textToSynthesize}"`)
    
    let audioSamples = []
    const response = await model.run({
      input: textToSynthesize,
      type: 'text'
    })

    console.log('Waiting for TTS results...')
    await response
      .onUpdate(data => {
        if (data.outputArray) {
          const samples = Array.from(data.outputArray)
          audioSamples = audioSamples.concat(samples)
          console.log(`Received ${samples.length} audio samples`)
        }
        if (data.event === 'JobEnded') {
          console.log('Job completed with stats:', data.stats)
        }
      })
      .await() // Wait for the final result

    console.log('TTS synthesis completed!')
    console.log(`Total audio samples: ${audioSamples.length}`)
    if (response.stats) {
      console.log(`Inference stats: ${JSON.stringify(response.stats)}`)
    }
  } catch (err) {
    console.error('Error during TTS processing:', err)
  } finally {
    console.log('Unloading model...')
    await model.unload()
    console.log('Model unloaded.')
  }
}

main().catch(console.error)
```

### 4. Run `index.js`

```bash
bare index.js
```

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
- **Sample Rate:** 16000 Hz
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
    // Check if this is an audio output event
    if (data.outputArray) {
      // Collect raw PCM audio samples
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
// Sample rate: 16000 Hz, Format: mono PCM
console.log(`Total audio samples generated: ${audioSamples.length}`)
```

## Other Examples

-   [Basic TTS](examples/example-onnx-tts.js) – Demonstrates basic text-to-speech synthesis.
-   [Hyperdrive TTS](examples/example-hd-onnx-tts.js) – Demonstrates TTS with Hyperdrive data loader.
-   Check the `examples/` directory for more usage examples.

### Setting up eSpeak-ng Data

The TTS system requires eSpeak-ng phoneme data to function properly. You need to download and compile the espeak-ng data from the official repository.
It can be fetched from: https://github.com/rhasspy/espeak-ng/tree/0f65aa301e0d6bae5e172cc74197d32a6182200f

#### Using the eSpeak Data in Your Project

Once you have the espeak-ng-data directory, reference it in your TTS configuration:

```javascript
const args = {
  mainModelUrl: './path/to/your/model.onnx',
  configJsonPath: './path/to/your/model.onnx.json',
  eSpeakDataPath: './espeak-ng-data',  // Path to your espeak data
  opts: { stats: true }
}
```

**Important Notes:**
- The `eSpeakDataPath` parameter is **required** and must point to a valid espeak-ng-data directory

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

• **Bare** – Small and modular JavaScript runtime for desktop and mobile. [Learn more](https://docs.pears.com/bare-reference/overview).  
• **QVAC** – QVAC is our open-source AI-SDK for building decentralized AI applications.  
• **ONNX** – Open Neural Network Exchange is an open format built to represent machine learning models. [Learn more](https://onnx.ai/).  
• **Piper** – A fast, local neural text-to-speech system. [Learn more](https://github.com/rhasspy/piper).  
• **Hyperdrive** – Hyperdrive is a secure, real-time distributed file system designed for easy P2P file sharing. [Learn more](https://docs.pears.com/building-blocks/hyperdrive).  
• **Corestore** – Corestore is a Hypercore factory that makes it easier to manage large collections of named Hypercores. [Learn more](https://docs.pears.com/helpers/corestore).

## Resources

*   **QVAC Examples Repo:** [https://github.com/tetherto/qvac-examples](https://github.com/tetherto/qvac-examples)
*   **ONNX Runtime:** [https://onnxruntime.ai/](https://onnxruntime.ai/)
*   **Base ONNX Addon:** [https://github.com/tetherto/qvac-lib-infer-onnx-base](https://github.com/tetherto/qvac-lib-infer-onnx-base)
*   **Piper TTS:** [https://github.com/rhasspy/piper](https://github.com/rhasspy/piper)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

## License

This project is licensed under the Apache-2.0 License – see the [LICENSE](./LICENSE) file for details.

_For questions or issues, please open an issue on the GitHub repository._