# Changelog v0.17.0

Release Date: 2026-10-22

## ✨ Features

- Shared plumbing for /qvac/v1 endpoints. (see PR [#5246](https://github.com/tetherto/qvac/pull/5246))

## 🔌 API

- Add the OpenAI Decisions endpoint to qvac serve --openai. (see PR [#5176](https://github.com/tetherto/qvac/pull/5176)) - See [breaking changes](./breaking.md) and [API changes](./api.md)
- Serve system resources and model fit on /qvac/v1. (see PR [#5219](https://github.com/tetherto/qvac/pull/5219)) - See [API changes](./api.md)
- Stream /v1/audio/speech over SSE. (see PR [#5220](https://github.com/tetherto/qvac/pull/5220)) - See [API changes](./api.md)
- Serve batch chat completion on /qvac/v1/chat/batch. (see PR [#5247](https://github.com/tetherto/qvac/pull/5247)) - See [API changes](./api.md)

## 🐞 Fixes

- Reject unexpected Host headers on qvac serve. (see PR [#5141](https://github.com/tetherto/qvac/pull/5141)) - See [breaking changes](./breaking.md)
- Refuse private-network fetches for video image URLs. (see PR [#5224](https://github.com/tetherto/qvac/pull/5224))
