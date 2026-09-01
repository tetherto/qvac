# @qvac/audiogen-ggml

Generate **music from a text description** with
[ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5) or
[MiniMax-Music3](https://huggingface.co/MiniMaxAI/MiniMax-Music3). ACE-Step
supports CPU and GPU generation across desktop and mobile. MiniMax-Music3 runs
on desktop CPUs and GPUs and returns stereo 44.1 kHz audio.

## How it works

Under the hood the model runs a small pipeline, and the addon just drives it and
hands you the audio:

1. **Text encoder** — turns your prompt (and lyrics) into embeddings the model
   understands.
2. **LM (language model)** — plans the song: it reads your caption plus any
   musical hints you pass (BPM, key/scale, time signature, duration) and
   produces a sequence of audio "tokens". This is the stage your rhythm hints
   steer.
3. **DiT (diffusion transformer)** — turns those tokens into an audio latent.
   This is the heavy, quality-defining stage and the only one you choose a
   variant of (see [Models](#models)).
4. **VAE** — decodes the latent into the actual waveform (stereo 48 kHz).

You get the audio as **interleaved Int16 PCM** through an output callback
(a single PCM payload once generation completes; progress ticks stream during
the run), followed by a final stats event. The addon never
downloads anything: you give it **local file paths** to the model GGUFs and it
opens them. GPU (Metal / CUDA / Vulkan, including Vulkan on Android Mali
devices) is used when you ask for it, with a CPU fallback.

## Install

```bash
npm install @qvac/audiogen-ggml
```

Published prebuilds cover Linux x64/arm64, macOS x64/arm64, Windows x64,
Android arm64, and iOS arm64. You also need the model GGUFs on disk (see
[Models](#models)); point the addon at the folder that holds them.
MiniMax-Music3 is available only in the Linux, macOS, and Windows prebuilds.

The linux-x64 prebuild bundles the CUDA backend next to Vulkan: ggml runs in
hybrid dynamically-loaded backend mode, the CPU-variant, Vulkan, and CUDA
backends ship as `.so` modules beside the addon, and only the CUDA module
depends on the CUDA runtime. Engaging CUDA needs the NVIDIA driver plus the
CUDA 13 runtime libraries (cudart and cuBLAS) resolvable at load time; hosts that
cannot resolve them skip the module and fall back to Vulkan or CPU. The engine
prefers CUDA when both GPU backends are usable. Elsewhere the CUDA backend is
opt-in at build time via `bare-make generate -D ENABLE_CUDA=ON` (needs `nvcc`
on the build host).

The prebuilt CUDA module targets **compute capability 8.0 and newer**. It
carries native code for 8.6 (RTX 30xx, A40) and 8.9 (RTX 40xx, L40) and
JIT-compiles from 8.0 PTX for anything newer (Hopper, Blackwell / RTX 50xx),
which costs a one-off compile on first use that the driver then caches. Cards
below 8.0 — Turing (RTX 20xx, GTX 16xx, T4), Volta and Pascal — have no CUDA
code path in the prebuild and should run on Vulkan.

To build the native addon from source in a repository checkout:

```bash
cd packages/audiogen-ggml
npm install
npm run build
```

## Usage

> Building with `@qvac/sdk`? Use the SDK's
> [`audioGen()` music generation guide](../../docs/website/content/docs/ai-capabilities/music-generation.mdx)
> for registry-hosted models, progress streaming, and targeted cancellation.

### MiniMax-Music3 on desktop

MiniMax-Music3 needs an LM GGUF and a synthesis GGUF. Pass their directory or
both explicit paths:

```js
const { AudioGen, ENGINE_MINIMAX } = require('@qvac/audiogen-ggml')

const gen = new AudioGen({
  engine: ENGINE_MINIMAX,
  files: { modelDir: '/path/to/minimax-music3' },
  config: { threads: 8 }
})

await gen.load()
const response = await gen.run('warm cinematic piano with gentle strings', {
  lyrics: '[Instrumental]',
  duration: 12,
  seed: 7,
  inferenceSteps: 8,
  cfgScale: 1.7
})
```

`duration` is converted to the model's 25 semantic frames per second. Use
`maxFrames` instead for direct control. MiniMax-Music3 rejects ACE-Step-only
controls such as BPM, DiT shift, frozen semantic codes, cover audio, and
`nGpuLayers`. Set `config.useGPU: true` to run the whole model pair on a GPU
backend (CUDA, Vulkan, Metal — ~22 GB of device memory for the f16 pair); the
engine falls back to CPU when no usable GPU exists and `stats.backendDevice`
reports the backend actually used. See
[`examples/generate-music-minimax.js`](examples/generate-music-minimax.js).

### 1. Simplest case — an instrumental

```js
const { AudioGen } = require('@qvac/audiogen-ggml')

// files.modelDir is a local folder with the 4 GGUFs; files.ditVariant picks the DiT.
const gen = new AudioGen({
  files: { modelDir: '/path/to/acestep/models', ditVariant: 'turbo-q4' },
  config: { useGPU: true }
})

await gen.load() // loads the 4 model stages

// iterate() streams live progress, then one interleaved-Int16 PCM item.
const response = await gen.run('lo-fi hip hop, mellow piano, rainy night', {
  lyrics: '[Instrumental]' // no vocals
})
for await (const item of response.iterate()) {
  if ('progress' in item) {
    console.log(item.progress.stage, item.progress.step, item.progress.total)
  } else {
    const pcmBytes = Buffer.from(
      item.outputArray.buffer,
      item.outputArray.byteOffset,
      item.outputArray.byteLength
    )
    // Copy pcmBytes if it must outlive item.outputArray.
  }
}
const stats = await response.await()
// { audioDurationMs, totalTimeMs, realTimeFactor, backendDevice, backendId }
// backendDevice: 0 = CPU, 1 = GPU
// backendId:     0 = CPU, 1 = Metal, 2 = CUDA, 3 = Vulkan, 4 = OpenCL, 99 = other

await gen.destroy()
```

> Progress items arrive live during generation. The current native engine emits
> one PCM item after generation, not incremental audio chunks. `await()` resolves
> with terminal stats. `backendDevice` /
> `backendId` report the backend the engine *resolved to*, not the one requested,
> so a `useGPU: true` run that fell back to the CPU is detectable. Use
> `audiogenBackendName(stats.backendId)` rather than copying the code table
> above; it returns `undefined` for an id this version does not know.
> [`examples/generate-music.js`](examples/generate-music.js) shows the pattern.

### 2. A song with lyrics + rhythm

Pass `lyrics` for vocals, and steer the LM with musical hints — `bpm`,
`keyscale`, `timesignature`, `vocalLanguage` and target `duration`:

```js
const response = await gen.run('energetic cumbia, brass stabs, live percussion, party vibe', {
  vocalLanguage: 'es',        // language the vocals are sung in
  bpm: 98,                    // tempo
  keyscale: 'A minor',        // key / scale
  timesignature: '4/4',       // time signature
  augmentCaptionWithMetadata: true, // reinforce these hints in the conditioning caption
  duration: 150,              // target length in seconds (omit => the LM decides)
  seed: 42,                   // reproducible run
  lyrics: `[verse]
Suena el tambor y el barrio se enciende
la noche es joven y la gente lo entiende

[chorus]
baila conmigo bajo la luna
que esta cumbia no para ninguna`
})
```

Anything you leave out is inferred: omit `bpm`/`keyscale`/`duration` and the LM
picks them from the caption. `inferenceSteps` / `shift` are auto-tuned to the
DiT you loaded (turbo vs sft), so you normally don't set them.
`augmentCaptionWithMetadata` is opt-in and defaults to `false`. When enabled,
ACE-Step appends BPM/tempo guidance, time signature, and key to its internal
conditioning caption while result metadata keeps the original user caption.

### 3. Reference and cover audio

`referenceAudio` conditions the generated timbre without changing the
text-to-music task:

```js
const response = await gen.run('slow blues with warm electric guitar', {
  lyrics: '[Instrumental]',
  referenceAudio
})
```

Use `cover-nofsq` to preserve the structure of source audio while applying a
new caption and optional timbre reference:

```js
const response = await gen.run('orchestral arrangement with dramatic strings', {
  lyrics: '[Instrumental]',
  taskType: 'cover-nofsq',
  sourceAudio,
  referenceAudio,
  audioCoverStrength: 1,
  coverNoiseStrength: 0.75
})
```

Both PCM inputs must be `Float32Array` values containing finite, normalized
samples in interleaved stereo order (`L, R, L, R, ...`) at 48 kHz. The addon
does not resample, convert channels, or normalize input PCM. Keep samples in
the conventional `[-1, 1]` range. `sourceAudio` is required for cover tasks.
`cover-nofsq` currently requires `audioCoverStrength: 1`;
`coverNoiseStrength` controls the source/noise blend from `0` to `1`. The
full FSQ-based `cover` task is reserved but not implemented.

See [`examples/generate-cover.js`](examples/generate-cover.js) for a runnable
cover example using raw stereo 48 kHz float PCM input.

```bash
ffmpeg -i source.wav -f f32le -acodec pcm_f32le -ar 48000 -ac 2 source.f32le
AUDIOGEN_MODEL_DIR=/path/to/models \
  AUDIOGEN_SOURCE_PCM=source.f32le \
  npm run example:cover
```

### Ordered audio editing

`edit()` starts a source-driven pipeline. `edit()`/`flowEdit()` and `repaint()`
append independent operations and execute them in the exact order they are
chained. Either operation can be used alone or repeated:

```js
const { AudioGen, RepaintMode } = require('@qvac/audiogen-ggml')

const response = await gen
  .edit({
    pcm: sourcePcm,
    sampleRate: 48000,
    channels: 2
  })
  .edit({
    from: {
      caption: 'original pop song',
      lyrics: originalLyrics
    },
    to: {
      caption: 'guitar pop-rock',
      lyrics: newLyrics
    }
  })
  .repaint({
    caption: 'analog synth solo',
    lyrics: '[Instrumental]',
    start: 10,
    end: 20,
    mode: RepaintMode.Balanced,
    strength: 0.5
  })
  .edit({
    from: { caption: 'guitar pop-rock' },
    to: { caption: 'dark synthwave' }
  })
  .run({ seed: 22883 })
```

The source must be interleaved stereo PCM at 48 kHz. Both normalized
`Float32Array` samples in `[-1, 1]` and addon-output `Int16Array` values are
accepted. Out-of-range Float32 samples are rejected. Repaint preserves PCM
outside its selected range; `start`/`end` must stay inside the source duration
and span at least one latent frame (`1/25` s). Omitting `end` repaints through
the end of the source. Flow-Edit is turbo DiT only (`turbo-q4`, `turbo-q8`) and
changes musical/lyrical conditioning over its `nMin`/`nMax` diffusion window.
Repainting an entire track is supported with `start: 0` and no `end`.

### Turning PCM into a file

Convert each `Int16Array` view to bytes using its `byteOffset` and `byteLength`,
concatenate the byte chunks, then encode them. Do not pass the entire backing
buffer because a typed array can be a smaller view into it. This snippet
continues with the `response` returned by `gen.run()` in the Usage example.

```js
const { AudioGen } = require('@qvac/audiogen-ggml')
const fs = require('fs')

const pcmChunks = []
for await (const item of response.iterate()) {
  if (!('outputArray' in item)) continue
  pcmChunks.push(Buffer.from(
    item.outputArray.buffer.slice(
      item.outputArray.byteOffset,
      item.outputArray.byteOffset + item.outputArray.byteLength
    )
  ))
}
const pcmBuffer = Buffer.concat(pcmChunks)

// Single format -> { format, data, extension, mimeType }
const wav = AudioGen.encode(pcmBuffer, 'wav', { sampleRate: 48000, channels: 2 })
fs.writeFileSync(`song.${wav.extension}`, wav.data)

// Several formats at once -> one result per format, in the requested order
const files = AudioGen.encode(pcmBuffer, ['wav', 'flac', 'm4a', 'opus'], {
  sampleRate: 48000,
  channels: 2
})
for (const f of files) fs.writeFileSync(`song.${f.extension}`, f.data)
```

#### Supported output formats

`pcm` and `wav` are dependency-free (pure JS). Everything else is encoded with
[`bare-ffmpeg`](https://www.npmjs.com/package/bare-ffmpeg) (the same FFmpeg build
vendored for `@qvac/decoder-audio`), so the matching encoder must be compiled
into that build.

| `format` | Container / codec | Extension | MIME | Notes |
|----------|-------------------|-----------|------|-------|
| `pcm` | raw interleaved Int16 | `pcm` | `audio/L16` | no container, dependency-free |
| `wav` | WAV / PCM s16le | `wav` | `audio/wav` | dependency-free (pure-JS header) |
| `flac` | FLAC | `flac` | `audio/flac` | lossless |
| `alac` | MP4 / ALAC | `m4a` | `audio/mp4` | Apple Lossless (shares the `.m4a` extension) |
| `aiff` | AIFF / PCM s16be | `aiff` | `audio/aiff` | uncompressed |
| `caf` | CAF / PCM s16le | `caf` | `audio/x-caf` | Apple Core Audio Format, uncompressed |
| `m4a` | MP4 / AAC | `m4a` | `audio/mp4` | AAC in an MP4/M4A container |
| `aac` | ADTS / AAC | `aac` | `audio/aac` | raw AAC stream |
| `opus` | Ogg / Opus | `opus` | `audio/opus` | resampled to 48 kHz (libopus requirement) |
| `ogg` | Ogg / Vorbis | `ogg` | `audio/ogg` | Vorbis |
| `ac3` | AC-3 | `ac3` | `audio/ac3` | Dolby Digital |
| `wma` | ASF / WMA v2 | `wma` | `audio/x-ms-wma` | Windows Media Audio |
| `mp2` | MPEG-1 Layer II | `mp2` | `audio/mpeg` | legacy MPEG audio |

> `mp3` is intentionally **not** listed: the vendored FFmpeg build ships no MP3
> encoder (`libmp3lame`). Unknown/unsupported formats throw.
>
> `AudioGen.encode(pcm, formats, opts)` returns `{ format, data, extension,
> mimeType }` for a single format, or an array of those (input order) for an
> array. `OUTPUT_FORMATS` exports the full allowed list.

See [`examples/generate-music.js`](examples/generate-music.js) for a full,
runnable end-to-end script (`npm run example`).

## Options

**Constructor** (`new AudioGen({ engine, files, config, logger })`):

`engine` is `acestep` by default. It is inferred as `minimax` when
`files.synthModel` is present.

`files` — model paths:

| Option | Meaning |
|--------|---------|
| `modelDir` | Folder holding the GGUFs (stages auto-classified by name). |
| `ditVariant` | Which DiT to load from `modelDir`: `turbo-q4` \| `turbo-q8` \| `sft`. |
| `textEncModel` / `lmModel` / `ditModel` / `vaeModel` | Explicit per-stage paths (override `modelDir`). |
| `lmModel` / `synthModel` | Explicit MiniMax-Music3 pair (override `modelDir`). |

`config` — runtime knobs:

| Option | Meaning |
|--------|---------|
| `useGPU` | Run on GPU (Metal / CUDA / Vulkan, including Android Mali); falls back to CPU. |
| `inferenceSteps` / `shift` | Advanced; leave unset to auto-tune per DiT. |
| `cfgScale` | Default MiniMax flow guidance scale; `0` uses the model default. |
| `nGpuLayers` | GPU layers to offload when `useGPU` is set (99 = all). |
| `threads` | CPU thread count (0 / unset = hardware default). |
| `backendsDir` | Advanced; override the prebuilds root scanned for dlopen'd ggml backend modules. Defaults to `<addon>/prebuilds` (correct for the shipped package). Needed on arm64, where the CPU backend is a set of per-microarch module `.so`s. |

`logger` — an optional object implementing `error`/`warn`/`info`/`debug`,
wrapped by a level-gated `QvacLogger`.

**`run(caption, opts)`** returns a `QvacResponse`.

| Option | Meaning |
|--------|---------|
| `lyrics` | Lyrics text; use `[Instrumental]` for no vocals. |
| `vocalLanguage` | Vocal language hint. |
| `bpm` | Tempo in beats per minute. |
| `keyscale` | Key and scale, such as `C minor`. |
| `timesignature` | Time signature, such as `4/4`. |
| `augmentCaptionWithMetadata` | Append BPM/tempo, time signature, and key guidance to the internal conditioning caption; defaults to `false`. |
| `duration` | Target length in seconds; omit to let the LM decide. |
| `maxFrames` | MiniMax semantic-frame cap; cannot be combined with `duration`. |
| `inferenceSteps` / `cfgScale` | Per-run MiniMax flow controls. |
| `seed` | RNG seed for reproducible generation. |
| `lmTemperature` / `lmTopP` / `lmTopK` / `lmCfgScale` | LM sampling controls. |
| `lmPhase1` | Allow the LM to infer missing metadata before generating semantic codes. |
| `dcwEnabled` / `dcwScaler` / `dcwHighScaler` | Haar DCW correction controls. |
| `audioCodes` | Frozen ACE-Step semantic codes as an `Int32Array`; skips the LM. |
| `referenceAudio` | Optional finite, normalized, interleaved stereo 48 kHz `Float32Array` used for timbre conditioning. |
| `sourceAudio` | Source PCM in the same format; required by cover tasks. |
| `taskType` | `text2music` (default), `cover-nofsq`, or reserved `cover`. |
| `audioCoverStrength` | Source-context strength from `0` to `1`; currently must be `1` for `cover-nofsq`. |
| `coverNoiseStrength` | Initial source/noise blend from `0` to `1`. |

## Models

### MiniMax-Music3

MiniMax-Music3 uses two GGUF files: `mm3-lm-<quant>.gguf` and
`mm3-synth-<quant>.gguf`. This package does not publish or download those
weights yet. Supply local converted files through `modelDir` or explicit
`lmModel` and `synthModel` paths. The model weights are governed by the
MiniMax-Music3 Community License.

### ACE-Step

Four stages. Three are fixed; only the DiT changes, so you pick it with
`ditVariant`.

| Stage | GGUF | Size | Notes |
|------|------|------|-------|
| text-enc | Qwen3-Embedding-0.6B-Q8_0 | 748 MB | fixed |
| LM | acestep-5Hz-lm-0.6B-Q8_0 | 677 MB | fixed |
| VAE | vae-BF16 | 322 MB | fixed |
| DiT | acestep-v15-turbo-Q4_K_M | 1.35 GB | `ditVariant: 'turbo-q4'` (fastest / smallest) |
| DiT | acestep-v15-turbo-Q8_0 | 2.37 GB | `ditVariant: 'turbo-q8'` (higher precision) |
| DiT | acestep-v15-sft-Q8_0 | 2.37 GB | `ditVariant: 'sft'` (50-step, non-turbo) |

Downloading the GGUFs is the caller's job (the qvac SDK's `resolveModelPath`, a
download script, etc.) — the addon only ever receives a local path. `models.js`
is the single source of truth for the registry paths and the `ditVariant` enum.

Install the optional registry client used by the downloader, then download a
selected model set into a directory owned by your application:

```bash
npm install @qvac/registry-client
npx qvac-audiogen-download-models --output ./models/audiogen --variant turbo-q4
```

`--output`/`-o` is required. `--variant`/`-v` accepts `turbo-q4`, `turbo-q8`,
`sft`, or `all`; it defaults to `turbo-q4`. Use `--help` to print the flags.
The command does not write into the installed package.

## Lifecycle

Call `load()` before `run()`. Overlapping `run()` calls are admitted in order;
each call returns its own `QvacResponse` after native admission, and the next
run waits until that response settles. A native busy rejection fails admission
with `QvacErrorAudioGen`.

`cancel()` cancels the active native job and rejects its response with
`ERR_CODES.CANCELLED`. `unload()` cancels and rejects active work, releases the
native instance, and permits a later `load()`. `destroy()` performs the same
cleanup but permanently closes that `AudioGen` instance. `AudioGen.encode()`
does not depend on loaded model state and converts collected PCM bytes to the
requested output format.

The package exports `QvacErrorAudioGen` and `ERR_CODES` for structured handling
of invalid input, lifecycle state, cancellation, admission, and native failures.

## Example environment variables

`examples/generate-music.js` accepts `AUDIOGEN_MODEL_DIR` (required),
`AUDIOGEN_DIT_VARIANT`, `AUDIOGEN_DIT`, `AUDIOGEN_CAPTION`,
`AUDIOGEN_LYRICS`, `AUDIOGEN_LANG`, `AUDIOGEN_BPM`, `AUDIOGEN_KEY`,
`AUDIOGEN_TSIG`, `AUDIOGEN_DUR`, `AUDIOGEN_SEED`, `AUDIOGEN_CODES`,
`AUDIOGEN_DCW`, `AUDIOGEN_DCW_LOW`, `AUDIOGEN_DCW_HIGH`,
`AUDIOGEN_FORMAT`, `AUDIOGEN_GPU`, and `AUDIOGEN_OUT`.

`AUDIOGEN_DIT_VARIANT` selects a named variant. `AUDIOGEN_DIT` is an explicit
DiT model path and takes precedence. The cover example additionally accepts
`AUDIOGEN_SOURCE_PCM` (required), `AUDIOGEN_REFERENCE_PCM`,
`AUDIOGEN_COVER_NOISE`, and the shared caption, lyrics, seed, GPU, output,
model-directory, and DiT-variant variables.

## Internals

`index.js` selects `AcestepModel` or `MinimaxModel`, then the native binding
dispatches to the corresponding `audiogen-cpp` engine.

- `addon/src/js-interface/binding.cpp` — `BARE_MODULE` exports.
- `addon/src/addon/AddonJs.hpp` — `createInstance` / `activate` / `runJob`.
- `addon/src/model-interface/acestep/` — `AcestepModel`, wrapping the engine.
- `addon/src/model-interface/minimax/` — desktop-only `MinimaxModel`.
- Built with `cmake-bare` + `cmake-vcpkg`; `vcpkg.json` depends on the
  `speech-cpp[audiogen]` port.

## Benchmarking

The package ships the Real-Time Factor benchmark it is measured with, so the
numbers can be reproduced on your own hardware:

```bash
npm run test:benchmark:rtf          # one (DiT variant, GPU) combination
npm run test:benchmark:rtf:matrix   # sweep several in one process
```

Both are configured through `QVAC_AUDIOGEN_GGML_BENCHMARK_*` environment
variables. `benchmarks/RTF-BENCHMARKS.md` documents the metrics, the determinism
guarantees and the full variable list.

### `@qvac/audiogen-ggml/test/benchmark-runner`

A subpath export of the shared measurement, used by the on-device harness so the
desktop and mobile lanes report comparable numbers:

```js
const {
  readBenchmarkSettings,
  runRtfBenchmark,
  emitCanonicalReport
} = require('@qvac/audiogen-ggml/test/benchmark-runner')

const settings = readBenchmarkSettings()
const { summary, backend } = await runRtfBenchmark(settings)
emitCanonicalReport(settings, summary, backend)
```

`runRtfBenchmark` throws if the measurement is unusable — a non-positive RTF, a
run that rendered no audio, implausible memory, or a mean RTF above
`QVAC_AUDIOGEN_GGML_BENCHMARK_RTF_UPPER_BOUND` — so a broken run can never be
reported as a passing one.

This subpath is test tooling, not part of the addon's stable API: it depends on
the runtime providing `bare-os` / `bare-fs`, and it may change without a major
version bump.

## License

Apache-2.0. ACE-Step model weights belong to ACE Studio and StepFun.
MiniMax-Music3 weights are governed by the MiniMax-Music3 Community License.
