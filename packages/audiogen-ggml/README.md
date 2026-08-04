# @qvac/audiogen-ggml

Generate **music from a text description** — fully native, on CPU or GPU. You
give it a prompt like _"lo-fi hip hop, mellow piano, rainy night"_ (optionally
with lyrics to sing and musical hints like BPM or key), and it returns stereo
48 kHz audio. It's the ggml-backed qvac addon around the
[ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5) model, same shape as
`@qvac/tts-ggml`.

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
opens them. GPU (Metal / Vulkan) is used when you ask for it, with a CPU
fallback.

## Install & build

```bash
npm install
npm run build      # bare-make generate && build && install
```

You also need the model GGUFs on disk (see [Models](#models)); point the addon
at the folder that holds them.

## Usage

### 1. Simplest case — an instrumental

```js
const { AudioGen } = require('@qvac/audiogen-ggml')

// files.modelDir is a local folder with the 4 GGUFs; files.ditVariant picks the DiT.
const gen = new AudioGen({
  files: { modelDir: '/path/to/acestep/models', ditVariant: 'turbo-q4' },
  config: { useGPU: true }
})

await gen.load() // loads the 4 model stages

// run() returns a @qvac/infer-base QvacResponse: iterate() streams progress
// ticks + the interleaved-Int16 PCM chunk(s); await() resolves the run stats.
const response = await gen.run('lo-fi hip hop, mellow piano, rainy night', {
  lyrics: '[Instrumental]' // no vocals
})
for await (const item of response.iterate()) {
  if (item.outputArray) {
    // item.outputArray: interleaved stereo Int16 @ item.sampleRate — collect
    // these chunks as they stream in.
  }
}
const stats = await response.await()
// { audioDurationMs, totalTimeMs, realTimeFactor, backendDevice, backendId }
// backendDevice: 0 = CPU, 1 = GPU
// backendId:     0 = CPU, 1 = Metal, 2 = CUDA, 3 = Vulkan, 4 = OpenCL, 99 = other

await gen.destroy()
```

> The audio arrives as PCM chunks over the `QvacResponse` stream; `await()`
> resolves with the run stats once generation completes. `backendDevice` /
> `backendId` report the backend the engine *resolved to*, not the one requested,
> so a `useGPU: true` run that fell back to the CPU is detectable.
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

### Turning PCM into a file

The run streams raw PCM chunks. Concatenate them and encode to a file. The
addon receives the format(s) **by parameter**: pass one format for a single
file, or an array to produce several at once (one file per format):

```js
const { AudioGen } = require('@qvac/audiogen-ggml')
const fs = require('fs')

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

**Constructor** (`new AudioGen({ files, config, logger })`):

`files` — model paths:

| Option | Meaning |
|--------|---------|
| `modelDir` | Folder holding the GGUFs (stages auto-classified by name). |
| `ditVariant` | Which DiT to load from `modelDir`: `turbo-q4` \| `turbo-q8` \| `sft`. |
| `textEncModel` / `lmModel` / `ditModel` / `vaeModel` | Explicit per-stage paths (override `modelDir`). |

`config` — runtime knobs:

| Option | Meaning |
|--------|---------|
| `useGPU` | Run on GPU (Metal / Vulkan); falls back to CPU. |
| `inferenceSteps` / `shift` | Advanced; leave unset to auto-tune per DiT. |
| `nGpuLayers` | GPU layers to offload when `useGPU` is set (99 = all). |
| `threads` | CPU thread count (0 / unset = hardware default). |
| `backendsDir` | Advanced; override the prebuilds root scanned for dlopen'd ggml backend modules. Defaults to `<addon>/prebuilds` (correct for the shipped package). Needed on arm64, where the CPU backend is a set of per-microarch module `.so`s. |

`logger` — an optional object implementing `error`/`warn`/`info`/`debug`,
wrapped by a level-gated `QvacLogger`.

**`run(caption, opts)`** returns a `QvacResponse`; `opts`: `lyrics`,
`vocalLanguage`, `bpm`, `keyscale`, `timesignature`, `duration`, `seed`.

## Models

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

## Internals

```
index.js ─► binding (BARE_MODULE) ─► AcestepModel ─► tts_cpp::acestep::Engine
                                                          │
                          text-enc ─► LM ─► DiT ─► VAE   (ggml graphs)
```

- `addon/src/js-interface/binding.cpp` — `BARE_MODULE` exports.
- `addon/src/addon/AddonJs.hpp` — `createInstance` / `activate` / `runJob`.
- `addon/src/model-interface/acestep/` — `AcestepModel`, wrapping the engine.
- Built with `cmake-bare` + `cmake-vcpkg`; `vcpkg.json` depends on `audiogen-cpp`
  (the C++ engine, on our ggml-speech fork). No prebuilt binaries — the C++ is
  compiled for every supported platform.

## License

Apache-2.0. Model weights belong to ACE Studio and StepFun.
