# transcription-parakeet

This library simplifies running NVIDIA Parakeet speech-to-text and Sortformer speaker-diarization inference within QVAC runtime applications. It provides an easy interface to load, execute, and manage Parakeet inference instances, supporting CTC, TDT, EOU, and Sortformer checkpoints from a single binding.

## Table of Contents

- [Supported Platforms](#supported-platforms)
- [Installation](#installation)
- [Development](#development)
- [Usage](#usage)
  - [1. Stage a Model](#1-stage-a-model)
  - [2. Configure the Model](#2-configure-the-model)
  - [3. Create Model Instance](#3-create-model-instance)
  - [4. Load the Model](#4-load-the-model)
  - [5. Run Inference](#5-run-inference)
  - [6. Release Resources](#6-release-resources)
- [Quickstart example](#quickstart-example)
- [Model Variants](#model-variants)
- [Other examples](#other-examples)
- [Glossary](#glossary)
- [Error Range](#error-range)
- [Resources](#resources)
- [License](#license)

## Supported Platforms

| Platform | Architecture | Min Version | Status | GPU Support |
|----------|-------------|-------------|--------|-------------|
| macOS | arm64, x64 | 14.0+ | Tier 1 | Metal |
| iOS | arm64 | 17.0+ | Tier 1 | Metal |
| Linux | arm64, x64 | Ubuntu-22+ | Tier 1 | Vulkan |
| Android | arm64 | 12+ | Tier 1 | Vulkan / OpenCL |
| Windows | x64 | 10+ | Tier 1 | Vulkan |

**Dependencies:**
- inference-addon-cpp: C++ addon framework
- parakeet-cpp (latest): NVIDIA Parakeet ASR + Sortformer diarization engine
- ggml-speech (latest): GGML flavour shared with the speech stack; library prefix `qvac-speech-` so it can coexist with the fabric/llm and diffusion ggml builds on the same Android device
- Bare Runtime (latest): JavaScript runtime
- Linux requires Clang/LLVM 22 with libc++

## Installation

### Prerequisites

Make sure [Bare](#glossary) Runtime is installed:
```bash
npm install -g bare bare-make
```

### Installing the Package

Install the latest version:
```bash
npm install @qvac/transcription-parakeet@latest
```

## Development

### Building the AddOn Locally

For local development, you'll need to build the native addon that interfaces with the Parakeet engine. Follow these steps:

#### Prerequisites

First, make sure you have the prerequisites from the [Installation](#installation) section.

#### System Requirements

**Supported Platforms:**
- **Linux** (x64, ARM64) -- requires Clang/LLVM 22 with libc++
- **macOS** (x64, ARM64)
- **Windows** (x64)

#### Required Tools

**All Platforms:**
- **CMake** (>= 3.25)
- **Git**
- **C++ Compiler** with C++20 support
  - Linux: Clang 22+ with libc++
  - macOS: Xcode 12+ (provides Clang 12+)
  - Windows: Visual Studio 2019+ or MinGW-w64

#### vcpkg Setup

This project uses [vcpkg](https://vcpkg.io/) for C++ dependency management. The `cmake-vcpkg` package pulls vcpkg in transparently during `npm install`, so most users don't need to set it up by hand. If you want a system-wide vcpkg checkout:

```bash
git clone https://github.com/Microsoft/vcpkg.git
cd vcpkg
./bootstrap-vcpkg.sh           # or .\bootstrap-vcpkg.bat on Windows
export VCPKG_ROOT=$(pwd)
```

#### Platform-Specific Setup

**Linux:**
```bash
# Ubuntu/Debian -- includes Clang 22 and libc++ required by the native addon
sudo apt update
sudo apt install clang libc++-dev libc++abi-dev build-essential cmake git pkg-config
```

**macOS:**
```bash
xcode-select --install
brew install cmake git
```

**Windows:**
- Install [Visual Studio 2019+](https://visualstudio.microsoft.com/) with C++ development tools
- Install [CMake](https://cmake.org/download/) (3.25+)
- Install [Git for Windows](https://git-scm.com/download/win)

#### GPU Acceleration (Optional)

GPU backends are selected at vcpkg install time via the `parakeet-cpp[metal|vulkan|opencl]` features, which forward to the matching `ggml-speech[...]` features. The `ggml-speech` port is a separate dependency from `parakeet-cpp` (it's the speech-stack flavour of ggml, with the `qvac-speech-` library prefix so it can coexist with the fabric/llm and diffusion ggml flavours on the same Android device); runtime falls back to CPU if the chosen backend doesn't initialise.

- **Metal (macOS/iOS):** automatic; no setup required.
- **Vulkan (Linux/Windows/Android):** install the [Vulkan SDK](https://vulkan.lunarg.com/sdk/home) and ensure GPU drivers support Vulkan 1.1+.
  ```bash
  # Ubuntu/Debian
  sudo apt install vulkan-tools libvulkan-dev vulkan-utility-libraries-dev spirv-tools
  ```

#### Clone and Setup

```bash
git clone https://github.com/tetherto/qvac.git
cd qvac/packages/transcription-parakeet
npm install
```

#### Build the Native AddOn

```bash
npm run build
```

This runs:
1. `bare-make generate` -- generates build configuration
2. `bare-make build` -- compiles the native C++ addon
3. `bare-make install` -- installs the prebuild

#### Running Tests

```bash
npm run test:unit                                    # JS unit tests (mocked)
QVAC_TEST_GGUF_DIR=models npm run test:integration   # JS integration vs. real GGUFs
npm run test:cpp                                     # gtest C++ suite
```

The integration suite locates each model type via `QVAC_TEST_GGUF_DIR=<path-with-staged-ggufs>` (or per-model overrides like `QVAC_TEST_GGUF_TDT=/full/path.gguf`). Tests skip cleanly when no GGUF is available, so CI without local models still passes.

## Usage

The library wraps `qvac-parakeet.cpp`'s engine in the QVAC addon framework so you can transcribe audio files, run speaker diarization, or stream live mic input through the same shape: load a single `.gguf`, push audio chunks, drain segment callbacks.

> **Heads up:** the package is intended to be used through `index.js`'s `TranscriptionParakeet` class. A lower-level `ParakeetInterface` (in `parakeet.js`) is also exported as an escape hatch for power users that need to drive the addon's job runner directly, but new code should default to `TranscriptionParakeet` -- it's what the bundled examples and integration tests use.

### 1. Stage a Model

The ggml backend takes a single `.gguf` per checkpoint. The standard flow is "provision a Python venv, download `.nemo` from HuggingFace, convert to `.gguf` via the in-tree converter":

```bash
npm run setup-models                       # venv + download + convert, all 4 models, q8_0
npm run setup-models -- -t tdt             # just TDT
npm run setup-models -- -t eou -q f16      # full-precision EOU
```

`setup-models` chains `setup-venv` -> `download-models` -> `convert-models`. The venv step is idempotent (skipped if `./venv` already has the required interpreter), so re-running `setup-models` after a successful first run only re-checks the downloads and conversions.

Output GGUFs land in `./models/`. The conversion is driven by `scripts/convert-nemo-to-gguf.py` (vendored from `qvac-parakeet.cpp`; resync on bump) and runs against the local `./venv`. The venv needs `gguf`, `numpy`, `torch`, `pyyaml`, and `sentencepiece` -- the converter reads the `.nemo` archive directly via `tarfile` + `torch.load` and does **not** depend on the heavy `nemo_toolkit` package despite the file extension. `sentencepiece` is required to decode the model's `tokenizer.model` proto into the GGUF's token / score / type arrays (without it, transcription output ends up as raw token IDs). Full requirement list lives at `scripts/requirements.txt`. To use a pre-existing interpreter instead of `./venv`, pass `--python /path/to/python` to either script (or set `PYTHON=...`).

The three underlying scripts are also flag-driven if you want to run them separately:

```
setup-venv.sh      [--python <bin>] [--venv <path>] [--force] [--help]
download-models.sh [--type ctc|tdt|eou|sortformer|all]
                   [--output <dir>] [--force] [--help]
convert-nemo.sh    [--type ctc|tdt|eou|sortformer|all]
                   [--quant f16|q8_0|q5_0|q4_0|f32]
                   [--python <bin>]
                   [--nemo-dir <dir>] [--output <dir>] [--force] [--help]
```

#### Source repositories

| Model | HuggingFace `.nemo` |
|-------|-----------------------------------|
| CTC | [`nvidia/parakeet-ctc-0.6b`](https://huggingface.co/nvidia/parakeet-ctc-0.6b) |
| TDT | [`nvidia/parakeet-tdt-0.6b-v3`](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) |
| EOU | [`nvidia/parakeet_realtime_eou_120m-v1`](https://huggingface.co/nvidia/parakeet_realtime_eou_120m-v1) |
| Sortformer | [`nvidia/diar_sortformer_4spk-v1`](https://huggingface.co/nvidia/diar_sortformer_4spk-v1) |

NVIDIA Open Model License -- see each repo's model card for terms.

### 2. Configure the Model

Most users interact with the package through `index.js`. From that entrypoint we surface a small, safe subset of options; the rest keep `parakeet-cpp` defaults.

#### What `index.js` accepts

| Section | Key | Description |
| --- | --- | --- |
| `files` | `model` | Absolute or relative path to the `.gguf` checkpoint |
| `config.parakeetConfig` | `maxThreads` | CPU threads; `0` lets the engine pick `hardware_concurrency` |
| | `useGPU` | Enable the linked ggml GPU backend (default: `false`) |
| | `streaming` | Open a long-lived `StreamSession` / `SortformerStreamSession` so speaker IDs stay stable across appends and EOU `<EOU>` boundaries surface as segments. Cross-append state is preserved only within a single `run()` call -- separate `run()` invocations on the same instance start a fresh session. For continuous live capture, drive a single long-running `run()` from a pushable stream, or use the duplex `runStreaming()` API which owns one streaming session for the lifetime of the call. Default: `false` (offline `transcribe_samples` / `diarize_samples`). |
| | `streamingChunkMs` | Streaming chunk cadence in ms (default: 2000) |
| | `streamingHistoryMs` | Sortformer rolling-history window in ms (default: 30000) |
| | `streamingEmitPartials` | Emit partials before chunk boundaries (default: `true`) |
| | `streamingEnergyVad` | CTC/TDT energy-VAD events (default: `false`) |
| | `streamingLeftContextMs` | ASR encoder left-context window in ms; `-1` keeps parakeet-cpp's default of 10000. ASR sessions only (Sortformer ignores it). |
| | `streamingRightLookaheadMs` | ASR encoder right-lookahead window in ms; `-1` keeps parakeet-cpp's default of 2000. Adds directly to the per-segment latency floor (`chunk_ms + right_lookahead_ms`). ASR sessions only. |
| | `streamingSpkCacheEnable` | AOSC: enable v2.1 Sortformer's speaker-cache streaming (default: `true`). Ignored on v1/v2 Sortformer GGUFs and on non-Sortformer models. Set `false` to force a v2.1 GGUF onto the v1 sliding-window path (A/B comparison). |
| | `streamingSpkCacheLen` | AOSC: long-term speaker-cache rows (~15 s of encoder frames). Default: 188. |
| | `streamingFifoLen` | AOSC: FIFO warmup buffer rows. Default: 188. |
| | `streamingChunkLeftContextMs` | AOSC: encoder left-context window (ms; ~1 encoder frame). Default: 80. |
| | `streamingChunkRightContextMs` | AOSC: encoder right-context window (ms; ~7 encoder frames). Default: 560. |
| | `streamingSpkCacheUpdatePeriod` | AOSC: FIFO-overflow pop-out count. Default: 144. |
| | `backendsDir` | Root directory for dynamically-loaded ggml backend `.so` files (Vulkan, OpenCL, per-arch CPU variants on Android). Defaults to the package's `prebuilds/` folder; the native addon appends `<bare-target>/<module-name>` before scanning. Pass an explicit path when prebuilds live elsewhere — e.g. Android `ApplicationInfo.nativeLibraryDir` when backend libs ship inside the APK. No-op on Apple (statically linked). |
| | `openclCacheDir` | Persistent directory for ggml-opencl's compiled program-binary cache (`$GGML_OPENCL_CACHE_DIR`). Android-only; pass the host app's cache directory (e.g. `Context.getCacheDir()`) to skip cold `clBuildProgram` on every process start. Ignored on other platforms. |

The model type (CTC / TDT / EOU / Sortformer) is **auto-detected from the GGUF metadata**, so callers don't need to pass `modelType`. Other knobs (`captionEnabled`, `timestampsEnabled`, `seed`, `sampleRate`, `channels`) keep sensible defaults.

**Sortformer Streaming Diarization (v2.1 + AOSC).** parakeet-cpp ships
two streaming-diarization paths picked automatically by the GGUF:

- **v1** uses a fixed-size sliding-history window inside the engine.
  Once two voices have been seen, the per-chunk decisions are
  permutation-invariant; if a speaker goes silent long enough to roll
  out of the window, the slot can drift onto a different physical voice
  when they return. Fine for short, stable clips; ships as
  `sortformer-4spk-v1.q8_0.gguf`.
- **v2.1** replaces the sliding window with AOSC (Audio-Online Speaker
  Cache, ported from NVIDIA NeMo) which anchors each slot to its
  accumulated embedding. Same physical speaker comes back to the same
  `Speaker N` tag across silences. Default for live capture; ships as
  `diar_streaming_sortformer_4spk-v2.1.q8_0.gguf`. The engine detects
  v2.1 via the GGUF metadata tag
  `parakeet.model_variant == "sortformer-streaming-v2.1-aosc"`; you
  don't need to opt in via config.

The defaults in the `streamingSpkCache*` / `streamingFifo*` /
`streamingChunk{Left,Right}ContextMs` table rows above are the NeMo-port
tuning parakeet-cpp ships -- you almost always want to keep them. The
knobs are exposed for A/B comparison (e.g. `--spk-cache-enable false`
in `examples/live-mic-diarized-aosc.js` to force a v2.1 GGUF onto the
v1 path) and for tuning unusual audio (longer cache, larger
right-context window for higher latency tolerance, etc.).

For offline diarization (single batch over a finite clip) v1 remains
the recommended GGUF -- AOSC's slot-stability benefit only applies to
continuous streaming and offers no measurable improvement when the
entire clip is available at once.

#### Configuration Example

```javascript
const config = {
  parakeetConfig: {
    useGPU:    true,
    streaming: false   // flip to true for live-mic / speaker-stable streaming
  }
}
```

### 3. Create Model Instance

```javascript
const TranscriptionParakeet = require('@qvac/transcription-parakeet')

const model = new TranscriptionParakeet({
  files: { model: './models/parakeet-tdt-0.6b-v3.q8_0.gguf' },
  config: {
    parakeetConfig: { useGPU: true }
  }
})
```

### 4. Load the Model

```javascript
try {
  await model.load()
} catch (error) {
  console.error('Failed to load model:', error)
}
```

`load()` opens the `.gguf`, instantiates `qvac_parakeet::Engine`, and (if `streaming: true`) opens the relevant streaming session.

### 5. Run Inference

Pass an audio stream (e.g. from `bare-fs.createReadStream` or a live PCM buffer) to either `run()` (offline / batched) or `runStreaming()` (duplex / live). Audio must be **16 kHz mono**, either Float32 or signed 16-bit little-endian PCM.

> **Buffer cap (`run()` only):** the JS layer batches every chunk for a single `run()` call into one native `process()` invocation. Total buffered audio per call is capped at **500 MiB** (`MAX_BUFFERED_BYTES` in `parakeet.js`); exceeding it raises `BUFFER_LIMIT_EXCEEDED`. At 16 kHz mono int16, that's roughly 4 hours of continuous audio. For longer single-session captures, use `runStreaming()` (no per-call buffer cap -- audio is fed straight to the engine as it arrives) or split into sequential `run()` calls.

There are three ways to receive transcription results:

#### Option 1: Real-time streaming with `onUpdate()`

```javascript
try {
  const audioStream = fs.createReadStream('path/to/audio.raw', {
    highWaterMark: 16000
  })
  const response = await model.run(audioStream)

  await response
    .onUpdate(segments => {
      // `segments` is `TranscriptionSegment[]`:
      //   { text, start, end, toAppend, id?, isEndOfTurn?, startsWord? }
      // - `isEndOfTurn` is true on EOU streaming chunks where the
      //   model fired the `<EOU>` token; CTC / TDT / Sortformer
      //   always leave it false.
      // - `startsWord` is true when the segment begins a new
      //   SentencePiece word (`▁`-marker token); concat verbatim
      //   when false to rejoin chunk-boundary wordpiece splits like
      //   ["pun", "ctuation"] -> "punctuation".
      for (const seg of segments) console.log(seg.text)
    })
    .await()
} catch (error) {
  console.error('Transcription failed:', error)
}
```

`run()` buffers the entire audio stream in JS memory and dispatches one
job at end-of-stream, so segments only surface after the whole input is
consumed. For latencies bound by `chunk_ms + right_lookahead_ms` rather
than by total audio length, use `runStreaming()` (Option 3 below).

#### Option 2: Complete result with `iterate()`

```javascript
const response = await model.run(audioStream)
for await (const chunk of response.iterate()) {
  console.log('Transcription chunk:', chunk)
}
```

#### Option 3: Duplex streaming with `runStreaming()`

For live-mic and other low-latency use cases, `runStreaming()` opens a
long-lived `parakeet::StreamSession` (or `SortformerStreamSession`) on
the C++ side and feeds each pushed chunk straight in -- bypassing the
`run()` path's batch-then-process lifecycle. Per-chunk segments surface
through the regular `onUpdate(...)` channel as soon as the engine
emits them. The session stays open across chunks, so the rolling
encoder context, EOU detector, and Sortformer speaker history are all
preserved (no chunk-boundary state resets).

```javascript
// Construct with `streaming: true` so the addon configures the
// duplex-friendly defaults at load time:
const model = new TranscriptionParakeet({
  files: { model: './models/parakeet-tdt-0.6b-v3.q8_0.gguf' },
  config: {
    parakeetConfig: {
      streaming: true,
      streamingChunkMs: 2000,
      useGPU: true
    }
  }
})
await model.load()

// Provide an async-iterable of Buffer / Float32Array chunks. The
// example uses a small `pushableStream()` helper from
// `examples/utils.js` that lets you `.push(chunk)` from any sync
// callback (e.g. `child_process.stdout.on('data', ...)`) and `.end()`
// when capture is done.
const audio = pushableStream()
captureProcess.stdout.on('data', chunk => audio.push(chunk))
captureProcess.on('exit', () => audio.end())

const response = await model.runStreaming(audio, {
  // optional per-call overrides; omitted fields fall back to the
  // matching `parakeetConfig.streaming*` value used at load time
  chunkMs: 2000
})

await response
  .onUpdate(segments => {
    for (const seg of segments) {
      if (seg.isEndOfTurn) console.log('--- end of turn ---')
      else console.log(seg.text)
    }
  })
  .await()
```

The new lower-level entry points (`startStreaming` / `appendStreamingAudio` / `endStreaming` / `cancelStreaming`) are exposed on the `ParakeetInterface` (`parakeet.js`) for callers that want to drive the session manually; `runStreaming` is the high-level wrapper that takes an async-iterable, opens the session, pumps chunks, and synthesises a `JobEnded` when the iterable completes.

**Key differences:**
- `onUpdate()` on `run()` -- one batch of segments after the entire input has been buffered.
- `iterate()` on `run()` -- collects all segments after the job finishes.
- `onUpdate()` on `runStreaming()` -- segments arrive as the engine produces them, with stable session state across chunks. Default for live-mic.

For Sortformer GGUFs, the `Output` event carries `Speaker N: HH:MM:SS - HH:MM:SS` text per segment instead of an ASR transcript -- see `examples/diarized-transcribe.js` for offline parsing and `examples/live-mic-diarized.js` for the streaming flow.

### 6. Release Resources

```javascript
try {
  await model.unload()
} catch (error) {
  console.error('Failed to unload model:', error)
}
```

## Quickstart example

### 1. Clone the repo & install dependencies

```bash
git clone https://github.com/tetherto/qvac.git
cd qvac/packages/transcription-parakeet
npm install
```

`npm install` pulls the `parakeet-cpp` and `ggml-speech` overlay ports (the speech-stack ggml flavour, with the `qvac-speech-` library prefix) and produces `prebuilds/<platform>-<arch>/qvac__transcription-parakeet.bare`.

### 2. Stage a model

```bash
npm run setup-models -- -t tdt -q q8_0
```

### 3. Run the bundled examples

```bash
# Single-file transcription (any model type -- CTC / TDT / EOU / Sortformer)
bare examples/transcribe.js \
     --model models/parakeet-tdt-0.6b-v3.q8_0.gguf \
     --audio examples/samples/sample-16k.wav

# Combined ASR + diarization
bare examples/diarized-transcribe.js \
     --asr-model  models/parakeet-tdt-0.6b-v3.q8_0.gguf \
     --diar-model models/sortformer-4spk-v1.q8_0.gguf \
     --audio      examples/samples/two-speakers-16k.wav

# Live mic transcription
bare examples/live-mic.js --model models/parakeet-eou-120m-v1.q8_0.gguf --accumulate

# Live mic + speaker tagging (recommended: v2.1 diar GGUF, AOSC auto-on)
bare examples/live-mic-diarized.js \
     --asr-model  models/parakeet-tdt-0.6b-v3.q8_0.gguf \
     --diar-model models/diar_streaming_sortformer_4spk-v2.1.q8_0.gguf --accumulate

# Same as above, with explicit AOSC tuning knobs exposed as CLI flags
bare examples/live-mic-diarized-aosc.js \
     --asr-model  models/parakeet-tdt-0.6b-v3.q8_0.gguf \
     --diar-model models/diar_streaming_sortformer_4spk-v2.1.q8_0.gguf \
     --spk-cache-len 256 --chunk-right-context-ms 480 --accumulate
```

> If you use `npm run example:* -- ...` instead of `bare`, remember the `--` separator -- without it npm interprets `--model` as one of its own config flags.

The live-mic examples capture the default input device via `sox -d` (install: `brew install sox` / `apt install sox` / `choco install sox`). With `--accumulate`, transcripts append onto one line per turn and flush on silence, speaker change, or Ctrl-C.

## Model Variants

| Variant | Languages | Decoder | Default GGUF size (q8_0) | Notes |
|---------|-----------|---------|-------------------------:|-------|
| **CTC** | English | argmax CTC | ~ 700 MiB | Fast, no PnC. |
| **TDT** | ~25 | RNN-T greedy + duration | ~ 715 MiB | Recommended default; PnC + auto-detect. |
| **EOU** | English | RNN-T greedy + `<EOU>` | ~ 132 MiB | Streaming-trained; native end-of-turn token. |
| **Sortformer v1** | n/a | Diarization head (sliding history) | ~ 141 MiB | 4-speaker. **Default for offline diarization.** |
| **Sortformer v2.1 + AOSC** | n/a | Diarization head + speaker cache | ~ 141 MiB | 4-speaker. **Default for streaming diarization.** AOSC anchors speaker slots across silence/re-entry; auto-detected via GGUF metadata tag `parakeet.model_variant`. |

## Other examples

- [`examples/transcribe.js`](examples/transcribe.js) -- universal single-file transcribe / diarize (any GGUF, all model types).
- [`examples/diarized-transcribe.js`](examples/diarized-transcribe.js) -- combined Sortformer + ASR pipeline ("who said what").
- [`examples/live-mic.js`](examples/live-mic.js) -- live microphone transcription via `sox` and the streaming session.
- [`examples/live-mic-diarized.js`](examples/live-mic-diarized.js) -- live mic with parallel Sortformer + ASR for speaker-tagged transcripts. Pass a v2.1 Sortformer GGUF to get AOSC speaker-cache streaming automatically.
- [`examples/live-mic-diarized-aosc.js`](examples/live-mic-diarized-aosc.js) -- same as above but with CLI flags for the AOSC tuning knobs (`--spk-cache-len`, `--fifo-len`, `--chunk-right-context-ms`, `--spk-cache-enable`, etc.). Useful for A/B comparing AOSC vs the v1 sliding-window code path on the same v2.1 GGUF.
- [`examples/decode-audio.js`](examples/decode-audio.js) -- decode + transcribe in one step. Same flag surface as `transcribe.js` but pipes the input through `@qvac/decoder-audio` (FFmpeg) first, so any container / codec FFmpeg supports (mp3, m4a, ogg, flac, mp4, ...) works -- not just 16 kHz mono `.wav` / raw s16le PCM.
- [`examples/utils.js`](examples/utils.js) -- shared helpers used by the examples (`loadWeights` streaming, `Output`/`JobEnded` race resolution).

## Glossary

- **Bare** -- small, modular JavaScript runtime for desktop and mobile. [Learn more](https://docs.pears.com/bare-reference/overview).
- **GGUF** -- single-file model format used by ggml-based runtimes; carries weights + tokenizer + hyperparameters in one file.
- **QVAC** -- our open-source AI-SDK for building decentralized AI applications.

## Resources

- [NVIDIA Parakeet model cards](https://huggingface.co/collections/nvidia/parakeet-asr-models-66b50d5a37b9580ee4ba93c2) -- upstream `.nemo` checkpoints.

## License

This project is licensed under the Apache-2.0 License -- see [LICENSE](LICENSE) for details. Model files are distributed under the **NVIDIA Open Model License**; see the upstream HuggingFace cards for the per-checkpoint terms.

For questions or issues, please open an issue on the GitHub repository.
