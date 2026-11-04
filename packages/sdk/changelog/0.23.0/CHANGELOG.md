# Changelog v0.23.0

Release Date: 2026-10-29

## ✨ Features

- Integrate standalone TurboVec addon for vector indexing. (see PR [#5227](https://github.com/tetherto/qvac/pull/5227))
- Drop rank pooling from the embedding config schema. (see PR [#5277](https://github.com/tetherto/qvac/pull/5277)) - See [breaking changes](./breaking.md)
- Run the model fit in process on every platform. (see PR [#5279](https://github.com/tetherto/qvac/pull/5279)) - See [breaking changes](./breaking.md)
- Default parallel_tool_calls to true in the SDK. (see PR [#5283](https://github.com/tetherto/qvac/pull/5283)) - See [breaking changes](./breaking.md)
- Detect the tool dialect from the GGUF architecture. (see PR [#5287](https://github.com/tetherto/qvac/pull/5287))
- Await async TurboVec index providers in inference. (see PR [#5385](https://github.com/tetherto/qvac/pull/5385))

## 🔌 API

- Let a log subscription be closed from the JS SDK. (see PR [#4959](https://github.com/tetherto/qvac/pull/4959)) - See [API changes](./api.md)
- Assess ESRGAN and ABot world memory fit. (see PR [#5038](https://github.com/tetherto/qvac/pull/5038)) - See [API changes](./api.md)
- Expose the prompt-cache keys in the SDK llm load config. (see PR [#5124](https://github.com/tetherto/qvac/pull/5124)) - See [API changes](./api.md)
- Expose CPU polling controls for llama.cpp models. (see PR [#5216](https://github.com/tetherto/qvac/pull/5216)) - See [API changes](./api.md)
- Expose llm-llamacpp speculative decoding in the SDK. (see PR [#5261](https://github.com/tetherto/qvac/pull/5261)) - See [API changes](./api.md)
- Add reranking with a llamacpp-rerank model type and rerank(). (see PR [#5285](https://github.com/tetherto/qvac/pull/5285)) - See [API changes](./api.md)
- Support Qwen-Image-2.1 generation and reference editing. (see PR [#5302](https://github.com/tetherto/qvac/pull/5302)) - See [breaking changes](./breaking.md), [API changes](./api.md)
- Prime system prompts and tools through completion. (see PR [#5312](https://github.com/tetherto/qvac/pull/5312)) - See [API changes](./api.md)
- Add Python assess_model_fit and model_fit_policy wrappers (Python client). (see PR [#5315](https://github.com/tetherto/qvac/pull/5315)) - See [breaking changes](./breaking.md), [API changes](./api.md)
- Add TranscribePsy transcription to the SDK. (see PR [#5347](https://github.com/tetherto/qvac/pull/5347)) - See [API changes](./api.md)
- Report a missing registry model as ModelRegistryModelNotFoundError; the /qvac/v1/registry route ships in the CLI. (see PR [#5356](https://github.com/tetherto/qvac/pull/5356)) - See [breaking changes](./breaking.md), [API changes](./api.md)

## 🐞 Fixes

- Resolve the lighter CosyVoice3 companion set. (see PR [#5175](https://github.com/tetherto/qvac/pull/5175)) - See [model changes](./models.md)
  Updated: TTS_COSYVOICE3_LLM_COSYVOICE_Q4_0
- Create the Node worker socket in a private temp folder. (see PR [#5233](https://github.com/tetherto/qvac/pull/5233))
- Load TurboVec only when creating or loading an index. (see PR [#5239](https://github.com/tetherto/qvac/pull/5239))
- Avoid rehashing unchanged cached models. (see PR [#5313](https://github.com/tetherto/qvac/pull/5313))
- Drop the exists checks before Expo plugin writes. (see PR [#5320](https://github.com/tetherto/qvac/pull/5320))
- Disable decoded-audio response retention. (see PR [#5340](https://github.com/tetherto/qvac/pull/5340))
- Declare tools loaded by tool_search in the tools block. (see PR [#5346](https://github.com/tetherto/qvac/pull/5346)) - See [breaking changes](./breaking.md)
- Pin the Python client's bare-rpc below 0.1 (Python client). (see PR [#5439](https://github.com/tetherto/qvac/pull/5439))

## 📦 Models

- Sync model constants and name the TranscribePsy Parakeet models. (see PR [#5316](https://github.com/tetherto/qvac/pull/5316)) - See [model changes](./models.md)
  Added: QWEN3_5_0_8B_MTP_Q4_K_M, QWEN3_5_2B_MTP_Q4_K_M, QWEN3_5_4B_MTP_Q4_K_M, QWEN3_5_9B_MTP_Q4_K_M, QWEN3_5_4B_DFLASH_Q8_0 (and 4 more)

## 📘 Docs

- Review and update code examples, part 1. (see PR [#5258](https://github.com/tetherto/qvac/pull/5258))
- Document the Android worker Binder access bound (Kotlin client, unpublished). (see PR [#5372](https://github.com/tetherto/qvac/pull/5372))

## 🧪 Tests

- Move the SDK e2e suite to packages/sdk-e2e with a client-neutral catalog (internal). (see PR [#5268](https://github.com/tetherto/qvac/pull/5268))
- Run the shared e2e catalog on the Kotlin SDK on Android (internal). (see PR [#5358](https://github.com/tetherto/qvac/pull/5358))
- Report each leg's own reasons for a merged e2e skip (internal). (see PR [#5240](https://github.com/tetherto/qvac/pull/5240))

## 🧹 Chores

- Move the native addon dependencies to the fabric 0.24 line and add @qvac/turbovec-ggml; one floor table replaces the intermediate bumps. (see PRs [#5227](https://github.com/tetherto/qvac/pull/5227), [#5293](https://github.com/tetherto/qvac/pull/5293), [#5297](https://github.com/tetherto/qvac/pull/5297), [#5302](https://github.com/tetherto/qvac/pull/5302), [#5328](https://github.com/tetherto/qvac/pull/5328), [#5347](https://github.com/tetherto/qvac/pull/5347), [#5350](https://github.com/tetherto/qvac/pull/5350), [#5386](https://github.com/tetherto/qvac/pull/5386)) - See [breaking changes](./breaking.md)
- Scan an explicit BCI backendsDir as given (bci-whispercpp ^0.14.0). (see PRs [#5293](https://github.com/tetherto/qvac/pull/5293), [#5350](https://github.com/tetherto/qvac/pull/5350)) - See [breaking changes](./breaking.md)
- Bundle with bare-pack ^3.0.2 (shipped with the CI change that skips addon post-publish tests). (see PR [#5058](https://github.com/tetherto/qvac/pull/5058)) - See [breaking changes](./breaking.md)
- Move model fit out of resources (internal). (see PR [#5280](https://github.com/tetherto/qvac/pull/5280))
- Replace the Kotlin bare-rpc implementation with bare-rpc-kotlin (Kotlin client, unpublished). (see PR [#5373](https://github.com/tetherto/qvac/pull/5373))

## ⚙️ Infrastructure

- Cut the Kotlin SDK checks' wall time (internal). (see PR [#5298](https://github.com/tetherto/qvac/pull/5298))
