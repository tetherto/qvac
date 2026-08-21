# Changelog v0.18.0

Release Date: 2026-08-20

## ✨ Features

- Remove SDK dynamic tools mode (toolsMode). (see PR [#3380](https://github.com/tetherto/qvac/pull/3380)) - See [breaking changes](./breaking.md)

## 🔌 API

- Multi-job continuous batching in the SDK. (see PR [#3682](https://github.com/tetherto/qvac/pull/3682)) - See [API changes](./api.md)
- Expose streaming transcription stats. (see PR [#3734](https://github.com/tetherto/qvac/pull/3734)) - See [API changes](./api.md)
- Address translation-nmtcpp package-review findings. (see PR [#3753](https://github.com/tetherto/qvac/pull/3753)) - See [API changes](./api.md)
- Integrate @qvac/translation-nmtcpp 0.8.0 into SDK. (see PR [#3817](https://github.com/tetherto/qvac/pull/3817)) - See [API changes](./api.md)
- Integrate @qvac/ocr-ggml 0.16.0 in @qvac/sdk. (see PR [#3825](https://github.com/tetherto/qvac/pull/3825)) - See [API changes](./api.md)
- Add fallbackSrc to loadModel. (see PR [#3845](https://github.com/tetherto/qvac/pull/3845)) - See [API changes](./api.md)
- Expose image_no_upscale in the SDK config schema. (see PR [#3854](https://github.com/tetherto/qvac/pull/3854)) - See [API changes](./api.md)
- Add Audio8 TTS support to the SDK. (see PR [#3858](https://github.com/tetherto/qvac/pull/3858)) - See [API changes](./api.md)
- Integrate @qvac/audiogen-ggml 0.2.1 into the SDK. (see PR [#3899](https://github.com/tetherto/qvac/pull/3899)) - See [API changes](./api.md)

## 🐞 Fixes

- Load sharded llamacpp models directly from disk. (see PR [#3716](https://github.com/tetherto/qvac/pull/3716))
- Validate bounded MQTT sessions in SDK E2E. (see PR [#3717](https://github.com/tetherto/qvac/pull/3717))
- Keep tool definitions out of the primed kv-cache prefix. (see PR [#3757](https://github.com/tetherto/qvac/pull/3757))
- Stop breaking-changes changelog sections truncating at the letter z. (see PR [#3844](https://github.com/tetherto/qvac/pull/3844))
- Decouple audio-format constants from the optional @qvac/decoder-audio. (see PR [#3864](https://github.com/tetherto/qvac/pull/3864))
- Align llama-family addon pins on fabric-10069 builds. (see PR [#3902](https://github.com/tetherto/qvac/pull/3902))
- Make Snap E2E portable on the GPU runner. (see PR [#3904](https://github.com/tetherto/qvac/pull/3904))

## 📦 Models

- Add Indic Conformer CTC transcription. (see PR [#3815](https://github.com/tetherto/qvac/pull/3815)) - See [model changes](./models.md)
  Added: MMPROJ_VISIONPSY_NANO_460M_MULTIMODAL_Q8_0, VISIONPSY_NANO_460M_MULTIMODAL_Q4_K_M, VISIONPSY_NANO_460M_MULTIMODAL_Q8_0, MMPROJ_VISIONPSY_NANO_460M_MULTIMODAL_Q8_0_1, VISIONPSY_NANO_460M_MULTIMODAL_Q4_K_M_1 (and 10 more)
- Add CosyVoice3 TTS support to the SDK. (see PR [#3857](https://github.com/tetherto/qvac/pull/3857)) - See [breaking changes](./breaking.md), [API changes](./api.md), [model changes](./models.md)
  Updated: TTS_COSYVOICE3_LLM_COSYVOICE_Q8_0
- Sync model constants from registry. (see PR [#3885](https://github.com/tetherto/qvac/pull/3885)) - See [model changes](./models.md)
  Added: MMPROJ_VISIONPSY_NANO_460M_MULTIMODAL_Q8_0, VISIONPSY_NANO_460M_MULTIMODAL_Q4_K_M, VISIONPSY_NANO_460M_MULTIMODAL_Q8_0, MMPROJ_VISIONPSY_NANO_460M_MULTIMODAL_Q8_0_1, VISIONPSY_NANO_460M_MULTIMODAL_Q4_K_M_1 (and 17 more)

## 📘 Docs

- Make embedded Python examples standalone. (see PR [#3724](https://github.com/tetherto/qvac/pull/3724))
- Add SDK hardware API examples. (see PR [#3789](https://github.com/tetherto/qvac/pull/3789))

## 🧪 Tests

- Stop the dispatch test leaking a global log level. (see PR [#3835](https://github.com/tetherto/qvac/pull/3835))

## 🧹 Chores

- Sync @qvac/inference with main. (see PR [#3756](https://github.com/tetherto/qvac/pull/3756))
- Release @qvac/inference 0.16.1. (see PR [#3770](https://github.com/tetherto/qvac/pull/3770))
- Migrate SDK e2e to public test suite package. (see PR [#3873](https://github.com/tetherto/qvac/pull/3873))
- Update @qvac/bci-whispercpp to 0.7.1. (see PR [#3912](https://github.com/tetherto/qvac/pull/3912))

## ⚙️ Infrastructure

- Add workspace SDK-pod source linking the in-repo @qvac/inference. (see PR [#3863](https://github.com/tetherto/qvac/pull/3863))

