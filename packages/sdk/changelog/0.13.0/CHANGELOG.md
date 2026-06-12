# Changelog v0.13.0

Release Date: 2026-06-12

## ✨ Features

- Serialize concurrent same-model requests via per-(kind, modelId) FIFO queue. (see PR [#2423](https://github.com/tetherto/qvac/pull/2423))

## 🔌 API

- Surface bare worker crash and shutdown as RPC errors. (see PR [#2350](https://github.com/tetherto/qvac/pull/2350)) - See [API changes](./api.md)
- Add img2vid (image-to-video) support to video generation in SDK. (see PR [#2436](https://github.com/tetherto/qvac/pull/2436)) - See [breaking changes](./breaking.md), [API changes](./api.md)
- Add electron-forge plugin for native addon tree-shaking. (see PR [#2480](https://github.com/tetherto/qvac/pull/2480)) - See [API changes](./api.md)
- Emit stopReason="length" on token budget exhaustion. (see PR [#2484](https://github.com/tetherto/qvac/pull/2484)) - See [API changes](./api.md)
- Bump transcription-whispercpp to 0.9.0 and surface backend/GPU stats. (see PR [#2488](https://github.com/tetherto/qvac/pull/2488)) - See [API changes](./api.md)
- Add BCI (whisper.cpp) neural-signal transcription to the SDK. (see PR [#2494](https://github.com/tetherto/qvac/pull/2494)) - See [API changes](./api.md)
- Integrate π₀.₅ (pi05) VLA model into @qvac/sdk. (see PR [#2508](https://github.com/tetherto/qvac/pull/2508)) - See [API changes](./api.md)

## 🐞 Fixes

- Strip multi-GPU config on mobile, surface embed contextSize, align native addon versions (SDK). (see PR [#2353](https://github.com/tetherto/qvac/pull/2353))
- Accept non-lowercase booleans in qwen35 tool-call parser. (see PR [#2372](https://github.com/tetherto/qvac/pull/2372))
- Bare config loader require() and models subpath for Metro. (see PR [#2431](https://github.com/tetherto/qvac/pull/2431))
- Add no and th to BERGAMOT_LANGUAGES enum. (see PR [#2456](https://github.com/tetherto/qvac/pull/2456))
- Wait for cold DHT before delegated connect + categorize connect failures. (see PR [#2468](https://github.com/tetherto/qvac/pull/2468))
- Reclassify SDK deps to optional peers, drop optionalDependencies. (see PR [#2474](https://github.com/tetherto/qvac/pull/2474))
- Bare-client close() must not exit in-process host. (see PR [#2526](https://github.com/tetherto/qvac/pull/2526))
- Prevent Android Parakeet GPU backend discovery. (see PR [#2529](https://github.com/tetherto/qvac/pull/2529))

## 🧪 Tests

- Restructure sdk test buckets — add test/bare, split unit/bare scripts. (see PR [#2271](https://github.com/tetherto/qvac/pull/2271))

## 🧹 Chores

- Drop legacy aliases in examples. (see PR [#2387](https://github.com/tetherto/qvac/pull/2387))
- Use typings from packages. (see PR [#2406](https://github.com/tetherto/qvac/pull/2406))
- Clean up dependencies. (see PR [#2443](https://github.com/tetherto/qvac/pull/2443))
- Bump addon deps to latest releases for M-RoPE K-shift. (see PR [#2504](https://github.com/tetherto/qvac/pull/2504))

## 📦 Models

- Model registry changes detected from model history: 21 added. See [model changes](./models.md) for full list.
- Added 2 BCI models.
- Added 3 LLM models.
- Added 2 Multimodal projector models.
- Added 3 Parakeet models.
- Added 1 VLA model.
- Added 8 TTS models.
- Added 2 Wan video models.

