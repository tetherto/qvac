# @qvac/tts-ggml

Text-to-speech Bare addon backed by the [`qvac-tts.cpp`][qvac-tts-cpp]
GGML library.  Wraps multiple engines under one package: **Chatterbox**
(Turbo English + multilingual) and **Supertonic** (v1 English, v2, and
v3 31-language), plus optional LavaSR neural denoise + 48 kHz
bandwidth-extension enhancement.

Runs in-process with a persistent native engine — the GGUFs, the S3Gen
preload, the ggml backend, and any voice-conditioning tensors are
loaded once and reused across every synthesis call.  GPU acceleration
(Metal on macOS/iOS, Vulkan on Linux/Windows, Vulkan / OpenCL on Android)
is **opt-in** via `config: { useGPU: true }`; the default is CPU.  On
Android `useGPU` flows through to `tts-cpp`, which picks the GPU
backend per its own per-vendor allowlist (Adreno → OpenCL,
Xclipse/Mali → Vulkan) for both engines (see
[Backends & GPU acceleration](#backends--gpu-acceleration)).

[qvac-tts-cpp]: https://github.com/tetherto/qvac-ext-lib-whisper.cpp/tree/master/tts-cpp

## Features

- Batch synthesis (`run({ input })` → single PCM buffer).
- **Sentence-granularity streaming** — `runStreaming(asyncIterable)`:
  yields one audio chunk per input sentence.
- **Native per-chunk streaming** — set `streamChunkTokens` and audio
  flows out of the C++ engine chunk-by-chunk as T3 tokens produce
  S3Gen+HiFT output; sub-second first-audio-out inside a single
  utterance.
- **Voice cloning** from a reference wav (or a pre-baked profile dir).
- **CPU by default**, GPU (Metal / Vulkan / OpenCL) opt-in via
  `config.useGPU: true` on GPU-capable hosts — including Android, where
  `tts-cpp` selects the GPU backend per its per-vendor allowlist (see
  [Backends & GPU acceleration](#backends--gpu-acceleration)).
- **Dynamic backend loading on Android** — per-arch CPU + Vulkan +
  OpenCL `.so` files ship under `prebuilds/<bare-target>/qvac__tts-ggml/`
  and are picked up at runtime via the new `backendsDir` option (see
  [Backends & GPU acceleration](#backends--gpu-acceleration)).
- **Cancellation** via `model.cancel()` — stops T3 decode on the next
  token; in-flight S3Gen chunk runs to completion.

## Install

```bash
npm install @qvac/tts-ggml
```

Requires [Bare](https://github.com/holepunchto/bare) `>=1.19.0`.
Prebuilds are published for darwin-arm64, android-arm64, ios-arm64;
Linux x64 / Windows prebuilds coming as demand warrants.  If your
platform has no prebuild the package falls back to a local build via
`bare-make` + `cmake-vcpkg` (see [Build from source](#build-from-source)).

## Model files

Two engines are wrapped, each with its own GGUF layout under `models/`:

```
# Chatterbox turbo (English)
chatterbox-t3-turbo.gguf   (~742 MB) — T3 GPT-2 Medium + BPE + VoiceEncoder
chatterbox-s3gen.gguf      (~1.0 GB) — S3Gen encoder/CFM + HiFT + CAMPPlus + S3TokenizerV2

# Chatterbox multilingual (en/es/fr/de/pt/it/zh/ja/ko/...)
chatterbox-t3-mtl.gguf     (~1.0 GB)
chatterbox-s3gen-mtl.gguf  (~1.0 GB)

# Supertonic English (Supertone/supertonic; 44.1 kHz, voice baked in)
supertonic.gguf            (~263 MB)

# Supertonic multilingual (Supertone/supertonic-2; en/ko/es/pt/fr)
supertonic2.gguf           (~263 MB)

# Supertonic 3 (Supertone/supertonic-3; 31 languages) — published per quant
# tier with the quant in the filename (auto-detected from modelDir)
supertonic3-f16.gguf       (also -q8_0 / -q4_0 / -f32)
```

The package converts these from upstream Resemble Chatterbox / Supertone
checkpoints via a Python venv pipeline:

```bash
npm run setup-models   # creates ./venv, installs requirements.txt, runs convert-models.sh
```

Or step-by-step:

```bash
npm run setup:venv
npm run convert-models
```

Point the addon at a custom location via `files.modelDir` (engine
auto-detected from the gguf filenames present), or pass explicit
`files.t3Model` + `files.s3genModel` (Chatterbox) /
`files.supertonicModel` (Supertonic).

## Quick start

```js
const TTSGgml = require('@qvac/tts-ggml')

const model = new TTSGgml({
  files: { modelDir: './models' }, // contains chatterbox-{t3-turbo,s3gen}.gguf
  config: { language: 'en' },
  opts: { stats: true }
})

await model.load()

const response = await model.run({
  type: 'text',
  input: 'Hello from qvac tts ggml.'
})

let pcm = []
await response
  .onUpdate(data => {
    if (data && data.outputArray) pcm = pcm.concat(Array.from(data.outputArray))
  })
  .await()

// pcm is Int16 mono @ 24 kHz for Chatterbox (rate varies by engine — see data.sampleRate)
await model.unload()
```

## Streaming

### Sentence streaming — `runStreaming(asyncIter)`

Use when your text arrives as discrete sentences (e.g. buffered LLM
output) and you want the audio to flow sentence-by-sentence.  One
`onUpdate` event per input yield.

```js
async function * sentencesOverTime () {
  yield 'First sentence.'
  await new Promise(r => setTimeout(r, 200))
  yield 'The second arrives shortly after.'
}

const response = await model.runStreaming(sentencesOverTime())
await response.onUpdate(data => {
  // data.outputArray    — Int16 PCM for this sentence's audio
  // data.chunkIndex     — 0-based index of the yielded sentence
  // data.sentenceChunk  — the sentence text that produced this audio
}).await()
```

Full runnable demo (with streaming playback):
`bare examples/chatterbox-sentence-stream-tts.js`

### Chunk streaming — `streamChunkTokens`

Use when you want the fastest possible first-audio-out **within a
single utterance**.  The C++ engine splits each synthesis into chunks
of `streamChunkTokens` speech tokens (25 ≈ 1 s of audio) and emits
audio per chunk, keeping HiFT's source cache phase-continuous across
seams so the joins are inaudible.

```js
const model = new TTSGgml({
  files: { modelDir: './models' },
  referenceAudio: './voices/jfk.wav', // optional
  streamChunkTokens: 25,              // ~1 s of audio per chunk
  streamFirstChunkTokens: 10,         // smaller first chunk = faster first-audio-out
  cfmSteps: 1,                        // 1-step meanflow: halves CFM cost
  config: { language: 'en' }
})

await model.load()

const response = await model.run({ input: 'A long sentence produces many chunks...' })
await response.onUpdate(data => {
  if (data && data.outputArray) playPcmChunk(data.outputArray)
}).await()
```

Full runnable demo (with gapless playback via `sox` or `ffplay`):
`bare examples/chatterbox-chunk-stream-tts.js`

## Voice cloning

Pass a mono wav ≥ 5 s of clean speech — the engine does the loudness
normalisation (−27 LUFS), resampling, and all conditioning (VoiceEncoder,
CAMPPlus, S3TokenizerV2, mel extraction) natively at `load()` time:

```js
const model = new TTSGgml({
  files: { modelDir: './models' },
  referenceAudio: './voices/me.wav',
  config: { language: 'en' }
})
```

Alternatively point at a pre-baked profile directory produced by the
upstream CLI's `--save-voice DIR` (loads `.npy` tensors; skips the
preprocessing entirely):

```js
new TTSGgml({
  files: { modelDir: './models' },
  voiceDir: './voices/me/',
})
```

When both are supplied, missing tensors in `voiceDir` are backfilled
from `referenceAudio`.

## Speech enhancement (LavaSR)

Opt-in neural post-processing that bandwidth-extends the synthesized audio to
**48 kHz** with a synthesised high band, using the LavaSR Vocos enhancer
(ConvNeXt backbone + ISTFT spec head) converted to a single GGUF. It follows the
engine's GPU intent: with `config.useGPU: true` (or `nGpuLayers`) the enhancer
runs on the GPU (Vulkan on Linux/Windows, Metal on macOS/iOS) and falls back to
CPU otherwise. It is fully backward compatible — provide no enhancer GGUF and
nothing changes.

Enhancement is enabled simply by supplying the enhancer GGUF; there is no
separate on/off flag.

```js
const model = new TTSGgml({
  engine: TTSGgml.ENGINE_SUPERTONIC,
  // Providing the enhancer GGUF is what turns enhancement on:
  files: { supertonicModel, lavasrEnhancer: 'models/lavasr/lavasr-enhancer.gguf' },
  config: { language: 'en' }
})
// The output callback now reports 48000:
//   response.onUpdate(d => { /* d.outputArray; d.sampleRate === 48000 */ })
```

The GGUF path may instead be given as `enhancer.enhancerPath` (an
`enhancer: { type: 'lavasr', enhancerPath }` block). Convert the GGUF from the
public [LavaSRcpp](https://github.com/Topping1/LavaSRcpp) ONNX release:

```bash
python scripts/convert-lavasr-enhancer-to-gguf.py \
  --backbone enhancer_backbone.onnx --spec-head enhancer_spec_head.onnx \
  --out models/lavasr/lavasr-enhancer.gguf --ftype f16   # or f32
```

Notes:

- Works for Supertonic and Chatterbox, on the batch path, sentence-level
  streaming, **and** Chatterbox native chunk streaming (`streamChunkTokens > 0`).
- For native chunk streaming the enhancer runs over a sliding window with
  look-ahead + crossfade so each emitted chunk is bandwidth-extended seam-free.
  This adds **~0.34 s of look-ahead latency** (inherent to the enhancer's
  receptive field), so first-audio-out arrives a little later than un-enhanced
  streaming.
- The enhancer always runs at 48 kHz internally. By default the emitted audio
  is 48 kHz; set `config.outputSampleRate` to resample the enhanced output to a
  different rate (`TTSOutputChunk.sampleRate` reports the actual rate).
- With `opts.stats`, `response.stats.enhancerBackendDevice` (`-1` none / `0` CPU
  / `1` GPU) and `enhancerBackendId` report where the enhancer actually ran.

### Denoiser

LavaSR's first stage — the UL-UNAS **denoiser**, which cleans the signal before
the enhancer bandwidth-extends it — is wired through the addon. It is enabled the
same way as the enhancer, via `files.lavasrDenoiser` (or a
`denoiser: { type: 'lavasr', denoiserPath }` block), and runs before the
enhancer (rate-preserving) on the batch path for both engines:

```js
const model = new TTSGgml({
  engine: TTSGgml.ENGINE_SUPERTONIC,
  files: {
    supertonicModel,
    lavasrDenoiser: 'models/lavasr/lavasr-denoiser.gguf', // cleaned first…
    lavasrEnhancer: 'models/lavasr/lavasr-enhancer.gguf'  // …then upsampled
  },
  config: { language: 'en' }
})
```

Convert the GGUF from the public [LavaSRcpp](https://github.com/Topping1/LavaSRcpp)
ONNX release using the `convert-lavasr-denoiser-to-gguf.py` script shipped in the
[`qvac-ext-lib-whisper.cpp/tts-cpp`][qvac-tts-cpp] repo (this package ships only
the enhancer converter under `scripts/`):

```bash
python /path/to/tts-cpp/scripts/convert-lavasr-denoiser-to-gguf.py \
  --denoiser denoiser_core_legacy_fixed63.onnx \
  --out models/lavasr/lavasr-denoiser.gguf --ftype f16   # or f32
```

Notes:

- The UL-UNAS forward runs at 16 kHz internally (resampled in/out), so the
  denoiser is **rate-preserving**: the emitted audio keeps the engine's sample
  rate. With no denoiser path the output is unchanged (full backward compat).
- Denoiser + Chatterbox native chunk streaming (`streamChunkTokens > 0`) is
  rejected up front — a stateful streaming denoiser is the follow-up. Use batch
  synthesis, or drop the denoiser for streaming.
- The tts-cpp UL-UNAS forward is implemented in
  [qvac-ext-lib-whisper.cpp#78](https://github.com/tetherto/qvac-ext-lib-whisper.cpp/pull/78)
  (scalar CPU port, validated bit-close to the ONNX reference); it requires a
  `tts-cpp` build that includes that port — see the pinned version in `vcpkg.json`.

## Backends & GPU acceleration

The addon delegates backend selection to `tts-cpp`'s registry-only
init path.  At `load()` time the engine walks the ggml-backend registry
once and picks the first available accelerator that matches the
host's policy:

| Platform                | Default backend when `useGPU: true`          |
|-------------------------|----------------------------------------------|
| macOS / iOS             | Metal                                        |
| Linux / Windows         | Vulkan                                       |
| Android — Adreno 700+   | OpenCL                                       |
| Android — Mali / others | Vulkan                                       |
| Everything else / CPU-only build | CPU                                 |

> Both Chatterbox and Supertonic run on ARM Mali via Vulkan: `tts-cpp` sets
> `allow_arm_mali=true` for both graphs. (Earlier `tts-cpp` builds declined
> Mali for the Chatterbox / S3Gen graph and fell back to CPU there.)

### Android: dynamic backend loading

Android prebuilds enable `GGML_BACKEND_DL=ON` and ship per-arch
backend `.so` files under
`prebuilds/<bare-target>/qvac__tts-ggml/`.

The engine `dlopen()`s the highest-tier CPU variant the device's
HWCAPs support and one of the GPU `.so` files based on the policy
table above.  Hosts must pass `backendsDir: path.join(__dirname,
'prebuilds')` (or rely on the default fallback the package ships)
so the runtime knows where to look.  `openclCacheDir` is also
Android-specific; setting it to a writable path lets the OpenCL
backend persist its compiled program cache across launches.
`vulkanCacheDir` is the Vulkan analogue (Supertonic + `useGPU: true`):
setting it to a writable path persists the compiled pipeline cache
(`GGML_VK_PIPELINE_CACHE_DIR`) across launches and enables a load-time
pre-warm, so the one-time first-dispatch shader-compile cost (seconds
on Mali) is paid once per install rather than on the first `run()` of
every process.  Both are fully opt-in: unset means behaviour is
unchanged.

## API overview

### Constructor — `new TTSGgml(options)`

| Option                    | Type       | Default    | Notes |
|---------------------------|------------|------------|-------|
| `files.modelDir`          | string     | —          | Dir containing the two GGUFs |
| `files.t3Model`           | string     | —          | Overrides `modelDir` for T3 |
| `files.s3genModel`        | string     | —          | Overrides `modelDir` for S3Gen |
| `files.supertonicModel`   | string     | —          | Supertonic GGUF (overrides `modelDir`) |
| `files.lavasrEnhancer`    | string     | —          | LavaSR enhancer GGUF — supplying it turns on 48 kHz enhancement |
| `files.lavasrDenoiser`    | string     | —          | LavaSR denoiser GGUF — supplying it turns on denoising (batch only) |
| `engine`                  | string     | auto       | Force `'chatterbox'` or `'supertonic'` (`TTSGgml.ENGINE_CHATTERBOX` / `ENGINE_SUPERTONIC`); auto-detected from the GGUFs present otherwise |
| `referenceAudio`          | string     | —          | Mono wav ≥ 5 s for voice cloning |
| `voiceDir`                | string     | —          | Pre-baked voice profile |
| `seed`                    | number     | 42         | RNG seed (CFM noise + sampling) |
| `nGpuLayers`              | number     | 0          | Layers offloaded to GPU (mirrors `useGPU`; pass `99` to offload all) |
| `nCtx`                    | number     | 4096       | Cap on the T3 context (prompt + generated speech tokens; 25 tokens ≈ 1 s of audio).  The KV cache is allocated up-front at this length, so it directly bounds memory: the Turbo GGUF's native `n_ctx=8196` would cost ~1.6 GB of f32 KV vs ~390 MB at the defaults (4096 + `f16`).  Pass `0` to use the GGUF's full context |
| `kvCacheType`             | string     | `f16`      | T3 KV-cache dtype: `f32` \| `f16` \| `q8_0`.  `f16` (~50% of f32) is the safe cross-backend default.  `q8_0` stores the cache at ~27% of f32 and decodes 20-30% faster on Metal, but only works on backends with a q8_0 CONT op (CPU, CUDA) — it hard-aborts the multilingual model on Metal, so it is opt-in.  Turbo greedy decoding is byte-identical across all three (upstream-validated).  Pass `f32` for bit-exact pre-quantisation behaviour |
| `threads`                 | number     | hw.concurrency capped at 4 | |
| `streamChunkTokens`       | number     | 0          | **>0 enables native chunk streaming** |
| `streamFirstChunkTokens`  | number     | = streamChunkTokens | Smaller first chunk for low first-audio-out |
| `cfmSteps`                | number     | 2          | Chatterbox: 1 = faster (halved CFM cost) |
| `speed`                   | number     | 1.0        | Speaking-rate multiplier, bounded `[0.25, 4.0]` (`< 1` slower, `> 1` faster). Both engines |
| `voice` / `voiceName`     | string     | —          | Supertonic voice id (e.g. `'F1'`, `'M1'`) |
| `steps` / `numInferenceSteps` | number | GGUF default | Supertonic vector-estimator CFM steps (`0` = GGUF default) |
| `noiseNpyPath`            | string     | —          | Supertonic: optional fixed CFM noise `.npy` for reproducibility |
| `mecabDictDir`            | string     | —          | Chatterbox MTL Japanese (`ja`): compiled MeCab/IPAdic dictionary directory |
| `cangjieTsvPath`          | string     | —          | Chatterbox MTL Chinese (`zh`): `Cangjie5_TC` TSV path |
| `backendsDir`             | string     | `path.join(__dirname, 'prebuilds')` | Root dir the addon scans for dynamically-loaded ggml backend `.so` files.  Required on Android (host should pass `path.join(__dirname, 'prebuilds')`); ignored on platforms that statically link the backend |
| `openclCacheDir`          | string     | unset      | Android-only: directory where the OpenCL backend persists its compiled program-binary cache.  Setting it across runs avoids re-JITing the kernels on every fresh process |
| `vulkanCacheDir`          | string     | unset      | Supertonic + `useGPU: true` only: writable directory where the Vulkan backend persists its compiled pipeline cache (`GGML_VK_PIPELINE_CACHE_DIR`).  Moves the one-time first-dispatch pipeline-compile cost (seconds on Mali) off the first `run()` — paid once per install instead of once per process — and enables a load-time pre-warm.  Fully opt-in: unset -> no cross-process cache, no pre-warm, behaviour unchanged |
| `config.language`         | string     | `"en"`     | Chatterbox MTL accepts `es/fr/de/pt/it/zh/ja/ko/...`; turbo & Supertonic are English |
| `config.useGPU`           | boolean    | `false`    | Set to `true` to route through Metal / Vulkan / CUDA / OpenCL if available.  Honored for both engines on GPU-capable hosts, including Android, where `tts-cpp` selects the GPU backend per its per-vendor allowlist (see [Backends & GPU acceleration](#backends--gpu-acceleration)) |
| `config.outputSampleRate` | number     | — (engine-native) | Resample the output to this rate (8000–192000 Hz). Omit to keep the engine-native rate (Chatterbox 24 kHz, Supertonic 44.1 kHz, enhancer 48 kHz) |
| `opts.stats`              | boolean    | `false`    | Populate `response.stats` with RTF, `backendDevice` (0=CPU, 1=GPU), `backendId` (0=CPU, 1=Metal, 2=CUDA, 3=Vulkan, 4=OpenCL, 99=other), and — when an enhancer is active — `enhancerBackendDevice` / `enhancerBackendId` |
| `exclusiveRun`            | boolean    | `false`    | **Top-level** option (not under `opts`): serialize overlapping streaming runs |

### Methods

- `await model.load()` — construct the native engine (loads T3, preloads
  S3Gen, bakes voice conditioning).  Subsequent `run()` calls reuse all
  of it.
- `await model.unload()` — release everything.  Idempotent.
- `await model.reload(newConfig)` — re-create the engine with a new
  config (`language`, `useGPU`, `outputSampleRate`, …).
- `await model.destroy()` — `unload()` + mark this instance dead.
- `await model.cancel()` — best-effort cancel of any in-flight run.
- `model.run({ input, type: 'text' })` → `QvacResponse`.
- `model.run({ input, streamOutput: true })` → sentence-chunked
  synthesis driven by the JS-side sentence splitter (see
  `lib/textChunker.js`).  Equivalent to `runStream(input)`.
- `model.run({ input, signal })` → pass an `AbortSignal` to cancel a
  **non-streaming** run: when the signal aborts, `response.await()` rejects
  with the abort reason.  An already-aborted signal rejects deterministically
  without dispatching the engine (no native interrupt).  **Ignored when
  `streamOutput: true`** (and on `runStream` / `runStreaming`) — the streaming
  path does not thread the signal, so passing it there is a silent no-op.
- `model.runStream(text, { locale?, maxChunkScalars? })` → same as
  above, but the options read more naturally for the "split this long
  string" use case.
- `model.runStreaming(textStream, opts)` → streaming input + streaming
  output (see [Sentence streaming](#sentence-streaming--runstreamingasynciter)).

### Response shape

All `run*` methods return a `QvacResponse` (from `@qvac/infer-base`):

```js
response.onUpdate(data => {
  data.outputArray   // Int16Array — mono PCM
  data.sampleRate    // actual rate: Chatterbox 24000, Supertonic 44100, enhancer 48000
  data.chunkIndex    // present on sentence-streaming events only
  data.sentenceChunk // present on sentence-streaming events only
})
await response.await()

// response.stats — only when constructor had `opts: { stats: true }`
response.stats.totalTime         // seconds
response.stats.realTimeFactor    // synthesis time / audio duration
response.stats.audioDurationMs
response.stats.totalSamples
response.stats.tokensPerSecond
response.stats.backendDevice     // 0=CPU, 1=GPU
response.stats.backendId         // 0=CPU, 1=Metal, 2=CUDA, 3=Vulkan, 4=OpenCL, 99=other
// present when a LavaSR enhancer is active:
response.stats.enhancerBackendDevice // -1 none, 0 CPU, 1 GPU
response.stats.enhancerBackendId
```

## Examples

Runnable demos under `examples/`:

| Script | Demonstrates |
|---|---|
| `chatterbox-tts.js` | Batch synth + wav dump. `bare examples/chatterbox-tts.js "Hello"` |
| `chatterbox-mtl-tts.js` | Multilingual Chatterbox synthesis |
| `chatterbox-mtl-sweep-tts.js` | Multilingual Chatterbox sweep across languages |
| `chatterbox-adjust-speed.js` | Speaking-rate (`speed`) control |
| `chatterbox-sentence-stream-tts.js` | `runStreaming()` over an async iterator of sentences, with gapless streaming playback |
| `chatterbox-chunk-stream-tts.js` | Native per-chunk PCM streaming via `streamChunkTokens`, with gapless streaming playback |
| `chatterbox-enhanced.js` | Chatterbox + LavaSR 48 kHz enhancement (batch). `bare examples/chatterbox-enhanced.js "Hello"` |
| `supertonic-tts.js` | Supertonic batch synth. `bare examples/supertonic-tts.js "Hello"` |
| `supertonic-mtl-tts.js` | Multilingual Supertonic synthesis |
| `supertonic-mtl-sweep-tts.js` | Multilingual Supertonic sweep across languages |
| `supertonic-sentence-stream-tts.js` | Supertonic sentence-level streaming |
| `supertonic-enhanced.js` | Supertonic + LavaSR 48 kHz enhancement. `bare examples/supertonic-enhanced.js "Hello"` |

The two streaming examples feed PCM into a single long-running
`sox play` / `ffplay` process so chunks play back-to-back without any
per-chunk spawn gaps — install one of them (`brew install sox` or
`brew install ffmpeg` on macOS) to enable playback.  Absent a player
the demos still run and write the concatenated wav.

## Testing

```bash
npm run test:unit          # mocked binding; fast
npm run test:integration   # spins up the real engine; needs models
npm run test               # both
```

Integration tests scan a few candidate `models/` directories for the
required GGUFs (see `test/utils/downloadModel.js`) and skip cleanly when
files are absent.  They cover, across both engines:

* batch synthesis with full RuntimeStats,
* sentence-level streaming (`runStream` / `run({ streamOutput: true })`
  / `runStreaming` over async iterators),
* native sub-sentence chunk streaming (Chatterbox-only via
  `streamChunkTokens`),
* sequential-run / fresh-instance / reload-stability behaviour,
* strict GPU-backend assertion via `response.stats.backendDevice` +
  `backendId` (set `NO_GPU=true` to skip on CPU-only runners,
  `QVAC_TTS_GPU_SMOKE_RELAX=1` to downgrade the strict gate to a
  warning),
* multilingual Chatterbox sweep (es/fr/de/pt) via `chatterbox-mtl.test.js`,
* on darwin the Chatterbox English batch path is additionally verified
  for WER against the synthesized audio (whisper-small).

To stress-test long inputs, set `INPUT_SENTENCES=medium` (or `long`)
and re-run the integration suite — `addon.test.js` reads the env var to
pick its sentence corpus from `test/data/sentences-{medium,long}.js`.

## Build from source

Prerequisites: `clang` with C++20 support, CMake ≥ 3.25,
[vcpkg](https://vcpkg.io/) (set `VCPKG_ROOT`), `bare-make`.

```bash
npm install
npx bare-make generate      # configures + fetches the tts-cpp port
npx bare-make build
npx bare-make install       # copies the .bare into prebuilds/<triple>/
```

The vcpkg port is hosted in
[`tetherto/qvac-registry-vcpkg`][registry] and pulls
[`qvac-tts.cpp`][qvac-tts-cpp] at a pinned REF.  See
[`vcpkg-configuration.json`](./vcpkg-configuration.json) for the
baseline commit.

GPU backends are controlled by the `tts-cpp` port's vcpkg features:
`metal` (default on osx/ios), `vulkan` (default on
linux/windows/android), `opencl` (default on android).
On Android the port is configured with
`GGML_BACKEND_DL=ON` + `GGML_CPU_ALL_VARIANTS=ON`, so the build
produces per-arch CPU + Vulkan + OpenCL `.so` files alongside the
`.bare` module instead of statically linking; the resulting prebuilds
layout is what the `backendsDir` option expects (see
[Backends & GPU acceleration](#backends--gpu-acceleration)).

[registry]: https://github.com/tetherto/qvac-registry-vcpkg

## Troubleshooting

**`t3 model not found` / `supertonic model not found`** — the paths in
`files` are wrong or the GGUFs weren't generated.  Run
`npm run setup-models` (creates the Python venv and converts the
upstream checkpoints into the four / five expected GGUF files).

**`VoiceEncoder forward failed`** when passing `referenceAudio`** —
the reference wav is likely < 5 s of clean speech.  Make it longer
(10–15 s gives the best similarity).

**Crash on process exit with Metal's `[rsets->data count] == 0`
assertion** — you're running on a build *before* the `s3gen_unload()`
teardown fix; bump the `tts-cpp` port to `>= 2026-04-21` port-version.

**Slower-than-expected RTF on darwin** — set `config: { useGPU: true }`
(the default is now CPU; see [Constructor](#constructor--new-ttsggmloptions)
+ [Backends & GPU acceleration](#backends--gpu-acceleration)) and
confirm the port was built with the `metal` feature.  Also confirm
your reference wav's mel was baked (`Using C++ VoiceEncoder` /
`C++ S3TokenizerV2` messages in the log) — if voice conditioning
falls back to CPU, a chunk of the first-call overhead is visible in
RTF.

**Slow-but-otherwise-fine RTF on Android** — set `config: { useGPU:
true }` (the default is CPU; see
[Backends & GPU acceleration](#backends--gpu-acceleration)) and confirm
your device's GPU is on `tts-cpp`'s per-vendor allowlist.  Both Chatterbox
and Supertonic run on the GPU on Adreno, Xclipse, and Mali (Adreno uses
OpenCL; Xclipse and Mali use Vulkan).

## License

Apache-2.0.  See [LICENSE](./LICENSE).
