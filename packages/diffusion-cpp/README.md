# diffusion-cpp

Native C++ addon for image, video, and ESRGAN inference through
[qvac-ext-stable-diffusion.cpp](https://github.com/tetherto/qvac-ext-stable-diffusion.cpp),
built for the Bare Runtime.

The package exposes three JS entry points:

| API                    | Entry point                                 | Use case                                                                        |
| ---------------------- | ------------------------------------------- | ------------------------------------------------------------------------------- |
| `ImgStableDiffusion`   | `@qvac/diffusion-cpp`                       | Text-to-image, image-to-image, FLUX.2 reference fusion, optional ESRGAN upscale |
| `VideoStableDiffusion` | `@qvac/diffusion-cpp/video` or named export | Wan and LTX text-to-video / image-to-video                                      |
| `EsrganUpscaler`       | named export from `@qvac/diffusion-cpp`     | Standalone PNG/JPEG upscaling                                                   |

## Table of Contents

- [Supported Models](#supported-models)
- [Supported Platforms](#supported-platforms)
- [Building From Source](#building-from-source)
- [Downloading Models](#downloading-models)
- [Examples](#examples)
- [Image API](#image-api)
  - [Constructor Files](#constructor-files)
  - [Image Config](#image-config)
  - [Image Generation Parameters](#image-generation-parameters)
- [Image-to-Image and FLUX.2 Fusion](#image-to-image-and-flux2-fusion)
- [Video API](#video-api)
  - [Video Files](#video-files)
  - [Video Parameters](#video-parameters)
- [LTX-2 Text-to-Video With Audio](#ltx-2-text-to-video-with-audio)
- [ESRGAN Upscaler](#esrgan-upscaler)
- [Response Streams and Stats](#response-streams-and-stats)
- [Cancellation and Unload](#cancellation-and-unload)
- [Operational Notes](#operational-notes)
- [Credits](#credits)
  - [Test Images](#test-images)
- [License](#license)

## Supported Models

| Family                       | Mode                                   | Notes                                                                             |
| ---------------------------- | -------------------------------------- | --------------------------------------------------------------------------------- |
| SD1.x / SD2.x                | image                                  | All-in-one checkpoints through `files.model`                                      |
| SDXL                         | image                                  | All-in-one checkpoints or split encoders when required                            |
| SD3                          | image                                  | Supports split CLIP-L / CLIP-G / T5-XXL inputs                                    |
| FLUX.2 [klein]               | image, img2img, multi-reference fusion | Split diffusion + Qwen3 LLM + VAE                                                 |
| Wan 2.1                      | text-to-video, image-to-video          | Single diffusion expert; I2V requires CLIP vision                                 |
| Wan 2.2 TI2V-5B Turbo Q5_K_S | text-to-video                          | Community-distilled GGUF with Wan 2.2 VAE; use `scripts/download-model-wan2.2.sh` |
| LTX-2 / LTXAV                | text-to-video + audio                  | Gemma text encoder, video VAE, audio VAE, embedding connectors                    |
| ESRGAN                       | upscale                                | Standalone or post-generation image upscale                                       |

## Supported Platforms

| Platform | Architecture | Status | GPU backend    |
| -------- | ------------ | ------ | -------------- |
| macOS    | arm64, x64   | Tier 1 | Metal          |
| Linux    | arm64, x64   | Tier 1 | Vulkan         |
| Android  | arm64        | Tier 1 | Vulkan, OpenCL |
| iOS      | arm64        | Tier 1 | Metal          |
| Windows  | x64          | Tier 1 | Vulkan         |

Dependencies:

- `qvac-ext-stable-diffusion.cpp`
- `ggml`
- Bare Runtime >= 1.24.0
- CMake >= 3.25 and a C++20-capable compiler

## Building From Source

See [build.md](./build.md) for prerequisites, platform setup, cross-compilation,
and troubleshooting.

```bash
npm install -g bare bare-make
npm install
npm run build
```

CUDA builds can be generated explicitly:

```bash
npm run build:cuda
```

## Downloading Models

Download scripts populate `packages/diffusion-cpp/models/` with the files used
by the examples.

| Script                                | Model set                     |
| ------------------------------------- | ----------------------------- |
| `./scripts/download-model.sh`         | FLUX.2 [klein] 4B image model |
| `./scripts/download-model-sd2.sh`     | SD2.x example model           |
| `./scripts/download-model-sd3.sh`     | SD3 example files             |
| `./scripts/download-model-sdxl.sh`    | SDXL example files            |
| `./scripts/download-model-wan.sh`     | Wan 2.1 T2V 1.3B              |
| `./scripts/download-model-wan-14b.sh` | Wan larger T2V variant        |
| `./scripts/download-model-wan-i2v.sh` | Wan 2.1 I2V 14B + CLIP vision |
| `./scripts/download-model-ltx.sh`     | LTX-2.3 video + audio files   |

The FLUX.2 [klein] default image example uses:

| Role            | File                        |
| --------------- | --------------------------- |
| Diffusion model | `flux-2-klein-4b-Q8_0.gguf` |
| Text encoder    | `Qwen3-4B-Q4_K_M.gguf`      |
| VAE             | `flux2-vae.safetensors`     |

LTX-2.3 requires more companion files:

| Role                 | Default file                                              |
| -------------------- | --------------------------------------------------------- |
| Diffusion model      | `LTX-2.3-22B-distilled-1.1-Q5_K_M.gguf`                   |
| Text encoder         | `gemma-3-12b-it-UD-Q4_K_XL.gguf`                          |
| Video VAE            | `ltx-2.3-22b-distilled_video_vae.safetensors`             |
| Audio VAE            | `ltx-2.3-22b-distilled_audio_vae.safetensors`             |
| Embedding connectors | `ltx-2.3-22b-distilled_embeddings_connectors.safetensors` |

Downloads are resumable where supported by the script.

## Examples

| Command                                      | Description                                 |
| -------------------------------------------- | ------------------------------------------- |
| `npm run example`                            | Load/unload the default FLUX.2 model        |
| `npm run generate`                           | FLUX.2 text-to-image                        |
| `npm run generate:sd2`                       | SD2.x text-to-image                         |
| `npm run generate:sd3`                       | SD3 text-to-image                           |
| `npm run generate:sdxl`                      | SDXL text-to-image                          |
| `bare examples/generate-fusion.js`           | FLUX.2 multi-reference fusion               |
| `bare examples/img2img-flux2.js`             | FLUX.2 single-reference img2img             |
| `bare examples/img2img-sd3.js`               | SD3 SDEdit img2img                          |
| `bare examples/generate-video-wan.js`        | Wan 2.1 text-to-video                       |
| `bare examples/img2vid-wan.js`               | Wan 2.1 image-to-video                      |
| `npm run generate:video`                     | Wan text-to-video                           |
| `npm run generate:ltx`                       | LTX-2.3 text-to-video with audio            |
| `npm run generate:esrgan`                    | Image generation followed by ESRGAN upscale |
| `bare examples/standalone-esrgan-upscale.js` | Standalone ESRGAN upscale                   |

Outputs are written to `packages/diffusion-cpp/output/`.

## Image API

```js
const path = require('bare-path')
const ImgStableDiffusion = require('@qvac/diffusion-cpp')

const MODELS_DIR = path.resolve(__dirname, './models')

const model = new ImgStableDiffusion({
  files: {
    model: path.join(MODELS_DIR, 'flux-2-klein-4b-Q8_0.gguf'),
    llm: path.join(MODELS_DIR, 'Qwen3-4B-Q4_K_M.gguf'),
    vae: path.join(MODELS_DIR, 'flux2-vae.safetensors')
  },
  config: {
    threads: 4,
    device: 'gpu',
    diffusion_fa: true
  },
  opts: { stats: true },
  logger: console
})

await model.load()

const response = await model.run({
  prompt: 'a majestic red fox in a snowy forest, golden light, photorealistic',
  width: 512,
  height: 512,
  steps: 20,
  guidance: 3.5,
  seed: 42
})

const images = []
await response
  .onUpdate((data) => {
    if (data instanceof Uint8Array) images.push(data) // PNG bytes
  })
  .await()

require('bare-fs').writeFileSync('output.png', images[0])
await model.unload()
```

### Constructor Files

All file paths must be absolute.

| Key                             | Required | Description                                                                 |
| ------------------------------- | -------: | --------------------------------------------------------------------------- |
| `files.model`                   |      yes | Main model. All-in-one checkpoint for SD, diffusion model for split layouts |
| `files.clipL`                   |       no | CLIP-L text encoder for SD3 / split layouts                                 |
| `files.clipG`                   |       no | CLIP-G text encoder for SDXL / SD3                                          |
| `files.t5Xxl`                   |       no | T5-XXL text encoder for SD3 / FLUX.1                                        |
| `files.llm`                     |       no | Qwen3 LLM text encoder for FLUX.2 [klein]                                   |
| `files.vae`                     |       no | Separate VAE                                                                |
| `files.esrgan`                  |       no | ESRGAN model for post-generation upscale                                    |
| `files.highNoiseDiffusionModel` |       no | Wan 2.2 high-noise expert path; normally used by `VideoStableDiffusion`     |

Passing any separate text encoder (`llm`, `t5Xxl`, `clipL`, `clipG`) makes the
wrapper route `files.model` to stable-diffusion.cpp's `diffusion_model_path`.
All-in-one checkpoints are routed to `model_path`.

### Image Config

`config` is part of the constructor object. There is no second constructor
argument.

| Key                     | Type                                      | Default           | Description                                                               |
| ----------------------- | ----------------------------------------- | ----------------- | ------------------------------------------------------------------------- |
| `threads`               | number                                    | auto              | CPU threads for loading / CPU ops                                         |
| `device`                | `'gpu'                                    | 'cpu'`            | `'gpu'`                                                                   | Prefer GPU backends or force CPU |
| `main-gpu`              | number \| `'integrated'` \| `'dedicated'` | unset             | Pin the GPU selected by stable-diffusion.cpp                              |
| `type`                  | weight type                               | auto              | Override weight quantization                                              |
| `rng`                   | `'cpu'                                    | 'cuda'            | 'std_default'`                                                            | `'cuda'`                         | Context RNG; `cuda` means Philox and is not GPU-specific |
| `sampler_rng`           | RNG type                                  | auto              | Sampler RNG override                                                      |
| `clip_on_cpu`           | boolean                                   | `false`           | Force CLIP/text encoder to CPU                                            |
| `vae_on_cpu`            | boolean                                   | `false`           | Force VAE to CPU                                                          |
| `vae_decode_only`       | boolean                                   | `false`           | Load only VAE decoder weights; leave false for img2img/fusion/hires paths |
| `vae_tiling`            | boolean                                   | `false`           | Tile VAE decode to reduce peak VRAM                                       |
| `flash_attn`            | boolean                                   | `false`           | Enable flash attention globally                                           |
| `diffusion_fa`          | boolean                                   | `true`            | Enable diffusion-model flash attention; important for FLUX/LTX memory use |
| `mmap`                  | boolean                                   | backend default   | Memory-map weights when supported                                         |
| `offload_to_cpu`        | boolean                                   | backend default   | Keep weights on CPU/offload as supported by backend                       |
| `prediction`            | prediction type                           | auto              | Required for FLUX img2img/fusion routing; use `'flux2_flow'` for FLUX.2   |
| `flow_shift`            | number                                    | model default     | Flow-matching noise schedule shift                                        |
| `diffusion_conv_direct` | boolean                                   | `true`            | Use direct convolution in diffusion model                                 |
| `vae_conv_direct`       | boolean                                   | `true`            | Use direct convolution in VAE                                             |
| `backendsDir`           | string                                    | package prebuilds | Custom ggml backend directory                                             |
| `lora_apply_mode`       | string                                    | auto              | LoRA application mode                                                     |
| `upscaler_tile_size`    | number                                    | `128`             | ESRGAN tile size                                                          |

`main-gpu` is resolved against the addon's own ggml device enumeration and then
pinned through `sd_ctx_params_t.backend`. If an explicit request cannot be
satisfied (`'integrated'` with no integrated GPU, `'dedicated'` with no discrete
GPU, or an out-of-range index), the addon falls back to CPU instead of silently
choosing another GPU. Mobile targets reject `main-gpu` because they are
single-GPU devices.

### Image Generation Parameters

| Key                           | Type              | Description                                                         |
| ----------------------------- | ----------------- | ------------------------------------------------------------------- |
| `prompt`                      | string            | Required non-empty prompt                                           |
| `negative_prompt`             | string            | Negative prompt                                                     |
| `width`, `height`             | number            | Positive multiples of 8; FLUX img2img defaults omitted axes to 1024 |
| `steps`                       | number            | Diffusion step count                                                |
| `cfg_scale`                   | number            | Classifier-free guidance for SD/SDXL/SD3 and FLUX img2img examples  |
| `guidance`                    | number            | Distilled guidance for FLUX.2                                       |
| `sampling_method` / `sampler` | string            | Sampler name; omit for auto-selection                               |
| `scheduler`                   | string            | Scheduler name; omit for auto-selection                             |
| `seed`                        | number            | `-1` for random                                                     |
| `batch_count`                 | number            | Number of images                                                    |
| `lora`                        | string            | Absolute path to a LoRA adapter                                     |
| `upscale`                     | boolean \| object | Post-generation ESRGAN upscale; requires `files.esrgan`             |
| `vae_tiling`                  | boolean           | Per-job VAE tiling                                                  |
| `vae_tile_size`               | number \| string  | VAE tile size, e.g. `512` or `'512x512'`                            |
| `vae_tile_overlap`            | number            | Tile overlap fraction                                               |
| `cache_mode`                  | string            | Step-caching algorithm                                              |
| `cache_preset`                | string            | Cache preset: `slow`, `medium`, `fast`, `ultra`                     |
| `cache_threshold`             | number            | Cache reuse threshold                                               |
| `eta`                         | number            | DDIM/TCD stochasticity                                              |
| `clip_skip`                   | number            | Skip last N CLIP layers                                             |

Do not force `sampling_method: 'euler_a'` for FLUX.2 models. Leave the sampler
unset unless you know the model family requires an override.

## Image-to-Image and FLUX.2 Fusion

`init_image` accepts PNG/JPEG bytes and selects image-to-image mode.

- FLUX.2 uses in-context conditioning: the reference image is VAE-encoded into
  separate latent tokens and the target starts from pure noise.
- SD1.x / SD2.x / SDXL / SD3 use SDEdit: the input is noised according to
  `strength` and denoised with the prompt.

For FLUX.2 img2img, load the context with `files.llm` and
`config.prediction: 'flux2_flow'`.

```js
const inputImage = require('bare-fs').readFileSync('assets/source.jpg')

const response = await model.run({
  prompt: 'a cinematic portrait of the same person, professional lighting',
  init_image: inputImage,
  width: 1024,
  height: 1024,
  cfg_scale: 1.0,
  guidance: 3.5,
  steps: 20,
  seed: 42
})
```

FLUX.2 multi-reference fusion uses `init_images`, an array of PNG/JPEG buffers.
It is mutually exclusive with `init_image` and requires
`config.prediction: 'flux2_flow'`.

```js
const response = await model.run({
  prompt: 'blend @image1 and @image2 into one scientist in a black studio',
  init_images: [image1Bytes, image2Bytes],
  width: 624,
  height: 624,
  cfg_scale: 1.0,
  guidance: 3.5,
  steps: 10,
  seed: 10
})
```

`@image1`, `@image2`, etc. are prose anchors for the text encoder. The FLUX.2
Qwen3 text encoder does not receive vision tokens; visual fusion happens in the
DiT through attention over reference latents. Keep `increase_ref_index` unset or
`false` for FLUX.2-klein fusion.

## Video API

```js
const path = require('bare-path')
const fs = require('bare-fs')
const VideoStableDiffusion = require('@qvac/diffusion-cpp/video')

const MODELS_DIR = path.resolve(__dirname, './models')

const model = new VideoStableDiffusion({
  files: {
    model: path.join(MODELS_DIR, 'wan2.1_t2v_1.3B_fp16.safetensors'),
    t5Xxl: path.join(MODELS_DIR, 'umt5_xxl_fp16.safetensors'),
    vae: path.join(MODELS_DIR, 'wan_2.1_vae.safetensors')
  },
  config: {
    threads: 4,
    device: 'gpu',
    diffusion_fa: true,
    offload_to_cpu: true,
    vae_tiling: true
  },
  logger: console
})

await model.load()

const response = await model.run({
  mode: 'txt2vid',
  prompt: 'a colorful bird flapping its wings',
  negative_prompt: 'blurry, low quality, static, jittery, watermark',
  width: 480,
  height: 832,
  video_frames: 81,
  fps: 16,
  steps: 30,
  cfg_scale: 6.0,
  flow_shift: 3.0,
  seed: 42
})

let avi = null
await response
  .onUpdate((data) => {
    if (data instanceof Uint8Array) avi = data // MJPG AVI bytes
  })
  .await()

fs.writeFileSync('wan_t2v_seed42.avi', avi)
await model.unload()
```

The default export from `@qvac/diffusion-cpp/video` and the named
`VideoStableDiffusion` export from `@qvac/diffusion-cpp` are the same class.

### Video Files

| Key                             | Model family | Description                                                     |
| ------------------------------- | ------------ | --------------------------------------------------------------- |
| `files.model`                   | all video    | Wan single/low-noise expert or LTX diffusion transformer        |
| `files.t5Xxl`                   | Wan          | UMT5-XXL text encoder                                           |
| `files.vae`                     | Wan / LTX    | Wan VAE or LTX video VAE                                        |
| `files.clipVision`              | Wan I2V      | OpenCLIP ViT-H/14; required for `mode: 'img2vid'` on Wan        |
| `files.llm`                     | LTX          | Gemma text encoder                                              |
| `files.audioVae`                | LTX          | Audio VAE decoder for synchronized audio                        |
| `files.embeddingsConnectors`    | LTX          | Text-embedding connector weights; also marks the context as LTX |

### Video Parameters

| Key                                                          | Description                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `mode`                                                       | Required: `'txt2vid'` or `'img2vid'`                               |
| `prompt`, `negative_prompt`                                  | Text conditioning                                                  |
| `width`, `height`                                            | Wan: multiples of 16. LTX: multiples of 32                         |
| `video_frames`                                               | Wan: `(4*k + 1)`. LTX: `(8*k + 1)`, max 257                        |
| `fps`                                                        | AVI framerate metadata, default 16 for Wan examples and 24 for LTX |
| `steps`, `cfg_scale`, `sampling_method`, `scheduler`, `seed` | Sampling controls                                                  |
| `flow_shift`                                                 | Per-job flow-shift override; Wan 2.1 T2V 1.3B works well at `3.0`  |
| `init_image`                                                 | First frame for `img2vid`; required by that mode                   |
| `control_frames`, `vace_strength`                            | Optional VACE guidance                                             |
| `temporal_tiling`                                            | LTX-only temporal VAE tiling to reduce peak VRAM                   |
| `cache_mode`, `cache_preset`, `cache_threshold`              | Step-cache controls                                                |

Video output is a single MJPG AVI `Uint8Array`. For LTX-2 models loaded with
`audioVae`, the AVI also contains a second IEEE-float PCM stream at 48 kHz.
VLC handles these files well.

### Wan 2.2

The supported Wan 2.2 workflow is the community-distilled TI2V-5B Turbo
Q5_K_S GGUF for text-to-video. The downloader does not include the CLIP vision
encoder required by the wrapper's image-to-video path. Download its complete
text-to-video model layout before running the example:

```sh
# TI2V-5B Turbo Q5_K_S (4 steps, CFG 1)
./scripts/download-model-wan2.2.sh
npm run generate:wan22
```

The download is approximately 16.4 GB: 3.56 GB for the Q5_K_S diffusion model,
11.4 GB for the fp16 UMT5-XXL encoder, and 1.41 GB for the Wan 2.2 VAE. The
backend runs one process on one device with optional CPU offload. Use dimensions
that are multiples of 32 for this TI2V model so the emitted AVI dimensions match
the requested dimensions.

## LTX-2 Text-to-Video With Audio

```js
const model = new VideoStableDiffusion({
  files: {
    model: path.join(MODELS_DIR, 'LTX-2.3-22B-distilled-1.1-Q5_K_M.gguf'),
    llm: path.join(MODELS_DIR, 'gemma-3-12b-it-UD-Q4_K_XL.gguf'),
    vae: path.join(MODELS_DIR, 'ltx-2.3-22b-distilled_video_vae.safetensors'),
    audioVae: path.join(MODELS_DIR, 'ltx-2.3-22b-distilled_audio_vae.safetensors'),
    embeddingsConnectors: path.join(
      MODELS_DIR,
      'ltx-2.3-22b-distilled_embeddings_connectors.safetensors'
    )
  },
  config: {
    threads: 4,
    device: 'gpu',
    diffusion_fa: true,
    vae_tiling: true,
    vae_conv_direct: true
  },
  opts: { stats: true },
  logger: console
})

const response = await model.run({
  mode: 'txt2vid',
  prompt: 'a claymation cat playing jazz on a piano',
  negative_prompt: 'blurry, low quality, static, jittery, watermark, distorted audio',
  width: 512,
  height: 320,
  video_frames: 241,
  fps: 24,
  steps: 10,
  cfg_scale: 1.0,
  temporal_tiling: true,
  seed: 42
})
```

LTX distilled variants are designed for low step counts and low CFG values.
For full dev weights, use higher steps and a larger CFG.

## ESRGAN Upscaler

```js
const { EsrganUpscaler } = require('@qvac/diffusion-cpp')
const fs = require('bare-fs')

const upscaler = new EsrganUpscaler({
  files: {
    esrgan: '/absolute/path/to/RealESRGAN_x4plus_anime_6B.pth'
  },
  config: {
    device: 'gpu',
    upscaler_tile_size: 128
  },
  logger: console
})

await upscaler.load()

const response = await upscaler.upscale(fs.readFileSync('input.png'), {
  repeats: 1
})

const images = []
await response
  .onUpdate((data) => {
    if (data instanceof Uint8Array) images.push(data)
  })
  .await()

fs.writeFileSync('upscaled.png', images[0])
await upscaler.unload()
```

`repeats` controls how many ESRGAN passes are applied. One pass typically scales
by 4x; two passes scale by 16x.

## Response Streams and Stats

All three wrappers return a `QvacResponse`.

- Progress updates are JSON strings like `{"step":1,"total":20,"elapsed_ms":...}`.
- Image generation and ESRGAN emit PNG `Uint8Array` values.
- Video generation emits one MJPG AVI `Uint8Array`.
- If `opts.stats` is enabled, a `stats` event is emitted before completion.

Image stats include load time, generation time, cumulative steps/images/pixels,
dimensions, and seed. Video stats additionally include cumulative videos,
frames, `fps`, `hasAudio`, and `audioSampleRate`. ESRGAN stats include upscale
timing, output dimensions, repeats, and the backend device actually used.

## Cancellation and Unload

Each wrapper has `cancel()` and `unload()` methods. Only one job may run per
model instance at a time; overlapping `run()` calls fail with a busy error.

```js
const response = await model.run({ prompt: '...', steps: 30 })
await model.cancel()
await response.await().catch(() => {})
await model.unload()
```

During ESRGAN upscale, cancellation is honored between repeat passes.

## Operational Notes

- Native C++ logs are process-global. Configure them once with
  `require('@qvac/diffusion-cpp/addonLogging').setLogger(...)`.
- Leave sampler and scheduler unset for normal use; the addon preserves
  stable-diffusion.cpp auto-detection for model-specific defaults.
- `diffusion_fa` defaults to true and is important for FLUX/LTX memory use.
- For FLUX.2 img2img/fusion, set `config.prediction: 'flux2_flow'` so the JS
  wrapper and native layer select the in-context conditioning path.
- Wan I2V requires `files.clipVision`; LTX img2vid does not.
- Wan dimensions must be multiples of 16; LTX dimensions must be multiples of 32.
- Wan frame counts use `(4*k + 1)`; LTX frame counts use `(8*k + 1)`.
- LTX audio is muxed into AVI as IEEE-float PCM at 48 kHz.

## Credits

### Test Images

`assets/von-neumann.jpg` — **John von Neumann** (1956).
Source: U.S. Department of Energy, File ID: HD.3F.191.
This image is in the **Public Domain** as a work of the U.S. Federal Government.

`assets/claude-shannon.jpg` — **Claude Shannon**.
Source: Bell Labs / [Wikimedia Commons](https://commons.wikimedia.org/wiki/Category:Claude_Shannon).
Licensed under **Creative Commons Attribution-ShareAlike (CC BY-SA)**.
Attribution must be preserved; any redistribution of this image or a derivative
must be released under a compatible CC BY-SA license.

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
