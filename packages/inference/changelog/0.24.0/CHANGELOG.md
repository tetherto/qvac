# Changelog v0.24.0

Release Date: 2026-11-13

## ✨ Features

- Load the MobileNet classifier from the registry. (see PR [#5551](https://github.com/tetherto/qvac/pull/5551)) - See [breaking changes](./breaking.md)
- Support FLUX.3 Image Klein in the SDK. (see PR [#5668](https://github.com/tetherto/qvac/pull/5668))

## 🔌 API

- Run the SDK worker on bare-stow. (see PR [#5186](https://github.com/tetherto/qvac/pull/5186)) - See [breaking changes](./breaking.md), [API changes](./api.md)
- Seed a new chat from an existing cache. (see PR [#5291](https://github.com/tetherto/qvac/pull/5291)) - See [API changes](./api.md)
- Add chunked Int16Array output to textToSpeech. (see PR [#5348](https://github.com/tetherto/qvac/pull/5348)) - See [API changes](./api.md)
- Replace JSON PCM transport with binary audio transport. (see PR [#5380](https://github.com/tetherto/qvac/pull/5380)) - See [API changes](./api.md)
- Keep backend fields on streamed TTS stats and put the audiogen GPU fallback code on the wire. (see PR [#5384](https://github.com/tetherto/qvac/pull/5384)) - See [API changes](./api.md)
- Support EmbeddingGemma 2 multimodal embeddings. (see PR [#5464](https://github.com/tetherto/qvac/pull/5464)) - See [breaking changes](./breaking.md), [API changes](./api.md)
- Expose whisper segment fields and prompt/GPU controls in the SDK. (see PR [#5468](https://github.com/tetherto/qvac/pull/5468)) - See [API changes](./api.md)
- Expose parakeet energy-VAD tuning and prewarm controls in the SDK. (see PR [#5478](https://github.com/tetherto/qvac/pull/5478)) - See [API changes](./api.md)
- Expose MegaLoc image embeddings through SDK. (see PR [#5499](https://github.com/tetherto/qvac/pull/5499)) - See [API changes](./api.md)
- Accept ordered text and media content in history. (see PR [#5505](https://github.com/tetherto/qvac/pull/5505)) - See [breaking changes](./breaking.md), [API changes](./api.md)
- Expose MOSS backend, ASR stats and VAD timestamp fields in the SDK. (see PR [#5510](https://github.com/tetherto/qvac/pull/5510)) - See [API changes](./api.md)
- Answer model fit from the addons' per-device memory. (see PR [#5512](https://github.com/tetherto/qvac/pull/5512)) - See [breaking changes](./breaking.md), [API changes](./api.md)
- Resume paused registry downloads and reclaim abandoned ones. (see PR [#5534](https://github.com/tetherto/qvac/pull/5534)) - See [API changes](./api.md)
- SDK caller sessions, model leases and scoped cancellation. (see PR [#5541](https://github.com/tetherto/qvac/pull/5541)) - See [breaking changes](./breaking.md), [API changes](./api.md)
- Expose the tts-ggml controls and stats the SDK dropped. (see PR [#5554](https://github.com/tetherto/qvac/pull/5554)) - See [API changes](./api.md)
- Cache SDK e2e models per model and restore only what each leg runs. (see PR [#5556](https://github.com/tetherto/qvac/pull/5556)) - See [API changes](./api.md)
- Add SDK support for Qwen-Image-2.1-Turbo. (see PR [#5576](https://github.com/tetherto/qvac/pull/5576)) - See [API changes](./api.md)
- Add chunkStream, encoded output and MiniMax Core ML to audioGen. (see PR [#5604](https://github.com/tetherto/qvac/pull/5604)) - See [API changes](./api.md)
- Report AMD APU memory and GPU carve-outs from bare-gpu-info 0.1.3. (see PR [#5612](https://github.com/tetherto/qvac/pull/5612)) - See [API changes](./api.md)
- Support device 'npu' for the AMD XDNA NPU in the SDK. (see PR [#5635](https://github.com/tetherto/qvac/pull/5635)) - See [API changes](./api.md)
- Load MOSS-Image JSON layout text-to-image with tokenizerSrc. (see PR [#5644](https://github.com/tetherto/qvac/pull/5644)) - See [API changes](./api.md)
- Expose Parakeet backend, speaker attribution and streaming metadata in the SDK. (see PR [#5659](https://github.com/tetherto/qvac/pull/5659)) - See [API changes](./api.md)
- Expose calcTokens in the SDK. (see PR [#5663](https://github.com/tetherto/qvac/pull/5663)) - See [API changes](./api.md)
- Let completion requests set tool_search limits. (see PR [#5669](https://github.com/tetherto/qvac/pull/5669)) - See [API changes](./api.md)
- Expose ACE-Step backend selection and the audiogen Core ML sidecars. (see PR [#5673](https://github.com/tetherto/qvac/pull/5673)) - See [API changes](./api.md)
- Expose the tts-ggml 0.15 backend, Core ML, sampling and replay controls. (see PR [#5684](https://github.com/tetherto/qvac/pull/5684)) - See [API changes](./api.md)
- Expose TurboVec calibration and staged search controls. (see PR [#5691](https://github.com/tetherto/qvac/pull/5691)) - See [API changes](./api.md)
- Let QVAC processes share the model registry store. (see PR [#5707](https://github.com/tetherto/qvac/pull/5707)) - See [API changes](./api.md)

## 🐞 Fixes

- Preserve UTF-8 tool callback results. (see PR [#5336](https://github.com/tetherto/qvac/pull/5336))
- Stabilize SDK e2e runs and let model-fit crash markers expire. (see PR [#5484](https://github.com/tetherto/qvac/pull/5484))
- Treat Core ML source-package files as companions. (see PR [#5486](https://github.com/tetherto/qvac/pull/5486))
- Preserve LLM completion stop reasons in the SDK. (see PR [#5516](https://github.com/tetherto/qvac/pull/5516))
- Raise the bare-fs floor to ^4.8.4 so Windows can reopen on-disk stores. (see PR [#5586](https://github.com/tetherto/qvac/pull/5586))
- Load only strong tool_search matches, and an exact name alone. (see PR [#5639](https://github.com/tetherto/qvac/pull/5639))
- Run rerank on the CPU on Pixel phones. (see PR [#5652](https://github.com/tetherto/qvac/pull/5652))
- Load sharded GGUF models without a tensors.txt file. (see PR [#5665](https://github.com/tetherto/qvac/pull/5665))
- Send no system message unless the caller configures one. (see PR [#5686](https://github.com/tetherto/qvac/pull/5686)) - See [breaking changes](./breaking.md)
- Drop the framing newlines around reasoning and the answer. (see PR [#5688](https://github.com/tetherto/qvac/pull/5688))
- Stop separate processes from corrupting or deleting each other's model downloads. (see PR [#5689](https://github.com/tetherto/qvac/pull/5689))
- Reject a prefill with no message and fix the SDK e2e prefill failures. (see PR [#5708](https://github.com/tetherto/qvac/pull/5708)) - See [breaking changes](./breaking.md)
- End an open <think> block at a tool call and return a reasoning-only answer as content. (see PR [#5712](https://github.com/tetherto/qvac/pull/5712))
- Let deleteCache wait for a download this process just cancelled. (see PR [#5750](https://github.com/tetherto/qvac/pull/5750))

## 📦 Models

- Refresh model constants from registry. (see PR [#5431](https://github.com/tetherto/qvac/pull/5431)) - See [model changes](./models.md)
  Added: MOBILENETV3_3CLASS_V3_FP16, PARAKEET_NEMOTRON_3_DIARIZATION_Q4_K, PARAKEET_MOSAIC_Q4_0_Q8_0, PARAKEET_MOSAIC_COMPACT_Q4_0_Q8_0_Q3_K_IQ3_S, AUDIOGEN_ACESTEP_V15_TURBO_BF16 (and 4 more)
- Add MegaLoc registry models. (see PR [#5498](https://github.com/tetherto/qvac/pull/5498)) - See [model changes](./models.md)
  Added: MEGALOC_F16, MEGALOC_MIXED
- Point EmbeddingGemma-300M constants at the Dense-layer models. (see PR [#5634](https://github.com/tetherto/qvac/pull/5634)) - See [breaking changes](./breaking.md), [model changes](./models.md)
  Updated: EMBEDDINGGEMMA_300M_BF16, EMBEDDINGGEMMA_300M_Q4_0, EMBEDDINGGEMMA_300M_Q8_0
  Removed: EMBEDDINGGEMMA_300M_F32
- Add TranscribePsy-250M-EU support to the SDK. (see PR [#5683](https://github.com/tetherto/qvac/pull/5683)) - See [API changes](./api.md), [model changes](./models.md)
  Added: PARAKEET_TRANSCRIBEPSY_250M_EU_Q8_0

## 🧪 Tests

- Cover shared prompt-prefix caching in the SDK. (see PR [#5571](https://github.com/tetherto/qvac/pull/5571))

## 🧹 Chores

- Consume decoder-audio 0.9.0 in ASR and SDK. (see PR [#5596](https://github.com/tetherto/qvac/pull/5596))
- Move inference to @qvac/registry-client ^0.8.0. (see PR [#5597](https://github.com/tetherto/qvac/pull/5597))
- Remove RPC inventory protocol version filtering. (see PR [#5678](https://github.com/tetherto/qvac/pull/5678))
- Move @qvac/sdk and @qvac/inference to bare-rpc ^2.0.0. (see PR [#5717](https://github.com/tetherto/qvac/pull/5717))

## ⚙️ Infrastructure

- Run a Pear e2e on the inference release against the latest pear-runtime and Bare. (see PR [#5539](https://github.com/tetherto/qvac/pull/5539))
