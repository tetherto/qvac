# qvac-lib-infer-parakeet

**Technology Stack:** C++20, CMake, vcpkg, Bare Runtime, ONNX Runtime  
**Package Type:** Native Bare addon

A high-performance speech-to-text (STT) inference addon for the Bare runtime using NVIDIA's Parakeet ASR models. This addon provides fast, accurate transcription with support for multiple languages, speaker diarization, and streaming audio processing via ONNX Runtime.

## Key Features

- **Fast Speech-to-Text** - Powered by NVIDIA's Parakeet ASR models via ONNX Runtime
- **Multilingual Support** - Supports ~25 languages with automatic language detection (TDT model)
- **Streaming Audio Processing** - Real-time transcription with end-of-utterance detection
- **Speaker Diarization** - Optional speaker identification using Sortformer models
- **Multiple Model Variants**:
  - **CTC** - English-only, fast transcription with punctuation/capitalization
  - **TDT** - Multilingual support (~25 languages) with auto-detection
  - **EOU** - Real-time streaming with end-of-utterance detection
  - **Sortformer** - Streaming speaker diarization (up to 4 speakers)
- **Cross-Platform** - CPU/GPU acceleration on macOS, Linux, Windows, iOS, and Android
- **Job Cancellation** - Cancel long-running transcription jobs
- **Bare Runtime Integration** - Async processing without blocking JavaScript event loop

## Model Information

This addon uses NVIDIA's Parakeet ASR models in ONNX format:

