---
name: image-generation
description: Generate images from text prompts with the local diffusion model.
tools: [generate_image]
---

# Image generation

Call `generate_image` when the user asks for an image, picture, illustration, drawing, or logo.

```json
{ "prompt": "a watercolor cat on a windowsill, soft morning light" }
```

## Parameters

- `prompt` (required) - describe subject, style, and mood in plain language.
- `width` / `height` - pixels, multiples of 64, max 1024. Default 512x512.
- `negative_prompt` - what to avoid.
- `seed` - set only when the user wants reproducible retries.
- `steps` - set only when the user asks for faster draft or higher quality.

## Notes

- Generation can take time, the result arrives as an attachment in this turn.
- One generation at a time; if the tool reports busy, wait and retry.
