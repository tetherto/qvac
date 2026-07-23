# Changelog v0.12.0

Release Date: 2026-05-29

## ✨ Features

- Migrate SDK parakeet transcription to 0.6.0 GGML. (see PR [#2184](https://github.com/tetherto/qvac/pull/2184)) - See [breaking changes](./breaking.md)
- Add @qvac/bare-sdk with explicit Bare plugin registration. (see PR [#2292](https://github.com/tetherto/qvac/pull/2292)) - See [breaking changes](./breaking.md)

## 🔌 API

- Resolve SDK from hoisted node_modules in expo plugins. (see PR [#2139](https://github.com/tetherto/qvac/pull/2139)) - See [API changes](./api.md)
- Integrate SmolVLA addon into SDK. (see PR [#2190](https://github.com/tetherto/qvac/pull/2190)) - See [API changes](./api.md)
- Integrate @qvac/classification-ggml into SDK. (see PR [#2236](https://github.com/tetherto/qvac/pull/2236)) - See [API changes](./api.md)
- Add text-to-video support with WAN models to the SDK. (see PR [#2243](https://github.com/tetherto/qvac/pull/2243)) - See [API changes](./api.md)
- Add @qvac/sdk/commands subpath. (see PR [#2253](https://github.com/tetherto/qvac/pull/2253)) - See [API changes](./api.md)
- Forward device + expose backendDevice for standalone ESRGAN upscaler. (see PR [#2274](https://github.com/tetherto/qvac/pull/2274)) - See [API changes](./api.md)
- Export RAG_ERROR_CODES from SDK for cancellation detection. (see PR [#2291](https://github.com/tetherto/qvac/pull/2291)) - See [API changes](./api.md)
- Surface promptTokens and ContextOverflowError on completion. (see PR [#2330](https://github.com/tetherto/qvac/pull/2330)) - See [API changes](./api.md)

## 🐞 Fixes

- Bump drifted peer ranges + trim redundant SDK peer entries. (see PR [#2089](https://github.com/tetherto/qvac/pull/2089))
- Widen react-native-bare-kit peer to ^0.14.0. (see PR [#2116](https://github.com/tetherto/qvac/pull/2116)) - See [breaking changes](./breaking.md)
- Drop SDK peerDependencies; enforce in CI. (see PR [#2126](https://github.com/tetherto/qvac/pull/2126))
- Align suspend/resume order in runtime-lifecycle. (see PR [#2145](https://github.com/tetherto/qvac/pull/2145))
- Make @qvac/sdk buildable under both bun and npm. (see PR [#2265](https://github.com/tetherto/qvac/pull/2265))
- Use snap common dir for qvac home. (see PR [#2287](https://github.com/tetherto/qvac/pull/2287))
- Route Bare delegated RPC through registry. (see PR [#2293](https://github.com/tetherto/qvac/pull/2293))

## 📦 Models

- Expose diffusion_fa, drop flux_flow, sync model registry. (see PR [#2046](https://github.com/tetherto/qvac/pull/2046)) - See [API changes](./api.md), [model changes](./models.md)
  Added: GEMMA4_31B_MULTIMODAL_Q4_K_M, GEMMA4_31B_MULTIMODAL_Q6_K, MMPROJ_GEMMA4_31B_MULTIMODAL_BF16, MMPROJ_GEMMA4_31B_MULTIMODAL_F16, GEMMA4_2B_MULTIMODAL_Q4_K_M (and 60 more)
  Updated: BERGAMOT_EN_BG, BERGAMOT_EN_HR, BERGAMOT_EN_NL, BERGAMOT_METADATA_13
- Migrate SDK TTS from onnx-tts to tts-ggml. (see PR [#2244](https://github.com/tetherto/qvac/pull/2244)) - See [breaking changes](./breaking.md), [model changes](./models.md)
  Added: TTS_S3GEN_MULTILINGUAL_CHATTERBOX, TTS_S3GEN_EN_CHATTERBOX, TTS_T3_MULTILINGUAL_CHATTERBOX_FP16, TTS_T3_TURBO_EN_CHATTERBOX_FP16, TTS_T3_MULTILINGUAL_CHATTERBOX_Q4_0 (and 7 more)

## 🧪 Tests

- Extend e2e cancel coverage across modalities + policy reject. (see PR [#2155](https://github.com/tetherto/qvac/pull/2155))

## 🧹 Chores

- Align ModelLoadingExecutor with ResourceManager. (see PR [#2135](https://github.com/tetherto/qvac/pull/2135))
- Rename e2e test suite from tests-qvac to e2e. (see PR [#2242](https://github.com/tetherto/qvac/pull/2242))
- Update SDK addon dependencies. (see PR [#2264](https://github.com/tetherto/qvac/pull/2264))
- Bump @qvac/rag and @qvac/registry-client to ^0.6.0. (see PR [#2281](https://github.com/tetherto/qvac/pull/2281))
- Bump @qvac/tts-ggml to ^0.1.4. (see PR [#2321](https://github.com/tetherto/qvac/pull/2321))

## ⚙️ Infrastructure

- Pre-download every model constant referenced by tests-qvac consumers. (see PR [#2049](https://github.com/tetherto/qvac/pull/2049))

