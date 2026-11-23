# Changelog v0.10.0

Release Date: 2026-11-11

## ✨ Features

- Rebuild @qvac/rag core on HyperDB with scoped search. (see PR [#5483](https://github.com/tetherto/qvac/pull/5483)) - See [breaking changes](./breaking.md)

## 🔌 API

- Derive a TurboVec index for @qvac/rag namespaces. (see PR [#5670](https://github.com/tetherto/qvac/pull/5670)) - See [API changes](./api.md)
- Ingest text and pre-chunked documents through an embeddings port. (see PR [#5671](https://github.com/tetherto/qvac/pull/5671)) - See [API changes](./api.md)
- Skip unchanged re-ingest and report replaced chunks in @qvac/rag. (see PR [#5693](https://github.com/tetherto/qvac/pull/5693)) - See [API changes](./api.md)

## 🐞 Fixes

- Let @qvac/rag import on Node.js. (see PR [#5440](https://github.com/tetherto/qvac/pull/5440))
