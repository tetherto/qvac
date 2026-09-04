# Changelog v0.19.0

Release Date: 2026-09-04

## ✨ Features

- Remove DHT delegated inference. (see PR [#4042](https://github.com/tetherto/qvac/pull/4042)) - See [breaking changes](./breaking.md)
- Adopt fabric b10297 consumers and replace no_mmap with load_mode. (see PR [#4078](https://github.com/tetherto/qvac/pull/4078)) - See [breaking changes](./breaking.md)
- Darwin-arm64 calibration — persistent-based fit, audio guard, validated fixture. (see PR [#4136](https://github.com/tetherto/qvac/pull/4136))
- Route Qwen3.8 tool calls through the Qwen parser. (see PR [#4230](https://github.com/tetherto/qvac/pull/4230))
- Return batch translations as an array. (see PR [#4237](https://github.com/tetherto/qvac/pull/4237)) - See [breaking changes](./breaking.md)

## 🔌 API

- Add ABot-World interactive world sessions to the SDK. (see PR [#3812](https://github.com/tetherto/qvac/pull/3812)) - See [API changes](./api.md)
- Generate model resource profiles for the catalog. (see PR [#4045](https://github.com/tetherto/qvac/pull/4045)) - See [API changes](./api.md)
- AssessModelFit pre-download fit assessment. (see PR [#4047](https://github.com/tetherto/qvac/pull/4047)) - See [API changes](./api.md)
- Expose assessModelFit from the SDK. (see PR [#4048](https://github.com/tetherto/qvac/pull/4048)) - See [API changes](./api.md)
- Describe shared modelSrc descriptor fields. (see PR [#4052](https://github.com/tetherto/qvac/pull/4052)) - See [API changes](./api.md)
- Describe classification modelConfig fields. (see PR [#4061](https://github.com/tetherto/qvac/pull/4061)) - See [API changes](./api.md)
- Describe OCR modelConfig fields. (see PR [#4062](https://github.com/tetherto/qvac/pull/4062)) - See [API changes](./api.md)
- Describe AudioGen load-time modelConfig fields. (see PR [#4064](https://github.com/tetherto/qvac/pull/4064)) - See [API changes](./api.md)
- Describe remaining diffusion modelConfig fields. (see PR [#4065](https://github.com/tetherto/qvac/pull/4065)) - See [API changes](./api.md)
- Describe NMT modelConfig union arms. (see PR [#4066](https://github.com/tetherto/qvac/pull/4066)) - See [API changes](./api.md)
- Describe TTS modelConfig union arms. (see PR [#4067](https://github.com/tetherto/qvac/pull/4067)) - See [API changes](./api.md)
- Describe whisper + parakeet modelConfig fields. (see PR [#4068](https://github.com/tetherto/qvac/pull/4068)) - See [API changes](./api.md)
- Describe BCI modelConfig fields. (see PR [#4069](https://github.com/tetherto/qvac/pull/4069)) - See [API changes](./api.md)
- Add injected TurboVec RAG index support. (see PR [#4074](https://github.com/tetherto/qvac/pull/4074)) - See [API changes](./api.md)
- Surface audiogen backend diagnostics on the run result. (see PR [#4099](https://github.com/tetherto/qvac/pull/4099)) - See [API changes](./api.md)
- Add MiniMax music generation support. (see PR [#4105](https://github.com/tetherto/qvac/pull/4105)) - See [breaking changes](./breaking.md), [API changes](./api.md)
- Verify Hugging Face HTTP model downloads against Hub SHA-256. (see PR [#4110](https://github.com/tetherto/qvac/pull/4110)) - See [API changes](./api.md)
- Guard that every modelConfig field is described. (see PR [#4122](https://github.com/tetherto/qvac/pull/4122)) - See [API changes](./api.md)
- Update @qvac/tts-ggml to 0.8.0. (see PR [#4138](https://github.com/tetherto/qvac/pull/4138)) - See [API changes](./api.md)
- Configurable worker RPC init timeout and typed startup failure cause. (see PR [#4159](https://github.com/tetherto/qvac/pull/4159)) - See [API changes](./api.md)
- Drop n_discarded from the SDK config schema. (see PR [#4163](https://github.com/tetherto/qvac/pull/4163)) - See [breaking changes](./breaking.md), [API changes](./api.md)
- Surface modelConfig descriptions for every model type in qvac configure. (see PR [#4172](https://github.com/tetherto/qvac/pull/4172)) - See [API changes](./api.md)
- Report why an audiogen run fell back to the CPU. (see PR [#4200](https://github.com/tetherto/qvac/pull/4200)) - See [API changes](./api.md)
- Mobile memory budget basis — per-process on iOS, explicit system on Android. (see PR [#4208](https://github.com/tetherto/qvac/pull/4208)) - See [API changes](./api.md)
- Add tensor split mode and flash attention config. (see PR [#4211](https://github.com/tetherto/qvac/pull/4211)) - See [API changes](./api.md)
- Land desktop calibration fixtures and GPU-memory assessment. (see PR [#4238](https://github.com/tetherto/qvac/pull/4238)) - See [API changes](./api.md)
- Allow indeterminate AudioGen progress totals. (see PR [#4243](https://github.com/tetherto/qvac/pull/4243)) - See [API changes](./api.md)

## 🐞 Fixes

- Preserve worker exit signal on RPC init timeout. (see PR [#3532](https://github.com/tetherto/qvac/pull/3532))
- Refresh iOS addon links during Expo prebuild. (see PR [#3776](https://github.com/tetherto/qvac/pull/3776))
- Align SDK @qvac/inference range to the 0.18 line. (see PR [#4021](https://github.com/tetherto/qvac/pull/4021))
- Raise inactivity timeout in audio-decoder long-WAV test to stop CI flake. (see PR [#4025](https://github.com/tetherto/qvac/pull/4025))
- Restore the inference peer-dependency enforcement dropped in #3812. (see PR [#4111](https://github.com/tetherto/qvac/pull/4111))
- Regenerate the SDK contract and Python client for zod 4.5. (see PR [#4156](https://github.com/tetherto/qvac/pull/4156))
- Pin local bare for calibration and name the VRAM-offload abort. (see PR [#4231](https://github.com/tetherto/qvac/pull/4231))

## 📦 Models

- Add Parakeet Unified transcription to the SDK. (see PR [#4155](https://github.com/tetherto/qvac/pull/4155)) - See [API changes](./api.md), [model changes](./models.md)
  Added: PARAKEET_UNIFIED_0_6B_F16, PARAKEET_UNIFIED_0_6B_Q4_0, PARAKEET_UNIFIED_0_6B_Q8_0
- Add Qwen3.8 Flash Next 177B model constants. (see PR [#4253](https://github.com/tetherto/qvac/pull/4253)) - See [model changes](./models.md)
  Added: MMPROJ_QWEN3_8_FLASH_NEXT_177B_MULTIMODAL_F16, QWEN3_8_FLASH_NEXT_177B_MULTIMODAL_UD_Q2_K_XL_SHARD, QWEN3_8_FLASH_NEXT_177B_MULTIMODAL_UD_Q4_K_XL_SHARD

## 📘 Docs

- Point Bare consumers at @qvac/inference. (see PR [#4018](https://github.com/tetherto/qvac/pull/4018))
- Flag built-in RAG vector store as prototype-only. (see PR [#4034](https://github.com/tetherto/qvac/pull/4034))

## 🧹 Chores

- Use @qvac/inference for SDK. (see PR [#3595](https://github.com/tetherto/qvac/pull/3595)) - See [breaking changes](./breaking.md)
- Remove langdetect-text-cld2 from the monorepo. (see PR [#4011](https://github.com/tetherto/qvac/pull/4011)) - See [breaking changes](./breaking.md)
- Drop @qvac/bare-sdk from the lockstep pipeline. (see PR [#4019](https://github.com/tetherto/qvac/pull/4019))
- Enforce inference's peer dependencies in SDK. (see PR [#4037](https://github.com/tetherto/qvac/pull/4037))
- Lint the SDK with lunte. (see PR [#4058](https://github.com/tetherto/qvac/pull/4058))
- Move SDK e2e onto the published @qvac/test-suite. (see PR [#4083](https://github.com/tetherto/qvac/pull/4083)) - See [breaking changes](./breaking.md)
- Bump bci-whispercpp to 0.8.0. (see PR [#4133](https://github.com/tetherto/qvac/pull/4133))
- Bump @qvac/diffusion-cpp to ^0.21.0. (see PR [#4144](https://github.com/tetherto/qvac/pull/4144))

## ⚙️ Infrastructure

- Calibration suite in the test-sdk dispatch. (see PR [#4158](https://github.com/tetherto/qvac/pull/4158))

