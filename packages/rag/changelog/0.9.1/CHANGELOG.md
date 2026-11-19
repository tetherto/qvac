# Changelog v0.9.1

Release Date: 2026-11-19

## 🐞 Fixes

- Make `TurboVecAdapter` work with `@qvac/turbovec-ggml` 0.7, whose index methods return promises. The adapter awaits every index call, finishes a checkpoint's snapshot write before renaming it, and falls back to a HyperDB scan when a rebuild disposes the index a search was waiting on. Synchronous indexes from turbovec 0.5 and earlier still work. (see PR [#5870](https://github.com/tetherto/qvac/pull/5870))

## 🔌 API

- `TurboVecIndex` methods return their result or a promise of it. Await calls made through the interface, and use `TurboVecIndexSearchResult` instead of `ReturnType<TurboVecIndex['search']>`.
