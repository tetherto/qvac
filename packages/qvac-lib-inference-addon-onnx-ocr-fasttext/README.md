# qvac-lib-inference-addon-onnx-ocr-fasttext

This library provides Optical Character Recognition (OCR) capabilities for QVAC runtime applications, leveraging the ONNX Runtime for efficient inference. It implements the [QVAC Inference Addon ONNX base class](https://github.com/tetherto/qvac-lib-infer-onnx-base).

The OCR process uses two models:
*   **Detector:** Locates text regions within an image.
*   **Recognizer:** Extracts text strings from the detected regions. Recognizer models are language-specific.

## Table of Contents

*   [Installation](#installation)
*   [Usage](#usage)
    *   [1. Configure Parameters](#1-configure-parameters)
    *   [2. Create Model Instance](#2-create-model-instance)
    *   [3. Load Model](#3-load-model)
    *   [4. Run OCR](#4-run-ocr)
    *   [5. Process Output](#5-process-output)
    *   [6. Release Resources](#6-release-resources)
*   [Usage Example](#usage-example)
*   [Output Format](#output-format)
*   [Glossary](#glossary)
*   [Resources](#resources)
*   [Supported Languages](#supported-languages)
*   [Contributing](#contributing)
*   [License](#license)

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

## Usage

The library provides a straightforward workflow for image-based text recognition:

### 1. Configure Parameters

Define the arguments for the OCR instance, including paths to the ONNX models and the list of languages to recognize.

```javascript
const args = {
  // Required: Paths to models and language list
  params: {
    langList: ['en'], // List of expected language codes (ISO 639-1)
    pathDetector: './models/ocr/detector_craft.onnx',
    // Option 1: Provide a prefix, and the library appends the language suffix
    pathRecognizerPrefix: './models/ocr/recognizer_',
    // Option 2: Provide an explicit recognizer path
    // pathRecognizer: './models/ocr/recognizer_latin.onnx',
    useGPU: false, // Optional: defaults to true, falls back to CPU if GPU unavailable
    timeout: 120 // Optional: inference timeout in seconds, defaults to 120
  },

  // Optional: Additional configuration
  opts: {
    stats: true // Enable performance statistics logging
  }
}
```

*   The `langList` The first supported language on the list will be assigned the corresponding recognizer, the rest will have best effort recognizer (limited accuracy). This field also helps select the appropriate recognizer model when using `pathRecognizerPrefix`.
*   Use `pathRecognizerPrefix` to let the library automatically append the language suffix (e.g., `recognizer_latin.onnx` for Latin-based languages).
*   Use `pathRecognizer` to explicitly specify a recognizer model path.
*   The `useGPU` optional param enables GPU/NPU/TPU acceleration when available; defaults to `true` and falls back to CPU if unavailable.
*   The `timeout` optional param sets the maximum time (in seconds) allowed for an inference operation before it times out; defaults to `120` seconds. This is relevant in some language models (such as thai) on Darwin devices which can exceed the default inference operation.

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

Pass the path to the input image file (currently requires BMP format) to the `run` method. Optionally include `options`.

```javascript
const imagePath = 'path/to/your/image.bmp'

try {
  const response = await model.run({
     path: imagePath,
     options: { paragraph: true } // Optional: Attempt to group results into paragraphs
  })
  // ... process the response (see step 5)
} catch (error) {
  console.error('OCR failed:', error)
}
```

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

This project is licensed under the Apache-2.0 License - see the LICENSE file for details.

For any questions or issues, please open an issue on the GitHub repository.

