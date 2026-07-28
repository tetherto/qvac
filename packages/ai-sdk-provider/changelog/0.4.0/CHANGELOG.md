# Changelog v0.4.0

Release Date: 2026-07-27

## ✨ Features

- Migrate AI SDK provider to v7. (see PR [#3370](https://github.com/tetherto/qvac/pull/3370)) - See [breaking changes](./breaking.md)

## 📦 Models

- Expose latest tts-ggml APIs and refresh models. (see PR [#3393](https://github.com/tetherto/qvac/pull/3393)) - See [model changes](./models.md)
  Added: GEMMA4_2B_MULTIMODAL_Q8_0, QWEN3_4B_4B_Q4_K_M, QWEN3_5_2B_MULTIMODAL_Q8_0, TTS_INDIC_MULTILINGUAL_PARLER_TTS_FP16, TTS_INDIC_MULTILINGUAL_PARLER_TTS_FP32 (and 7 more)
  Removed: PARAKEET_CTC_FP32, PARAKEET_CTC_TOKENIZER, PARAKEET_EOU_DECODER_FP32, PARAKEET_EOU_ENCODER_FP32, PARAKEET_EOU_TOKENIZER (and 85 more)

## 🧹 Chores

- Unify lint/format/typecheck across SDK-pod packages. (see PR [#3040](https://github.com/tetherto/qvac/pull/3040))
