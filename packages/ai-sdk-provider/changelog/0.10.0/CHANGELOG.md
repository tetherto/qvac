# Changelog v0.10.0

Release Date: 2026-10-16

## 💥 Breaking Changes

- Narrow the optional `@qvac/cli` peer to `^0.16.0`. - See [breaking changes](./breaking.md)
- Drop Core ML bundle files from the provider catalog. (see PR [#5012](https://github.com/tetherto/qvac/pull/5012)) - See [breaking changes](./breaking.md), [model changes](./models.md)
  Removed: PARAKEET_COREMLDATA, PARAKEET_COREMLDATA_1, PARAKEET_MODEL, PARAKEET_WEIGHT, PARAKEET_COREMLDATA_2 (and 32 more)
- Drop named exports for Qwen3.8 Flash Next UD shard constants. (see PR [#5012](https://github.com/tetherto/qvac/pull/5012)) - See [breaking changes](./breaking.md), [model changes](./models.md)
  Removed: QWEN3_8_FLASH_NEXT_177B_MULTIMODAL_UD_Q2_K_XL_SHARD, QWEN3_8_FLASH_NEXT_177B_MULTIMODAL_UD_Q4_K_XL_SHARD

## 🔌 API

- Verify the managed serve before sending it the key. (see PR [#5024](https://github.com/tetherto/qvac/pull/5024)) - See [API changes](./api.md)

## 📦 Models

- Add MOSS ASR and Nemotron diarization support. (see PR [#4945](https://github.com/tetherto/qvac/pull/4945)) - See [API changes](./api.md), [model changes](./models.md)
  Added: PARAKEET_NEMOTRON_3_DIARIZATION_Q8_0
- Sync model constants from registry. (see PR [#5207](https://github.com/tetherto/qvac/pull/5207)) - See [model changes](./models.md)
  Added: TTS_MOSS_SPEECH_BF16, TTS_CODEC_MOSS_SPEECH_F16, TTS_MOSS_SPEECH_Q8_0, TTS_DIALOGUE_MULTILINGUAL_MOSS_TTSD_F16
- Drop Core ML bundle files from the provider catalog. (see PR [#5012](https://github.com/tetherto/qvac/pull/5012)) - See [breaking changes](./breaking.md), [model changes](./models.md)
  Removed: PARAKEET_COREMLDATA, PARAKEET_COREMLDATA_1, PARAKEET_MODEL, PARAKEET_WEIGHT, PARAKEET_COREMLDATA_2 (and 32 more)

## ⚙️ Infrastructure

- Switch the SDK toolchain from Bun to npm. (see PR [#4859](https://github.com/tetherto/qvac/pull/4859))
