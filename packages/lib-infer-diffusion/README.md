# qvac-lib-infer-stable-diffusion-cpp

Native C++ addon for text-to-image generation using [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp), built for the Bare Runtime. Supports **Stable Diffusion 1.x / 2.x / XL / 3** and **FLUX.2 [klein]**.

## Table of Contents

- [Supported platforms](#supported-platforms)
- [Building from Source](#building-from-source)
- [Downloading Model Files](#downloading-model-files)
- [Running the Example](#running-the-example)
- [Other Examples](#other-examples)
- [Usage](#usage)
  - [1. Import the Model Class](#1-import-the-model-class)
  - [2. Create the `args` object](#2-create-the-args-object)
  - [3. Create the `config` object](#3-create-the-config-object)
  - [4. Create a Model Instance](#4-create-a-model-instance)
  - [5. Load the Model](#5-load-the-model)
  - [6. Run Inference](#6-run-inference)
  - [7. Release Resources](#7-release-resources)
- [Model File Reference](#model-file-reference)
- [FLUX.2 Implementation Notes](#flux2-implementation-notes)
- [Credits](#credits)
- [License](#license)

---

## Supported platforms

| Platform | Architecture | Status | GPU Backend |
|----------|-------------|--------|-------------|
| macOS | arm64 | ✅ Tier 1 | Metal |
| macOS | x64 | ✅ Tier 1 | Metal |
| Linux | arm64, x64 | ✅ Tier 1 | Vulkan |
| Android | arm64 | ✅ Tier 1 | Vulkan, OpenCL |
| iOS | arm64 | ✅ Tier 1 | Metal |
| Windows | x64 | ✅ Tier 1 | Vulkan |

**Dependencies:**
- `stable-diffusion.cpp` (bundled via vcpkg overlay port)
- `ggml` (bundled alongside stable-diffusion.cpp)
- Bare Runtime ≥ 1.24.0
- CMake ≥ 3.25 and a C++20-capable compiler

---

## Building from Source

See [build.md](./build.md) for prerequisites, platform-specific setup, cross-compilation, and troubleshooting.

Quick start:

```bash
npm install -g bare bare-make
npm install
npm run build
```

---

## Downloading Model Files

A download script is provided that fetches all required files for **FLUX.2 [klein] 4B**:

```bash
./scripts/download-model.sh
```

This downloads three files into the `models/` directory:

| File | Size | Description |
|------|------|-------------|
| `flux-2-klein-4b-Q8_0.gguf` | ~4.0 GB | FLUX.2 [klein] 4B diffusion model (Q8_0 quantised) |
| `Qwen3-4B-Q4_K_M.gguf` | ~2.5 GB | Qwen3 4B text encoder (Q4_K_M quantised) |
| `flux2-vae.safetensors` | ~321 MB | VAE decoder |

> **Note:** Downloads can be resumed if interrupted — the script uses `curl -C -` for resumable transfers.

### Why these specific files?

FLUX.2 [klein] uses a split model layout. Three separate components are required:

- **Diffusion model** (`flux-2-klein-4b-Q8_0.gguf`) — the main image transformer. This GGUF has no SD metadata KV pairs so it must be loaded via `diffusion_model_path` internally, not `model_path`.
- **Text encoder** (`Qwen3-4B-Q4_K_M.gguf`) — Qwen3 4B in standard GGML Q4_K_M format.
- **VAE** (`flux2-vae.safetensors`) — standard safetensors format, compatible as-is.

### Disk and RAM requirements

| Component | Disk | RAM at runtime |
|-----------|------|----------------|
| Diffusion model (Q8_0) | 4.0 GB | ~4.1 GB |
| Text encoder (Q4_K_M) | 2.5 GB | ~4.3 GB |
| VAE | 321 MB | ~95 MB |
| **Total** | **~6.8 GB** | **~8.5 GB** |

A machine with **16 GB of unified memory** (e.g. MacBook Air M-series) can run this model.

---

## Running the Example

Two runnable examples are provided.

### Load / unload only

Verifies the model loads and releases cleanly without running inference:

```bash
npm run example
```

Expected output:

```
FLUX.2 [klein] 4B — load/unload example
========================================
Model loaded in 12.0s
Model is ready. (No inference in this example.)
Done — all resources released.
```

Source: [`examples/load-model.js`](./examples/load-model.js)

### Text-to-image generation

Generates a 512 × 512 PNG with a 20-step FLUX.2 run, saves it to `output/`:

```bash
npm run generate
```

Expected output:

```
FLUX.2 [klein] 4B — text-to-image inference
============================================
Loaded in 15.2s

Starting generation...
  [████████████████████] 20/20 steps

Generated in 610.0s
Got 1 image(s)
Saved → .../output/output_seed42_0.png
```

Source: [`examples/generate-image.js`](./examples/generate-image.js)

> **Performance note:** On an M1 MacBook Air (16 GB) with Metal enabled, loading takes ~15 s and 20 steps at 512 × 512 take ~10 minutes. Reduce `STEPS` to 4 for quick tests — FLUX.2's distilled model is designed for low step counts.

## Other Examples

-   [Quickstart](./examples/quickstart.js) – Minimal text-to-image generation with SD2.1.
-   [Generate Image (SD2.1)](./examples/generate-image-sd2.js) – Text-to-image with an SD2.1 all-in-one GGUF model.
-   [Generate Image (SD3)](./examples/generate-image-sd3.js) – Text-to-image with SD3 Medium (safetensors, diffusion + CLIP encoders).
-   [Generate Image (SDXL)](./examples/generate-image-sdxl.js) – Text-to-image with an SDXL base all-in-one GGUF model.
-   [Runtime Stats](./examples/runtime-stats-sd2.js) – Run SD2.1 inference and report runtime statistics.
-   [img2img FLUX2](./examples/img2img-flux2.js) – Transform an image with FLUX2-klein (Q8_0, in-context conditioning).
-   [img2img FLUX2 F16](./examples/img2img-flux2-f16.js) – Transform an image with FLUX2-klein (F16 full precision).
-   [img2img SD3](./examples/img2img-sd3.js) – Transform an image with SD3 Medium (SDEdit, flow-matching).

---

## Usage

### 1. Import the Model Class

```js
const ImgStableDiffusion = require('@qvac/diffusion-cpp')
```

### 2. Create the `args` object

```js
const path = require('bare-path')

const MODELS_DIR = path.resolve(__dirname, './models')
const args = {
  logger: console,
  diskPath: MODELS_DIR,
  modelName:  'flux-2-klein-4b-Q8_0.gguf',
  llmModel:   'Qwen3-4B-Q4_K_M.gguf',   // Qwen3 text encoder for FLUX.2 [klein]
  vaeModel:   'flux2-vae.safetensors'
}
```

| Property | Required | Description |
|----------|----------|-------------|
| `diskPath` | ✅ | Local directory where model files are already stored |
| `modelName` | ✅ | Diffusion model file name (all-in-one for SD1.x/2.x; diffusion-only GGUF for FLUX.2) |
| `logger` | — | Logger instance (e.g. `console`) |
| `clipLModel` | — | Separate CLIP-L text encoder (SD3) |
| `clipGModel` | — | Separate CLIP-G text encoder (SDXL / SD3) |
| `t5XxlModel` | — | Separate T5-XXL text encoder (SD3) |
| `llmModel` | — | Qwen3 LLM text encoder (FLUX.2 [klein]) |
| `vaeModel` | — | Separate VAE file |

### 3. Create the `config` object

```js
const config = {
  threads: 8  // CPU threads for tensor operations (Metal handles GPU automatically)
}
```

Config values are coerced to strings internally. Generation parameters (prompt, steps, seed, etc.) are JSON-serialized with their native types preserved.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `threads` | number | auto | Number of CPU threads for model loading and CPU ops |
| `type` | `'f32'` \| `'f16'` \| `'q4_0'` \| `'q8_0'` \| … | auto | Override weight quantisation type |
| `rng` | `'cpu'` \| `'cuda'` \| `'std_default'` | `'cuda'` | RNG backend (`'cuda'` = philox RNG — not GPU-specific despite the name; recommended) |
| `clip_on_cpu` | `true` \| `false` | `false` | Force CLIP encoder to run on CPU |
| `vae_on_cpu` | `true` \| `false` | `false` | Force VAE to run on CPU |
| `flash_attn` | `true` \| `false` | `false` | Enable flash attention (reduces memory) |

### 4. Create a Model Instance

```js
const model = new ImgStableDiffusion(args, config)
```

The constructor stores configuration only — no memory is allocated yet.

### 5. Load the Model

```js
await model.load()
```

This creates the native `sd_ctx_t` and loads all weights into memory. It can take 10–30 seconds depending on disk speed and model size. All model files must already be present on disk at `diskPath`.

### 6. Run Inference

#### Text-to-image (`model.run`)

The primary API. Returns a `QvacResponse` that streams step-progress ticks and the final PNG:

```js
const images = []

const response = await model.run({
  prompt: 'a majestic red fox in a snowy forest, golden light, photorealistic',
  steps: 20,
  width: 512,
  height: 512,
  guidance: 3.5,   // distilled guidance scale — FLUX.2 specific
  seed: 42
})

await response
  .onUpdate(data => {
    if (data instanceof Uint8Array) {
      images.push(data)  // PNG-encoded output image
    } else if (typeof data === 'string') {
      try {
        const tick = JSON.parse(data)
        if ('step' in tick) process.stdout.write(`\rStep ${tick.step}/${tick.total}`)
      } catch (_) {}
    }
  })
  .await()

require('bare-fs').writeFileSync('output.png', images[0])
```

**Generation parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | string | — | Text prompt |
| `negative_prompt` | string | `''` | Things to avoid in the output |
| `width` | number | `512` | Output width in pixels (multiple of 8) |
| `height` | number | `512` | Output height in pixels (multiple of 8) |
| `steps` | number | `20` | Number of diffusion steps |
| `guidance` | number | `3.5` | Distilled guidance scale (FLUX.2) |
| `cfg_scale` | number | `7.0` | Classifier-free guidance scale (SD1.x / SD2.x) |
| `sampling_method` | string | auto | Sampler name; auto-selects `euler` for FLUX.2, `euler_a` for SD1.x |
| `scheduler` | string | auto | Scheduler; auto-selected per model family |
| `seed` | number | `-1` | Random seed (-1 for random) |
| `batch_count` | number | `1` | Number of images to generate |
| `vae_tiling` | boolean | `false` | Enable VAE tiling (required for large images on 16 GB) |
| `cache_preset` | string | — | Step-caching preset: `slow`, `medium`, `fast`, `ultra` |

> **Sampler note:** Do not set `sampling_method: 'euler_a'` for FLUX.2 models — it will produce random noise. Leave the field unset to let the library auto-select `euler` for flow-matching models.

#### Image-to-image (`init_image`)

Pass `init_image` (a `Uint8Array` of PNG or JPEG bytes) to transform an existing image with a text prompt. Width and height are auto-detected from the image header and rounded to the nearest multiple of 8.

The addon automatically selects the correct img2img strategy based on the model's prediction type:

| Model family | Prediction type | Strategy | How it works |
|-------------|----------------|----------|-------------|
| FLUX.2 | `flux2_flow` / `flux_flow` | In-context conditioning (`ref_images`) | Input image is VAE-encoded into separate latent tokens; the transformer attends to them via joint attention with distinct RoPE positions. The target starts from pure noise, so the model preserves features while generating a fully new image. |
| SD1.x / SD2.x / SDXL / SD3 | All others | SDEdit (`init_image`) | Input image is noised according to `strength` (0.0–1.0), then denoised with the text prompt. Lower strength preserves more of the original; higher strength allows more creative freedom. |

**FLUX.2 example (in-context conditioning):**

```js
const fs = require('bare-fs')

const inputImage = fs.readFileSync('assets/von-neumann.jpg')

const response = await model.run({
  prompt: 'a modern tech CEO version of this person, professional headshot',
  init_image: inputImage,
  cfg_scale: 1.0,
  steps: 20,
  guidance: 9.0,
  seed: 42
})
```

**SD3 example (SDEdit):**

```js
const inputImage = fs.readFileSync('headshot.jpeg')

const response = await model.run({
  prompt: 'anime portrait, same pose, studio ghibli style, soft cel shading',
  negative_prompt: 'photorealistic, blurry, low quality',
  init_image: inputImage,
  cfg_scale: 4.5,
  steps: 30,
  strength: 0.75,
  sampling_method: 'euler',
  seed: 42
})
```

> **SDEdit img2img limitations:**
>
> - **Black-and-white input images** produce weaker results because the model must hallucinate all color information. Consider colorizing the image before feeding it in.
> - **Low-resolution images** (below ~512×512) give the model less detail to preserve identity. Upscaling beforehand helps.
> - **High `strength` values** (≥ 0.7) allow the model to deviate significantly from the input, including changing facial features, gender, or ethnicity. Use `strength` 0.35–0.55 for identity-preserving edits.
> - **Style prompts** like "anime" or "studio ghibli" carry training-data biases that can alter the subject's appearance. Anchor the prompt with terms like "same person, same face" and use the negative prompt to block unwanted changes.
> - **Non-multiple-of-8 images** are automatically aligned (nearest-neighbor resize to the next multiple of 8) before processing. For best quality, provide images with dimensions that are already multiples of 8.

The bundled test image (`assets/von-neumann.jpg`) is a 1956 portrait of John von Neumann sourced from the U.S. Department of Energy (Public Domain). See the [Credits](#credits) section for details.

### 7. Release Resources

```js
await model.unload()
```

`unload()` calls `free_sd_ctx` which releases all GPU and CPU memory. The JS object can be safely garbage collected afterwards.

---

## Model File Reference

### FLUX.2 [klein] 4B (recommended for 16 GB machines)

| Role | File | Source |
|------|------|--------|
| Diffusion model | `flux-2-klein-4b-Q8_0.gguf` | [leejet/FLUX.2-klein-4B-GGUF](https://huggingface.co/leejet/FLUX.2-klein-4B-GGUF) |
| Text encoder | `Qwen3-4B-Q4_K_M.gguf` | [unsloth/Qwen3-4B-GGUF](https://huggingface.co/unsloth/Qwen3-4B-GGUF) |
| VAE | `flux2-vae.safetensors` | [black-forest-labs/FLUX.2-klein-4B](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B) |

### Stable Diffusion 1.x / 2.x

Pass an all-in-one checkpoint directly as `modelName`. No separate encoders needed.

---

## FLUX.2 Implementation Notes

This section documents non-obvious issues encountered integrating FLUX.2 [klein] into the addon and how each was resolved. These serve as a reference if the underlying `stable-diffusion.cpp` version is upgraded.

### 1. Metal GPU backend not activated (macOS)

**Symptom:** Generation ran entirely on CPU at 700%+ CPU usage; 20 steps at 512 × 512 never completed.

**Root cause:** The vcpkg overlay port passed `-DGGML_METAL=ON` to CMake, which compiled the ggml Metal library (`libggml-metal.a`). However, `stable-diffusion.cpp` internally guards `ggml_backend_metal_init()` behind its own `SD_USE_METAL` preprocessor define, which is only set when `-DSD_METAL=ON` is passed — a separate flag from `GGML_METAL`.

**Fix:** Changed the portfile (`vcpkg/ports/stable-diffusion-cpp/portfile.cmake`) from:

```cmake
-DGGML_METAL=${SD_GGML_METAL}
```

to:

```cmake
-DSD_METAL=${SD_GGML_METAL}
```

`-DSD_METAL=ON` causes `stable-diffusion.cpp`'s own `CMakeLists.txt` to set `GGML_METAL=ON` *and* emit `-DSD_USE_METAL`, which activates `ggml_backend_metal_init()` at runtime.

**Verification:** After the fix, CPU usage dropped from ~700% to ~0.5% during generation, confirming the GPU is handling the compute.

---

### 2. Noise output instead of image — wrong prediction type default

**Symptom:** Generation completed all 20 steps and produced a PNG, but the image was pure coloured noise (TV static).

**Root cause:** `SdCtxConfig::prediction` defaulted to `EPS_PRED` (the classic SD1.x epsilon-prediction denoiser). When `SdModel::load()` passed this to `sd_ctx_params_t.prediction`, it overrode `stable-diffusion.cpp`'s auto-detection, forcing the wrong denoiser on a FLUX.2 flow-matching model. The correct sentinel value for auto-detection is `PREDICTION_COUNT`.

**Fix:** Changed the default in `addon/src/handlers/SdCtxHandlers.hpp`:

```cpp
// Before
prediction_t prediction = EPS_PRED;

// After
prediction_t prediction = PREDICTION_COUNT;  // auto-detect from GGUF metadata
```

---

### 3. Noise output — wrong flow_shift default

**Symptom:** Same noise output as above (compounded with fix 2).

**Root cause:** `SdCtxConfig::flowShift` defaulted to `0.0f`. For FLUX.2, `stable-diffusion.cpp` expects `INFINITY` as the sentinel meaning "use the model's embedded flow-shift value". A value of `0.0f` disabled flow-shifting entirely, breaking the entire noise schedule.

**Fix:**

```cpp
// Before
float flowShift = 0.0f;

// After
float flowShift = std::numeric_limits<float>::infinity();  // use model's embedded value
```

---

### 4. Wrong sampler default bypassing auto-detection

**Symptom:** Even with fixes 1–3, the wrong sampler could be selected if passed explicitly.

**Root cause:** `SdGenConfig::sampleMethod` defaulted to `EULER_A_SAMPLE_METHOD`. The `generate_image()` function in `stable-diffusion.cpp` only runs its auto-detection (`sd_get_default_sample_method()`) when `sample_method == SAMPLE_METHOD_COUNT`. Since we always passed `EULER_A` explicitly, FLUX.2 (a DiT flow-matching model that needs `EULER`) got the ancestral euler sampler instead, producing garbage.

**Fix:** Changed the default in `addon/src/handlers/SdGenHandlers.hpp`:

```cpp
// Before
sample_method_t sampleMethod = EULER_A_SAMPLE_METHOD;
scheduler_t     scheduler    = DISCRETE_SCHEDULER;

// After
sample_method_t sampleMethod = SAMPLE_METHOD_COUNT;  // auto (euler for FLUX, euler_a for SD1.x)
scheduler_t     scheduler    = SCHEDULER_COUNT;      // auto
```

With these sentinel values, `stable-diffusion.cpp` selects `euler` for DiT/FLUX models and `euler_a` for SD1.x/SD2.x automatically.

---

### 5. Wrong RNG default

**Symptom:** Minor correctness difference vs reference CLI output.

**Root cause:** `SdCtxConfig` defaulted to `rngType = CPU_RNG` (Mersenne Twister). `sd_ctx_params_init()` in `stable-diffusion.cpp` sets `CUDA_RNG` (the philox RNG — named `CUDA_RNG` for historical reasons but not GPU-specific). The philox RNG is the expected default across all platforms.

**Fix:**

```cpp
// Before
rng_type_t rngType        = CPU_RNG;
rng_type_t samplerRngType = CPU_RNG;

// After
rng_type_t rngType        = CUDA_RNG;       // philox RNG — matches sd_ctx_params_init default
rng_type_t samplerRngType = RNG_TYPE_COUNT; // auto
```

---

### Summary of default alignment

The underlying pattern across all these fixes is the same: our C++ config structs had concrete default values that *overrode* `stable-diffusion.cpp`'s own sentinel-based auto-detection. The correct approach is to use the same sentinel values that `sd_ctx_params_init()` and `sd_sample_params_init()` set, and only pass concrete values when the caller explicitly requests them.

| Field | Wrong default | Correct default | Effect of wrong value |
|-------|--------------|-----------------|----------------------|
| `prediction` | `EPS_PRED` | `PREDICTION_COUNT` | Forces SD1.x epsilon denoiser on FLUX.2 → noise |
| `flow_shift` | `0.0f` | `INFINITY` | Disables flow-shifting → broken noise schedule |
| `sample_method` | `EULER_A_SAMPLE_METHOD` | `SAMPLE_METHOD_COUNT` | Wrong sampler for flow-matching models → noise |
| `scheduler` | `DISCRETE_SCHEDULER` | `SCHEDULER_COUNT` | Wrong schedule for FLUX.2 |
| `rng_type` | `CPU_RNG` | `CUDA_RNG` | Different noise seed generation vs reference |
| `ggml_metal` cmake flag | `-DGGML_METAL=ON` | `-DSD_METAL=ON` | Metal library compiled but never initialised |

---

## Credits

### Test Image

`assets/von-neumann.jpg` — **John von Neumann** (1956).
Source: U.S. Department of Energy, File ID: HD.3F.191.
This image is in the **Public Domain** as a work of the U.S. Federal Government.

---

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
