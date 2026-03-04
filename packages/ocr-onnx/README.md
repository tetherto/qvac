# qvac-lib-inference-addon-onnx-ocr-fasttext

[![Build Status](https://github.com/tetherto/qvac-lib-inference-addon-onnx-ocr-fasttext/actions/workflows/on-pr.yaml/badge.svg)](https://github.com/tetherto/qvac-lib-inference-addon-onnx-ocr-fasttext/actions/workflows/on-pr.yaml)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![npm version](https://img.shields.io/npm/v/@qvac/ocr-onnx.svg)](https://www.npmjs.com/package/@qvac/ocr-onnx)

This library provides Optical Character Recognition (OCR) capabilities for QVAC runtime applications, leveraging the ONNX Runtime for efficient inference.

The library supports two OCR pipelines:

*   **EasyOCR pipeline** (default): Uses CRAFT detector + language-specific recognizers.
*   **DocTR pipeline**: Uses DBNet detector + CRNN/PARSeq recognizer, matching the [OnnxTR](https://github.com/felixdittrich92/OnnxTR) Python library.

## Table of Contents

*   [Supported Platforms](#supported-platforms)
*   [Installation](#installation)
*   [Building from Source](#building-from-source)
*   [Usage](#usage)
*   [Output Format](#output-format)
*   [Glossary](#glossary)
*   [Supported Languages](#supported-languages)
*   [DocTR Pipeline](#doctr-pipeline)
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

The library provides a straightforward workflow for image-based text recognition. The pipeline is selected via the `pipelineMode` parameter: `'easyocr'` (default) or `'doctr'`.

### 1. Configure Parameters

#### EasyOCR Mode (default)

```javascript
const args = {
  params: {
    // Required
    langList: ['en'],                        // Language codes for recognizer selection
    pathDetector: './models/ocr/detector_craft.onnx',
    pathRecognizer: './models/ocr/recognizer_latin.onnx',
    // Or use prefix: pathRecognizerPrefix: './models/ocr/recognizer_',

    // Shared optional
    useGPU: true,                            // Enable GPU/NPU acceleration (falls back to CPU)
    timeout: 120,                            // Max inference time in seconds

    // EasyOCR-specific optional
    magRatio: 1.5,                           // Detection magnification ratio (1.0–2.0)
    defaultRotationAngles: [90, 270],        // Rotation angles to try (use [] to disable)
    contrastRetry: false,                    // Re-process low-confidence regions with adjusted contrast
    lowConfidenceThreshold: 0.4,             // Confidence threshold below which contrast retry triggers
    recognizerBatchSize: 32                  // Text regions per batch (lower = less memory on mobile)
  },
  opts: {
    stats: true                              // Enable performance statistics
  }
}
```

#### DocTR Mode

```javascript
const args = {
  params: {
    pipelineMode: 'doctr',                   // Select DocTR pipeline
    langList: ['en'],                        // Language codes (defaults to ['en'] for DocTR)
    pathDetector: './models/doctr/db_mobilenet_v3_large.onnx',
    pathRecognizer: './models/doctr/crnn_mobilenet_v3_small.onnx',

    // Shared optional
    useGPU: false,                           // Enable GPU/NPU acceleration (falls back to CPU)

    // DocTR-specific optional
    straightenPages: false,                  // Apply perspective transform to straighten text regions
    decodingMethod: 'greedy'                 // 'greedy' (all models) or 'attention' (PARSeq only)
  },
  opts: {
    stats: true                              // Enable performance statistics
  }
}
```

#### Shared Parameters (both pipelines)

| Parameter | Type | Default | Required | Description |
|-----------|------|---------|----------|-------------|
| `pipelineMode` | `string` | `'easyocr'` | No | Pipeline to use: `'easyocr'` or `'doctr'`. |
| `langList` | `string[]` | — | Yes (EasyOCR), optional for DocTR | Language codes (ISO 639-1). In EasyOCR mode, determines the recognizer model. In DocTR mode, defaults to `['en']`. |
| `pathDetector` | `string` | — | Yes | Path to the detector ONNX model (CRAFT for EasyOCR, DBNet for DocTR). |
| `pathRecognizer` | `string` | — | Yes | Path to the recognizer ONNX model. **In EasyOCR mode**, can be omitted if `pathRecognizerPrefix` is provided. |
| `pathRecognizerPrefix` | `string` | — | No | EasyOCR only. Prefix path for recognizer model; the library appends the language suffix (e.g., `recognizer_latin.onnx`). |
| `useGPU` | `boolean` | `true` | No | Enable GPU/NPU/TPU acceleration. Falls back to CPU if unavailable. |
| `timeout` | `number` | `120` | No | Maximum inference time in seconds. |

#### EasyOCR-Specific Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `magRatio` | `number` | `1.5` | Detection magnification ratio (1.0-2.0). Higher values improve detection of small text but increase processing time. |
| `defaultRotationAngles` | `number[]` | `[90, 270]` | Rotation angles to try for text detection. Use `[]` to disable rotation. |
| `contrastRetry` | `boolean` | `false` | Re-process low-confidence regions with adjusted contrast. |
| `lowConfidenceThreshold` | `number` | `0.4` | Confidence threshold (0-1) below which contrast retry is triggered. |
| `recognizerBatchSize` | `number` | `32` | Number of text regions processed per batch. Lower values reduce memory on mobile. |

#### DocTR-Specific Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `straightenPages` | `boolean` | `false` | Apply perspective transform to straighten detected text regions before recognition. |
| `decodingMethod` | `string` | `'greedy'` | Decoding method: `'greedy'` (all models) or `'attention'` (PARSeq only). |

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

## DocTR Pipeline

The DocTR pipeline (`pipelineMode: 'doctr'`) provides an alternative OCR engine based on the [OnnxTR](https://github.com/felixdittrich92/OnnxTR) project. It uses DBNet for text detection and CRNN or PARSeq for text recognition.

### DocTR Models

| Model | Type | Description |
|-------|------|-------------|
| `db_resnet50.onnx` | Detector | DBNet with ResNet50 backbone (higher accuracy) |
| `db_mobilenet_v3_large.onnx` | Detector | DBNet with MobileNetV3 backbone (faster, mobile-friendly) |
| `parseq.onnx` | Recognizer | PARSeq attention-based recognizer (supports `attention` decoding) |
| `crnn_mobilenet_v3_small.onnx` | Recognizer | CRNN with MobileNetV3 backbone (faster, mobile-friendly, `greedy` decoding only) |

### EasyOCR vs DocTR

| Feature | EasyOCR | DocTR |
|---------|---------|-------|
| `pipelineMode` | `'easyocr'` (default) | `'doctr'` |
| Detector | CRAFT | DBNet (ResNet50 / MobileNetV3) |
| Recognizer | Language-specific CRNN models | PARSeq or CRNN (single model) |
| Language support | 50+ languages via separate models | French vocab (126 chars) |
| Mobile | Supported | Supported (MobileNet models recommended) |
| Perspective correction | N/A | `straightenPages` option |
| Image resizing | Auto-resize to 1200px | Full resolution (no resize) |

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

## License

This project is licensed under the Apache-2.0 License - see the [LICENSE](LICENSE) file for details.

## Support

For questions, bug reports, or feature requests, please [open an issue](https://github.com/tetherto/qvac-lib-inference-addon-onnx-ocr-fasttext/issues) on GitHub.
