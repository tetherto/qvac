# FLUX2-klein img2img Quick Start Guide

## Installation

1. Download the models:
```bash
cd packages/lib-infer-diffusion
./scripts/download-model-i2i.sh
```

This downloads ~6.7 GB of models (FLUX2-klein, Qwen3 text encoder, VAE).

## Basic Usage

```javascript
const ImgStableDiffusion = require('@qvac/lib-infer-diffusion')
const fs = require('bare-fs')

// 1. Setup model
const model = new ImgStableDiffusion(
  {
    diskPath: './models',
    modelName: 'flux-2-klein-4b-Q8_0.gguf',
    llmModel: 'Qwen3-4B-Q4_K_M.gguf',
    vaeModel: 'flux2-vae.safetensors'
  },
  {
    threads: 4,
    device: 'gpu',  // or 'cpu'
    prediction: 'flux2_flow'
  }
)

// 2. Load model
await model.load()

// 3. Read input image
const inputImage = fs.readFileSync('input.jpg')

// 4. Transform image
const response = await model.img2img({
  prompt: 'professional portrait, studio lighting',
  init_image: inputImage,
  strength: 0.5,
  steps: 20
  // width/height auto-detected from init_image
})

// 5. Handle output
await response.onUpdate((data) => {
  if (data instanceof Uint8Array) {
    fs.writeFileSync('output.png', data)
  }
}).await()

// 6. Cleanup
await model.unload()
```

## Parameters

### Essential

- **`prompt`**: Text description of desired transformation
- **`init_image`**: Source image as `Uint8Array` (PNG or JPEG)
- **`strength`**: Transformation strength (0-1)
  - `0.3-0.4`: Subtle changes (style tweaks)
  - `0.5-0.6`: Moderate transformation (recommended starting point)
  - `0.7-0.8`: Strong changes (significant alterations)

### Optional

- **`negative_prompt`**: Elements to avoid
- **`steps`**: Denoising steps (default: 20, higher = better quality)
- **`width`/`height`**: Output dimensions (must match input or be multiples of 8)
- **`guidance`**: FLUX2 guidance scale (default: 3.5)
- **`seed`**: Random seed for reproducibility (default: -1 = random)

## Examples

### 1. Subtle Style Change

```javascript
await model.img2img({
  prompt: 'same photo, cinematic color grading',
  init_image: photo,
  strength: 0.35,
  steps: 20
  // width/height auto-detected
})
```

### 2. Moderate Transformation

```javascript
await model.img2img({
  prompt: 'professional headshot, studio lighting, sharp focus',
  negative_prompt: 'blurry, low quality, distorted',
  init_image: photo,
  strength: 0.5,
  steps: 25
  // width/height auto-detected
})
```

### 3. Strong Artistic Style

```javascript
await model.img2img({
  prompt: 'oil painting, impressionist style, vibrant colors',
  init_image: photo,
  strength: 0.75,
  steps: 30
  // width/height auto-detected
})
```

## Tips

### Resolution
- **Important:** Do NOT specify `width` or `height` for img2img
- Dimensions are automatically detected from the input image
- FLUX2 supports images up to 1024x1024
- Input images should be multiples of 8 for best results

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
- Generation (20 steps, 800x800): ~60-90s
- Memory usage: ~8-10 GB

## CLI Testing

Test img2img via the CLI script:

```bash
bare examples/img2img-flux2.js
```

The bundled test image (`assets/von-neumann.jpg`) is used by default. Output is saved to `temp/von-neumann_transformed.png`.

## Troubleshooting

### Out of Memory
- Reduce resolution (e.g., 512x512 instead of 1024x1024)
- Use CPU mode: `device: 'cpu'`
- Enable VAE tiling: `vae_tiling: true`

### Poor Quality
- Increase steps (25-30)
- Adjust strength (try 0.4-0.6 range)
- Refine prompt (be specific about desired style)

### Slow Generation
- Reduce steps (15-20)
- Lower resolution (512x512 or 640x640)
- Use CPU if GPU is thermal throttling

## Full Example

See [`examples/img2img-flux2.js`](../examples/img2img-flux2.js) for a complete working example.

## API Reference

Full documentation: [README.md](../README.md#image-to-image-modelimg2img)
