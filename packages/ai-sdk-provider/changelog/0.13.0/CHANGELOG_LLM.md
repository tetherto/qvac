# QVAC AI SDK Provider v0.13.0 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/ai-sdk-provider/v/0.13.0

This release adds twelve model constants, including the first with the new `QVAC_` prefix for models QVAC trained, and moves the provider onto `@qvac/cli` 0.21. No constant was removed or renamed, and provider behavior is unchanged.

## Model Changes

### QVAC-trained models carry a `QVAC_` prefix

Constants for models that QVAC trained now start with `QVAC_`, so a QVAC fine-tune cannot be mistaken for an upstream build of the same family. A projector keeps `MMPROJ_` first, as in `MMPROJ_QVAC_...`. The first such constant is QVAC's Qwen3.5 9B tool-calling fine-tune. No model in earlier releases carried the registry tag that marks a QVAC-trained model, so no existing constant changes name.

```typescript
import { models } from '@qvac/ai-sdk-provider'

models.QVAC_QWEN3_5_9B_TOOL_CALLING_Q4_K_M.endpointCategory // 'chat'
```

### Added

Chat models:

- `QVAC_QWEN3_5_9B_TOOL_CALLING_Q4_K_M`
- `BOTPSY_0_8B_TOOL_CALLING_BF16`
- `BOTPSY_0_8B_TOOL_CALLING_Q4_K_M`
- `BOTPSY_0_8B_TOOL_CALLING_Q8_0`
- `DEEPSEEK_V4_1_552B_A16B_DSPARK_Q8_0`
- `DEEPSEEK_V4_1_552B_A16B_MULTIMODAL_Q4_K_M_SHARD`
- `MMPROJ_DEEPSEEK_V4_1_552B_A16B_MULTIMODAL_F16`

Image models and their companion files:

- `MOSS_IMAGE_SFT_5B_BF16`
- `MOSS_IMAGE_SFT_TOKENIZER`
- `MOSS_IMAGE_VAE`
- `TAESD_VAE`
- `TAESDXL_VAE`

## Dependency Alignment

The optional `@qvac/cli` peer is now `^0.21.0`. A 0.x caret range does not cross a minor, so `^0.20.0` would not accept CLI 0.21.
