# Changelog v0.9.2

Release Date: 2026-04-27

## 🔌 API

- Add sentence-level streaming for onnx text-to-speech. (see PR [#1590](https://github.com/tetherto/qvac/pull/1590)) - See [API changes](./api.md)
- Make auto KV-cache reuse completed turn history. (see PR [#1705](https://github.com/tetherto/qvac/pull/1705)) - See [API changes](./api.md)
- Propagate registry download retries and expose stream timeout. (see PR [#1743](https://github.com/tetherto/qvac/pull/1743)) - See [API changes](./api.md)

## 🐞 Fixes

- Scope kv-cache invalidation to deleted key on RPC delete-cache. (see PR [#1740](https://github.com/tetherto/qvac/pull/1740))

## 🧹 Chores

- Migrate SDK plugins to new addon constructor shape. (see PR [#1688](https://github.com/tetherto/qvac/pull/1688)) - See [breaking changes](./breaking.md)
- Refresh tests-qvac docs, tooling, and workflow job names. (see PR [#1712](https://github.com/tetherto/qvac/pull/1712))
- Backmerge release sdk 0.9.1. (see PR [#1726](https://github.com/tetherto/qvac/pull/1726))

