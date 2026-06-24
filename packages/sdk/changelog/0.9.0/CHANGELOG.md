# Changelog v0.9.0

Release Date: 2026-04-17

## ✨ Features

- Integrate CLD2 language detection for SDK. (see PR [#975](https://github.com/tetherto/qvac/pull/975))
- Add heartbeat for proactive provider status checks. (see PR [#1160](https://github.com/tetherto/qvac/pull/1160)) - See [breaking changes](./breaking.md)
- Update SDK OCR plugin to work with @qvac/ocr-onnx@0.4.0. (see PR [#1505](https://github.com/tetherto/qvac/pull/1505))

## 🔌 API

- **Add finetuning support to the SDK.** (see PR [#1479](https://github.com/tetherto/qvac/pull/1479)) - See [API changes](./api.md)
- **SDK diffusion plugin integration.** (see PR [#1021](https://github.com/tetherto/qvac/pull/1021)) - See [API changes](./api.md)
- Add duplex streaming transcription API (transcribeStream). (see PR [#999](https://github.com/tetherto/qvac/pull/999)) - See [API changes](./api.md)
- Add suspend/resume lifecycle. (see PR [#1511](https://github.com/tetherto/qvac/pull/1511)) - See [API changes](./api.md)
- Add delegated cancellation for inference and remote downloads. (see PR [#1153](https://github.com/tetherto/qvac/pull/1153)) - See [API changes](./api.md)
- Add RPC health probe and centralize stale-connection cleanup for delegation. (see PR [#1149](https://github.com/tetherto/qvac/pull/1149)) - See [API changes](./api.md)
- Addon Stats & Stream Profiling. (see PR [#1068](https://github.com/tetherto/qvac/pull/1068)) - See [API changes](./api.md)
- Expose backendDevice stat in SDK for LLM and embed addons. (see PR [#1495](https://github.com/tetherto/qvac/pull/1495)) - See [API changes](./api.md)
- Refactor JS interface in TTS package. (see PR [#1170](https://github.com/tetherto/qvac/pull/1170)) - See [API changes](./api.md)

## 🐞 Fixes

- Remove indictrans model type block in nmtcpp translat…. (see PR [#1112](https://github.com/tetherto/qvac/pull/1112))
- Use network-layer progress for registry downloads instead of disk I/O. (see PR [#1118](https://github.com/tetherto/qvac/pull/1118))
- Throttle RPC progress frames to prevent call stack overflow. (see PR [#1134](https://github.com/tetherto/qvac/pull/1134))
- Regenerate model registry to fix VLM addon classification. (see PR [#1167](https://github.com/tetherto/qvac/pull/1167))
- Resolve code scanning security alerts for SDK pod packages. (see PR [#1207](https://github.com/tetherto/qvac/pull/1207))
- Rename test assets to unique stems for android build. (see PR [#1262](https://github.com/tetherto/qvac/pull/1262))
- Bare direct process global and clean exit on RPC close. (see PR [#1284](https://github.com/tetherto/qvac/pull/1284))
- Fix kv-cache save race condition in tool-calling completions. (see PR [#1298](https://github.com/tetherto/qvac/pull/1298))
- Strip <think> blocks before parsing tool calls. (see PR [#1316](https://github.com/tetherto/qvac/pull/1316))
- Preserve KV cache across tool-call round-trips in completion. (see PR [#1327](https://github.com/tetherto/qvac/pull/1327))
- Examples bug fixes. (see PR [#1330](https://github.com/tetherto/qvac/pull/1330))
- Fix teardown race in closeConnection. (see PR [#1334](https://github.com/tetherto/qvac/pull/1334))
- Replace Buffer with Uint8Array in diffusion client for React Native. (see PR [#1368](https://github.com/tetherto/qvac/pull/1368))
- Buffer throttled progress events instead of dropping them. (see PR [#1481](https://github.com/tetherto/qvac/pull/1481))
- Add asset download instructions to examples that use local files. (see PR [#1517](https://github.com/tetherto/qvac/pull/1517))
- Support .onnx.data companions in registry onnx resolution. (see PR [#1526](https://github.com/tetherto/qvac/pull/1526))
- Update whispercpp plugin to new constructor api. (see PR [#1542](https://github.com/tetherto/qvac/pull/1542))
- Update CLI + sdk-tests for new embed() return shape. (see PR [#1596](https://github.com/tetherto/qvac/pull/1596))
- Bump @qvac/diffusion-cpp to ^0.1.3 in SDK. (see PR [#1601](https://github.com/tetherto/qvac/pull/1601))

## 📘 Docs

- Replace @tetherto npm references with @qvac namespace in READMEs. (see PR [#1247](https://github.com/tetherto/qvac/pull/1247))

## 🧪 Tests

- Add parallel download and cancel isolation E2E tests. (see PR [#1059](https://github.com/tetherto/qvac/pull/1059))
- Refactor model executor for asset-based mobile e2e. (see PR [#1126](https://github.com/tetherto/qvac/pull/1126))
- Use bootstrap in SDK tests, introduce models cache in CI. (see PR [#1402](https://github.com/tetherto/qvac/pull/1402))

## 🧹 Chores

- Bump bare-crypto and @qvac/rag for runtime stability. (see PR [#1325](https://github.com/tetherto/qvac/pull/1325))
- Bump test-suite for profiler report formatting. (see PR [#1326](https://github.com/tetherto/qvac/pull/1326))
- Replace FeatureBase support links with Discord. (see PR [#1352](https://github.com/tetherto/qvac/pull/1352))
- Update Parakeet version in sdk to 0.2.7. (see PR [#1436](https://github.com/tetherto/qvac/pull/1436))
- Update TTS version in sdk to 0.6.7. (see PR [#1441](https://github.com/tetherto/qvac/pull/1441))

## 📦 Models

- Model registry updated: 312 → 653 (+341). See [model changes](./models.md) for full list.
- Added 295 Bergamot translation models (42 language pairs bidirectional).
- Added 5 FLUX models.
- Added 4 Stable Diffusion models.
- Added 17 TTS Supertonic models.
- Added 1 LLM model (Qwen3 4B).

