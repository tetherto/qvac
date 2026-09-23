# Changelog v0.18.0

Release Date: 2026-08-20

## ✨ Features

- Remove SDK dynamic tools mode (toolsMode). (see PR [#3380](https://github.com/tetherto/qvac/pull/3380)) - See [breaking changes](./breaking.md)

## 🔌 API

- Multi-job continuous batching. (see PR [#3682](https://github.com/tetherto/qvac/pull/3682)) - See [API changes](./api.md)
- Expose streaming transcription stats. (see PR [#3734](https://github.com/tetherto/qvac/pull/3734)) - See [API changes](./api.md)
- Address translation-nmtcpp package-review findings. (see PR [#3753](https://github.com/tetherto/qvac/pull/3753)) - See [API changes](./api.md)
- Add fallbackSrc to loadModel. (see PR [#3845](https://github.com/tetherto/qvac/pull/3845)) - See [API changes](./api.md)
- Expose image_no_upscale in the config schema. (see PR [#3854](https://github.com/tetherto/qvac/pull/3854)) - See [API changes](./api.md)
- Add CosyVoice3 TTS support. (see PR [#3857](https://github.com/tetherto/qvac/pull/3857)) - See [breaking changes](./breaking.md), [API changes](./api.md), [model changes](./models.md)
- Add Audio8 TTS support. (see PR [#3858](https://github.com/tetherto/qvac/pull/3858)) - See [API changes](./api.md)
- Integrate @qvac/audiogen-ggml 0.2.1. (see PR [#3899](https://github.com/tetherto/qvac/pull/3899)) - See [API changes](./api.md)

## 🐞 Fixes

- Load sharded llamacpp models directly from disk. (see PR [#3716](https://github.com/tetherto/qvac/pull/3716))
- Keep tool definitions out of the primed kv-cache prefix. (see PR [#3757](https://github.com/tetherto/qvac/pull/3757))
- Decouple audio-format constants from the optional @qvac/decoder-audio. (see PR [#3864](https://github.com/tetherto/qvac/pull/3864))

## 📦 Models

- Add Indic Conformer CTC transcription. (see PR [#3815](https://github.com/tetherto/qvac/pull/3815)) - See [model changes](./models.md)
  Added: PARAKEET_INDIC_CONFORMER_CTC_F16, PARAKEET_INDIC_CONFORMER_CTC_Q4_0, PARAKEET_INDIC_CONFORMER_CTC_Q8_0
- Add CosyVoice3 TTS support. (see PR [#3857](https://github.com/tetherto/qvac/pull/3857)) - See [breaking changes](./breaking.md), [API changes](./api.md), [model changes](./models.md)
  Updated: TTS_COSYVOICE3_LLM_COSYVOICE_Q8_0
- Sync model constants from registry. (see PR [#3885](https://github.com/tetherto/qvac/pull/3885)) - See [model changes](./models.md)
  Added: MMPROJ_VISIONPSY_NANO_460M_MULTIMODAL_Q8_0, VISIONPSY_NANO_460M_MULTIMODAL_Q4_K_M, VISIONPSY_NANO_460M_MULTIMODAL_Q8_0, MMPROJ_VISIONPSY_NANO_460M_MULTIMODAL_Q8_0_1, VISIONPSY_NANO_460M_MULTIMODAL_Q4_K_M_1 (and 14 more)

## 🧪 Tests

- Stop the dispatch test leaking a global log level. (see PR [#3835](https://github.com/tetherto/qvac/pull/3835))
