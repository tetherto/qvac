# Changelog v0.8.0

Release Date: 2026-03-20

## ✨ Features

- Add Parakeet transcription plugin. (see PR [#366](https://github.com/tetherto/qvac/pull/366)) - See [API changes](./api.md)
- Decouple Builtin Plugins from Core Load Path. (see PR [#774](https://github.com/tetherto/qvac/pull/774)) - See [breaking changes](./breaking.md)
- Add CTC and Sortformer model support to SDK. (see PR [#811](https://github.com/tetherto/qvac/pull/811)) - See [breaking changes](./breaking.md)
- Add AfriqueGemma support. (see PR [#861](https://github.com/tetherto/qvac/pull/861))
- Profiler Operation Transport + Load/Download Metrics + Stream Profiling. (see PR [#899](https://github.com/tetherto/qvac/pull/899))
- Enable profiling in test-qvac desktop and mobile consumers. (see PR [#965](https://github.com/tetherto/qvac/pull/965))

## 🔌 API

- Add Bergamot pivot translation support. (see PR [#834](https://github.com/tetherto/qvac/pull/834)) - See [API changes](./api.md)
- SDK Profiler. (see PR [#836](https://github.com/tetherto/qvac/pull/836)) - See [API changes](./api.md)

## 🐞 Fixes

- Make SDK support latest LLM and Embedding add-ons. (see PR [#669](https://github.com/tetherto/qvac/pull/669)) - See [breaking changes](./breaking.md)
- Support multiple validator tags and add [updated] section to model history. (see PR [#778](https://github.com/tetherto/qvac/pull/778))
- Race condition in getRPCInstance. (see PR [#862](https://github.com/tetherto/qvac/pull/862))
- Fix addon logging on all plugins. (see PR [#870](https://github.com/tetherto/qvac/pull/870))
- Use params.modelId in parakeet addon logger calls. (see PR [#916](https://github.com/tetherto/qvac/pull/916))
- Unload delegated model on provider device. (see PR [#924](https://github.com/tetherto/qvac/pull/924))
- Replace stale delegated model registry entry on re-registration. (see PR [#928](https://github.com/tetherto/qvac/pull/928))

## 📦 Models

- Update SDK constant models. (see PR [#771](https://github.com/tetherto/qvac/pull/771)) - See [model changes](./models.md)

## 📘 Docs

- Reorganize monorepo docs structure. (see PR [#785](https://github.com/tetherto/qvac/pull/785))

## 🧪 Tests

- Port logging executor to direct assertions and add missing test handlers. (see PR [#982](https://github.com/tetherto/qvac/pull/982))

## 🧹 Chores

- Consolidate transcription schemas and shared ops. (see PR [#677](https://github.com/tetherto/qvac/pull/677))
- Update @qvac/tts-onnx to v0.6.1. (see PR [#854](https://github.com/tetherto/qvac/pull/854))
- Update whispercpp addon version in sdk. (see PR [#860](https://github.com/tetherto/qvac/pull/860))
- TTS Plugin Artifacts Pattern Alignment. (see PR [#871](https://github.com/tetherto/qvac/pull/871))

## ⚙️ Infrastructure

- Port android e2e test workflow to monorepo. (see PR [#544](https://github.com/tetherto/qvac/pull/544))
- Prefer CHANGELOG_LLM.md in root changelog aggregation. (see PR [#777](https://github.com/tetherto/qvac/pull/777))

