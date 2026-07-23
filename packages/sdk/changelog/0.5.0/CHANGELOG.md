# Changelog v0.5.0

Release Date: 2025-12-19

## 💥 Breaking Changes

- Replace setConfig client API with config file. (see PR [#269](https://github.com/tetherto/qvac-sdk/pull/269)) - See [breaking changes](./breaking.md)
- Fix Linting and Add Multilingual Models. (see PR [#293](https://github.com/tetherto/qvac-sdk/pull/293)) - See [breaking changes](./breaking.md)
- Capture SDK Logs Through Unified Logger/Stream. (see PR [#295](https://github.com/tetherto/qvac-sdk/pull/295)) - See [breaking changes](./breaking.md)

## 🔌 API

- Add Config HotReload. (see PR [#279](https://github.com/tetherto/qvac-sdk/pull/279)) - See [API changes](./api.md)
- Add Batch Embeddings. (see PR [#268](https://github.com/tetherto/qvac-sdk/pull/268)) - See [API changes](./api.md)
- Add addon log streaming (see PR [#271](https://github.com/tetherto/qvac-sdk/pull/271)) - See [API changes](./api.md)
- Add MCP adapter for tool integration. (see PR [#290](https://github.com/tetherto/qvac-sdk/pull/290)) - See [API changes](./api.md)

## ✨ Features

- Add changelog generator and commit/PR validation. (see PR [#270](https://github.com/tetherto/qvac-sdk/pull/270))
- Add non-blocking model update check to pre-commit hook. (see PR [#277](https://github.com/tetherto/qvac-sdk/pull/277))
- Unify addon logging support for Whsiper and TTS. (see PR [#291](https://github.com/tetherto/qvac-sdk/pull/291))
- Unify addon logging support for NMT. (see PR [#298](https://github.com/tetherto/qvac-sdk/pull/298))
- Package dependencies upgraded to comply with 16 kb page size on Android (see PR [#281](https://github.com/tetherto/qvac-sdk/pull/281))
- Switch to bare-ffmpeg decoder. (see PR [#306](https://github.com/tetherto/qvac-sdk/pull/306))

## 🐞 Fixes

- Fix corrupted audio file hang. (see PR [#284](https://github.com/tetherto/qvac-sdk/pull/284))
- Prevent process hanging due to decoder not exiting. (see PR [#285](https://github.com/tetherto/qvac-sdk/pull/285))
- Disable Flash Attention on Android for Embeddings. (see PR [#301](https://github.com/tetherto/qvac-sdk/pull/301))
- Prevent Whisper prompt state from leaking between transcriptions (see PR [#273](https://github.com/tetherto/qvac-sdk/pull/273))
- Bump decoder. (see PR [#309](https://github.com/tetherto/qvac-sdk/pull/309))

## 📘 Docs

- Standardize documentation. (see PR [#287](https://github.com/tetherto/qvac-sdk/pull/287))
- Create new script: docs-gen-pages. (see PR [#296](https://github.com/tetherto/qvac-sdk/pull/296))
- Create new script docs:gen-api. (see PR [#303](https://github.com/tetherto/qvac-sdk/pull/303))
- Update PR template, contribute and readme. (see PR [#304](https://github.com/tetherto/qvac-sdk/pull/304))

## 📦 Models

- Update models for 0.5.0 release. (see PR [#310](https://github.com/tetherto/qvac-sdk/pull/310))

## 🧹 Chores

- Update bare/qvac dependencies. (see PR [#286](https://github.com/tetherto/qvac-sdk/pull/286))
- Remove npm lockfile, standardize on Bun. (see PR [#292](https://github.com/tetherto/qvac-sdk/pull/292))

## ⚙️ Infrastructure

- Tag commit post npm publish. (see PR [#288](https://github.com/tetherto/qvac-sdk/pull/288))
- Added trigger and publish to npm on merge to npm-patch-\* branches. (see PR [#289](https://github.com/tetherto/qvac-sdk/pull/289))