- **CTC Model (English-only)**: [parakeet-ctc-0.6b-ONNX](https://huggingface.co/onnx-community/parakeet-ctc-0.6b-ONNX/tree/main/onnx)
- **TDT Model (Multilingual)**: [parakeet-tdt-0.6b-v3-onnx](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx)
- **EOU Model (Streaming)**: [parakeet-rs realtime_eou_120m-v1-onnx](https://huggingface.co/altunene/parakeet-rs/tree/main/realtime_eou_120m-v1-onnx)
- **Sortformer Model (Diarization)**: [parakeet-rs sortformer models](https://huggingface.co/altunene/parakeet-rs/tree/main)

**License**: CC-BY-4.0 by NVIDIA

## Built With

This addon is built on [qvac-lib-inference-addon-cpp](https://github.com/tetherto/qvac-lib-inference-addon-cpp), which provides the foundational framework for QVAC inference addons.

## Table of Contents

- [Installation](#installation)
- [Examples](#examples)
- [Model Setup](#model-setup)
- [Benchmark Results](#benchmark-results)
- [JavaScript API](#javascript-api)
- [Model Variants](#model-variants)
- [Development](#development)
- [Supported Platforms](#supported-platforms)
- [Resources](#resources)  
- [License](#license)

## Installation

### Prerequisites

- **Bare Runtime**: Install from [holepunchto/bare](https://github.com/holepunchto/bare)
- **Node.js/npm**: For installing dependencies
- **vcpkg**: For C++ dependency management (will be handled automatically by cmake-vcpkg)
- **C++ Compiler**: C++20 support required
  - macOS: Xcode Command Line Tools
  - Linux: Clang/LLVM 19 with libc++
  - Windows: Visual Studio 2022 with C++ workload

### Build from Source

1. **Clone the repository:**
   ```bash
   git clone https://github.com/tetherto/qvac.git
   cd qvac/packages/qvac-lib-infer-parakeet
   ```

2. **Install npm dependencies** (includes cmake-bare and cmake-vcpkg):
   ```bash
   npm install
   ```
   
   This will automatically:
   - Install cmake-bare and cmake-vcpkg
   - Run bare-make to build the addon
   - Download and build ONNX Runtime via vcpkg
   - Create the addon in `prebuilds/` directory

3. **Or build manually:**
   ```bash
   npm run build
   ```

## Examples

The `examples/` folder contains ready-to-run scripts demonstrating different use cases.

### Quickstart

**[quickstart.js](./examples/quickstart.js)** - Basic transcription of a WAV file using the TDT model. Start here to understand the core workflow: create instance, load weights, activate, transcribe, cleanup.

```bash
bare examples/quickstart.js
```

### Multilingual Transcription

**[transcribe.js](./examples/transcribe.js)** - Transcribe audio files in any supported language. Supports both WAV and raw PCM formats with automatic language detection.

```bash
# Transcribe Spanish audio
bare examples/transcribe.js --file examples/samples/LastQuestion_long_ES.raw

# Transcribe French audio
bare examples/transcribe.js --file examples/samples/French.raw

# Transcribe Croatian audio with INT8 model
bare examples/transcribe.js -f examples/samples/croatian.raw -m models/parakeet-tdt-0.6b-v3-onnx-int8-full

# Transcribe English WAV file
bare examples/transcribe.js --file examples/samples/sample-16k.wav
```

### CTC Transcription (English-only)

**[quickstart-ctc.js](./examples/quickstart-ctc.js)** - Fast English-only transcription using the CTC model. Includes punctuation and capitalization. Best for single-language, high-throughput use cases.

```bash
bare examples/quickstart-ctc.js
```

### Streaming with End-of-Utterance Detection

**[quickstart-eou.js](./examples/quickstart-eou.js)** - Real-time streaming transcription using the EOU model (120M params). Automatically detects utterance boundaries for turn-by-turn output. Note: the EOU model is optimized for low latency over accuracy — expect lower transcription quality compared to TDT/CTC.

```bash
bare examples/quickstart-eou.js
```

### Speaker Diarization

**[quickstart-sortformer.js](./examples/quickstart-sortformer.js)** - Identifies who is speaking when using the Sortformer model (up to 4 speakers). Outputs speaker-labeled time segments.

```bash
bare examples/quickstart-sortformer.js
```

### Diarized Transcription

**[quickstart-diarized.js](./examples/quickstart-diarized.js)** - Combines TDT transcription with Sortformer diarization to produce speaker-attributed text. Runs both models in parallel and merges the results. Diarization accuracy depends on audio quality and speaker overlap — some boundary imprecision is expected.

```bash
bare examples/quickstart-diarized.js
```

### Audio Decoding

**[example.decoder.js](./examples/example.decoder.js)** - Demonstrates using `@qvac/decoder-audio` to decode audio files before transcription. Useful when working with compressed audio formats.

## Model Setup

### Downloading Models

Download models from HuggingFace using the provided script:

```bash
./scripts/download-models.sh
```

The interactive script lets you choose which model variant to download (TDT, CTC, EOU, Sortformer, or all).

**Model Variants:**
| Variant | Size | Path | Notes |
|---------|------|------|-------|
| INT8 (default) | ~650 MB | `models/parakeet-tdt-0.6b-v3-onnx-int8/` | Recommended, 73% smaller, Conv+MatMul quantized |
| INT8 partial | ~890 MB | `models/parakeet-tdt-0.6b-v3-onnx-int8-partial/` | MatMul-only quantized |
| FP32 | ~2.4 GB | `models/parakeet-tdt-0.6b-v3-onnx/` | Full precision |

Models will be saved to the `models/` directory.

### Supported Languages (TDT Model)

The TDT model supports approximately 25 languages with automatic detection:
- English (en), Spanish (es), French (fr), German (de), Italian (it)
- Portuguese (pt), Russian (ru), Chinese (zh), Japanese (ja), Korean (ko)
- Arabic (ar), Hindi (hi), Turkish (tr), Polish (pl), Dutch (nl)
- And more...

Set `language: 'auto'` for automatic detection or specify the language code explicitly.

## Benchmark Results

The following benchmarks were run using the **parakeet-tdt-0.6b-v3-onnx** model with 100 samples per language on CPU (4 threads).

### Word Error Rate (WER) by Language

| Language | Dataset | WER (%) | CER (%) | Quality |
|----------|---------|---------|---------|---------|
| English | LibriSpeech (clean) | **7.51** | 6.61 | Excellent |
| French | Multilingual LibriSpeech | 22.35 | 19.31 | Adequate |
| Spanish | Multilingual LibriSpeech | 27.34 | 25.93 | Adequate |
| Russian | FLEURS | 30.97 | 28.81 | Adequate |
| Italian | Multilingual LibriSpeech | 31.39 | 24.71 | Low |
| Portuguese | Multilingual LibriSpeech | 31.24 | 29.48 | Low |
| Czech | FLEURS | 35.39 | 30.18 | Low |
| German | Multilingual LibriSpeech | 40.99 | 38.83 | Low |

### Quality Interpretation

| WER Range | Quality | Description |
|-----------|---------|-------------|
| 0–5% | Excellent | Near human-parity transcription |
| 5–15% | High | Minor word errors, highly usable |
| 15–30% | Adequate | Understandable but noticeable mistakes |
| >30% | Low | Transcript may need significant correction |

### Notes

- **English** is the primary language the model was trained on, hence the best performance
- Performance on non-English languages varies based on training data representation
- GPU acceleration typically improves both speed and accuracy
- INT8 quantized models provide similar accuracy with faster inference

For detailed benchmark methodology and raw results, see the [benchmarks/](./benchmarks/) directory.

## JavaScript API

### Core Methods

#### `createInstance(config, outputCallback)`
Creates a new Parakeet instance.

**Parameters:**
- `config` (Object):
  - `modelPath` (string): Path to model directory
  - `modelType` (string): 'ctc', 'tdt', 'eou', or 'sortformer'
  - `config` (Object):
    - `language` (string): Language code or 'auto'
    - `maxThreads` (number): Maximum CPU threads to use
    - `useGPU` (boolean): Enable GPU acceleration
- `outputCallback` (Function): `(handle, event, data, error) => {}`

**Returns:** Handle (number) for this instance

#### `loadWeights(handle, buffer)`
Load model weights from buffer.

**Parameters:**
- `handle` (number): Instance handle
- `buffer` (ArrayBuffer): Model file data

#### `activate(handle)`
Activate the model after loading weights.

**Parameters:**
- `handle` (number): Instance handle

#### `runJob(handle, input)`
Run transcription job.

**Parameters:**
- `handle` (number): Instance handle
- `input` (Object):
  - `type` (string): 'audio'
  - `data` (ArrayBuffer): Audio data
  - `sampleRate` (number): Sample rate (e.g., 16000)
  - `channels` (number): Number of audio channels

#### `cancelJob(handle)`
Cancel the current running job.

#### `destroyInstance(handle)`
Destroy the instance and free resources.

### Output Callback Events

The output callback receives these events:

- **`transcription`**: Partial or complete transcription result
  - `data.text` (string): Transcribed text
  - `data.confidence` (number): Confidence score (0-1)
  - `data.isFinal` (boolean): Whether this is the final result
  
- **`progress`**: Processing progress update
  - `data.percent` (number): Progress percentage (0-100)
  - `data.timeElapsed` (number): Elapsed time in ms
  
- **`diarization`**: Speaker identification (if using Sortformer)
  - `data.speakerId` (number): Speaker ID (0-3)
  - `data.startTime` (number): Start time in seconds
  - `data.endTime` (number): End time in seconds
  
- **`complete`**: Job completed successfully
  
- **`error`**: Error occurred
  - `error` (string): Error message

## Model Variants

### CTC Model
- **Use case:** Fast English-only transcription
- **Features:** Punctuation and capitalization
- **Size:** ~600MB
- **Download:** [Hugging Face](https://huggingface.co/onnx-community/parakeet-ctc-0.6b-ONNX/tree/main/onnx)

### TDT Model (Recommended)
- **Use case:** Multilingual transcription (~25 languages)
- **Features:** Auto language detection, high accuracy
- **Variants:**
  - **INT8 full (recommended):** ~650 MB - Conv+MatMul quantized, 73% smaller
  - **INT8 partial:** ~890 MB - MatMul-only quantized, 63% smaller
  - **FP32:** ~2.4 GB - Full precision weights
- **Download:** Use `./scripts/download-models.sh` or [Hugging Face](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx)

### EOU Model
- **Use case:** Real-time streaming with end-of-utterance detection
- **Features:** Low latency, streaming support
- **Size:** ~120MB
- **Download:** [Hugging Face](https://huggingface.co/altunene/parakeet-rs/tree/main/realtime_eou_120m-v1-onnx)

### Sortformer Model
- **Use case:** Speaker diarization (up to 4 speakers)
- **Features:** Streaming speaker identification
- **Versions:** v2, v2.1 (with int8 quantized options)
- **Download:** [Hugging Face](https://huggingface.co/altunene/parakeet-rs/tree/main)

## Development

### Building from Source

1. **Clone the repository:**
   ```bash
   git clone https://github.com/tetherto/qvac.git
   cd qvac/packages/qvac-lib-infer-parakeet
   ```

2. **Configure with vcpkg:**
   ```bash
   cmake -S . -B build \
     -DCMAKE_TOOLCHAIN_FILE="$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" \
     -DCMAKE_BUILD_TYPE=Release
   ```

3. **Build:**
   ```bash
   cmake --build build --config Release
   ```

### Running Tests

```bash
# Build with tests enabled
cmake -S . -B build \
  -DCMAKE_TOOLCHAIN_FILE="$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" \
  -DBUILD_TESTING=ON

cmake --build build
ctest --test-dir build --output-on-failure
```

### Project Structure

```
qvac-lib-infer-parakeet/
├── src/
│   ├── ParakeetModel.hpp       # Main model implementation
│   ├── ParakeetModel.cpp       # ONNX Runtime integration
│   ├── binding.cpp             # Bare addon registration
│   └── qvac-lib-inference-addon-cpp/  # Base framework (header-only)
├── models/                     # Downloaded ONNX models (not in git)
├── tests/                      # C++ tests
├── examples/                   # JavaScript usage examples
├── CMakeLists.txt             # Build configuration
├── vcpkg.json                 # C++ dependencies
├── package.json               # npm/bare package
└── README.md
```

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
- Bare Runtime: JavaScript runtime
- Linux requires Clang/LLVM 19 with libc++

### Hardware Acceleration

ONNX Runtime provides automatic hardware acceleration:
- **macOS/iOS**: CoreML
- **Windows**: DirectML or CUDA
- **Linux**: CUDA, ROCm, or CPU
- **Android**: NNAPI

Enable with `useGPU: true` in the config.

## Resources

### Documentation

- **Bare Runtime:** https://github.com/holepunchto/bare
- **ONNX Runtime:** https://onnxruntime.ai/
- **Parakeet Models:** https://github.com/altunene/parakeet-rs
- **Base Framework:** https://github.com/tetherto/qvac-lib-inference-addon-cpp

### Model Sources

There are no official ONNX models on huggingface from NVIDIA. These are converted ONNX model files by the open community. 

- **CTC Model:** [onnx-community/parakeet-ctc-0.6b-ONNX](https://huggingface.co/onnx-community/parakeet-ctc-0.6b-ONNX)
- **TDT Model:** [istupakov/parakeet-tdt-0.6b-v3-onnx](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx)
- **EOU Model:** [altunene/parakeet-rs](https://huggingface.co/altunene/parakeet-rs/tree/main/realtime_eou_120m-v1-onnx)
- **Sortformer:** [altunene/parakeet-rs](https://huggingface.co/altunene/parakeet-rs)

### Related Projects

- [qvac-lib-infer-whispercpp](https://github.com/tetherto/qvac-lib-infer-whispercpp) - Alternative STT using Whisper
- [qvac-lib-infer-onnx-tts](https://github.com/tetherto/qvac-lib-infer-onnx-tts) - Text-to-speech
- [qvac-lib-infer-llamacpp-llm](https://github.com/tetherto/qvac-lib-infer-llamacpp-llm) - LLM inference

## License

This project is licensed under the Apache-2.0 License – see the [LICENSE](LICENSE) file for details.

**Model License:** The Parakeet models are licensed under CC-BY-4.0 by NVIDIA.

## Contributing

Contributions are welcome! Please open an issue or pull request on GitHub.

## Acknowledgments

- **NVIDIA** for the Parakeet ASR models
- **Tether** for the QVAC inference framework
- **ONNX Runtime** team for the inference engine
- **altunene** for the parakeet-rs project and ONNX conversions

---

*For questions or issues, please open an issue on the GitHub repository.*
