# Changelog v0.7.0

Release Date: 2026-02-27

## ✨ Features

- Model Registry merge to main. (see PR [#323](https://github.com/tetherto/qvac/pull/323)) - See [breaking changes](./breaking.md)
- Add --sdk-path option to CLI for explicit sdk location. (see PR [#384](https://github.com/tetherto/qvac/pull/384))
- Add Pear pear.pre hook for auto-generated worker entry. (see PR [#451](https://github.com/tetherto/qvac/pull/451))
- Use downloadBlob for direct registry downloads. (see PR [#571](https://github.com/tetherto/qvac/pull/571))

## 🔌 API

- Harden node rpc socket lifecycle and async close handling. (see PR [#263](https://github.com/tetherto/qvac/pull/263)) - See [API changes](./api.md)
- Add Plugins. (see PR [#327](https://github.com/tetherto/qvac/pull/327)) - See [API changes](./api.md)
- Add Chatterbox and Supertonic TTS engines. (see PR [#375](https://github.com/tetherto/qvac/pull/375)) - See [API changes](./api.md)

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

