# Changelog v0.2.4

Release Date: 2026-04-27

## 🐞 Fixes

- Update `SDKModule.embed` type and `sdkEmbed()` to handle the new `{ embedding, stats? }` return shape introduced in `@qvac/sdk` 0.9+. The CLI's internal `number[] | number[][]` contract is preserved so callers (notably the OpenAI embeddings route) stay unchanged. (see PR [#1596](https://github.com/tetherto/qvac/pull/1596))
- Extract nested `node_modules` packages when generating the addons manifest in `qvac bundle sdk`, so deeply-hoisted addon dependencies are correctly included in the mobile worker bundle. (see PR [#1731](https://github.com/tetherto/qvac/pull/1731))
