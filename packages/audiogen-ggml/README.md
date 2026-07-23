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
(streamed in chunks), followed by a final stats event. The addon never
downloads anything: you give it **local file paths** to the model GGUFs and it
opens them. GPU (Metal / CUDA / Vulkan) is used when you ask for it, with a CPU
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

// modelDir is a local folder with the 4 GGUFs; ditVariant picks the DiT.
const gen = new AudioGen(
  { modelDir: '/path/to/acestep/models', ditVariant: 'turbo-q4', useGpu: true },
  (handle, event, data, error) => {
    if (error) throw new Error(error)
    if (data?.outputArray) {
      // data.outputArray: interleaved stereo Int16 @ data.sampleRate — a chunk
      // of audio. Collect these as they stream in.
    }
    // The final event carries stats (data.audioDurationMs, data.totalTimeMs).
  }
)

await gen.activate()                       // loads the 4 model stages
await gen.generate('lo-fi hip hop, mellow piano, rainy night', {
  lyrics: '[Instrumental]'                 // no vocals
})
await gen.destroy()
```

> `generate()` resolves as soon as the job is queued — the audio arrives later
> through the callback, and completion is signalled by the final stats event.
> Wait for that event before you use the audio or call `destroy()`;
> [`examples/generate-music.js`](examples/generate-music.js) shows the pattern.

### 2. A song with lyrics + rhythm

Pass `lyrics` for vocals, and steer the LM with musical hints — `bpm`,
`keyscale`, `timesignature`, `vocalLanguage` and target `duration`:

```js
await gen.generate('energetic cumbia, brass stabs, live percussion, party vibe', {
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

The callback gives you raw PCM chunks. Concatenate them and encode to WAV:

```js
const { AudioGen } = require('@qvac/audiogen-ggml')
const { data } = AudioGen.encode(pcmBuffer, 'wav', { sampleRate: 48000, channels: 2 })
require('fs').writeFileSync('song.wav', data)   // 'wav' | 'pcm'
```

See [`examples/generate-music.js`](examples/generate-music.js) for a full,
runnable end-to-end script (`npm run example`).

## Options

**Constructor** (`new AudioGen(options, outputCb)`):

| Option | Meaning |
|--------|---------|
| `modelDir` | Folder holding the GGUFs (stages auto-classified by name). |
| `ditVariant` | Which DiT to load from `modelDir`: `turbo-q4` \| `turbo-q8` \| `sft`. |
| `textEncModel` / `lmModel` / `ditModel` / `vaeModel` | Explicit per-stage paths (override `modelDir`). |
| `useGpu` | Run on GPU (Metal / CUDA / Vulkan); falls back to CPU. |
| `inferenceSteps` / `shift` | Advanced; leave unset to auto-tune per DiT. |
| `threads` | CPU thread count (0 / unset = hardware default). |

**`generate(caption, opts)`**: `lyrics`, `vocalLanguage`, `bpm`, `keyscale`,
`timesignature`, `duration`, `seed`.

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
