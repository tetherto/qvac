# Changelog v0.25.0

Release Date: 2026-11-25

## ✨ Features

- Recover malformed tool calls in inference. (see PR [#5846](https://github.com/tetherto/qvac/pull/5846))
- Size classification and MegaLoc loads in assessModelFit. (see PR [#5854](https://github.com/tetherto/qvac/pull/5854))
- Remove the RAG API from the SDK and inference. (see PR [#5874](https://github.com/tetherto/qvac/pull/5874)) - See [breaking changes](./breaking.md)
- Cancel queued and running vector index calls. (see PR [#5916](https://github.com/tetherto/qvac/pull/5916))
- Size BridgeDepth loads in assessModelFit. (see PR [#5954](https://github.com/tetherto/qvac/pull/5954))

## 🔌 API

- Forward diffusion performance profile options. (see PR [#5577](https://github.com/tetherto/qvac/pull/5577)) - See [API changes](./api.md)
- Expose TurboVec IVF search controls in the SDK. (see PR [#5745](https://github.com/tetherto/qvac/pull/5745)) - See [API changes](./api.md)
- Expose BridgeDepth stereo depth through the SDK. (see PR [#5795](https://github.com/tetherto/qvac/pull/5795)) - See [API changes](./api.md)
- Bound shared-runtime operations with deadlines. (see PR [#5850](https://github.com/tetherto/qvac/pull/5850)) - See [API changes](./api.md)
- Report the runtime's capability contracts and major versions. (see PR [#5851](https://github.com/tetherto/qvac/pull/5851)) - See [API changes](./api.md)
- Deprecate history attachments in favor of ordered content parts. (see PR [#5858](https://github.com/tetherto/qvac/pull/5858)) - See [API changes](./api.md)
- Judge model fit on shared memory and report why a fit is unknown. (see PR [#5860](https://github.com/tetherto/qvac/pull/5860)) - See [breaking changes](./breaking.md), [API changes](./api.md)
- Add qvac fit. (see PR [#5861](https://github.com/tetherto/qvac/pull/5861)) - See [API changes](./api.md)
- Enforce capability grants for each runtime session. (see PR [#5872](https://github.com/tetherto/qvac/pull/5872)) - See [API changes](./api.md)
- Forward the Core ML FFN load options for Qwen3.5. (see PR [#5879](https://github.com/tetherto/qvac/pull/5879)) - See [API changes](./api.md)
- Move the SDK onto the fabric 0.31 addon set with the new speech addons. (see PR [#5880](https://github.com/tetherto/qvac/pull/5880)) - See [breaking changes](./breaking.md), [API changes](./api.md)
- Support TranslatePsy-AfriNano and -EuroNano Bergamot packs. (see PR [#5908](https://github.com/tetherto/qvac/pull/5908)) - See [API changes](./api.md)
- Run Stable Diffusion on Core ML through the SDK with diffusion-cpp 0.38.0. (see PR [#5928](https://github.com/tetherto/qvac/pull/5928)) - See [API changes](./api.md)
- Accept spec_type 'draft-dspark' and 'auto' in the SDK. (see PR [#5945](https://github.com/tetherto/qvac/pull/5945)) - See [API changes](./api.md)
- Stage the full TranscribePsy EU Core ML bundles through the SDK. (see PR [#5956](https://github.com/tetherto/qvac/pull/5956)) - See [API changes](./api.md)

## 🐞 Fixes

- Keep clearStorage on a local sharded model to its own files. (see PR [#5594](https://github.com/tetherto/qvac/pull/5594))
- Keep sharded HTTP downloads inside the model cache, with e2e coverage. (see PR [#5811](https://github.com/tetherto/qvac/pull/5811))
- Prevent Parakeet TDT word loss. (see PR [#5845](https://github.com/tetherto/qvac/pull/5845)) - See [breaking changes](./breaking.md)
- Check base64 fields in one pass instead of a per-quad pattern. (see PR [#5939](https://github.com/tetherto/qvac/pull/5939))
- Pass image-max-megapixels to llm-llamacpp's fitter. (see PR [#5940](https://github.com/tetherto/qvac/pull/5940))
- Show why qvac serve re-downloads a cached model. (see PR [#5959](https://github.com/tetherto/qvac/pull/5959))
- Drop a KV cache file the addon cannot load. (see PR [#5968](https://github.com/tetherto/qvac/pull/5968))

## 📦 Models

- Add MOSS-Image, BotPsy and DeepSeek V4.1 model constants. (see PR [#5743](https://github.com/tetherto/qvac/pull/5743)) - See [model changes](./models.md)
  Added: MOSS_IMAGE_SFT_5B_BF16, MOSS_IMAGE_VAE, MOSS_IMAGE_SFT_TOKENIZER, BOTPSY_0_8B_TOOL_CALLING_BF16, BOTPSY_0_8B_TOOL_CALLING_Q4_K_M (and 4 more)
- Prefix QVAC-trained model constants with QVAC_ and regenerate the catalogs. (see PR [#5941](https://github.com/tetherto/qvac/pull/5941)) - See [model changes](./models.md)
  Added: QVAC_QWEN3_5_9B_TOOL_CALLING_Q4_K_M, TAESDXL_VAE, TAESD_VAE
- Add Inkling 2 Mini and Ternary Bonsai 2.5 27B model constants. (see PR [#6023](https://github.com/tetherto/qvac/pull/6023)) - See [model changes](./models.md)
  Added: INKLING2_MINI_26B_A3B_MULTIMODAL_UD_Q4_K_M, MMPROJ_INKLING2_MINI_26B_A3B_MULTIMODAL_F16, INKLING2_MINI_26B_A3B_DSPARK_Q8_0, INKLING2_MINI_26B_A3B_DFLASH2_Q8_0, TERNARY_BONSAI_2_5_27B_MULTIMODAL_Q2_0 (and 1 more)

## 📘 Docs

- Keep the setIvf docs true across fabric versions. (see PR [#5878](https://github.com/tetherto/qvac/pull/5878))
- Say how ctx_size splits across parallel slots. (see PR [#5967](https://github.com/tetherto/qvac/pull/5967))

## 🧪 Tests

- Cover Parakeet word-loss safeguards in the SDK. (see PR [#5937](https://github.com/tetherto/qvac/pull/5937))

## 🧹 Chores

- Move the SDK onto the fabric 0.33 addon set. (see PR [#5942](https://github.com/tetherto/qvac/pull/5942)) - See [breaking changes](./breaking.md)
- Use caret ranges for unpinned sdk, inference and cli dependencies. (see PR [#6009](https://github.com/tetherto/qvac/pull/6009))

## ⚙️ Infrastructure

- Move the SDK pod onto the package CI contract. (see PR [#5466](https://github.com/tetherto/qvac/pull/5466))
