# Changelog v0.8.1

Release Date: 2026-04-01

## ✨ Features

- Add heartbeat for proactive provider status checks. (see PR [#1160](https://github.com/tetherto/qvac/pull/1160)) - See [breaking changes](./breaking.md)

## 🔌 API

- Add RPC health probe and centralize stale-connection cleanup for delegation. (see PR [#1149](https://github.com/tetherto/qvac/pull/1149)) - See [API changes](./api.md)
- Add delegated cancellation for inference and remote downloads. (see PR [#1153](https://github.com/tetherto/qvac/pull/1153)) - See [API changes](./api.md)

## 🐞 Fixes

- Remove indictrans model type block in nmtcpp translat…. (see PR [#1112](https://github.com/tetherto/qvac/pull/1112))
- Use network-layer progress for registry downloads instead of disk I/O. (see PR [#1118](https://github.com/tetherto/qvac/pull/1118))
- Throttle RPC progress frames to prevent call stack overflow. (see PR [#1134](https://github.com/tetherto/qvac/pull/1134))
- Regenerate model registry to fix VLM addon classification. (see PR [#1167](https://github.com/tetherto/qvac/pull/1167))
- Resolve code scanning security alerts for SDK pod packages. (see PR [#1207](https://github.com/tetherto/qvac/pull/1207))

## 📘 Docs

- Replace @tetherto npm references with @qvac namespace in READMEs. (see PR [#1247](https://github.com/tetherto/qvac/pull/1247))

## 🧪 Tests

- Add parallel download and cancel isolation E2E tests. (see PR [#1059](https://github.com/tetherto/qvac/pull/1059))
- Refactor model executor for asset-based mobile e2e. (see PR [#1126](https://github.com/tetherto/qvac/pull/1126))

