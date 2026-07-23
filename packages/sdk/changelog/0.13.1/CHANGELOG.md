# Changelog v0.13.1

Release Date: 2026-06-12

## 🔧 Maintenance

- Adopt `bare-fetch@^3.0.1` (3.x major; public `fetch` API unchanged) and move the dev-only `bare-subprocess` to `^6.1.0`.
- Bump `@qvac/decoder-audio` to `^0.4.0`, which drops the deprecated `@qvac/response` (consolidated into `@qvac/infer-base`). `decoder-audio@0.4.0` returns its `QvacResponse` from `decoder.run()` synchronously, so the SDK audio decoder no longer `await`s that call (`server/utils/audio/decoder.ts`).
- Net effect on the dependency tree: the exact `bare-events 2.4.2` pin and the deprecated `@qvac/response` are removed; `bare-events` resolves to `^2.9.1` (via `@qvac/infer-base@0.4.2`) and `bare-fetch` to `3.x`. `@qvac/sdk` and `@qvac/bare-sdk` are bumped in lockstep.
