# Changelog v0.19.1

Release Date: 2026-09-10

## ✨ Features

- Report the iOS per-process memory allowance. (see PR [#4359](https://github.com/tetherto/qvac/pull/4359))

## 🔌 API

- Add deleteCache({ auto: true }) to reclaim automatic KV caches. (see PR [#4248](https://github.com/tetherto/qvac/pull/4248)) - See [API changes](./api.md)
- Pass prompt-processing throughput through completion stats. (see PR [#4295](https://github.com/tetherto/qvac/pull/4295)) - See [API changes](./api.md)
- Refuse from the computed floor when no calibration applies. (see PR [#4358](https://github.com/tetherto/qvac/pull/4358)) - See [API changes](./api.md)

## 🧹 Chores

- Bump @qvac/rag to ^0.8.1. (see PR [#4367](https://github.com/tetherto/qvac/pull/4367))
