# Changelog v0.5.0

Release Date: 2026-05-15

## ✨ Features

- CLI cancel bridge + cancelHandler retirement. (see PR [#2074](https://github.com/tetherto/qvac/pull/2074)) - See [breaking changes](./breaking.md)

## 🔌 API

- Add POST /v1/audio/speech to qvac serve OpenAI adapter. (see PR [#2009](https://github.com/tetherto/qvac/pull/2009)) - See [API changes](./api.md)
- Add /v1/vector_stores OpenAI endpoints to qvac serve. (see PR [#2013](https://github.com/tetherto/qvac/pull/2013)) - See [API changes](./api.md)
- Add OpenAI-compatible POST /v1/completions (legacy). (see PR [#2027](https://github.com/tetherto/qvac/pull/2027)) - See [API changes](./api.md)
- Add openai responses routes with in-memory store. (see PR [#2030](https://github.com/tetherto/qvac/pull/2030)) - See [API changes](./api.md)
- Add POST /v1/audio/translations to qvac serve OpenAI adapter. (see PR [#2031](https://github.com/tetherto/qvac/pull/2031)) - See [API changes](./api.md)
- Add POST /v1/images/edits to OpenAI adapter. (see PR [#2032](https://github.com/tetherto/qvac/pull/2032)) - See [breaking changes](./breaking.md), [API changes](./api.md)

## 🧹 Chores

- Bump `@qvac/sdk` dep from `^0.10.0` to `^0.11.0` and the `MIN_SDK_VERSION` runtime check in `serve/core/sdk.ts` from `'0.10.0'` to `'0.11.0'` to track the new requestId-based cancel surface that the CLI cancel bridge depends on. `qvac serve openai` now refuses to start if the installed `@qvac/sdk` is older than `0.11.0`.

