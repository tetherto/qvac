# Changelog v0.15.0

Release Date: 2026-07-09

## 🔌 API

- Single-job batch processing. (see PR [#2627](https://github.com/tetherto/qvac/pull/2627)) - See [API changes](./api.md)
- Expose llm-llamacpp mmproj-use-gpu config key. (see PR [#3170](https://github.com/tetherto/qvac/pull/3170)) - See [API changes](./api.md)

## 🐞 Fixes

- Bundle sdk resolves the SDK's hoisted bare-* deps for symlinked installs. (see PR [#2947](https://github.com/tetherto/qvac/pull/2947))
- Honor registry descriptor cache metadata. (see PR [#2984](https://github.com/tetherto/qvac/pull/2984))
- Always terminate() the bare worklet on Android. (see PR [#3010](https://github.com/tetherto/qvac/pull/3010))
- Preserve ValidationHelpers.validate this-binding in TTS e2e executors. (see PR [#3117](https://github.com/tetherto/qvac/pull/3117))
- Map bare-rpc channel-closed errors to worker error classes. (see PR [#3148](https://github.com/tetherto/qvac/pull/3148))

## 📦 Models

- Add LavaSR speech enhancer and denoiser support to TTS. (see PR [#3069](https://github.com/tetherto/qvac/pull/3069)) - See [API changes](./api.md), [model changes](./models.md)
  Added: TTS_ENHANCER_LAVASR_FP16, TTS_ENHANCER_LAVASR_FP32, TTS_DENOISER_LAVASR_FP16, TTS_DENOISER_LAVASR_FP32, PARAKEET_CTC_0_6B_F16 (and 4 more)
  Updated: TTS_MULTILINGUAL_SUPERTONIC3_Q4_0
- Add chatterbox japanese and chinese asset support. (see PR [#3091](https://github.com/tetherto/qvac/pull/3091)) - See [API changes](./api.md), [model changes](./models.md)
  Added: TTS_CANGJIE_ZH_CHATTERBOX

## 🧪 Tests

- Skip mobile HTTP download-resilience when flaky server unreachable. (see PR [#2925](https://github.com/tetherto/qvac/pull/2925))

## 🧹 Chores

- Bump SDK whisper dependency to 0.11.0. (see PR [#3011](https://github.com/tetherto/qvac/pull/3011))
- Bump SDK BCI whisper dependency. (see PR [#3013](https://github.com/tetherto/qvac/pull/3013))
- Make gguf NeedMoreDataError erasable-syntax-only. (see PR [#3018](https://github.com/tetherto/qvac/pull/3018))
- Adopt Prettier across SDK-pod packages. (see PR [#3039](https://github.com/tetherto/qvac/pull/3039))
- Unify lint/format/typecheck across SDK-pod packages. (see PR [#3040](https://github.com/tetherto/qvac/pull/3040))
- Bump sdk parakeet dependency. (see PR [#3122](https://github.com/tetherto/qvac/pull/3122))
- Bump SDK addon dependency ranges. (see PR [#3150](https://github.com/tetherto/qvac/pull/3150))
- Adopt fabric 9341.1.6 consumer releases in SDK addon dependencies. (see PR [#3167](https://github.com/tetherto/qvac/pull/3167))

