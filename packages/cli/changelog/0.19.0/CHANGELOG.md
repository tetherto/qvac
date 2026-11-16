# Changelog v0.19.0

Release Date: 2026-11-13

## ✨ Features

- Load the MobileNet classifier from the registry. (see PR [#5551](https://github.com/tetherto/qvac/pull/5551)) - See [breaking changes](./breaking.md)
- Default qvac serve port to 11435. (see PR [#5695](https://github.com/tetherto/qvac/pull/5695)) - See [breaking changes](./breaking.md)

## 🔌 API

- Run the SDK worker on bare-stow. (see PR [#5186](https://github.com/tetherto/qvac/pull/5186)) - See [breaking changes](./breaking.md), [API changes](./api.md)
- Experimental world scene endpoints under /qvac/v1/world. (see PR [#5421](https://github.com/tetherto/qvac/pull/5421)) - See [API changes](./api.md)
- Serve runtime state, loaded models and admin-gated suspend/resume. (see PR [#5426](https://github.com/tetherto/qvac/pull/5426)) - See [API changes](./api.md)
- Expose whisper segment fields and prompt/GPU controls in the SDK. (see PR [#5468](https://github.com/tetherto/qvac/pull/5468)) - See [API changes](./api.md)
- Accept ordered text and media content in history. (see PR [#5505](https://github.com/tetherto/qvac/pull/5505)) - See [breaking changes](./breaking.md), [API changes](./api.md)
- Answer model fit from the addons' per-device memory. (see PR [#5512](https://github.com/tetherto/qvac/pull/5512)) - See [breaking changes](./breaking.md), [API changes](./api.md)
- SDK caller sessions, model leases and scoped cancellation. (see PR [#5541](https://github.com/tetherto/qvac/pull/5541)) - See [breaking changes](./breaking.md), [API changes](./api.md)
- Named KV cache sessions for /v1/responses. (see PR [#5548](https://github.com/tetherto/qvac/pull/5548)) - See [breaking changes](./breaking.md), [API changes](./api.md)
- Expose the tts-ggml controls and stats the SDK dropped. (see PR [#5554](https://github.com/tetherto/qvac/pull/5554)) - See [API changes](./api.md)
- Report input tokens and separate reasoning on /v1/responses. (see PR [#5557](https://github.com/tetherto/qvac/pull/5557)) - See [API changes](./api.md)
- Make /v1/responses work with Codex requests. (see PR [#5559](https://github.com/tetherto/qvac/pull/5559)) - See [API changes](./api.md)
- Load MOSS-Image JSON layout text-to-image with tokenizerSrc. (see PR [#5644](https://github.com/tetherto/qvac/pull/5644)) - See [API changes](./api.md)
- Expose Parakeet backend, speaker attribution and streaming metadata in the SDK. (see PR [#5659](https://github.com/tetherto/qvac/pull/5659)) - See [API changes](./api.md)
- Expose the tts-ggml 0.15 backend, Core ML, sampling and replay controls. (see PR [#5684](https://github.com/tetherto/qvac/pull/5684)) - See [API changes](./api.md)
- Let QVAC processes share the model registry store. (see PR [#5707](https://github.com/tetherto/qvac/pull/5707)) - See [API changes](./api.md)

## 🐞 Fixes

- Close, bundle, verify and host transport defects in the bare-stow worker. (see PR [#5680](https://github.com/tetherto/qvac/pull/5680))

## 🧹 Chores

- Move @qvac/sdk and @qvac/inference to bare-rpc ^2.0.0. (see PR [#5717](https://github.com/tetherto/qvac/pull/5717))
