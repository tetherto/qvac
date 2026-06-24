# Changelog v0.3.0

Release Date: 2026-04-30

## 🔌 API

- Wire OpenAI's standard `response_format` field through `qvac serve` (POST `/v1/chat/completions`). The body field is parsed, validated, and forwarded to the SDK as `responseFormat`, enabling structured-output requests (`text` / `json_object` / `json_schema`) over the OpenAI-compatible HTTP surface. Requires `@qvac/sdk` `^0.10.0`. (see PR [#1810](https://github.com/tetherto/qvac/pull/1810)) - See [API changes](./api.md)

