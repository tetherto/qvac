# @qvac/bci-whispercpp

Brain-Computer Interface (BCI) neural signal transcription addon for qvac, powered by the [tetherto/qvac-ext-lib-whisper.cpp](https://github.com/tetherto/qvac-ext-lib-whisper.cpp) fork of whisper.cpp.

Transcribes multi-channel neural signals (e.g., 512-channel microelectrode array recordings) into text using a BCI-trained whisper model running natively via GGML. Output matches the Python BrainWhisperer reference model exactly.

## Table of Contents

- [Architecture](#architecture)
- [Results](#results)
- [Neural Signal Format](#neural-signal-format)
- [Installation](#installation)
- [Model Conversion](#model-conversion)
- [Usage](#usage)
- [Configuration](#configuration)
- [Tests](#tests)
- [Error Range](#error-range)
- [whisper.cpp Patches](#whispercpp-patches)
- [Resources](#resources)
- [Glossary](#glossary)
- [License](#license)

## Architecture

```
Neural Signal (512ch, 20ms bins)
    │
    ▼
┌──────────────────────────────┐
│   NeuralProcessor (C++)      │
│   - Gaussian smoothing       │  std=2, kernel=100
│   - Day-specific projection  │  low-rank (A·B) + month + softsign
│   - Pad to 3000 frames       │  mel-major layout for whisper.cpp
└──────────────┬───────────────┘
               │  mel features (512 × 3000)
               ▼
┌──────────────────────────────┐
│   whisper.cpp (patched)      │
│   - conv1 (k=7, 512→384)    │  BCI-trained embedder weights
│   - conv2 (k=3, stride=2)   │
│   - Positional encoding      │  learned time PE + sinusoidal day PE
│   - 6-layer encoder          │  windowed attention (w=57) on layers 0–3
│   - 4-layer decoder (LoRA)   │  beam search, length_penalty=0.14
└──────────────┬───────────────┘
               │
               ▼
          Text output
```

## Results

Native GGML inference matches the Python BrainWhisperer reference on all test samples:

| Sample | Ground Truth | GGML Native Output | WER |
|--------|-------------|-------------------|-----|
| 0 | "You can see the code at this point as well." | "You can see the good at this point as well." | 10.0% |
| 1 | "How does it keep the cost down?" | "How does it keep the cost down?" | 0.0% |
| 2 | "Not too controversial." | "Not too controversial." | 0.0% |
| 3 | "The jury and a judge work together on it." | "The jury and a judge work together on it." | 0.0% |
| 4 | "Were quite vocal about it." | "We're quite vocal about it." | 20.0% |
| **Average** | | | **6.0%** |

## Neural Signal Format

Binary files with the following layout:

| Offset | Type      | Description                                          |
|--------|-----------|------------------------------------------------------|
| 0      | uint32    | Number of timesteps                                  |
| 4      | uint32    | Number of channels                                   |
| 8      | float32[] | Feature data (row-major: `features[t * channels + c]`) |

Each timestep represents a 20ms bin of neural activity. Channels correspond to individual electrodes in a microelectrode array (typically 512 channels).

## Installation

```bash
cd packages/bci-whispercpp
npm install
VCPKG_ROOT=/path/to/vcpkg npm run build
```

### Prerequisites

- **Bare runtime** >= 1.24.0
- **CMake** >= 3.25
- **vcpkg** with `VCPKG_ROOT` environment variable set

### Model Conversion Prerequisites

- **Python 3** with `numpy`, `torch`, and `transformers` (`pip install numpy torch transformers`)

### Model Conversion

Convert a trained BrainWhisperer checkpoint. This produces **two files**, both required for inference:

| File | Size | Description |
|------|------|-------------|
| `ggml-bci-windowed.bin` | ~84 MB | GGML model: whisper encoder/decoder (LoRA-merged), tokenizer, positional embedding, windowed attention header |
| `bci-embedder.bin` | ~24 MB | Day projection weights: low-rank A·B matrices per recording day, month projections, session-to-day mapping |

```bash
python3 scripts/convert-model.py \
  --checkpoint /path/to/epoch=93-val_wer=0.0910.ckpt
```

Both files are written to `models/` by default. All flags are optional:

| Flag | Default | Description |
|------|---------|-------------|
| `--output` | `models/ggml-bci-windowed.bin` | GGML model output path |
| `--embedder-output` | `models/bci-embedder.bin` | Embedder weights output path |
| `--day-idx` | `1` | Day index for baked positional embedding |
| `--window-size` | `57` | Windowed attention size (0 to disable) |
| `--last-window-layer` | `3` | Last encoder layer with windowed attention |
| `--f32` | off | Use f32 for all tensors (avoids f16 precision loss, ~2x larger) |

**Important:** Both files must be in the same directory at runtime. The C++ addon looks for `bci-embedder.bin` next to the GGML model file and will fail if it is missing.

## Usage

The package's default export is the high-level `BCIWhispercpp` class. It owns model lifecycle, an inference queue, and a sliding-window streaming driver on top of the native addon.

```js
const BCIWhispercpp = require('@qvac/bci-whispercpp')
```

### 1. Construct an instance

```js
const bci = new BCIWhispercpp({
  files: { model: './models/ggml-bci-windowed.bin' },
  opts: { stats: true }            // optional — surfaces runtime stats on response.stats
}, {
  whisperConfig: { language: 'en', temperature: 0.0 },
  bciConfig:     { day_idx: 1 },   // session day index for day-specific projection
  miscConfig:    { caption_enabled: false }
})
```

> The companion `bci-embedder.bin` must sit next to `files.model`. The native addon resolves it by path and will fail to load otherwise.

### 2. Load the model

```js
await bci.load()
```

`load()` is idempotent — calling it again unloads the existing model and re-initialises with the current config. There is no progress callback today.

### 3. Transcribe (batch mode)

Use this when you have the full neural signal up-front. `transcribe()` accepts the raw bytes (header + body); `transcribeFile()` is a convenience wrapper that reads the file for you.

```js
const fs = require('bare-fs')

const response = await bci.transcribeFile('./signal.bin')
// or: const response = await bci.transcribe(new Uint8Array(fs.readFileSync('./signal.bin')))

const segments = await response.await()
const text = segments.map(s => s.text).join('').trim()
console.log(text)

if (response.stats) console.log(response.stats) // when opts.stats: true
```

Concurrent calls are serialised — a second `transcribe()` waits for the first to settle.

### 4. Transcribe (streaming mode)

`transcribeStream()` consumes a stream of bytes (async iterable, sync iterable, `Uint8Array`, or array of chunks) and decodes a sliding window over the body as data arrives. The first 8 bytes of the stream must be the standard `[T u32 LE, C u32 LE]` header (`T` is ignored in stream mode; `C` must be non-zero).

```js
const response = await bci.transcribeStream(chunkIterable, {
  windowTimesteps: 1500,   // default
  hopTimesteps:    500,    // default — must be < windowTimesteps
  emit:            'delta' // 'delta' (default) | 'full'
})

response.onUpdate(segments => {
  // emit: 'delta' — newly-discovered tail segments since the last window.
  //                 Each segment carries native fields (text, t0, t1, ...) plus
  //                 windowStartTimestep so you can map back to the stream timeline.
  // emit: 'full'  — single { text } entry with the full running transcript.
  for (const s of segments) process.stdout.write(s.text)
})

await response.await()     // resolves when the stream ends and the final window decodes
```

Streaming constraints:

| Option | Constraint |
|--------|------------|
| `windowTimesteps` | positive integer, ≤ `2900` (`MAX_WINDOW_TIMESTEPS`) |
| `hopTimesteps` | positive integer, `< windowTimesteps` |
| `emit` | `'delta'` or `'full'` |

Only one stream may be active at a time. `response.stats` is **not** populated for streams.

### 5. Cancel / unload / destroy

```js
await bci.cancel()    // abort an in-flight job or stream; instance remains usable
await bci.unload()    // release native resources; bci.load() can be called again
await bci.destroy()   // permanent — instance cannot be reused
```

### 6. Word Error Rate helper

The package re-exports `computeWER(hypothesis, reference)` for evaluation:

```js
const { computeWER } = require('@qvac/bci-whispercpp')
const wer = computeWER('how does it keep the cost down', 'how does it keep the cost down?')
```

### Output shape

`response.await()` resolves to an array of segments; `response.onUpdate(cb)` receives the same shape per emission:

```js
[
  { text: ' How does it keep the cost down?', t0: 0, t1: 280, /* ... */ }
]
```

In streaming `delta` mode each segment is annotated with `windowStartTimestep`. In `full` mode the array contains a single `{ text }` entry.

## Tests

| Script | Purpose |
|--------|---------|
| `npm run test:unit` | JS unit tests (`brittle-bare test/unit/*.test.js`) — no model required |
| `npm run test:integration` | JS integration tests against the native addon — requires `WHISPER_MODEL_PATH` |
| `npm run test:cpp` | C++ unit tests (GoogleTest); `bare-make` rebuilds the addon with `BUILD_TESTING=ON` |
| `npm run test:dts` | Type-checks the published `index.d.ts` |
| `npm test` | Runs `test:unit` + `test:integration` |

```bash
# JS unit tests
npm run test:unit

# JS integration tests
WHISPER_MODEL_PATH=./models/ggml-bci-windowed.bin npm run test:integration

# C++ unit tests
VCPKG_ROOT=/path/to/vcpkg npm run test:cpp

# .d.ts typecheck
npm run test:dts
```

Integration tests require both `ggml-bci-windowed.bin` and `bci-embedder.bin` to be present in the same directory. See [Model Conversion](#model-conversion).

## Configuration

`BCIWhispercpp` accepts two arguments:

```js
new BCIWhispercpp(args, config)
```

### args

| Field | Type | Description |
|-------|------|-------------|
| `files.model` | string | **Required.** Path to BCI GGML model file (`bci-embedder.bin` must sit alongside it). |
| `logger` | object | Optional logger; wrapped in `@qvac/logging`. Defaults to a noop logger. |
| `opts.stats` | boolean | When `true`, runtime stats are surfaced on `response.stats` for batch jobs. Default `false`. |

### config.whisperConfig

The convenience defaults below are surfaced explicitly. **Any other `whisper_full_params` key is forwarded untouched** to whisper.cpp — see [Advanced configuration](#advanced-configuration).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `language` | string | `"en"` | Language code |
| `temperature` | number | `0.0` | Sampling temperature |
| `n_threads` | number | `0` (auto) | Number of threads |

### config.bciConfig

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `day_idx` | number | `0` | Session day index for the day-specific low-rank projection at runtime. Distinct from the conversion-time `--day-idx` flag, which bakes a positional embedding into `ggml-bci-windowed.bin`. |

### config.contextParams

These keys back the `whisper_context`. Changing any of them between jobs forces a full model reload (unload → re-init → warmup), which can take several seconds.

| Parameter | Type | Description |
|-----------|------|-------------|
| `model` | string | Optional override; usually set via `args.files.model`. |
| `use_gpu` | boolean | Enable GPU acceleration (Metal on macOS by default). |
| `flash_attn` | boolean | Enable flash attention. |
| `gpu_device` | number | Select a non-default GPU device. |

### config.miscConfig

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `caption_enabled` | boolean | `false` | Format segments with `<\|start\|>..<\|end\|>` markers. |

### streamOpts (passed to `transcribeStream()`)

| Parameter | Type | Default | Constraint | Description |
|-----------|------|---------|------------|-------------|
| `windowTimesteps` | number | `1500` | positive integer, ≤ `2900` (`MAX_WINDOW_TIMESTEPS`) | Decode window size in 20 ms timesteps. |
| `hopTimesteps` | number | `500` | positive integer, `< windowTimesteps` | How far the window advances between decodes (~33% overlap by default). |
| `emit` | string | `'delta'` | `'delta'` or `'full'` | `'delta'` emits the newly-discovered tail per window with native segment fields plus `windowStartTimestep`. `'full'` emits a single `{ text }` entry with the running transcript. |

The encoder accepts up to ~3000 timesteps per forward pass; `MAX_WINDOW_TIMESTEPS = 2900` keeps a safety margin so partial flush windows always fit.

### Advanced configuration

`whisperConfig` is a thin pass-through to whisper.cpp's `whisper_full_params`. For the full surface (decoding strategy, beam search, VAD, suppression, callbacks, etc.) refer to the upstream reference:

- [`whisper_full_params` in whisper.cpp](https://github.com/ggerganov/whisper.cpp/blob/master/include/whisper.h)
- Concrete shapes used in production: see the [examples](examples) directory and [`@qvac/transcription-whispercpp`](https://github.com/tetherto/qvac/tree/main/packages/qvac-lib-infer-whispercpp) for richer usage patterns (VAD, chunking, live streaming).

## whisper.cpp Patches

The BCI patches live in the `tetherto/qvac-ext-lib-whisper.cpp` fork (v1.8.4.2) and are consumed via the `qvac-registry-vcpkg` port:

| Feature | Description |
|---------|-------------|
| Variable conv1 kernel | Read `n_audio_conv1_kernel` from model header (k=7 for 512ch BCI vs k=3 for audio) |
| Windowed attention | Attention mask with configurable window size/layer params in header |
| BCI SOS tokens | BCI-specific start-of-sequence token handling |
| Graph placement fix | Correct encoder-graph mask population for the encoder graph refactor |

## Error Range

All errors thrown by this package are `QvacErrorAddonBCI` instances (extending `QvacErrorBase` from `@qvac/error`) and use codes in the range **26001–27000**.

| Code | Name | When |
|------|------|------|
| `26001` | `FAILED_TO_LOAD_WEIGHTS` | Native addon failed to load the GGML model |
| `26002` | `FAILED_TO_CANCEL` | `cancel()` failed at the addon layer |
| `26003` | `FAILED_TO_APPEND` | Append to processing queue failed |
| `26004` | `FAILED_TO_DESTROY` | `destroy()` failed at the addon layer |
| `26005` | `FAILED_TO_ACTIVATE` | `addon.activate()` failed during `load()` |
| `26006` | `INVALID_NEURAL_INPUT` | Batch input rejected by the addon |
| `26007` | `JOB_ALREADY_RUNNING` | `transcribe()` called while a job is in flight |
| `26008` | `MODEL_NOT_LOADED` | Inference called before `load()` or after `destroy()` |
| `26009` | `MODEL_FILE_NOT_FOUND` | `files.model` missing or unreadable |
| `26010` | `BUFFER_LIMIT_EXCEEDED` | Neural signal buffer exceeded the addon limit |
| `26011` | `FAILED_TO_START_JOB` | Addon refused to start the job |
| `26012` | `INVALID_CONFIG` | Constructor / context configuration rejected |
| `26013` | `EMBEDDER_WEIGHTS_INVALID` | `bci-embedder.bin` failed validation |
| `26014` | `STREAM_ALREADY_ACTIVE` | `transcribeStream()` called while one is already active |
| `26015` | `INVALID_STREAM_INPUT` | Bad stream input type or `streamOpts` |
| `26016` | `INVALID_STREAM_HEADER` | Stream `[T u32, C u32]` header malformed (e.g. `C == 0`) |
| `26017` | `WINDOW_TOO_LARGE` | `windowTimesteps` exceeds `MAX_WINDOW_TIMESTEPS` (2900) |

Codes are also re-exported via `require('@qvac/bci-whispercpp/lib/error').ERR_CODES` for programmatic matching.

## Resources

- whisper.cpp fork (Tether): [`tetherto/qvac-ext-lib-whisper.cpp`](https://github.com/tetherto/qvac-ext-lib-whisper.cpp)
- Sibling package — audio transcription: [`@qvac/transcription-whispercpp`](https://github.com/tetherto/qvac/tree/main/packages/qvac-lib-infer-whispercpp)
- vcpkg registry: [`qvac-registry-vcpkg`](https://github.com/tetherto/qvac-registry-vcpkg)
- BrainWhisperer reference (Python): the model checkpoints converted by `scripts/convert-model.py`

## Glossary

- **Bare** — small modular JavaScript runtime for desktop and mobile. [Learn more](https://docs.pears.com/bare-reference/overview).
- **QVAC** — Tether's open-source SDK for building decentralized, local-first AI applications.
- **GGML** — tensor library / file format used by whisper.cpp for native inference.
- **BCI** — Brain-Computer Interface; here, microelectrode-array recordings of neural activity decoded into text.
- **Day index (`day_idx`)** — selects the day-specific low-rank projection (A·B) baked into `bci-embedder.bin`. Sessions recorded on different days use different projections.
- **Windowed attention** — encoder attention mask restricted to a local window (`w=57` over layers 0–3 by default), configured at model conversion time.

## License

Apache-2.0
