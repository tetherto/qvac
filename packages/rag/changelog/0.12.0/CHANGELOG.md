# Changelog v0.12.0

Release Date: 2026-11-26

## 🔌 API

- Harden @qvac/rag for host integrations and store float16 vectors. (see PR [#5979](https://github.com/tetherto/qvac/pull/5979)) - See [API changes](./api.md) and [breaking changes](./breaking.md)
- Resolve rag snapshot fs per runtime and report snapshot errors. (see PR [#5996](https://github.com/tetherto/qvac/pull/5996)) - See [API changes](./api.md)

## 🐞 Fixes

- Await the TurboVec 0.7 async index in @qvac/rag. (see PR [#5876](https://github.com/tetherto/qvac/pull/5876))
- Build @qvac/rag without the bare CLI. (see PR [#5970](https://github.com/tetherto/qvac/pull/5970))

## 🧹 Chores

- Move the SDK onto the fabric 0.33 addon set; `@qvac/turbovec-ggml` peer range is now `^0.8.0`. (see PR [#5942](https://github.com/tetherto/qvac/pull/5942)) - See [breaking changes](./breaking.md)
