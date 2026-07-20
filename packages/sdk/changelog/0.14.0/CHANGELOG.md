# Changelog v0.14.0

Release Date: 2026-06-26

## ✨ Features

- Silence SDK and native logs by default, opt in to surface them. (see PR [#2653](https://github.com/tetherto/qvac/pull/2653)) - See [breaking changes](./breaking.md)
- Add Electron SDK e2e consumer. (see PR [#2690](https://github.com/tetherto/qvac/pull/2690))

## 🔌 API

- Add `subscribeServerLogs` to capture all server logs. (see PR [#2558](https://github.com/tetherto/qvac/pull/2558)) - See [API changes](./api.md)
- Separate TTS language validation per engine. (see PR [#2581](https://github.com/tetherto/qvac/pull/2581)) - See [API changes](./api.md)
- Friendly, field-level validation errors for user input. (see PR [#2618](https://github.com/tetherto/qvac/pull/2618)) - See [API changes](./api.md)
- Expose tts-ggml chatterbox config. (see PR [#2716](https://github.com/tetherto/qvac/pull/2716)) - See [API changes](./api.md)
- Expose parakeet 0.8 runtime fields. (see PR [#2787](https://github.com/tetherto/qvac/pull/2787)) - See [API changes](./api.md)
- Support explicit BCI embedder loading. (see PR [#2791](https://github.com/tetherto/qvac/pull/2791)) - See [API changes](./api.md)
- Expose remove_thinking_from_context completion param. (see PR [#2797](https://github.com/tetherto/qvac/pull/2797)) - See [API changes](./api.md)
- Support positive reasoning_budget token caps in llm schemas. (see PR [#2799](https://github.com/tetherto/qvac/pull/2799)) - See [API changes](./api.md)
- Harden Gemma4 completion drains. (see PR [#2802](https://github.com/tetherto/qvac/pull/2802)) - See [API changes](./api.md)
- Support more Chatterbox languages. (see PR [#2832](https://github.com/tetherto/qvac/pull/2832)) - See [API changes](./api.md)
- Add image_tile_mode SDK config + bump addon deps to new fabric version. (see PR [#2874](https://github.com/tetherto/qvac/pull/2874)) - See [API changes](./api.md)

## 🐞 Fixes

- Surface worker startup stderr. (see PR [#2550](https://github.com/tetherto/qvac/pull/2550))
- Clarify misplaced loadModel config fields. (see PR [#2600](https://github.com/tetherto/qvac/pull/2600))
- Register built-in plugins for Bare examples; clarify Bare docs and error. (see PR [#2640](https://github.com/tetherto/qvac/pull/2640))
- Classification plugin bundling and mobile e2e coverage. (see PR [#2663](https://github.com/tetherto/qvac/pull/2663))
- Recover Qwen hybrid tool-call frames. (see PR [#2677](https://github.com/tetherto/qvac/pull/2677))
- Keep @qvac/sdk plugin subpath resolvable after the publish rename. (see PR [#2784](https://github.com/tetherto/qvac/pull/2784))
- Normalize GPT-OSS Harmony output. (see PR [#2803](https://github.com/tetherto/qvac/pull/2803))
- Skip mobile HTTP embed tests and clean Electron artifacts. (see PR [#2831](https://github.com/tetherto/qvac/pull/2831))
- HTTP model downloads survive suspend and network drops. (see PR [#2865](https://github.com/tetherto/qvac/pull/2865))

## 📦 Models

- Use Supertonic 3 in examples/e2e and expand Supertonic languages to 31. (see PR [#2740](https://github.com/tetherto/qvac/pull/2740)) - See [model changes](./models.md)
  Added: TTS_MULTILINGUAL_SUPERTONIC3_FP16, TTS_MULTILINGUAL_SUPERTONIC3_FP32, TTS_MULTILINGUAL_SUPERTONIC3_Q4_0, TTS_MULTILINGUAL_SUPERTONIC3_Q8_0, HEALTHCARE_1_7B_MEDICAL_BF16 (and 21 more)
- Replace ONNX OCR with GGML-OCR 0.4.0 in SDK. (see PR [#2785](https://github.com/tetherto/qvac/pull/2785)) - See [breaking changes](./breaking.md), [model changes](./models.md)
  Added: MMPROJ_QWEN3_5_2B_MULTIMODAL_Q8_0, MMPROJ_QWEN3_5_4B_MULTIMODAL_Q8_0, HEALTHCARE_1_7B_MEDICAL_BF16, HEALTHCARE_1_7B_MEDICAL_IQ3_M, HEALTHCARE_1_7B_MEDICAL_IQ3_XXS (and 27 more)
  Removed: OCR_CRAFT_DETECTOR_GGML, OCR_LATIN_RECOGNIZER_GGML
- Update SDK registry models. (see PR [#2792](https://github.com/tetherto/qvac/pull/2792)) - See [model changes](./models.md)
  Added: MMPROJ_QWEN3_5_2B_MULTIMODAL_Q8_0, MMPROJ_QWEN3_5_4B_MULTIMODAL_Q8_0

## 📘 Docs

- Clarify companion assets in examples. (see PR [#2718](https://github.com/tetherto/qvac/pull/2718))
- Update npm package homepage metadata. (see PR [#2810](https://github.com/tetherto/qvac/pull/2810))

## 🧪 Tests

- Remove Wan 2.1 video e2e. (see PR [#2593](https://github.com/tetherto/qvac/pull/2593))
- Add NMT plugin, schema, and e2e lifecycle tests. (see PR [#2614](https://github.com/tetherto/qvac/pull/2614))
- Enable GPU on TTS sdk tests. (see PR [#2624](https://github.com/tetherto/qvac/pull/2624))
- Use canonical model type names in SDK e2e. (see PR [#2695](https://github.com/tetherto/qvac/pull/2695))

## 🧹 Chores

- Bump SDK decoder-audio to ^0.5.0. (see PR [#2608](https://github.com/tetherto/qvac/pull/2608))
- Adopt canonical model type names in SDK docs, examples, and tests. (see PR [#2623](https://github.com/tetherto/qvac/pull/2623))
- Remove bare-process in favor of Bare primitives. (see PR [#2689](https://github.com/tetherto/qvac/pull/2689)) - See [breaking changes](./breaking.md)
- Bump @qvac/transcription-whispercpp to ^0.10.0. (see PR [#2691](https://github.com/tetherto/qvac/pull/2691))
- Bump bci-whispercpp SDK dependency. (see PR [#2773](https://github.com/tetherto/qvac/pull/2773))
- Use q4 chatterbox models in sdk e2e tests. (see PR [#2867](https://github.com/tetherto/qvac/pull/2867))
- Bump @qvac/ocr-ggml ^0.6.0 and diffusion-cpp ^0.12.0. (see PR [#2868](https://github.com/tetherto/qvac/pull/2868))

## ⚙️ Infrastructure

- Add manual Electron SDK e2e CI. (see PR [#2798](https://github.com/tetherto/qvac/pull/2798))

