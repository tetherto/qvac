# Changelog v0.12.0

Release Date: 2026-08-21

## ✨ Features

- Add deep SDK runtime checks to qvac doctor. (see PR [#3492](https://github.com/tetherto/qvac/pull/3492))
- Add `qvac configure` interactive config generator. (see PR [#3953](https://github.com/tetherto/qvac/pull/3953))

## 🔌 API

- Honor preload:false via lazy-load, keep DELETE reversible. (see PR [#3906](https://github.com/tetherto/qvac/pull/3906)) - See [API changes](./api.md)
- Browse models by capability (serve catalog). (see PR [#3932](https://github.com/tetherto/qvac/pull/3932)) - See [API changes](./api.md)

## ⚙️ Infrastructure

- Revert incident-era macOS runner switches — back to qvac-macos26-arm64-gpu. (see PR [#3859](https://github.com/tetherto/qvac/pull/3859))
