# Changelog v0.21.0

Release Date: 2026-11-25

## ✨ Features

- Recover malformed tool calls in inference. (see PR [#5846](https://github.com/tetherto/qvac/pull/5846))
- Remove the RAG API from the SDK and inference; `/v1/vector_stores` now runs on `@qvac/rag`. (see PR [#5874](https://github.com/tetherto/qvac/pull/5874)) - See [breaking changes](./breaking.md)

## 🔌 API

- Serve custom plugin invoke behind --enable-admin. (see PR [#5533](https://github.com/tetherto/qvac/pull/5533)) - See [API changes](./api.md)
- Report the runtime's capability contracts and major versions. (see PR [#5851](https://github.com/tetherto/qvac/pull/5851)) - See [API changes](./api.md)
- Deprecate history attachments in favor of ordered content parts. (see PR [#5858](https://github.com/tetherto/qvac/pull/5858)) - See [API changes](./api.md)
- Judge model fit on shared memory and report why a fit is unknown. (see PR [#5860](https://github.com/tetherto/qvac/pull/5860)) - See [breaking changes](./breaking.md), [API changes](./api.md)
- Add qvac fit. (see PR [#5861](https://github.com/tetherto/qvac/pull/5861)) - See [API changes](./api.md)

## 🐞 Fixes

- Write serve upload temp files into private directories. (see PR [#5917](https://github.com/tetherto/qvac/pull/5917))
- Report full prompt usage and standard statuses to coding agents. (see PR [#5931](https://github.com/tetherto/qvac/pull/5931)) - See [breaking changes](./breaking.md)
- Show why qvac serve re-downloads a cached model. (see PR [#5959](https://github.com/tetherto/qvac/pull/5959))

## Compatibility

- Released with the SDK train. Depends on `@qvac/sdk@^0.25.0`.
