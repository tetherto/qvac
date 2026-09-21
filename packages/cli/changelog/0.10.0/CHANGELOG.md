# Changelog v0.10.0

Release Date: 2026-08-07

## 🔌 API

- Add timed audio transcription response formats. (see PR [#3500](https://github.com/tetherto/qvac/pull/3500)) - See [API changes](./api.md)
- Resolve nested *ModelSrc constant names in serve config. (see PR [#3572](https://github.com/tetherto/qvac/pull/3572)) - See [API changes](./api.md)
- Count emitted tokens for usage, keep decode count for length. (see PR [#3573](https://github.com/tetherto/qvac/pull/3573)) - See [API changes](./api.md)

## 🧹 Chores

- Remove retired ocr-onnx addon from the monorepo. (see PR [#3466](https://github.com/tetherto/qvac/pull/3466)) - See [breaking changes](./breaking.md)
- Replace the custom alias resolver with tsc-alias. (see PR [#3522](https://github.com/tetherto/qvac/pull/3522))
