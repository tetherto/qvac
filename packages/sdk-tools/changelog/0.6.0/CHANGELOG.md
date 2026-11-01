# Changelog v0.6.0

Release Date: 2026-06-02

## ✨ Features

- Rewrite CLI bundle/verify as thin wrappers around @qvac/sdk/commands. (see PR [#2261](https://github.com/tetherto/qvac/pull/2261)) - See [breaking changes](./breaking.md)
- Delete CLI SDK wrapper layer, use static @qvac/sdk imports in serve. (see PR [#2267](https://github.com/tetherto/qvac/pull/2267)) - See [breaking changes](./breaking.md)
- Rewrite serve HTTP layer on Fastify + Zod. (see PR [#2306](https://github.com/tetherto/qvac/pull/2306)) - See [API changes](./api.md), [breaking changes](./breaking.md)

## 🔌 API

- Add live OpenAI coverage reporting to CLI. (see PR [#2103](https://github.com/tetherto/qvac/pull/2103)) - See [API changes](./api.md)
- Resolve SDK from hoisted node_modules in cli bundler. (see PR [#2140](https://github.com/tetherto/qvac/pull/2140)) - See [API changes](./api.md)
- Add OpenAI-compatible /v1/videos (txt2vid, async). (see PR [#2367](https://github.com/tetherto/qvac/pull/2367)) - See [API changes](./api.md)

## 📦 Models

- Migrate SDK TTS from onnx-tts to tts-ggml. (see PR [#2244](https://github.com/tetherto/qvac/pull/2244)) - See [breaking changes](./breaking.md), [model changes](./models.md)
  Added: TTS_S3GEN_MULTILINGUAL_CHATTERBOX, TTS_S3GEN_EN_CHATTERBOX, TTS_T3_MULTILINGUAL_CHATTERBOX_FP16, TTS_T3_TURBO_EN_CHATTERBOX_FP16, TTS_T3_MULTILINGUAL_CHATTERBOX_Q4_0 (and 7 more)
