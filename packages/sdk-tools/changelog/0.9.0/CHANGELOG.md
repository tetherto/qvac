# Changelog v0.9.0

Release Date: 2026-07-27

## ✨ Features

- Reuse KV cache across turns in OpenAI serve endpoints. (see PR [#3264](https://github.com/tetherto/qvac/pull/3264))
- Migrate AI SDK provider to v7. (see PR [#3370](https://github.com/tetherto/qvac/pull/3370)) - See [breaking changes](./breaking.md)

## 🔌 API

- OpenAI-compatible chat — reasoning_content, token usage, native tool-call replay. (see PR [#3259](https://github.com/tetherto/qvac/pull/3259)) - See [API changes](./api.md)

## 🐞 Fixes

- Log CLI server error stack traces. (see PR [#3184](https://github.com/tetherto/qvac/pull/3184))
- Qvac openai coverage crashes in published CLI installs. (see PR [#3289](https://github.com/tetherto/qvac/pull/3289))

## 📘 Docs

- Document Vulkan 1.4 minimum and correct the CPU-fallback claim. (see PR [#3118](https://github.com/tetherto/qvac/pull/3118))

## 🧪 Tests

- Add OpenAI serve provider compare benchmark harness. (see PR [#3316](https://github.com/tetherto/qvac/pull/3316))

## 🧹 Chores

- Adopt Prettier across SDK-pod packages. (see PR [#3039](https://github.com/tetherto/qvac/pull/3039))
- Unify lint/format/typecheck across SDK-pod packages. (see PR [#3040](https://github.com/tetherto/qvac/pull/3040))
