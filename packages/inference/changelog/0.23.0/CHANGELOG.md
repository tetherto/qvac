# Changelog v0.23.0

Release Date: 2026-10-29

## ✨ Features

- Integrate standalone TurboVec addon for vector indexing. (see PR [#5227](https://github.com/tetherto/qvac/pull/5227)) - See [breaking changes](./breaking.md)
- Drop rank pooling from the embedding config schema. (see PR [#5277](https://github.com/tetherto/qvac/pull/5277)) - See [breaking changes](./breaking.md)
- Run the model fit in process on every platform. (see PR [#5279](https://github.com/tetherto/qvac/pull/5279)) - See [breaking changes](./breaking.md)
- Default parallel_tool_calls to true. (see PR [#5283](https://github.com/tetherto/qvac/pull/5283)) - See [breaking changes](./breaking.md)
- Detect the tool dialect from the GGUF architecture. (see PR [#5287](https://github.com/tetherto/qvac/pull/5287))
- Await async TurboVec index providers in inference. (see PR [#5385](https://github.com/tetherto/qvac/pull/5385))

## 🔌 API

- Let a log subscription be closed with an abort signal. (see PR [#4959](https://github.com/tetherto/qvac/pull/4959)) - See [API changes](./api.md)
- Assess ESRGAN and ABot world memory fit. (see PR [#5038](https://github.com/tetherto/qvac/pull/5038)) - See [API changes](./api.md)
- Expose the prompt-cache keys in the llm load config. (see PR [#5124](https://github.com/tetherto/qvac/pull/5124)) - See [API changes](./api.md)
- Expose CPU polling controls for llama.cpp models. (see PR [#5216](https://github.com/tetherto/qvac/pull/5216)) - See [API changes](./api.md)
- Expose llm-llamacpp speculative decoding. (see PR [#5261](https://github.com/tetherto/qvac/pull/5261)) - See [API changes](./api.md)
- Add reranking with a llamacpp-rerank model type and rerank(). (see PR [#5285](https://github.com/tetherto/qvac/pull/5285)) - See [API changes](./api.md)
- Support Qwen-Image-2.1 generation and reference editing. (see PR [#5302](https://github.com/tetherto/qvac/pull/5302)) - See [breaking changes](./breaking.md), [API changes](./api.md)
- Prime system prompts and tools through completion. (see PR [#5312](https://github.com/tetherto/qvac/pull/5312)) - See [API changes](./api.md)
- Add TranscribePsy transcription. (see PR [#5347](https://github.com/tetherto/qvac/pull/5347)) - See [API changes](./api.md)
- Report a missing registry model as ModelRegistryModelNotFoundError. (see PR [#5356](https://github.com/tetherto/qvac/pull/5356)) - See [breaking changes](./breaking.md), [API changes](./api.md)

## 🐞 Fixes

- Resolve the lighter CosyVoice3 companion set. (see PR [#5175](https://github.com/tetherto/qvac/pull/5175)) - See [model changes](./models.md)
  Updated: TTS_COSYVOICE3_LLM_COSYVOICE_Q4_0
- Load TurboVec only when creating or loading an index. (see PR [#5239](https://github.com/tetherto/qvac/pull/5239))
- Avoid rehashing unchanged cached models. (see PR [#5313](https://github.com/tetherto/qvac/pull/5313))
- Disable decoded-audio response retention. (see PR [#5340](https://github.com/tetherto/qvac/pull/5340))
- Declare tools loaded by tool_search in the tools block. (see PR [#5346](https://github.com/tetherto/qvac/pull/5346)) - See [breaking changes](./breaking.md)

## 📦 Models

- Sync model constants and name the TranscribePsy Parakeet models. (see PR [#5316](https://github.com/tetherto/qvac/pull/5316)) - See [model changes](./models.md)
  Added: QWEN3_5_0_8B_MTP_Q4_K_M, QWEN3_5_2B_MTP_Q4_K_M, QWEN3_5_4B_MTP_Q4_K_M, QWEN3_5_9B_MTP_Q4_K_M, QWEN3_5_4B_DFLASH_Q8_0 (and 4 more)

## 🧹 Chores

- Move the native addon peer floors to the fabric 0.24 line and add the optional @qvac/turbovec-ggml peer; one floor table replaces the intermediate bumps. (see PRs [#5227](https://github.com/tetherto/qvac/pull/5227), [#5293](https://github.com/tetherto/qvac/pull/5293), [#5297](https://github.com/tetherto/qvac/pull/5297), [#5302](https://github.com/tetherto/qvac/pull/5302), [#5328](https://github.com/tetherto/qvac/pull/5328), [#5347](https://github.com/tetherto/qvac/pull/5347), [#5350](https://github.com/tetherto/qvac/pull/5350), [#5385](https://github.com/tetherto/qvac/pull/5385), [#5386](https://github.com/tetherto/qvac/pull/5386)) - See [breaking changes](./breaking.md)
- Scan an explicit BCI backendsDir as given (bci-whispercpp ^0.14.0). (see PRs [#5293](https://github.com/tetherto/qvac/pull/5293), [#5350](https://github.com/tetherto/qvac/pull/5350)) - See [breaking changes](./breaking.md)
- Move model fit out of resources (internal). (see PR [#5280](https://github.com/tetherto/qvac/pull/5280))
