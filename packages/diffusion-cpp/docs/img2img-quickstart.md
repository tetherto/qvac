# FLUX2-klein img2img Quick Start Guide

## Installation

1. Download the models:
```bash
cd packages/diffusion-cpp
./scripts/download-model-i2i.sh
```

This downloads ~6.7 GB of models (FLUX2-klein, Qwen3 text encoder, VAE).

## Basic Usage

```javascript
const ImgStableDiffusion = require('@qvac/diffusion-cpp')
const fs = require('bare-fs')
const path = require('bare-path')

const modelsDir = path.resolve('./models')

// 1. Setup model
const model = new ImgStableDiffusion({
  files: {
    model: path.join(modelsDir, 'flux-2-klein-4b-Q8_0.gguf'),
    llm:   path.join(modelsDir, 'Qwen3-4B-Q4_K_M.gguf'),
    vae:   path.join(modelsDir, 'flux2-vae.safetensors')
  },
  config: {
    threads: 4,
    device: 'gpu', // or 'cpu'
    // FLUX img2img requires an explicit prediction type. Without this the
    // addon silently falls back to the SD/SDEdit branch instead of the
    // FLUX in-context conditioning path.
    prediction: 'flux2_flow'
  },
  logger: console
})

// 2. Load model
await model.load()

// 3. Read input image
const inputImage = fs.readFileSync('input.jpg')

// 4. Transform image — output defaults to 1024x1024 for FLUX img2img
const response = await model.run({
  prompt: 'professional portrait, studio lighting',
  init_image: inputImage,
  cfg_scale: 1.0,
  guidance: 5.0,
  steps: 20
  // width/height omitted → JS defaults to 1024x1024 for FLUX img2img
})

// 5. Handle output
response.onUpdate((data) => {
  if (data instanceof Uint8Array) {
    fs.writeFileSync('output.png', data)
  }
})
await response.await()

// 6. Cleanup
await model.unload()
```

## Parameters

### Essential

- **`prompt`**: Text description of desired transformation
- **`init_image`**: Source image as `Uint8Array` (PNG or JPEG)
- **`strength`**: Transformation strength (0–1). Applies to the SD/SDEdit branch. For FLUX.2 the image is routed through in-context conditioning instead, so `strength` is ignored.
  - `0.3-0.4`: Subtle changes (style tweaks)
  - `0.5-0.6`: Moderate transformation (recommended starting point)
  - `0.7-0.8`: Strong changes (significant alterations)

### Optional

- **`negative_prompt`**: Elements to avoid
- **`steps`**: Denoising steps (default: 20, higher = better quality)
- **`width`/`height`**: Output dimensions (multiples of 8). For FLUX.2 img2img these default to 1024 each when omitted — the output resolution is independent of the input image size.
- **`guidance`**: FLUX2 guidance scale (default: 3.5)
- **`seed`**: Random seed for reproducibility (default: -1 = random)

## Examples

### 1. Subtle Style Change

```javascript
await model.run({
  prompt: 'same photo, cinematic color grading',
  init_image: photo,
  cfg_scale: 1.0,
  guidance: 5.0,
  steps: 20
  // width/height omitted → 1024x1024 output for FLUX img2img
})
```

### 2. Moderate Transformation

```javascript
await model.run({
  prompt: 'professional headshot, studio lighting, sharp focus',
  negative_prompt: 'blurry, low quality, distorted',
  init_image: photo,
  cfg_scale: 1.0,
  guidance: 5.0,
  steps: 25
  // width/height omitted → 1024x1024 output for FLUX img2img
})
```

### 3. Strong Artistic Style

```javascript
await model.run({
  prompt: 'oil painting, impressionist style, vibrant colors',
  init_image: photo,
  cfg_scale: 1.0,
  guidance: 5.0,
  steps: 30
  // width/height omitted → 1024x1024 output for FLUX img2img
})
```

## Tips

### Resolution

For **FLUX.2 img2img** (`prediction: 'flux2_flow'`):
- Output dimensions are independent of the input image size.
- When `width`/`height` are omitted, the addon defaults to 1024×1024.
- You can pass any explicit multiple-of-8 values — the reference image is auto-resized inside `generate_image()`.

For **SDEdit models** (SD2.x / SDXL / SD3):
- When `width`/`height` are omitted, output dimensions are taken from the input image (rounded up to the next multiple of 8).
- Input images should be multiples of 8 for best results.

### Strength Values
- Start with 0.5 and adjust based on results
- Lower = more faithful to original
- Higher = more creative interpretation

### Quality
- More steps = better quality but slower
- 20 steps: good for testing
- 25-30 steps: production quality
- 40+ steps: diminishing returns

### Performance (MacBook Air M1, 16GB)
- Model load: ~30-60s (one-time)
- Generation (20 steps, 1024×1024): ~60-90s
- Memory usage: ~8-10 GB

## CLI Testing

Test img2img via the CLI script:

```bash
bare examples/img2img-flux2.js
```

The bundled test image (`assets/von-neumann.jpg`) is used by default. Output is saved to `temp/von-neumann_transformed.png`.

## Troubleshooting

### Out of Memory
- Pass explicit `width`/`height` smaller than 1024 (e.g., `width: 768, height: 768`)
- Use CPU mode: `device: 'cpu'`
- Enable VAE tiling: `vae_tiling: true`

### Poor Quality
- Increase steps (25-30)
- Adjust strength (try 0.4-0.6 range)
- Refine prompt (be specific about desired style)

### Slow Generation
- Reduce steps (15-20)
- Lower resolution (`width: 768, height: 768`)
- Use CPU if GPU is thermal throttling

## Full Example

See [`examples/img2img-flux2.js`](../examples/img2img-flux2.js) for a complete working example.

## API Reference

Full documentation: [README.md](../README.md)
