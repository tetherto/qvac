# Changelog v0.24.2

Release Date: 2026-11-26

## 🐞 Fixes

- Publish the built files: `0.24.1` reached npm without `dist` and cannot be loaded.
- Keep KV cache folders when `cache_share_across_keys` is turned on. (see PR [#5919](https://github.com/tetherto/qvac/pull/5919))
- Keep KV cache folders for loads that send `verbosity`. (see PR [#5950](https://github.com/tetherto/qvac/pull/5950))

## 🧹 Chores

- Depend on `@qvac/inference` `^0.24.2` and `@qvac/tts-ggml` `^0.15.2`, both on `bare-https` 4. (see PR [#5859](https://github.com/tetherto/qvac/pull/5859))
