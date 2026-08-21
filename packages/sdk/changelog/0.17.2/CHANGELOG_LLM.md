# QVAC SDK v0.17.2 Release Notes

📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.17.2

QVAC SDK 0.17.2 is a patch that adds compile-time model constants for entries that were already live in the production registry. Apps can import Qwen3.8-27B multimodal, VisionPsy Nano, Audio8 TTS, CosyVoice 3, and Parakeet CTC weights from `@qvac/sdk` / `@qvac/inference` by constant name. `@qvac/inference`, `@qvac/sdk`, `@qvac/bare-sdk`, and `tetherto-qvac-sdk` ship together at 0.17.2.

## Model Changes

This cut syncs the SDK catalog with the live P2P registry (697 → 719 models). The new constants are grouped below; the full list is in the Added Models block.

### Qwen3.8 27B Multimodal

Qwen3.8-27B is now importable as a multimodal LLM plus its projector, so you can load the 27B vision stack from a named constant instead of a raw registry path.

```typescript
import {
  MMPROJ_QWEN3_8_27B_MULTIMODAL_F16,
  QWEN3_8_27B_MULTIMODAL_UD_Q4_K_XL,
  QWEN3_8_27B_MULTIMODAL_UD_Q8_K_XL,
} from "@qvac/sdk";
```

### VisionPsy Nano 460M

VisionPsy Nano 460M multimodal weights (Q4_K_M / Q8_0, including `_1` variants) and their projectors are now first-class constants.

### Audio8 TTS and CosyVoice 3

Audio8 ships codec encoder/decoder and multilingual LM constants (FP16 / Q8_0). CosyVoice 3 adds CAMPPlus and S3Tok companion weights (FP16 / FP32 / Q8_0).

### Parakeet CTC

Parakeet CTC transcription weights are available as F16, Q4_0, and Q8_0 constants.

### Added Models

```text
MMPROJ_QWEN3_8_27B_MULTIMODAL_F16
MMPROJ_VISIONPSY_NANO_460M_MULTIMODAL_Q8_0
MMPROJ_VISIONPSY_NANO_460M_MULTIMODAL_Q8_0_1
PARAKEET_CTC_F16
PARAKEET_CTC_Q4_0
PARAKEET_CTC_Q8_0
QWEN3_8_27B_MULTIMODAL_UD_Q4_K_XL
QWEN3_8_27B_MULTIMODAL_UD_Q8_K_XL
TTS_CODEC_DECODER_AUDIO8_FP16
TTS_CODEC_DECODER_AUDIO8_Q8_0
TTS_CODEC_ENCODER_AUDIO8_FP16
TTS_CODEC_ENCODER_AUDIO8_Q8_0
TTS_COSYVOICE3_CAMPPLUS_COSYVOICE_FP32
TTS_COSYVOICE3_S3TOK_COSYVOICE_FP16
TTS_COSYVOICE3_S3TOK_COSYVOICE_FP32
TTS_COSYVOICE3_S3TOK_COSYVOICE_Q8_0
TTS_LM_MULTILINGUAL_AUDIO8_FP16
TTS_LM_MULTILINGUAL_AUDIO8_Q8_0
VISIONPSY_NANO_460M_MULTIMODAL_Q4_K_M
VISIONPSY_NANO_460M_MULTIMODAL_Q4_K_M_1
VISIONPSY_NANO_460M_MULTIMODAL_Q8_0
VISIONPSY_NANO_460M_MULTIMODAL_Q8_0_1
```
