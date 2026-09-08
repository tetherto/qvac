# Changelog v0.2.1

Release Date: 2026-08-21

## 🐞 Fixes

- Require the `@qvac/cli` `0.12.x` line, so the bundled launcher starts a `qvac serve` on the `@qvac/sdk` 0.18.x runtime.
- Selecting a model other than the configured one no longer fails with `503 model_not_ready`. The launcher writes every catalog model into the serve config with `preload: false` except the selected one, and CLI 0.12 lazy-loads those on first request instead of leaving them permanently unloaded.
