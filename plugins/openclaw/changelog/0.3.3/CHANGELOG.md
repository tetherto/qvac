# Changelog v0.3.3

Release Date: 2026-09-28

## 🐞 Fixes

- Onboarding now saves the `local-service.js` launcher path from the plugin install directory instead of OpenClaw's per-process copy, which OpenClaw 2026.9.6 deletes on exit. ([#4686](https://github.com/tetherto/qvac/pull/4686))
