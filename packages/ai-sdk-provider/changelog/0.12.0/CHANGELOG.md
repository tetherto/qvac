# Changelog v0.12.0

Release Date: 2026-11-13

## ✨ Features

- Match the default `baseURL` to the new `qvac serve` default port, 11435. (see PR [#5695](https://github.com/tetherto/qvac/pull/5695)) - See [breaking changes](./breaking.md)

## 🐞 Fixes

- Treat Core ML source-package files as companions. (see PR [#5486](https://github.com/tetherto/qvac/pull/5486))
- Trim trailing slashes from the AI SDK provider baseURL in linear time. (see PR [#5661](https://github.com/tetherto/qvac/pull/5661))

## 📦 Models

- Refresh model constants from registry. (see PR [#5431](https://github.com/tetherto/qvac/pull/5431)) - See [model changes](./models.md)
  Added: EMBEDDINGGEMMA_2_Q8_0, MMPROJ_EMBEDDINGGEMMA_2_Q8_0, PARAKEET_NEMOTRON_3_DIARIZATION_Q4_K, PARAKEET_MOSAIC_Q4_0_Q8_0, PARAKEET_MOSAIC_COMPACT_Q4_0_Q8_0_Q3_K_IQ3_S (and 1 more)
- Point EmbeddingGemma-300M constants at the Dense-layer models. (see PR [#5634](https://github.com/tetherto/qvac/pull/5634)) - See [breaking changes](./breaking.md), [model changes](./models.md)
  Updated: EMBEDDINGGEMMA_300M_BF16, EMBEDDINGGEMMA_300M_Q4_0, EMBEDDINGGEMMA_300M_Q8_0
  Removed: EMBEDDINGGEMMA_300M_F32
- Add the TranscribePsy-250M-EU constant. (see PR [#5683](https://github.com/tetherto/qvac/pull/5683)) - See [API changes](./api.md), [model changes](./models.md)
  Added: PARAKEET_TRANSCRIBEPSY_250M_EU_Q8_0
- Add GLM 5.3 Flash constants to the AI SDK provider. (see PR [#5739](https://github.com/tetherto/qvac/pull/5739)) - See [model changes](./models.md)
  Added: GLM_5_3_FLASH_320B_A18B_MULTIMODAL_Q4_K_M_SHARD, MMPROJ_GLM_5_3_FLASH_320B_A18B_MULTIMODAL_BF16
