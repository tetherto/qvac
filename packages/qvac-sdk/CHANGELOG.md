# Changelog

## v0.7.0

Release Date: 2026-02-27

## ✨ Features

- Model Registry merge to main. (see PR [#323](https://github.com/tetherto/qvac/pull/323)) - See [breaking changes](./changelog/0.7.0/breaking.md)
- Add --sdk-path option to CLI for explicit sdk location. (see PR [#384](https://github.com/tetherto/qvac/pull/384))
- Add Pear pear.pre hook for auto-generated worker entry. (see PR [#451](https://github.com/tetherto/qvac/pull/451))
- Use downloadBlob for direct registry downloads. (see PR [#571](https://github.com/tetherto/qvac/pull/571))

## 🔌 API

- Harden node rpc socket lifecycle and async close handling. (see PR [#263](https://github.com/tetherto/qvac/pull/263)) - See [API changes](./changelog/0.7.0/api.md)
- Add Plugins. (see PR [#327](https://github.com/tetherto/qvac/pull/327)) - See [API changes](./changelog/0.7.0/api.md)
- Add Chatterbox and Supertonic TTS engines. (see PR [#375](https://github.com/tetherto/qvac/pull/375)) - See [API changes](./changelog/0.7.0/api.md)

## 🐞 Fixes

- Corestore directory deletion order causing EBUSY on Windows. (see PR [#266](https://github.com/tetherto/qvac/pull/266))
- Add path traversal protection. (see PR [#281](https://github.com/tetherto/qvac/pull/281))
- Reject empty text input in TTS and wrap addon errors. (see PR [#300](https://github.com/tetherto/qvac/pull/300))
- Extract expo-device to stubbable module and add Android build config plugins. (see PR [#351](https://github.com/tetherto/qvac/pull/351))
- Remove persistent node-rpc-client truncation from expo plugin. (see PR [#386](https://github.com/tetherto/qvac/pull/386))
- Resolve SDK package dir dynamically in Expo plugins. (see PR [#396](https://github.com/tetherto/qvac/pull/396))
- Fix delegate RPC client connection bugs. (see PR [#402](https://github.com/tetherto/qvac/pull/402))
- Use stable corestore storage path for registry download resume. (see PR [#422](https://github.com/tetherto/qvac/pull/422))
- Await closeRegistryClient in findModelShards to fix Windows fd-lock race. (see PR [#454](https://github.com/tetherto/qvac/pull/454))

## 🧹 Chores

- Bump llamacpp deps and remove iphone 17 cpu override. (see PR [#213](https://github.com/tetherto/qvac/pull/213))
- Backmerge release-qvac-sdk-0.6.1 into main. (see PR [#285](https://github.com/tetherto/qvac/pull/285))
- Add plugin path constants and cleanup dead exports. (see PR [#376](https://github.com/tetherto/qvac/pull/376))
- Consolidate registry core key constant and scope corestore cache by key. (see PR [#439](https://github.com/tetherto/qvac/pull/439))
- Update @qvac/registry-client to 0.2.0. (see PR [#546](https://github.com/tetherto/qvac/pull/546))
- Bump tts 0.5.4. (see PR [#595](https://github.com/tetherto/qvac/pull/595))
- Bump nmt to 0.3.9. (see PR [#596](https://github.com/tetherto/qvac/pull/596))

## ⚙️ Infrastructure

- Update SDK pod changelog generation and shared tooling. (see PR [#155](https://github.com/tetherto/qvac/pull/155))
- Configure test workflow with auth tokens. (see PR [#509](https://github.com/tetherto/qvac/pull/509))

## v0.6.1

Release Date: 2026-02-10

## 🧹 Chores

- Bump llamacpp dependencies and remove iphone 17 cpu override. (see PR [#213](https://github.com/tetherto/qvac/pull/213))

## ⚙️ Infrastructure

- Update SDK pod changelog generation and shared tooling. (see PR [#155](https://github.com/tetherto/qvac/pull/155))

## v0.6.0

Release Date: 2026-02-02

## ✨ Features

- RAG lifecycle improvements with progress streaming, cancellation & workspace management. (see PR [#329](https://github.com/tetherto/qvac-sdk/pull/329)) - See [breaking changes](./changelog/0.6.0/breaking.md)
- Improve embed config with structured options. (see PR [#335](https://github.com/tetherto/qvac-sdk/pull/335)) - See [breaking changes](./changelog/0.6.0/breaking.md)
- Add Bergamot translation engine support. (see PR [#343](https://github.com/tetherto/qvac-sdk/pull/343)) - See [breaking changes](./changelog/0.6.0/breaking.md)
- Migrate to import maps for cross-runtime compatibility. (see PR [#371](https://github.com/tetherto/qvac-sdk/pull/371))

## 🔌 API

- Add Support for Sharded Pattern-Based URLs Model Downloads. (see PR [#305](https://github.com/tetherto/qvac-sdk/pull/305)) - See [API changes](./changelog/0.6.0/api.md)
- Add Support for Archive-Based Sharded Models. (see PR [#311](https://github.com/tetherto/qvac-sdk/pull/311)) - See [API changes](./changelog/0.6.0/api.md)
- Add OCR addon. (see PR [#312](https://github.com/tetherto/qvac-sdk/pull/312)) - See [API changes](./changelog/0.6.0/api.md)
- Unify model type naming with canonical engine-usecase format. (see PR [#384](https://github.com/tetherto/qvac-sdk/pull/384)) - See [API changes](./changelog/0.6.0/api.md)
- Add runtime context, model config per device/brand/platform. (see PR [#389](https://github.com/tetherto/qvac-sdk/pull/389)) - See [API changes](./changelog/0.6.0/api.md)

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

- Add model history tracking, validator support, and new models. (see PR [#394](https://github.com/tetherto/qvac-sdk/pull/394)) - See [model changes](./changelog/0.6.0/models.md)

## 📘 Docs

- Create new example get started. (see PR [#307](https://github.com/tetherto/qvac-sdk/pull/307))
- Update installation and quickstart page. (see PR [#352](https://github.com/tetherto/qvac-sdk/pull/352))
- Contributing.md and coc .mds. (see PR [#354](https://github.com/tetherto/qvac-sdk/pull/354))
- Add config system example and update README. (see PR [#363](https://github.com/tetherto/qvac-sdk/pull/363))

## 🧹 Chores

- Code style fixes and RAG config alignment. (see PR [#375](https://github.com/tetherto/qvac-sdk/pull/375))
- RPC request logging summarization for large payloads. (see PR [#376](https://github.com/tetherto/qvac-sdk/pull/376))
- Add github issue templates for bugs and features. (see PR [#388](https://github.com/tetherto/qvac-sdk/pull/388))

## v0.5.0

Release Date: 2025-12-19

## 💥 Breaking Changes

- Replace setConfig client API with config file. (see PR [#269](https://github.com/tetherto/qvac-sdk/pull/269)) - See [breaking changes](./changelog/0.5.0/breaking.md)
- Fix Linting and Add Multilingual Models. (see PR [#293](https://github.com/tetherto/qvac-sdk/pull/293)) - See [breaking changes](./changelog/0.5.0/breaking.md)
- Capture SDK Logs Through Unified Logger/Stream. (see PR [#295](https://github.com/tetherto/qvac-sdk/pull/295)) - See [breaking changes](./changelog/0.5.0/breaking.md)

## 🔌 API

- Add Config HotReload. (see PR [#279](https://github.com/tetherto/qvac-sdk/pull/279)) - See [API changes](./changelog/0.5.0/api.md)
- Add Batch Embeddings. (see PR [#268](https://github.com/tetherto/qvac-sdk/pull/268)) - See [API changes](./changelog/0.5.0/api.md)
- Add addon log streaming (see PR [#271](https://github.com/tetherto/qvac-sdk/pull/271)) - See [API changes](./changelog/0.5.0/api.md)
- Add MCP adapter for tool integration. (see PR [#290](https://github.com/tetherto/qvac-sdk/pull/290)) - See [API changes](./changelog/0.5.0/api.md)

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
