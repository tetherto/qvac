# Changelog v0.6.0

Release Date: 2026-02-02

## ✨ Features

- RAG lifecycle improvements with progress streaming, cancellation & workspace management. (see PR [#329](https://github.com/tetherto/qvac-sdk/pull/329)) - See [breaking changes](./breaking.md)
- Improve embed config with structured options. (see PR [#335](https://github.com/tetherto/qvac-sdk/pull/335)) - See [breaking changes](./breaking.md)
- Add Bergamot translation engine support. (see PR [#343](https://github.com/tetherto/qvac-sdk/pull/343)) - See [breaking changes](./breaking.md)
- Migrate to import maps for cross-runtime compatibility. (see PR [#371](https://github.com/tetherto/qvac-sdk/pull/371))

## 🔌 API

- Add Support for Sharded Pattern-Based URLs Model Downloads. (see PR [#305](https://github.com/tetherto/qvac-sdk/pull/305)) - See [API changes](./api.md)
- Add Support for Archive-Based Sharded Models. (see PR [#311](https://github.com/tetherto/qvac-sdk/pull/311)) - See [API changes](./api.md)
- Add OCR addon. (see PR [#312](https://github.com/tetherto/qvac-sdk/pull/312)) - See [API changes](./api.md)
- Unify model type naming with canonical engine-usecase format. (see PR [#384](https://github.com/tetherto/qvac-sdk/pull/384)) - See [API changes](./api.md)
- Add runtime context, model config per device/brand/platform. (see PR [#389](https://github.com/tetherto/qvac-sdk/pull/389)) - See [API changes](./api.md)

## 🐞 Fixes

- Eliminate whisper transcription cold start delay. (see PR [#334](https://github.com/tetherto/qvac-sdk/pull/334))
- Validate file size in isCached check to detect incomplete downloads. (see PR [#339](https://github.com/tetherto/qvac-sdk/pull/339))
- Add offline fallback for HTTP model cache validation. (see PR [#344](https://github.com/tetherto/qvac-sdk/pull/344))
- Enable archive extraction on mobile and update RAG test executor. (see PR [#345](https://github.com/tetherto/qvac-sdk/pull/345))
- KV cache not reusing context after initialization. (see PR [#378](https://github.com/tetherto/qvac-sdk/pull/378))
- Pear stage compatibility for dev packages. (see PR [#385](https://github.com/tetherto/qvac-sdk/pull/385))
- KV cache not reusing across requests. (see PR [#386](https://github.com/tetherto/qvac-sdk/pull/386))
- Update addons. (see PR [#392](https://github.com/tetherto/qvac-sdk/pull/392))

## 📦 Models

- Add model history tracking, validator support, and new models. (see PR [#394](https://github.com/tetherto/qvac-sdk/pull/394)) - See [model changes](./models.md)

## 📘 Docs

- Create new example get started. (see PR [#307](https://github.com/tetherto/qvac-sdk/pull/307))
- Update installation and quickstart page. (see PR [#352](https://github.com/tetherto/qvac-sdk/pull/352))
- Contributing.md and coc .mds. (see PR [#354](https://github.com/tetherto/qvac-sdk/pull/354))
- Add config system example and update README. (see PR [#363](https://github.com/tetherto/qvac-sdk/pull/363))

## 🧹 Chores

- Code style fixes and RAG config alignment. (see PR [#375](https://github.com/tetherto/qvac-sdk/pull/375))
- RPC request logging summarization for large payloads. (see PR [#376](https://github.com/tetherto/qvac-sdk/pull/376))
- Add github issue templates for bugs and features. (see PR [#388](https://github.com/tetherto/qvac-sdk/pull/388))
