# qvac-lib-inference-addon-onnx-ocr-fasttext

[![Build Status](https://github.com/tetherto/qvac-lib-inference-addon-onnx-ocr-fasttext/actions/workflows/on-pr.yaml/badge.svg)](https://github.com/tetherto/qvac-lib-inference-addon-onnx-ocr-fasttext/actions/workflows/on-pr.yaml)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![npm version](https://img.shields.io/npm/v/@qvac/ocr-onnx.svg)](https://www.npmjs.com/package/@qvac/ocr-onnx)

This library provides Optical Character Recognition (OCR) capabilities for QVAC runtime applications, leveraging the ONNX Runtime for efficient inference.

The OCR process uses two models:
*   **Detector:** Locates text regions within an image.
*   **Recognizer:** Extracts text strings from the detected regions. Recognizer models are language-specific.

## Table of Contents

*   [Supported Platforms](#supported-platforms)
*   [Installation](#installation)
*   [Building from Source](#building-from-source)
*   [Usage](#usage)
*   [Output Format](#output-format)
*   [Glossary](#glossary)
*   [Supported Languages](#supported-languages)
*   [Contributing](#contributing)
*   [License](#license)
*   [Support](#support)

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

Install Bare Runtime:
```bash
npm install -g bare
```
Note: Make sure the Bare version is `>= 1.19.3`. Check this using:

```bash
bare -v
```

### Installing the Package

Install the latest version of the package:
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

After building, verify everything works by running the Hyperdrive example:

```bash
bare examples/example.hd.js
```

This example will:
- Download the detector and recognizer models from Hyperdrive (cached locally in `models/hd/`)
- Load the OCR model
- Run text recognition on a test image
- Display the detected text with confidence scores

### Examples

The `examples/` folder contains several examples to help you get started:

| Example | Description |
|---------|-------------|
| `example.hd.js` | Downloads models from Hyperdrive and runs OCR |
| `example.fs.js` | Basic OCR using local model files |
| `exampleGPU.fs.js` | OCR with GPU acceleration enabled |
| `example.logger.js` | OCR with custom logging |
| `visualize_ocr.js` | Runs OCR and saves results to JSON for visualization |
| `draw_boxes.py` | Python script to draw bounding boxes on images using OCR results |

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

*   **Bare** – Small and modular JavaScript runtime for desktop and mobile.
*   **QVAC** – QVAC is our open-source AI-SDK for building decentralized AI applications.
*   **ONNX** – Open Neural Network Exchange is an open format built to represent machine learning models. [Learn more](https://onnx.ai/).

## Supported Languages

Language support is determined by the recognizer model used. Each recognizer model supports a specific set of languages. The library automatically selects the appropriate model based on the `langList` parameter.

| Recognizer Model | Languages |
|------------------|-----------|
| `recognizer_latin.onnx` | af, az, bs, cs, cy, da, de, en, es, et, fr, ga, hr, hu, id, is, it, ku, la, lt, lv, mi, ms, mt, nl, no, oc, pi, pl, pt, ro, rs_latin, sk, sl, sq, sv, sw, tl, tr, uz, vi |
| `recognizer_arabic.onnx` | ar, fa, ug, ur |
| `recognizer_cyrillic.onnx` | ru, rs_cyrillic, be, bg, uk, mn, abq, ady, kbd, ava, dar, inh, che, lbe, lez, tab, tjk |
| `recognizer_devanagari.onnx` | hi, mr, ne, bh, mai, ang, bho, mah, sck, new, gom, sa, bgc |
| `recognizer_bengali.onnx` | bn, as, mni |
| `recognizer_thai.onnx` | th |
| `recognizer_zh_sim.onnx` | ch_sim |
| `recognizer_zh_tra.onnx` | ch_tra |
| `recognizer_japanese.onnx` | ja |
| `recognizer_korean.onnx` | ko |
| `recognizer_tamil.onnx` | ta |
| `recognizer_telugu.onnx` | te |
| `recognizer_kannada.onnx` | kn |

See `supportedLanguages.js` for the complete language definitions.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

## License

This project is licensed under the Apache-2.0 License - see the [LICENSE](LICENSE) file for details.

## Support

For questions, bug reports, or feature requests, please [open an issue](https://github.com/tetherto/qvac-lib-inference-addon-onnx-ocr-fasttext/issues) on GitHub.
