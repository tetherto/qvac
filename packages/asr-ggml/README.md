# @qvac/asr-ggml

Multi-engine automatic speech recognition for QVAC runtime applications on the
[Bare](#glossary) runtime. One npm package and one native prebuild serve two
ggml-based ASR engines behind a single class, `ASRGgml`:

| Engine | Native library | Good for |
| --- | --- | --- |
| **Whisper** | [whisper.cpp](https://github.com/ggerganov/whisper.cpp) | Multilingual offline transcription, translation, Silero-VAD-segmented live capture |
| **Parakeet** | [parakeet-cpp](https://github.com/tetherto/qvac-ext-lib-whisper.cpp) (NVIDIA Parakeet / Sortformer) | Low-latency streaming ASR, native end-of-turn detection, 4-speaker diarization |

This package replaces `@qvac/transcription-whispercpp` and
`@qvac/transcription-parakeet`. See [CHANGELOG.md](CHANGELOG.md) for the
breaking changes the merge introduced.

## Table of Contents

- [Supported Engines and Models](#supported-engines-and-models)
- [Supported Platforms](#supported-platforms)
- [Installation](#installation)
- [Quickstart](#quickstart)
  - [Whisper — batch `run()`](#whisper--batch-run)
  - [Whisper — VAD streaming `runStreaming()`](#whisper--vad-streaming-runstreaming)
  - [Parakeet — batch `run()`](#parakeet--batch-run)
  - [Parakeet — duplex streaming `runStreaming()`](#parakeet--duplex-streaming-runstreaming)
- [Engine Selection](#engine-selection)
- [API Surface](#api-surface)
- [Configuration Reference](#configuration-reference)
- [Audio Input](#audio-input)
- [Backends and GPU Acceleration](#backends-and-gpu-acceleration)
- [Staging Models](#staging-models)
- [Error Codes](#error-codes)
- [Development](#development)
- [Benchmarking](#benchmarking)
- [Examples](#examples)
- [Documentation](#documentation)
- [Glossary](#glossary)
- [License](#license)

## Supported Engines and Models

### Whisper (`engine: 'whisper'`)

Legacy single-file GGML `.bin` checkpoints from
[ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp):

| Model | Size | Description |
|-------|------|-------------|
| `ggml-tiny.bin` | 78 MB | Smallest, fastest |
| `ggml-base.bin` | 148 MB | Balanced size/accuracy |
| `ggml-small.bin` | 488 MB | Better accuracy |
| `ggml-medium.bin` | 1.5 GB | High accuracy |
| `ggml-large-v3.bin` | 3.1 GB | Best accuracy |
| `ggml-large-v3-turbo.bin` | 1.6 GB | Best accuracy, faster |

Quantized variants (`q8_0`, `q5_1`, `q5_0`) exist for all sizes. Whisper
covers ~99 languages plus translation-to-English, and the fine-tuned
per-language checkpoints listed in [NOTICE](NOTICE) also load.

VAD model (required for `runStreaming()`), from
[ggml-org/whisper-vad](https://huggingface.co/ggml-org/whisper-vad):

| Model | Size | Description |
|-------|------|-------------|
| `ggml-silero-v5.1.2.bin` | 885 KB | Silero VAD for voice-activity detection |

### Parakeet (`engine: 'parakeet'`)

Single-file `.gguf` checkpoints. **The model type is auto-detected from the
GGUF metadata** — there is no `modelType` to pass.

| Variant | Languages | Decoder | ~Size (q8_0) | Notes |
|---------|-----------|---------|-------------:|-------|
| **CTC** (`parakeet-ctc-0.6b`) | English | argmax CTC | ~700 MiB | Fast, no punctuation/capitalization |
| **TDT** (`parakeet-tdt-0.6b-v3`) | ~25 | RNN-T greedy + duration | ~715 MiB | Recommended default; PnC + language auto-detect |
| **EOU** (`parakeet-eou-120m-v1`) | English | RNN-T greedy + `<EOU>` | ~132 MiB | Streaming-trained; native end-of-turn token |
| **Sortformer v1** (`sortformer-4spk-v1`) | n/a | Diarization head (sliding history) | ~141 MiB | 4-speaker. Default for **offline** diarization |
| **Sortformer v2.1 + AOSC** (`diar_streaming_sortformer_4spk-v2.1`) | n/a | Diarization head + speaker cache | ~141 MiB | 4-speaker. Default for **streaming** diarization; AOSC anchors speaker slots across silence, auto-detected from GGUF metadata |

Upstream `.nemo` checkpoints are NVIDIA's; see the
[Parakeet model cards](https://huggingface.co/collections/nvidia/parakeet-asr-models-66b50d5a37b9580ee4ba93c2)
for the per-checkpoint NVIDIA Open Model License terms.

## Supported Platforms

| Platform | Architecture | Min Version | Status | GPU Support |
|----------|-------------|-------------|--------|-------------|
| macOS | arm64, x64 | 14.0+ | ✅ Tier 1 | Metal |
| iOS | arm64 | 17.0+ | ✅ Tier 1 | Metal |
| Linux | arm64, x64 | Ubuntu-22+ | ✅ Tier 1 | Vulkan |
| Android | arm64 | 12+ | ✅ Tier 1 | Vulkan, OpenCL (Adreno) |
| Windows | x64 | 10+ | ✅ Tier 1 | Vulkan |

**Dependencies:**

- `qvac-lib-inference-addon-cpp` — C++ addon framework (vcpkg port; version pinned in `vcpkg.json`)
- `whisper-cpp` — provides both the whisper.cpp and parakeet-cpp engines (vcpkg port; version pinned in `vcpkg.json`)
- Bare runtime — see `engines.bare` in `package.json`
- Linux requires Clang/LLVM 22 with libc++

## Installation

Make sure the Bare runtime is installed:

```bash
npm install -g bare bare-make
bare -v   # must satisfy package.json engines.bare
```

Then:

```bash
npm install @qvac/asr-ggml
```

## Quickstart

All four snippets assume:

```javascript
const fs = require('bare-fs')
const ASRGgml = require('@qvac/asr-ggml')
```

Audio must be **16 kHz mono**. See [Audio Input](#audio-input) for the accepted
shapes.

### Whisper — batch `run()`

```javascript
const model = new ASRGgml({
  files: { model: './models/ggml-tiny.bin' },
  config: {
    engine: 'whisper',
    whisperConfig: {
      language: 'en',
      audio_format: 's16le'   // how raw Uint8Array bytes are decoded
    }
  }
})

await model.load()

const audioStream = fs.createReadStream('./audio.raw', { highWaterMark: 16000 })
const response = await model.run(audioStream)

// Push-based: segments arrive as whisper.cpp emits them.
await response
  .onUpdate((out) => {
    for (const segment of Array.isArray(out) ? out : [out]) {
      console.log(segment.start, '→', segment.end, segment.text)
    }
  })
  .await()

await model.destroy()
```

Or pull-based, with `iterate()` instead of `onUpdate()`:

```javascript
const response = await model.run(audioStream)
for await (const out of response.iterate()) {
  for (const segment of Array.isArray(out) ? out : [out]) {
    console.log(segment.text)
  }
}
```

### Whisper — VAD streaming `runStreaming()`

Silero VAD splits the incoming audio into utterances and each one is
transcribed as it completes. A VAD model is **required** — pass it as
`files.vadModel`, `config.vadModelPath`, or
`config.whisperConfig.vad_model_path`; a missing file throws
`VAD_MODEL_NOT_FOUND` (6018) from the constructor, and a missing path throws
`VAD_MODEL_REQUIRED` (6009) from `runStreaming()`.

```javascript
const model = new ASRGgml({
  files: {
    model: './models/ggml-tiny.bin',
    vadModel: './models/ggml-silero-v5.1.2.bin'
  },
  config: { engine: 'whisper', whisperConfig: { language: 'en' } }
})

await model.load()

const response = await model.runStreaming(micStream, {
  emitVadEvents: true,      // adds { type: 'vad', speaking, score, source }
  endOfTurnSilenceMs: 800   // adds { type: 'endOfTurn', source: 'vad-silence' }
})

for await (const out of response.iterate()) {
  if (out.type === 'vad') console.log('speaking:', out.speaking)
  else if (out.type === 'endOfTurn') console.log('--- turn ended ---')
  else for (const s of Array.isArray(out) ? out : [out]) console.log(s.text)
}
```

### Parakeet — batch `run()`

```javascript
const model = new ASRGgml({
  files: { model: './models/parakeet-tdt-0.6b-v3.q8_0.gguf' },
  config: {
    engine: 'parakeet',
    parakeetConfig: { useGPU: true, maxThreads: 4 }
  }
})

await model.load()

const response = await model.run(float32Samples)   // Float32Array, 16 kHz mono
const segments = []
await response
  .onUpdate((out) => {
    for (const s of Array.isArray(out) ? out : [out]) {
      // `toAppend` marks a segment that continues the previous one rather
      // than replacing it.
      if (s.text && s.toAppend) segments.push(s)
    }
  })
  .await()

console.log(segments.map((s) => s.text).join(''))
await model.unload()
```

> **Buffer cap (`run()` only):** every chunk of one `run()` call is normalized
> to Float32 and batched into a single native `process()` call. The cap is
> 500 MiB of **caller-supplied** audio — ≈4.55 h of 16 kHz mono `s16le` (the
> default byte format) or ≈2.27 h of 16 kHz mono `f32le`, which needs no
> expansion on the way to native. Exceeding it raises `BUFFER_LIMIT_EXCEEDED`
> (6015), whose message names the source format the budget is denominated in.
> For longer captures use `runStreaming()`, which feeds the engine as audio
> arrives, or split into sequential `run()` calls.

### Parakeet — duplex streaming `runStreaming()`

`runStreaming()` opens one long-lived native session for the lifetime of the
call and forwards each chunk as it arrives — no batching, no per-chunk session
recreation. Speaker IDs stay stable across appends, and an EOU model's `<EOU>`
boundaries surface both as `segment.isEndOfTurn` and as a synthesized
`{ type: 'endOfTurn', source: 'model-eou' }` event.

```javascript
const model = new ASRGgml({
  engine: 'parakeet',                                  // no config → alias form
  files: { model: './models/parakeet-eou-120m-v1.q8_0.gguf' }
})

await model.load()

const response = await model.runStreaming(micStream, { chunkMs: 480 })
await response
  .onUpdate((out) => {
    if (out.type === 'endOfTurn') return console.log('--- turn ended ---')
    for (const s of Array.isArray(out) ? out : [out]) process.stdout.write(s.text)
  })
  .await()
```

Only one streaming session may be open per instance; a concurrent `run()` or
`runStreaming()` throws `STREAMING_SESSION_ACTIVE` (6020).

## Engine Selection

The engine is resolved **once, in the constructor**, from three sources in
strict precedence order:

1. **`config.engine`** — authoritative, and the recommended form. If `config`
   is supplied at all, it must carry `engine`; a missing or unrecognized value
   throws `INVALID_ENGINE` (6021).
2. **`engine`** — a top-level convenience alias, used only when `config` is
   omitted entirely. Unrecognized values throw `INVALID_ENGINE`.
3. **Model-file sniffing** — last resort when neither is given. The first four
   bytes of `files.model` are read: `GGUF` ⇒ parakeet, anything else ⇒ whisper.

**Sniffing is a convenience for scripts, not an integration path.** It opens
the model file synchronously inside the constructor, it cannot distinguish a
GGUF whisper build from a GGUF parakeet build, and it throws `INVALID_ENGINE`
if the file exists but cannot be read (a missing file is reported first, as
`MODEL_NOT_FOUND` (24009)). Library and SDK callers should always pass
`config.engine` explicitly.

Validation and sniffing both target the file the driver actually opens: for
whisper that is `config.path` when set, otherwise `files.model`; parakeet only
ever loads `files.model`.

`getEngineType()` reports the resolved engine; `ASRGgml.ENGINE_WHISPER` and
`ASRGgml.ENGINE_PARAKEET` are available as statics.

## API Surface

Every verb has one signature and one meaning regardless of engine.

| Member | Description |
| --- | --- |
| `new ASRGgml({ files, config?, engine?, enableStats?, logger?, exclusiveRun? })` | Resolves the engine, validates model files and the engine config vocabulary. Throws on any problem — nothing is deferred to `load()`. |
| `load()` | Creates the native instance and activates the model. Calling it on a loaded instance unloads first. Throws `INSTANCE_DESTROYED` after `destroy()`. |
| `run(audio)` | Batch transcription. Returns a `QvacResponse`; drain it with `onUpdate(cb)` (push) or `iterate()` (pull). |
| `runStreaming(audio, opts?)` | Duplex/VAD-segmented streaming. Resolves once the native session is open; `opts` is the engine's streaming vocabulary. |
| `reload(newConfig?)` | Applies an engine-scoped partial config in place where possible. Rejects with `NOT_SUPPORTED` (6019) on an engine whose driver has no native reload. |
| `cancel(jobId?)` | Cancels the active job **and fails it**, so a draining `iterate()` throws. The native verb takes no id; `jobId` is accepted for source compatibility only. |
| `status()` | Native state string. Rejects with `FAILED_TO_GET_STATUS` (24004) before `load()`. |
| `addon` | The native interface, or `undefined` before `load()` (not cleared by `unload()`, as in both pre-merge packages). Escape hatch for a native hard cancel that stops the decode *without* failing the job (what the SDK's model-wide `cancel` uses). Not otherwise part of the supported surface. |
| `unload()` / `destroy()` | Release the model / retire the instance. |
| `getState()` | `{ configLoaded, weightsLoaded, destroyed }`. |
| `getEngineType()` | `'whisper'` \| `'parakeet'`. |
| `getBackendInfo()` | `BackendInfo` or `null` before `load()`. |
| `pause()` / `unpause()` | Always reject with `NOT_SUPPORTED` (6019). Neither engine implements a correct pause/resume. |

Constructor options:

| Option | Default | Description |
| --- | --- | --- |
| `files.model` | — | **Required.** Path to the `.bin` (whisper) or `.gguf` (parakeet) checkpoint. Must exist. |
| `files.vadModel` | — | Whisper streaming only: path to the Silero VAD model. Must exist if given. |
| `config` | — | Engine-scoped config; **must** carry `engine` when present. |
| `engine` | — | Alias for `config.engine`, used when `config` is omitted. |
| `enableStats` | `true` | Attach `RuntimeStats` to the job-end payload. |
| `logger` | `null` | A `@qvac/logging` `LoggerInterface`. |
| `exclusiveRun` | `true` | Serialize `run()` calls to completion on the inference lane; `runStreaming()` holds that lane for session setup only. `reload`/`unload`/`destroy` serialize on a **separate** lifecycle lane, so teardown pre-empts an in-flight `run()` instead of queueing behind it. |

`run()` / `runStreaming()` output payloads are:

- bare `TranscriptionSegment[]` (or a single segment) for transcripts — there
  is no `{ type: 'segment' }` wrapper;
- `{ type: 'vad', speaking, score, source }` for voice-activity events;
- `{ type: 'endOfTurn', source, silenceDurationMs? }` for turn boundaries.

## Configuration Reference

Configuration vocabularies are **engine-scoped** — there is no merged config
namespace. A key belonging to one engine is rejected, not ignored, by the
other, and unknown keys throw at construction time.

### Whisper: `config.whisperConfig` / `contextParams` / `miscConfig`

```javascript
const config = {
  engine: 'whisper',
  contextParams: {
    model: './models/ggml-tiny.bin',
    use_gpu: true,      // opt-in; defaults to false
    gpu_device: 0
  },
  whisperConfig: {
    language: 'en',     // 'auto' for language detection
    duration_ms: 0,
    temperature: 0.0,
    suppress_nst: true,
    n_threads: 0,
    audio_format: 's16le',
    vad_model_path: './models/ggml-silero-v5.1.2.bin',
    vad_params: {
      threshold: 0.6,
      min_speech_duration_ms: 250,
      min_silence_duration_ms: 200
    }
  },
  miscConfig: { caption_enabled: false }
}
```

**The authoritative vocabulary is the whitelist in
[`src/engines/whisper/configChecker.ts`](src/engines/whisper/configChecker.ts).**
It accepts a curated subset of `whisper_full_params` (decoder strategy,
thresholds, timestamps, VAD, prompts) plus the `vadParams` sub-object; any key
outside the list throws from the constructor. `contextParams` accepts only
`model`, `use_gpu`, `flash_attn`, `gpu_device`; `miscConfig` only
`caption_enabled`, `seed`. For what each flag means see the upstream
[`whisper_full_params` reference](https://github.com/ggerganov/whisper.cpp/blob/master/examples/stream/stream.cpp#L30-L96).

Notes:

- **GPU is opt-in.** `use_gpu` defaults to `false`; set it in `contextParams`.
- **Four context keys force a full reload** — `model`, `use_gpu`,
  `flash_attn`, `gpu_device`. Changing any of them destroys and rebuilds the
  whisper context (seconds, depending on model size). Everything in
  `whisperConfig` is applied in place.
- `backendsDir` (in `whisperConfig`) overrides where dynamically-loaded ggml
  backend libraries are found. See
  [Backends and GPU Acceleration](#backends-and-gpu-acceleration).
- `max_seconds` is a convenience that derives `duration_ms`.

Whisper `runStreaming(audio, opts)` options:

| Option | Description |
|--------|-------------|
| `emitVadEvents` / `conversationMode` | Emit `{ type: 'vad' }` as speech starts and stops. |
| `endOfTurnSilenceMs` | Emit `{ type: 'endOfTurn' }` after this much trailing silence. |
| `vadRunIntervalMs` | How often the VAD is evaluated. |

### Parakeet: `config.parakeetConfig`

```javascript
const config = {
  engine: 'parakeet',
  parakeetConfig: {
    useGPU: true,
    maxThreads: 4,
    timestampsEnabled: true,
    streaming: false     // true opens a session at load time
  }
}
```

**The authoritative vocabulary is `ParakeetConfig` in
[`src/engines/parakeet/driver.ts`](src/engines/parakeet/driver.ts)** — every
key is documented inline there, and any key outside it throws
`INVALID_CONFIG` (24015) from the constructor. Groups:

| Group | Keys |
| --- | --- |
| Compute | `maxThreads`, `useGPU`, `seed` |
| Audio | `sampleRate` (16000), `channels` (1) |
| Output | `captionEnabled`, `timestampsEnabled` |
| Streaming (ASR) | `streaming`, `streamingChunkMs`, `streamingEmitPartials`, `streamingEnergyVad`, `streamingLeftContextMs`, `streamingRightLookaheadMs` |
| Streaming (Sortformer) | `streamingHistoryMs`, `streamingSpkCacheEnable`, `streamingSpkCacheLen`, `streamingFifoLen`, `streamingChunkLeftContextMs`, `streamingChunkRightContextMs`, `streamingSpkCacheUpdatePeriod` |
| Backends | `backendsDir`, `openclCacheDir` |

The `streamingSpkCache*` / `streamingFifoLen` /
`streamingChunk{Left,Right}ContextMs` defaults are the NeMo-port tuning
parakeet-cpp ships — keep them unless you are A/B comparing AOSC against the
v1 sliding-window path. There is no `modelType`: CTC / TDT / EOU / Sortformer,
and Sortformer v1 vs v2.1+AOSC, are all detected from the GGUF metadata.

Parakeet `runStreaming(audio, opts)` options are per-call overrides of the same
knobs without the `streaming` prefix: `chunkMs`, `historyMs`, `leftContextMs`,
`rightLookaheadMs`, `emitPartials`, `emitEnergyVad`, `spkCacheEnable`,
`spkCacheLen`, `fifoLen`, `chunkLeftContextMs`, `chunkRightContextMs`,
`spkCacheUpdatePeriod`.

For a deep dive on Sortformer streaming, AOSC, and the `.nemo` → `.gguf`
pipeline, see the heritage
[`docs/PARAKEET-README.md`](docs/PARAKEET-README.md) (pre-merge API names).

## Audio Input

Both engines take **16 kHz mono** audio. `run()` and `runStreaming()` accept a
stream, an iterable, a single chunk, or an array of chunks. A chunk's *class*
decides how it is interpreted:

| Chunk type | Interpretation |
| --- | --- |
| `Float32Array` | f32 samples in `[-1, 1]` |
| `Int16Array` | s16 samples |
| `Uint8Array` | raw bytes, decoded as `s16le` by default; whisper's `whisperConfig.audio_format: 'f32le'` switches the byte interpretation |

`audio_format` accepts `'s16le'`, `'f32le'` and `'decoded'` (an alias for
`'f32le'`); anything else throws `INVALID_AUDIO_FORMAT` (24010) rather than
being decoded as little-endian s16. It only ever describes raw `Uint8Array`
bytes — it never reinterprets a typed array.

A byte length that is not a whole number of samples raises
`INVALID_AUDIO_INPUT` (6011). In a **stream** of byte chunks the check is
applied in aggregate, so a sample split across a chunk boundary (arbitrary
socket/pipe read sizes) is carried over into the next chunk; only a stream
that ends mid-sample is rejected.

## Backends and GPU Acceleration

GPU backends are selected per platform via `vcpkg.json` features; no
`bare-make generate` flag is needed:

- **Linux / Windows** — Vulkan (needs the [Vulkan SDK](https://vulkan.lunarg.com/) on the build host)
- **Android** — Vulkan + OpenCL (Adreno) as dynamically-loaded `.so` backends shipped beside the prebuild
- **macOS / iOS** — Metal, statically linked

Both engines default to CPU: whisper needs `contextParams.use_gpu: true`,
parakeet needs `parakeetConfig.useGPU: true`.

`getBackendInfo()` reports what actually ran — `backendName`, `backendId`
(see the `BackendId` enum), `backendDevice`, `backendDescription`,
`encoderBackend`, and `encoderOnCoreml` (Apple: whether the Neural Engine
Core ML sidecar drove the encoder). Whisper additionally reports
`gpuMemTotalMb` / `gpuMemFreeMb`.

Two paths matter on mobile:

- **`backendsDir`** (in `whisperConfig` / `parakeetConfig`) — root directory
  holding dynamically-loaded ggml backend libraries (Vulkan, OpenCL, per-arch
  CPU variants). Defaults to the package's `prebuilds/`; the native addon
  appends `<bare-target>/<module-name>` before scanning. Pass an explicit path
  when backend libraries ship elsewhere — e.g. Android's
  `ApplicationInfo.nativeLibraryDir` when they are packaged inside the APK.
  No-op on Apple, where backends are statically linked.
- **`openclCacheDir`** (parakeet) — persistent directory for ggml-opencl's
  compiled program-binary cache. Android-only; pass the host app's cache
  directory to avoid a cold `clBuildProgram` on every process start.

## Staging Models

The addon loads weights from local paths only — it never downloads. Stage
files with the bundled scripts, from the
[QVAC model registry](https://github.com/tetherto/qvac/tree/main/packages/registry-server),
or by hand.

**Whisper** (HuggingFace):

```bash
npm run download-models                 # interactive picker into ./models/
```

**Parakeet**, prebuilt GGUFs from the QVAC registry (fastest path):

```bash
npm run download-models:parakeet:registry              # all types
npm run download-models:parakeet:registry -- -t tdt    # just TDT
```

**Parakeet**, converting NVIDIA `.nemo` yourself:

```bash
npm run setup-models:parakeet                  # venv + download + convert (all types, q8_0)
npm run setup-models:parakeet -- -t tdt        # just TDT
npm run setup-models:parakeet -- -t eou -q f16 # full-precision EOU
```

`setup-models:parakeet` chains `setup:venv` → `download-models:parakeet` →
`convert-models:parakeet` and is idempotent. Each step is also flag-driven on
its own (`scripts/setup-venv.sh`, `scripts/parakeet-download-models.sh`,
`scripts/convert-nemo.sh` — all accept `--help`). The converter reads the
`.nemo` archive directly and does **not** need the heavy `nemo_toolkit`
package, but it does need `sentencepiece` to decode the tokenizer (without it
transcripts come out as raw token IDs). Full requirements:
`scripts/requirements.txt`.

## Error Codes

Thrown errors are `QvacErrorAddonASRGgml` instances (extending
`QvacErrorBase`) carrying a numeric `.code`, so callers can match
programmatically. `ERR_CODES` is exposed as `ASRGgml.ERR_CODES` and the class
as `ASRGgml.Error`.

The map spans **two ranges**, because no historical code was allowed to move:

- **Shared verbs are canonical in the whisper `6001–7000` range** —
  `FAILED_TO_LOAD_WEIGHTS` 6001 … `VAD_MODEL_NOT_FOUND` 6018, plus the codes
  the merge added: `NOT_SUPPORTED` 6019, `STREAMING_SESSION_ACTIVE` 6020,
  `INVALID_ENGINE` 6021.
- **Parakeet-only names keep their historical `24001–25000` numbers** —
  `MODEL_NOT_FOUND` 24009, `INVALID_AUDIO_FORMAT` 24010, `INVALID_CONFIG`
  24015, `INSTANCE_DESTROYED` 24018, `JOB_CANCELLED` 24019. Shared verbs
  raised *by the parakeet engine* also stay in `24xxx` (a parakeet append
  failure is 24003, not 6003).

Every number from both historical tables is registered, so pre-merge codes
still resolve to a name and message. See
[`src/lib/error.ts`](src/lib/error.ts) for the full table and
[`docs/engines.md`](docs/engines.md#error-codes-across-engines) for the
rationale.

## Development

### Prerequisites

- **CMake** ≥ 3.25, **Git** with submodule support, a **C++20** compiler
  - Linux: Clang/LLVM 22 with libc++ (`clang libc++-dev libc++abi-dev`)
  - macOS: Xcode command-line tools
  - Windows: Visual Studio 2019+ or Build Tools
- **vcpkg** — clone it, run `bootstrap-vcpkg.sh`/`.bat`, and export
  `VCPKG_ROOT=/path/to/vcpkg`
- Optional GPU SDKs: [Vulkan SDK](https://vulkan.lunarg.com/) on
  Linux/Windows (`vulkan-tools libvulkan-dev vulkan-utility-libraries-dev
  spirv-tools` on Ubuntu/Debian); Metal needs nothing on macOS/iOS

### Build

```bash
git clone https://github.com/tetherto/qvac.git
cd qvac/packages/asr-ggml
git submodule update --init --recursive
npm install
npm run build          # build:ts (TypeScript) + build:native (bare-make)
```

`build:native` runs `bare-make generate` → `bare-make build` →
`bare-make install`.

### Test

```bash
npm test                              # unit + the main integration suites
npm run test:unit
npm run test:integration              # both engines
npm run test:integration:whisper
npm run test:integration:parakeet
npm run test:cpp                      # native gtest suite
npm run lint                          # separate from npm test
```

Targeted suites worth knowing: `test:integration:chunking` (reload-per-chunk
long audio), `test:integration:live-stream-simultion` (single long-lived job),
`test:integration:gpu`, `test:integration:model-file-validation`.

Typical loop: `npm install && npm run build && npm run test:integration`.

## Benchmarking

Accuracy (WER / CER / AraDiaWER) and RTF benchmarks live under
[`benchmarks/`](benchmarks) and are engine-keyed throughout:

- [`benchmarks/server/`](benchmarks/server/README.md) — one bare HTTP server;
  `POST /run` takes an `engine: "whisper" | "parakeet"` discriminator.
- [`benchmarks/client/`](benchmarks/client/README.md) — one Python client;
  `src/main.py` dispatches on the config's required top-level `engine:` key
  over `src/whisper/` and `src/parakeet/`.
- `benchmarks/client/config/config-whisper*.yaml` (incl. three Common Voice
  Arabic variants) and `config-parakeet{,-ctc,-eou,-sortformer}.yaml`.
- `benchmarks/manual-results/{whisper,parakeet}/` — drop RTF artifacts for
  backends CI cannot host.
- `benchmarks/ci/` — the HuggingFace → GGML conversion step the accuracy
  workflow uses for whisper's `custom_model_repo` input.

```bash
# accuracy
cd benchmarks/client && poetry install
poetry run python -u -m src.main --config config/config-whisper.yaml
poetry run python -u -m src.main --config config/config-parakeet.yaml

# RTF matrix (engine-keyed entries via QVAC_ASR_GGML_BENCHMARK_MATRIX_JSON)
npm run test:benchmark:rtf:matrix
```

`scripts/trigger-benchmark.sh -e whisper|parakeet` dispatches the CI accuracy
workflow. Aggregated historical results:
[`benchmarks/results/results_summary.md`](benchmarks/results/results_summary.md).

## Examples

Whisper:

- [`examples/quickstart.js`](examples/quickstart.js) — basic transcription (`npm run example:whisper`)
- [`examples/example.streaming-vad.js`](examples/example.streaming-vad.js) — VAD-segmented `runStreaming()`
- [`examples/example.mic-conversation.js`](examples/example.mic-conversation.js) — mic capture with VAD state and end-of-turn events
- [`examples/example.live-transcription.js`](examples/example.live-transcription.js) — small chunks into one long-lived job
- [`examples/example.audio-ctx-chunking.js`](examples/example.audio-ctx-chunking.js) — long recordings via per-chunk `reload()`
- [`examples/example.reload.js`](examples/example.reload.js) — reloading with a different language/temperature
- [`examples/example.decoder.js`](examples/example.decoder.js) — the FFmpeg decoder standalone

Parakeet:

- [`examples/parakeet-transcribe.js`](examples/parakeet-transcribe.js) — universal transcribe/diarize, any GGUF (`npm run example:parakeet`)
- [`examples/parakeet-diarized-transcribe.js`](examples/parakeet-diarized-transcribe.js) — Sortformer + ASR, "who said what"
- [`examples/parakeet-live-mic.js`](examples/parakeet-live-mic.js) — live mic via the duplex streaming session
- [`examples/parakeet-live-mic-diarized.js`](examples/parakeet-live-mic-diarized.js) — live mic with speaker tags
- [`examples/parakeet-live-mic-diarized-aosc.js`](examples/parakeet-live-mic-diarized-aosc.js) — same, with the AOSC tuning knobs as CLI flags
- [`examples/parakeet-decode-audio.js`](examples/parakeet-decode-audio.js) — decode + transcribe any FFmpeg-supported container

The live-mic examples capture the default input device via `sox -d`
(`brew install sox` / `apt install sox` / `choco install sox`). With
`npm run example:* -- ...`, keep the `--` separator or npm eats the flags.

## Documentation

- [`docs/engines.md`](docs/engines.md) — the orchestrator + driver layout, the
  native verb table, engine resolution, and how to add a third engine
- [`docs/architecture.md`](docs/architecture.md) — full architecture write-up
  (heritage: whisper engine, pre-merge naming)
- [`docs/data-flows-detailed.md`](docs/data-flows-detailed.md) — sequence
  diagrams for load / run / streaming / reload (heritage: whisper engine)
- [`docs/whisper-addon-help.md`](docs/whisper-addon-help.md) — whisper.cpp
  parameter reference
- [`docs/PARAKEET-README.md`](docs/PARAKEET-README.md) — heritage
  `@qvac/transcription-parakeet` README; still the deepest reference for
  Sortformer/AOSC behaviour and the `.nemo` → `.gguf` pipeline
- [`docs/WHISPER-CHANGELOG.md`](docs/WHISPER-CHANGELOG.md) /
  [`docs/PARAKEET-CHANGELOG.md`](docs/PARAKEET-CHANGELOG.md) — the two
  pre-merge histories, preserved verbatim
- [`CHANGELOG.md`](CHANGELOG.md) — the merged package's history, starting at
  `0.1.0`

## Glossary

- **Bare** — small, modular JavaScript runtime for desktop and mobile. [Learn more](https://docs.pears.com/bare-reference/overview).
- **GGUF** — single-file model format used by ggml-based runtimes; carries weights, tokenizer, and hyperparameters together.
- **QVAC** — Tether's open-source AI SDK for building decentralized AI applications.
- **RTF** — real-time factor: processing time divided by audio duration. Lower is better; below 1.0 is faster than real time.
- **AOSC** — Audio-Online Speaker Cache, the NeMo-derived mechanism that anchors Sortformer v2.1 speaker slots across silence.
- **EOU** — end of utterance; Parakeet's EOU model emits a native `<EOU>` token at turn boundaries.

## Resources

- [NVIDIA Parakeet model cards](https://huggingface.co/collections/nvidia/parakeet-asr-models-66b50d5a37b9580ee4ba93c2) — upstream `.nemo` checkpoints
- [whisper.cpp GGML models](https://huggingface.co/ggerganov/whisper.cpp) — upstream whisper checkpoints

## License

This project is licensed under the Apache-2.0 License — see [LICENSE](LICENSE)
for details, and [NOTICE](NOTICE) for third-party components. Parakeet model
files are distributed under the **NVIDIA Open Model License**; see the
upstream HuggingFace model cards for the per-checkpoint terms.

For questions or issues, please open an issue on the GitHub repository.
