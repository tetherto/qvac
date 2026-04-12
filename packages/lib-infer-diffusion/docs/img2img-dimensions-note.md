# Important: img2img Dimensions

## The Issue

When using `model.img2img()`, **DO NOT specify `width` or `height` parameters**.

If you do, you'll get this error:
```
GGML_ASSERT(image.width == tensor->ne[0]) failed
```

## Why?

For img2img, stable-diffusion.cpp automatically detects the dimensions from the input image. When you manually specify width/height, it creates a mismatch between:
- The latent tensor size (based on width/height params)
- The actual input image dimensions

## Correct Usage

```javascript
// CORRECT - No width/height
await model.img2img({
  prompt: 'professional headshot',
  init_image: imageBuffer,
  strength: 0.5,
  steps: 20
})

// WRONG - Specifying width/height causes crash
await model.img2img({
  prompt: 'professional headshot',
  init_image: imageBuffer,
  strength: 0.5,
  steps: 20,
  width: 800,   // DON'T DO THIS
  height: 800   // DON'T DO THIS
})
```

## Resolution Requirements

Your input image should already be:
- A multiple of 8 in both dimensions (e.g., 512, 640, 768, 800, 1024)
- Within FLUX2's supported range (up to 1024x1024 works well)

If your image isn't a multiple of 8, stable-diffusion.cpp will handle it internally.

## CLI vs JavaScript API

Note that the **CLI** (`sd-cli`) works differently:
- CLI: You CAN specify `--width` and `--height` (they resize the init image)
- JavaScript API: You CANNOT specify width/height (auto-detected only)

This is why `scripts/headshot.sh` works with width/height but the JavaScript example doesn't.

---

## Guidance Scale Reference

Guidance scale controls how strongly the model follows the text prompt during
denoising. The parameter name and recommended range differ between model
families because they use fundamentally different conditioning mechanisms.

### How it works

During each denoising step the model produces two predictions: one conditioned
on the prompt and one unconditional. The guidance scale determines how far
the final prediction is pushed away from the unconditional one toward the
conditioned one. Higher values mean stronger prompt adherence but can introduce
artefacts; lower values produce more natural but less prompt-faithful results.

### Per-model summary

| Model family | Parameter | Default | Recommended range | Notes |
|---|---|---|---|---|
| SD1.x / SD2.x | `cfg_scale` | 7.0 | 5.0 - 12.0 | Classic Classifier-Free Guidance (CFG). Trained with DDPM noise schedule. 7.0-9.0 is the sweet spot for most prompts. |
| SDXL | `cfg_scale` | 7.0 | 5.0 - 9.0 | Same CFG mechanism as SD1/SD2, but lower values (5-7) tend to produce cleaner results at 1024x1024. |
| SD3 Medium | `cfg_scale` | 7.0 (library default, too high) | 3.5 - 5.0 | SD3 uses a rectified flow-matching objective (not DDPM). The library default of 7.0 is tuned for SD1/SD2 and is too high for SD3 -- it causes over-saturation and distorted faces. Use 4.5 as a starting point (the value stable-diffusion.cpp recommends for SD3). |
| FLUX.2 | `guidance` | 3.5 | 2.5 - 5.0 | FLUX.2 uses **distilled guidance**, a separate mechanism from CFG. The `guidance` value is embedded directly into the model's timestep conditioning rather than being applied as a post-hoc interpolation. Set `cfg_scale: 1.0` (effectively disabling CFG) and control prompt strength exclusively through `guidance`. |

### FLUX.2 vs SD3: why the parameter is different

SD3 and FLUX.2 are both flow-matching models, but they handle guidance
differently at the architecture level:

- **SD3** uses standard Classifier-Free Guidance. The model runs two forward
  passes per step (conditional and unconditional) and the outputs are
  interpolated using `cfg_scale`. This is the same mechanism as SD1/SD2, just
  with a different noise schedule that requires lower scale values.

- **FLUX.2** bakes guidance into the model via distillation. During training
  the guidance scale was encoded as an input signal, so at inference time the
  model only needs a single forward pass. The `guidance` parameter tells the
  model how strongly to follow the prompt internally. Setting `cfg_scale > 1`
  on FLUX.2 would run redundant unconditional passes and waste compute
  (or degrade quality), which is why the examples set `cfg_scale: 1.0`.

### img2img specifics

For img2img the `img_cfg_scale` parameter controls image-level guidance
independently from text guidance. When set to `-1` (the default) it inherits
the value of `cfg_scale`. In practice:

- **FLUX.2 img2img**: `cfg_scale: 1.0`, `guidance: 3.5-5.0`. The model
  preserves input image features through joint attention rather than through
  CFG-based image conditioning.
- **SD3 img2img**: `cfg_scale: 3.5-5.0`, no `guidance` parameter. Standard
  CFG applies to both text and image conditioning.
- **SD1/SD2 img2img**: `cfg_scale: 5.0-9.0`. Higher values push further from
  the input image toward the prompt.

### Quick reference for img2img calls

```javascript
// FLUX.2
await model.run({
  prompt: 'portrait, studio lighting',
  init_image: imageBuffer,
  cfg_scale: 1.0,       // disable classic CFG
  guidance: 5.0,         // distilled guidance (FLUX-specific)
  strength: 0.5,
  steps: 10
})

// SD3 Medium
await model.run({
  prompt: 'anime portrait, comic-book style',
  init_image: imageBuffer,
  cfg_scale: 3.5,        // flow-matching CFG (lower than SD1/SD2)
  strength: 0.65,
  steps: 28,
  sampling_method: 'euler'
})

// SD2.1
await model.run({
  prompt: 'oil painting, impressionist style',
  init_image: imageBuffer,
  cfg_scale: 7.5,        // classic DDPM CFG
  strength: 0.6,
  steps: 20
})
```

