# Changelog v0.4.0

Release Date: 2026-05-13

## 🔌 API

- Add qvac verify deps to detect native addon lockfile changes. (see PR [#1969](https://github.com/tetherto/qvac/pull/1969)) - See [API changes](./api.md)
- Add Qwen3.5, Gemma4 tool-call dialects and reasoning_budget param. (see PR [#1974](https://github.com/tetherto/qvac/pull/1974)) - See [API changes](./api.md)
- Add qvac verify bundle command for prebuild and ABI verification. (see PR [#1984](https://github.com/tetherto/qvac/pull/1984)) - See [API changes](./api.md)
- Add POST /v1/images/generations to qvac serve OpenAI adapter. (see PR [#2008](https://github.com/tetherto/qvac/pull/2008)) - See [API changes](./api.md)

## 🧹 Chores

- Consolidate PR templates and hide style note in HTML comment — delete the 19 unused per-package `PULL_REQUEST_TEMPLATE.md` files (including `packages/cli/PULL_REQUEST_TEMPLATE.md`) and centralise on `.github/PULL_REQUEST_TEMPLATE/{sdk-pod,addon}.md` plus a minimal default. (see PR [#1924](https://github.com/tetherto/qvac/pull/1924))
