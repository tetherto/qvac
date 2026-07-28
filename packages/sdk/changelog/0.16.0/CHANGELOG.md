# Changelog v0.16.0

Release Date: 2026-07-22

## ✨ Features

- Reuse KV cache across turns in OpenAI serve endpoints. (see PR [#3264](https://github.com/tetherto/qvac/pull/3264))

## 🔌 API

- Add Ideogram 4 diffusion support. (see PR [#3287](https://github.com/tetherto/qvac/pull/3287)) - See [API changes](./api.md)
- Add per-phase diffusion timing stats. (see PR [#3317](https://github.com/tetherto/qvac/pull/3317)) - See [API changes](./api.md)
- Full-fidelity Python SDK client (landed in source, not yet published). (see PR [#3354](https://github.com/tetherto/qvac/pull/3354)) - See [API changes](./api.md)
- First-class GR00T exposure in VLA SDK (registry + hparams + docs). (see PR [#3362](https://github.com/tetherto/qvac/pull/3362)) - See [API changes](./api.md)

## 🐞 Fixes

- Make registry GGUF OCR models load via documented ocr() path. (see PR [#3326](https://github.com/tetherto/qvac/pull/3326))

## 📦 Models

- Expose latest tts-ggml APIs and refresh models. (see PR [#3393](https://github.com/tetherto/qvac/pull/3393)) - See [model changes](./models.md)
  Added: GEMMA4_2B_MULTIMODAL_Q8_0, QWEN3_4B_4B_Q4_K_M, QWEN3_5_2B_MULTIMODAL_Q8_0, TTS_INDIC_MULTILINGUAL_PARLER_TTS_FP16, TTS_INDIC_MULTILINGUAL_PARLER_TTS_FP32 (and 7 more)
  Removed: PARAKEET_CTC_FP32, PARAKEET_CTC_TOKENIZER, PARAKEET_EOU_DECODER_FP32, PARAKEET_EOU_ENCODER_FP32, PARAKEET_EOU_TOKENIZER (and 85 more)

## 🧪 Tests

- Stabilize vision text extraction e2e. (see PR [#3344](https://github.com/tetherto/qvac/pull/3344))
- Add GR00T VLA usage example + desktop e2e. (see PR [#3395](https://github.com/tetherto/qvac/pull/3395))

## 🧹 Chores

- Adopt fabric 9840.0.0 consumer releases in SDK addon dependencies. (see PR [#3335](https://github.com/tetherto/qvac/pull/3335))

