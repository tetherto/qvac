# qvac-lib-inference-addon-onnx-ocr-fasttext

[![Build Status](https://github.com/tetherto/qvac-lib-inference-addon-onnx-ocr-fasttext/actions/workflows/on-pr.yaml/badge.svg)](https://github.com/tetherto/qvac-lib-inference-addon-onnx-ocr-fasttext/actions/workflows/on-pr.yaml)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![npm version](https://img.shields.io/npm/v/@qvac/ocr-onnx.svg)](https://www.npmjs.com/package/@qvac/ocr-onnx)

This library provides Optical Character Recognition (OCR) capabilities for QVAC runtime applications, leveraging the ONNX Runtime for efficient inference. It implements the [QVAC Inference Addon ONNX base class](https://github.com/tetherto/qvac-lib-infer-onnx-base).

The OCR process uses two models:
*   **Detector:** Locates text regions within an image.
*   **Recognizer:** Extracts text strings from the detected regions. Recognizer models are language-specific.

## Table of Contents

*   [Installation](#installation)
*   [Building from Source](#building-from-source)
*   [Obtaining Models](#obtaining-models)
*   [Usage](#usage)
    *   [1. Configure Parameters](#1-configure-parameters)
    *   [2. Create Model Instance](#2-create-model-instance)
    *   [3. Load Model](#3-load-model)
    *   [4. Run OCR](#4-run-ocr)
    *   [5. Process Output](#5-process-output)
    *   [6. Release Resources](#6-release-resources)
*   [Quickstart Example](#quickstart-example)
*   [Output Format](#output-format)
*   [Glossary](#glossary)
*   [Resources](#resources)
*   [Supported Languages](#supported-languages)
*   [Error Codes](#error-code)
*   [Contributing](#contributing)
*   [License](#license)
*   [Support](#support)

## Installation

### Prerequisites

Install [Bare](https://docs.pears.com/bare-reference/overview) Runtime:
```bash
npm install -g bare
```
Note : Make sure the Bare version is `>= 1.19.3`. Check this using :

```bash
bare -v
```

To install and run this package you will need a project folder. If one doesn't exist, create a simple test project using:

```bash
mkdir my-ocr-test-project
cd my-ocr-test-project
npm init -y
```

Before proceeding with the installation, please generate a **classic GitHub Personal Access Token (PAT)** with the `read:packages` scope. Once generated, add the token to your environment variables using the name `NPM_TOKEN`.

```bash
export NPM_TOKEN=your_personal_access_token
```

Next, create a `.npmrc` file in the root of your project with the following content:

```ini
@qvac:registry=https://registry.npmjs.org/
//registry.npmjs.org/:_authToken={NPM_TOKEN}
```

This configuration ensures secure access to GitHub Packages when installing scoped packages.

### Installing the Package

Now, you should be able to install the latest version of the package running:
```shell
npm install @qvac/ocr-onnx@latest
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
   git clone git@github.com:tetherto/qvac-lib-inference-addon-onnx-ocr-fasttext.git
   cd qvac-lib-inference-addon-onnx-ocr-fasttext
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

**Note**: Integration tests require model files to be present in the `models/` directory. See the [CI integration test script](ci/integration-test.sh) for details on model requirements.

## Obtaining Models

OCR models are **not included** in the repository due to their size. You need to download them before running the examples.

### Option 1: Download via Hyperdrive (Recommended)

Run the Hyperdrive example to automatically download and cache models:

```bash
bare examples/example.hd.js
```

This downloads models to `models/hd/`. To use them with other examples, copy to the expected location:

```bash
cp models/hd/*.onnx models/ocr/
```

### Option 2: Manual Download

Download the models manually using the Hyperdrive key:

```
hd://03d712abb026bc390cfe803fb851a1b4a581c31c5b9335ef6294333bbeb60043
```

Required files:
- `detector_craft.onnx` - Text detection model
- `recognizer_latin.onnx` - Text recognition model (Latin languages)

Place the downloaded files in `models/ocr/` directory:

```bash
mkdir -p models/ocr
# Copy your downloaded models here
```

## Usage

The library provides a straightforward workflow for image-based text recognition:

### 1. Configure Parameters

Define the arguments for the OCR instance, including paths to the ONNX models and the list of languages to recognize.

```javascript
const args = {
  params: {
    // Required parameters
    langList: ['en'],                              // Language codes (ISO 639-1)
    pathDetector: './models/ocr/detector_craft.onnx',
    pathRecognizer: './models/ocr/recognizer_latin.onnx',
    // Or use prefix: pathRecognizerPrefix: './models/ocr/recognizer_',

    // Optional parameters
    useGPU: true,                    // Enable GPU acceleration (default: true)
    timeout: 120,                    // Inference timeout in seconds (default: 120)

    // Performance tuning (optional)
    magRatio: 1.5,                   // Detection magnification ratio (default: 1.5)
    defaultRotationAngles: [90, 270], // Rotation angles to try (default: [90, 270])
    contrastRetry: false,            // Retry low-confidence with contrast adjustment (default: false)
    lowConfidenceThreshold: 0.4,     // Threshold for contrast retry (default: 0.4)
    recognizerBatchSize: 32          // Batch size for recognizer inference (default: 32)
  },
  opts: {
    stats: true                      // Enable performance statistics logging
  }
}
```

#### Required Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `langList` | `string[]` | List of language codes (ISO 639-1). The first supported language determines the recognizer model. See [Supported Languages](#supported-languages). |
| `pathDetector` | `string` | Path to the detector ONNX model file. |
| `pathRecognizer` | `string` | Path to the recognizer ONNX model file. **Required if `pathRecognizerPrefix` is not provided.** |
| `pathRecognizerPrefix` | `string` | Prefix path for recognizer model. The library appends the language suffix automatically (e.g., `recognizer_latin.onnx`). **Required if `pathRecognizer` is not provided.** |

#### Optional Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `useGPU` | `boolean` | `true` | Enable GPU/NPU/TPU acceleration. Falls back to CPU if unavailable. |
| `timeout` | `number` | `120` | Maximum inference time in seconds. Increase for complex images or slower devices. |
| `magRatio` | `number` | `1.5` | Detection magnification ratio (1.0-2.0). Higher values improve detection of small text but increase processing time. |
| `defaultRotationAngles` | `number[]` | `[90, 270]` | Rotation angles to try for text detection. Use `[]` to disable rotation variants. |
| `contrastRetry` | `boolean` | `false` | Re-process low-confidence regions with adjusted contrast. Improves accuracy but increases memory usage. |
| `lowConfidenceThreshold` | `number` | `0.4` | Confidence threshold (0-1) below which contrast retry is triggered (when `contrastRetry` is enabled). |
| `recognizerBatchSize` | `number` | `32` | Number of text regions processed per batch. Lower values reduce memory usage on mobile devices. |

### 2. Create Model Instance

Import the library and create a new instance with the configured arguments.

```javascript
const { ONNXOcr } = require('@qvac/ocr-onnx')

const model = new ONNXOcr(args)
```

### 3. Load Model

Asynchronously load the ONNX models specified in the parameters.

```javascript
try {
  await model.load()
  console.log('OCR model loaded successfully.')
} catch (error) {
  console.error('Failed to load OCR model:', error)
}
```

### 4. Run OCR

Pass the path to the input image file to the `run` method. Supported formats: **BMP**, **JPEG**, and **PNG**.

```javascript
const imagePath = 'path/to/your/image.jpg'

try {
  const response = await model.run({
     path: imagePath,
     options: {
       paragraph: true,           // Group results into paragraphs (default: false)
       rotationAngles: [90, 270], // Override default rotation angles for this run
       boxMarginMultiplier: 1.0   // Adjust bounding box margins
     }
  })
  // ... process the response (see step 5)
} catch (error) {
  console.error('OCR failed:', error)
}
```

#### Runtime Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `paragraph` | `boolean` | `false` | Group detected text regions into paragraphs based on proximity. |
| `rotationAngles` | `number[]` | Uses `defaultRotationAngles` | Override default rotation angles for this specific run. |
| `boxMarginMultiplier` | `number` | `1.0` | Multiplier for bounding box margins around detected text. |

### 5. Process Output

The `run` method returns a `QvacResponse` object. Use its methods to handle the OCR results as they become available.

```javascript
// Option 1: Using onUpdate callback
await response
  .onUpdate(data => {
    // data contains OCR results for a chunk or the final result
    console.log('OCR Update:', JSON.stringify(data))
  })
  .await() // Wait for the entire process to complete

// Option 2: Using async iterator (if supported by QvacResponse in the future)
// for await (const data of response.iterate()) {
//   console.log('OCR Chunk:', JSON.stringify(data))
// }

// Access performance stats if enabled
if (response.stats) {
  console.log(`Inference stats: ${JSON.stringify(response.stats)}`)
}
```

See [Output Format](#output-format) for the structure of the results.

### 6. Release Resources

Unload the model and free up resources when done.

```javascript
try {
  await model.unload()
  console.log('OCR model unloaded.')
} catch (error) {
  console.error('Failed to unload model:', error)
}
```

## Quickstart Example

This example demonstrates loading the OCR model, running inference on an image, and printing the results.

### 1. Clone the repo & Install the dependencies
```bash
git clone git@github.com:tetherto/qvac-lib-inference-addon-onnx-ocr-fasttext.git
cd qvac-lib-inference-addon-onnx-ocr-fasttext/examples
npm install
```

Install the [model package](#installation), run the command:
```bash
npm install @qvac/ocr-onnx@latest
```

### 2. Run the example

From the repository root, run:

```bash
# CPU example (uses pathRecognizerPrefix for automatic language detection)
bare examples/example.fs.js

# GPU example (explicitly enables GPU acceleration and explicit recognizer)
bare examples/exampleGPU.fs.js
```

You can also pass custom paths as arguments:
```bash
bare examples/example.fs.js <images_dir> <detector_path> <recognizer_prefix>
# Example:
bare examples/example.fs.js test/images models/ocr/detector_craft.onnx models/ocr/recognizer_
```

### 3. Code Walkthrough

```javascript
'use strict'

const process = require('bare-process')
const path = require('bare-path')
const { ONNXOcr } = require('@qvac/ocr-onnx')

// Command line arguments with defaults
const args = process.argv.slice(2)
const [
  argImagesDir = 'test/images',
  argDetectorPath = 'models/ocr/detector_craft.onnx',
  argRecognizerPrefix = 'models/ocr/recognizer_'
] = args

const basePath = process.cwd()

// Define paths relative to the current working directory
const imagePath = path.join(basePath, `${argImagesDir}/basic_test.bmp`)
const modelDetectorPath = path.join(basePath, argDetectorPath)
const modelRecognizerPrefix = path.join(basePath, argRecognizerPrefix)

async function main () {
  const args = {
    params: {
      langList: ['en'],
      pathDetector: modelDetectorPath,
      pathRecognizerPrefix: modelRecognizerPrefix, // Library appends language suffix
    },
    opts: { stats: true } // Enable stats logging
  }

  const model = new ONNXOcr(args)

  try {
    console.log('Loading OCR model...')
    await model.load()
    console.log('Model loaded.')

    console.log(`Running OCR on: ${imagePath}`)
    const response = await model.run({
      path: imagePath
      // options: { paragraph: true } // Optional paragraph mode
    })

    console.log('Waiting for OCR results...')
    await response
      .onUpdate(data => {
        console.log('--- OCR Update ---')
        console.log('Output: ' + JSON.stringify(data.map(o => o[1]))) // Extract text strings
        console.log('--- data ---')
        // Output structure might vary based on paragraph option and updates
        // Refer to Output Format section
        console.log(JSON.stringify(data, null, 2))
        console.log('------------------')
      })
      .await() // Wait for the final result

    console.log('OCR finished!')
    if (response.stats) {
      console.log(`Inference stats: ${JSON.stringify(response.stats)}`)
    }
  } catch (err) {
    console.error('Error during OCR processing:', err)
  } finally {
    console.log('Unloading model...')
    await model.unload()
    console.log('Model unloaded.')
  }
}

main().catch(console.error)
```

#### GPU Example

To run with GPU acceleration, use `exampleGPU.fs.js` which sets `useGPU: true`:

```javascript
const args = {
  params: {
    langList: ['en'],
    pathDetector: './models/ocr/detector_craft.onnx',
    pathRecognizer: './models/ocr/recognizer_latin.onnx', // Explicit recognizer path
    useGPU: true, // Enable GPU acceleration
    timeout: 120 // Optional: inference timeout in seconds
  },
  opts: { stats: true }
}
```

*(See [`examples/example.fs.js`](examples/example.fs.js) and [`examples/exampleGPU.fs.js`](examples/exampleGPU.fs.js) for the full examples.)*

#### Hyperdrive Example

To load models from [Hyperdrive](https://github.com/holepunchto/hyperdrive) (peer-to-peer distributed storage), use `example.hd.js`:

```bash
bare examples/example.hd.js
bare examples/example.hd.js /path/to/image.jpg
```

This example demonstrates:
- Downloading OCR models from Hyperdrive using a content-addressed key
- Caching models locally for subsequent runs
- Running OCR with the downloaded models

```javascript
const HyperdriveDL = require('@qvac/dl-hyperdrive')
const { ONNXOcr } = require('@qvac/ocr-onnx')

// Model configuration
const MODEL_KEY = 'hd://03d712abb026bc390cfe803fb851a1b4a581c31c5b9335ef6294333bbeb60043'

// Initialize Hyperdrive loader
const hdDL = new HyperdriveDL({ key: MODEL_KEY })
await hdDL.ready()

// Download models
const detectorDownload = await hdDL.download('detector_craft.onnx', { diskPath: './models/hd' })
await detectorDownload.await()

const recognizerDownload = await hdDL.download('recognizer_latin.onnx', { diskPath: './models/hd' })
await recognizerDownload.await()

// Initialize OCR with downloaded model paths
const model = new ONNXOcr({
  params: {
    langList: ['en'],
    pathDetector: './models/hd/detector_craft.onnx',
    pathRecognizer: './models/hd/recognizer_latin.onnx',
    useGPU: false
  }
})

await model.load()
// ... run OCR
await hdDL.close()
```

*(See [`examples/example.hd.js`](examples/example.hd.js) for the full example.)*

## Output Format

The output is typically received via the `onUpdate` callback of the `QvacResponse` object. It's a JSON array where each element represents a detected text block.

Each text block contains:
1.  **Bounding Box:** An array of four `[x, y]` coordinate pairs defining the corners of the box around the detected text. Coordinates are clockwise, starting from the top-left relative to the text orientation.
2.  **Detected Text:** The recognized text string.
3.  **Confidence Score:** A numerical value indicating the model's confidence in the recognition (range may vary, often 0-1).

```json
[ // Array of detected text blocks
  [ // First text block
    [ // Bounding Box
      [x1, y1], // Top-left corner
      [x2, y2], // Top-right corner
      [x3, y3], // Bottom-right corner
      [x4, y4]  // Bottom-left corner
    ],
    "Detected Text String", // Recognized text
    0.95 // Confidence score
  ],
  [ // Second text block
    [ /* Bounding Box */ ],
    "Another piece of text",
    0.88
  ]
  // ... more text blocks
]
```

**Example:**

```json
[[
  [
    [10, 10],
    [150, 12],
    [149, 30],
    [9, 28]
  ],
  "Example Text",
  0.85
]]
```

The box coordinates are always provided in clockwise direction and starting from the top-left point with relation to the extracted text. Therefore, it is possible to know how extracted text is rotated based on this.

*(Note: The exact structure and timing of updates might depend on internal buffering and the `paragraph` option.)*

## Glossary

*   **Bare** – Small and modular JavaScript runtime for desktop and mobile. [Learn more](https://docs.pears.com/bare-reference/overview).
*   **QVAC** – QVAC is our open-source AI-SDK for building decentralized AI applications.
*   **ONNX** – Open Neural Network Exchange is an open format built to represent machine learning models. [Learn more](https://onnx.ai/).

## Resources

*   **QVAC Examples Repo (Lens App):** [https://github.com/tetherto/qvac-examples/tree/main/lens-app](https://github.com/tetherto/qvac-examples/tree/main/lens-app)
    *   `desktop` - Desktop application branch (Linux, macOS, Windows)
    *   `mobile` - Mobile application branch (Android and iOS)
*   **ONNX Runtime:** [https://onnxruntime.ai/](https://onnxruntime.ai/)
*   **Base ONNX Addon:** [https://github.com/tetherto/qvac-lib-infer-onnx-base](https://github.com/tetherto/qvac-lib-infer-onnx-base)

## Supported Languages

*   af — Afrikaans
*   az — Azerbaijani
*   bs — Bosnian
*   cs — Czech
*   cy — Welsh
*   da — Danish
*   de — German
*   en — English
*   es — Spanish
*   et — Estonian
*   fr — French
*   ga — Irish
*   hr — Croatian
*   hu — Hungarian
*   id — Indonesian
*   is — Icelandic
*   it — Italian
*   ku — Kurdish
*   la — Latin
*   lt — Lithuanian
*   lv — Latvian
*   mi — Māori
*   ms — Malay
*   mt — Maltese
*   nl — Dutch
*   no — Norwegian
*   oc — Occitan
*   pi — Pali
*   pl — Polish
*   pt — Portuguese
*   ro — Romanian
*   rs_latin — Serbian (Latin script)
*   sk — Slovak
*   sl — Slovenian
*   sq — Albanian
*   sv — Swedish
*   sw — Swahili
*   tl — Tagalog
*   tr — Turkish
*   uz — Uzbek
*   vi — Vietnamese

*(Note: Other languages like Arabic, Bengali, Cyrillic, Devanagari, Thai, Chinese, Japanese, Korean, Tamil, Telugu, Kannada may be supported via different recognizer model files, determined automatically based on the `langList` provided. See `index.js` for details.)*

## Error code
This library uses error code in the range of 9001 to 10,000.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

## License

This project is licensed under the Apache-2.0 License - see the [LICENSE](LICENSE) file for details.

## Support

For questions, bug reports, or feature requests, please [open an issue](https://github.com/tetherto/qvac-lib-inference-addon-onnx-ocr-fasttext/issues) on GitHub.

