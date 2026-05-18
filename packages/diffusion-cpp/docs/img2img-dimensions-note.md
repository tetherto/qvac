# img2img Dimensions

## FLUX.2 img2img (`prediction: 'flux2_flow'`)

Output dimensions are **independent of the input image size**. When `width`/`height` are omitted, the addon defaults both to **1024**. You can pass any explicit multiple-of-8 values — the reference image is auto-resized inside `generate_image()`.

```javascript
// Omit width/height → 1024×1024 output (FLUX img2img default)
await model.run({
  prompt: 'professional headshot',
  init_image: imageBuffer,
  cfg_scale: 1.0,
  guidance: 5.0,
  steps: 20
})

// Explicit dimensions — any multiple-of-8 values work
await model.run({
  prompt: 'professional headshot',
  init_image: imageBuffer,
  width: 768,
  height: 1024,
  cfg_scale: 1.0,
  guidance: 5.0,
  steps: 20
})
```

## SDEdit img2img (SD2.x / SDXL / SD3)

When `width`/`height` are omitted, output dimensions are taken from the input image (rounded up to the next multiple of 8). Supplying explicit values that differ from the input image dimensions will cause a tensor-shape mismatch error in stable-diffusion.cpp, so omit them or match them to the input.

```javascript
// Correct — dimensions match input image
await model.run({
  prompt: 'professional headshot',
  init_image: imageBuffer,   // e.g. 512×512 image
  cfg_scale: 7.0,
  strength: 0.5,
  steps: 20
  // width/height omitted → taken from input image
})
```

## Resolution Requirements

- All dimensions must be multiples of 8.
- FLUX.2 works well at 1024×1024 (the default when omitted).
- For SDEdit, if your input image dimensions are not multiples of 8, stable-diffusion.cpp rounds up internally.

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
| SD2.x | `cfg_scale` | 7.0 | 5.0 - 12.0 | Classic Classifier-Free Guidance (CFG). Trained with DDPM noise schedule. 7.0-9.0 is the sweet spot for most prompts. |
| SDXL | `cfg_scale` | 7.0 | 5.0 - 9.0 | Same CFG mechanism as SD2, but lower values (5-7) tend to produce cleaner results at 1024x1024. |
| SD3 Medium | `cfg_scale` | 7.0 (library default, too high) | 3.5 - 5.0 | SD3 uses a rectified flow-matching objective (not DDPM). The library default of 7.0 is tuned for SD2/SDXL and is too high for SD3 -- it causes over-saturation and distorted faces. Use 4.5 as a starting point (the value stable-diffusion.cpp recommends for SD3). |
| FLUX.2 | `guidance` | 3.5 | 2.5 - 5.0 | FLUX.2 uses **distilled guidance**, a separate mechanism from CFG. The `guidance` value is embedded directly into the model's timestep conditioning rather than being applied as a post-hoc interpolation. Set `cfg_scale: 1.0` (effectively disabling CFG) and control prompt strength exclusively through `guidance`. |

### FLUX.2 vs SD3: why the parameter is different

SD3 and FLUX.2 are both flow-matching models, but they handle guidance
differently at the architecture level:

- **SD3** uses standard Classifier-Free Guidance. The model runs two forward
  passes per step (conditional and unconditional) and the outputs are
  interpolated using `cfg_scale`. This is the same mechanism as SD2, just
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
- **SD2/SDXL img2img**: `cfg_scale: 5.0-9.0`. Higher values push further from
  the input image toward the prompt.

### Quick reference for img2img calls

```javascript
// FLUX.2
await model.run({
  prompt: 'portrait, studio lighting',
  init_image: imageBuffer,
  cfg_scale: 1.0,       // disable classic CFG
  guidance: 5.0,         // distilled guidance (FLUX-specific)
  steps: 10
})

// SD3 Medium
await model.run({
  prompt: 'anime portrait, comic-book style',
  init_image: imageBuffer,
  cfg_scale: 3.5,        // flow-matching CFG (lower than SD2/SDXL)
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
