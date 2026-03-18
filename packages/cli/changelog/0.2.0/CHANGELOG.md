# Changelog v0.2.0

Release Date: 2026-03-18

## 🔌 API

- Add OpenAI-compatible REST API server (qvac serve) - Part I. (see PR [#753](https://github.com/tetherto/qvac/pull/753)) - See [API changes](./api.md)
- Bump LLM/embed addons and wire per-request generation params. (see PR [#895](https://github.com/tetherto/qvac/pull/895))
- Add POST /v1/audio/transcriptions to qvac serve OpenAI adapter. (see PR [#915](https://github.com/tetherto/qvac/pull/915)) - See [API changes](./api.md)

## 🐞 Fixes

- Resolve Windows EFTYPE error when spawning bare-pack. (see PR [#949](https://github.com/tetherto/qvac/pull/949))
- Normalize composite JSON Schema types in tool parameter validation. (see PR [#964](https://github.com/tetherto/qvac/pull/964))

## 🧹 Chores

- Rename qvac-cli package to cli. (see PR [#644](https://github.com/tetherto/qvac/pull/644))
- Migrate CLI package from JavaScript to TypeScript. (see PR [#722](https://github.com/tetherto/qvac/pull/722))

