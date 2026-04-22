# @qvac/tts-ggml

Text-to-speech Bare addon backed by the [`qvac-tts.cpp`][qvac-tts-cpp]
GGML library.  Currently ships the **Chatterbox Turbo English** model;
additional engines will land under the same package as the upstream
library grows.

Runs in-process with a persistent native engine — the GGUFs, the S3Gen
preload, the ggml backend, and any voice-conditioning tensors are
loaded once and reused across every synthesis call.  GPU acceleration
(Metal on macOS/iOS, Vulkan on Linux/Windows/Android, CUDA when built)
is enabled by default; falls back to CPU if no GPU backend is available.

[qvac-tts-cpp]: https://github.com/GustavoA1604/chatterbox.cpp
<!-- NOTE: the upstream repo will be renamed to qvac-tts.cpp; link will follow. -->

## Features

- Batch synthesis (`run({ input })` → single PCM buffer).
- **Sentence-granularity streaming** — `runStreaming(asyncIterable)`:
  yields one audio chunk per input sentence.
- **Native per-chunk streaming** — set `streamChunkTokens` and audio
  flows out of the C++ engine chunk-by-chunk as T3 tokens produce
  S3Gen+HiFT output; sub-second first-audio-out inside a single
  utterance.
- **Voice cloning** from a reference wav (or a pre-baked profile dir).
- **GPU-by-default**, CPU selectable via `config.useGPU: false`.
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

The Chatterbox pipeline needs two GGUFs:

```
chatterbox-t3-turbo.gguf   (~742 MB) — T3 GPT-2 Medium + BPE + VoiceEncoder
chatterbox-s3gen.gguf      (~1.0 GB) — S3Gen encoder/CFM + HiFT + CAMPPlus + S3TokenizerV2
```

Download them into `models/` with the bundled script:

```bash
npm run models:ensure:chatterbox
```

Or point the addon at a custom location via `files.modelDir` /
`files.t3Model` + `files.s3genModel`.

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

// pcm is Int16 mono @ 24 kHz
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

## API overview

### Constructor — `new TTSGgml(options)`

| Option                    | Type       | Default    | Notes |
|---------------------------|------------|------------|-------|
| `files.modelDir`          | string     | —          | Dir containing the two GGUFs |
| `files.t3Model`           | string     | —          | Overrides `modelDir` for T3 |
| `files.s3genModel`        | string     | —          | Overrides `modelDir` for S3Gen |
| `referenceAudio`          | string     | —          | Mono wav ≥ 5 s for voice cloning |
| `voiceDir`                | string     | —          | Pre-baked voice profile |
| `seed`                    | number     | 42         | RNG seed (CFM noise + sampling) |
| `nGpuLayers`              | number     | 0 / auto   | Layers offloaded to GPU |
| `threads`                 | number     | hw.concurrency capped at 4 | |
| `streamChunkTokens`       | number     | 0          | **>0 enables native chunk streaming** |
| `streamFirstChunkTokens`  | number     | = streamChunkTokens | Smaller first chunk for low first-audio-out |
| `cfmSteps`                | number     | 2          | 1 = faster (halved CFM cost) |
| `config.language`         | string     | `"en"`     | Only English today |
| `config.useGPU`           | boolean    | `true`     | Route through Metal / Vulkan / CUDA if available |
| `config.outputSampleRate` | number     | 24000      | Resample native 24 kHz output |
| `opts.stats`              | boolean    | `false`    | Populate `response.stats` with RTF etc. |
| `opts.exclusiveRun`       | boolean    | `false`    | Serialize overlapping streaming runs |

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
- `model.runStream(text, { locale?, maxChunkScalars? })` → same as
  above, but the options read more naturally for the "split this long
  string" use case.
- `model.runStreaming(textStream, opts)` → streaming input + streaming
  output (see [Sentence streaming](#sentence-streaming--runstreamingasynciter)).

### Response shape

All `run*` methods return a `QvacResponse` (from `@qvac/infer-base`):

```js
response.onUpdate(data => {
  data.outputArray   // Int16Array — 24 kHz mono PCM
  data.sampleRate    // 24000
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
```

## Examples

Runnable demos under `examples/`:

| Script | Demonstrates |
|---|---|
| `chatterbox-tts.js` | Batch synth + wav dump. `bare examples/chatterbox-tts.js "Hello"` |
| `chatterbox-sentence-stream-tts.js` | `runStreaming()` over an async iterator of sentences, with gapless streaming playback |
| `chatterbox-chunk-stream-tts.js` | Native per-chunk PCM streaming via `streamChunkTokens`, with gapless streaming playback |

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

Integration tests download `models/chatterbox-{t3-turbo,s3gen}.gguf`
and `models/whisper/ggml-small.bin` on first run (via
`scripts/ensure-*`), then exercise batch + sentence streaming + native
chunk streaming paths.  On darwin the batch path is verified for WER
against the synthesized audio.

Longer sentence sets for perf sweeps:

```bash
npm run test:integration:medium
npm run test:integration:long
```

C++ unit tests (GoogleTest) — off by default, built via the
`BUILD_TESTING=ON` feature in `vcpkg.json`:

```bash
npm run test:cpp
```

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
`metal` (default on osx/ios), `vulkan` (default on linux/windows/android).
CUDA is opt-in at port-build time.

[registry]: https://github.com/tetherto/qvac-registry-vcpkg

## Troubleshooting

**`t3 model not found`** — the paths in `files` are wrong or the GGUFs
weren't downloaded.  Run `npm run models:ensure:chatterbox`.

**`VoiceEncoder forward failed`** when passing `referenceAudio`** —
the reference wav is likely < 5 s of clean speech.  Make it longer
(10–15 s gives the best similarity).

**Crash on process exit with Metal's `[rsets->data count] == 0`
assertion** — you're running on a build *before* the `s3gen_unload()`
teardown fix; bump the `tts-cpp` port to `>= 2026-04-21` port-version.

**Slower-than-expected RTF on darwin** — double-check that the port
was built with the `metal` feature (default) and that you're not
overriding `useGPU: false`.  Also confirm your reference wav's mel
was baked (`Using C++ VoiceEncoder` / `C++ S3TokenizerV2` messages in
the log) — if voice conditioning falls back to CPU, a chunk of the
first-call overhead is visible in RTF.

## License

Apache-2.0.  See [LICENSE](./LICENSE).
