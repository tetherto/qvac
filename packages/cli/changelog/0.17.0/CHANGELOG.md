# Changelog v0.17.0

Release Date: 2026-10-20

## 💥 Breaking Changes

- Replace `qvac serve --systemone` with `POST /v1/decisions`. (see PR [#5176](https://github.com/tetherto/qvac/pull/5176)) - See [breaking changes](./breaking.md)

## 🔌 API

- Add the OpenAI Decisions endpoint to qvac serve --openai. (see PR [#5176](https://github.com/tetherto/qvac/pull/5176)) - See [API changes](./api.md)
- Accept `poll` and `pollBatch` on llama.cpp serve aliases through `@qvac/sdk` 0.23. (see PR [#5216](https://github.com/tetherto/qvac/pull/5216)) - See [API changes](./api.md)

## 🐞 Fixes

- Reject unexpected Host headers on qvac serve. (see PR [#5141](https://github.com/tetherto/qvac/pull/5141)) - See [breaking changes](./breaking.md), [API changes](./api.md)

## Compatibility

- Depends on `@qvac/sdk@^0.23.0`.
