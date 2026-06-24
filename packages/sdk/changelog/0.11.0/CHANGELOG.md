# Changelog v0.11.0

Release Date: 2026-05-16

## ✨ Features

- Migrate SDK parakeet plugin to 0.4.0 GGML + duplex streaming. (see PR [#2018](https://github.com/tetherto/qvac/pull/2018)) - See [breaking changes](./breaking.md)
- CLI cancel bridge + cancelHandler retirement. (see PR [#2074](https://github.com/tetherto/qvac/pull/2074)) - See [breaking changes](./breaking.md)

## 🔌 API

- Expose split-mode and tensor-split in SDK LLM config. (see PR [#1759](https://github.com/tetherto/qvac/pull/1759)) - See [API changes](./api.md)
- Add FLUX.2 multi-reference fusion and LoRA adapter support to diffusion API. (see PR [#1838](https://github.com/tetherto/qvac/pull/1838)) - See [API changes](./api.md)
- Expose whisper VAD and end-of-turn events in transcribeStream. (see PR [#1848](https://github.com/tetherto/qvac/pull/1848)) - See [API changes](./api.md)
- Add harmony tool-call dialect (gpt-oss). (see PR [#1878](https://github.com/tetherto/qvac/pull/1878)) - See [API changes](./api.md)
- Add ESRGAN upscale support to SDK diffusion. (see PR [#1930](https://github.com/tetherto/qvac/pull/1930)) - See [API changes](./api.md)
- Introduce request lifecycle primitives with signal-based cancel. (see PR [#1949](https://github.com/tetherto/qvac/pull/1949)) - See [API changes](./api.md)
- Add Qwen3.5, Gemma4 tool-call dialects and reasoning_budget param. (see PR [#1974](https://github.com/tetherto/qvac/pull/1974)) - See [API changes](./api.md)
- Add standalone image upscaling support to the SDK. (see PR [#1990](https://github.com/tetherto/qvac/pull/1990)) - See [API changes](./api.md)
- Wire qvac verify bundle into Expo plugin. (see PR [#2000](https://github.com/tetherto/qvac/pull/2000)) - See [API changes](./api.md)
- Typed cancel outcomes on the wire + atomic KV-cache via KvCacheSession. (see PR [#2007](https://github.com/tetherto/qvac/pull/2007)) - See [API changes](./api.md)
- Add unloadModel autoClose option, default-off on Bare. (see PR [#2024](https://github.com/tetherto/qvac/pull/2024)) - See [breaking changes](./breaking.md), [API changes](./api.md)
- Cancel capability + per-handler cancel scope + structured logging. (see PR [#2036](https://github.com/tetherto/qvac/pull/2036)) - See [API changes](./api.md)
- Inference-handler migrations. (see PR [#2058](https://github.com/tetherto/qvac/pull/2058)) - See [API changes](./api.md)
- Non-inference migrations + decorated-promise requestId. (see PR [#2060](https://github.com/tetherto/qvac/pull/2060)) - See [API changes](./api.md)

## 🐞 Fixes

- Prime system-prompt KV cache via addon prefill instead of cancel-on-first-token. (see PR [#1880](https://github.com/tetherto/qvac/pull/1880))
- Avoid Node-only Buffer in RN duplex RPC path. (see PR [#1915](https://github.com/tetherto/qvac/pull/1915))
- Drop blocking dht.fullyBootstrapped() wait from delegated connect. (see PR [#1934](https://github.com/tetherto/qvac/pull/1934))
- Bundle SDK worker.js for packaged consumers. (see PR [#2011](https://github.com/tetherto/qvac/pull/2011))
- Bump @qvac/embed-llamacpp to ^0.16.0. (see PR [#2012](https://github.com/tetherto/qvac/pull/2012))
- Bump @qvac/transcription-whispercpp to ^0.7.0 in SDK. (see PR [#2015](https://github.com/tetherto/qvac/pull/2015))
- Bump @qvac/registry-client to ^0.5.0 in SDK. (see PR [#2076](https://github.com/tetherto/qvac/pull/2076))

## 📦 Models

- Bergamot vocab re-downloaded on every loadModel for shared-vocab pairs. (see PR [#1892](https://github.com/tetherto/qvac/pull/1892)) - See [model changes](./models.md)
- Sync sdk model registry to bergamot base-memory and drop deprecated marian opus. (see PR [#1903](https://github.com/tetherto/qvac/pull/1903)) - See [model changes](./models.md)
  Removed: NMT_Q0F16, NMT_Q0F16_1, NMT_Q0F16_2, NMT_Q0F16_3, NMT_Q0F16_4 (and 27 more)

## 🧪 Tests

- Skip multi-gpu tests on mobile. (see PR [#1998](https://github.com/tetherto/qvac/pull/1998))

## 🧹 Chores

- Move Holepunch libs to peerDependencies. (see PR [#1905](https://github.com/tetherto/qvac/pull/1905))
- Update tts-onnx to 0.9.0 and transcription-parakeet to 0.5.0. (see PR [#2063](https://github.com/tetherto/qvac/pull/2063))

## ⚙️ Infrastructure

- Scope e2e bootstrap to deps required by filtered tests. (see PR [#1991](https://github.com/tetherto/qvac/pull/1991))

