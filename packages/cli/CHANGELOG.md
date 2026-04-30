# Changelog

## [0.2.4]

Release Date: 2026-04-27

## 🐞 Fixes

- Update `SDKModule.embed` type and `sdkEmbed()` to handle the new `{ embedding, stats? }` return shape introduced in `@qvac/sdk` 0.9+. The CLI's internal `number[] | number[][]` contract is preserved so callers (notably the OpenAI embeddings route) stay unchanged. (see PR [#1596](https://github.com/tetherto/qvac/pull/1596))
- Extract nested `node_modules` packages when generating the addons manifest in `qvac bundle sdk`, so deeply-hoisted addon dependencies are correctly included in the mobile worker bundle. (see PR [#1731](https://github.com/tetherto/qvac/pull/1731))

## [0.2.3]

Release Date: 2026-04-06

## 🐞 Fixes

- Add `sdcpp-generation` (diffusion) to `BUILTIN_PLUGINS` for mobile worker bundle. Without this, mobile apps using `qvac bundle sdk` would get "Plugin not found" errors for the diffusion model type. (see PR [#1338](https://github.com/tetherto/qvac/pull/1338))
- Update README built-in plugins list to include `parakeet-transcription` and `sdcpp-generation`.

## [0.2.2]

Release Date: 2026-03-19

## 🔌 API

- Add OpenAI-compatible REST API server (qvac serve) - Part I. (see PR [#753](https://github.com/tetherto/qvac/pull/753)) - See [API changes](./changelog/0.2.2/api.md)
- Bump LLM/embed addons and wire per-request generation params. (see PR [#895](https://github.com/tetherto/qvac/pull/895))
- Add POST /v1/audio/transcriptions to qvac serve OpenAI adapter. (see PR [#915](https://github.com/tetherto/qvac/pull/915)) - See [API changes](./changelog/0.2.2/api.md)

## 🐞 Fixes

- Resolve Windows EFTYPE error when spawning bare-pack. (see PR [#949](https://github.com/tetherto/qvac/pull/949))
- Normalize composite JSON Schema types in tool parameter validation. (see PR [#964](https://github.com/tetherto/qvac/pull/964))

## 🧹 Chores

- Rename qvac-cli package to cli. (see PR [#644](https://github.com/tetherto/qvac/pull/644))
- Migrate CLI package from JavaScript to TypeScript. (see PR [#722](https://github.com/tetherto/qvac/pull/722))

## ⚙️ Infrastructure

- Add explicit build step to CLI publish workflow. (see PR [#1010](https://github.com/tetherto/qvac/pull/1010))

## [0.1.3]

Release Date: 2026-02-17

### ✨ Features

- Add `--sdk-path` option to explicitly specify SDK location instead of auto-detecting from `node_modules/@qvac/sdk` (see PR [#384](https://github.com/tetherto/qvac/pull/384))

### 🐛 Fixes

- Use dynamic module resolution for `bare-pack` and `tsx` dependencies — fixes resolution failures when CLI dependencies are hoisted to project root (see PR [#392](https://github.com/tetherto/qvac/pull/392))

## [0.1.2]

Release Date: 2026-02-14

### 🔧 Changed

- Make `bare-pack` resolution self-contained — CLI now resolves `bare-pack` from its own `node_modules` instead of relying on consumer project
- Use explicit SDK exports in worker entry generation (`@qvac/sdk/worker-core`, `@qvac/sdk/plugins`, `@qvac/sdk/logging`) to align with SDK's tightened package boundaries

### 📝 Documentation

- Updated README to reflect that `bare-pack` is bundled with CLI (no longer a user dependency)

## [0.1.1]

Release Date: 2026-02-11

### 🧹 Chores

- Add cli to sdk pod & remove manual CHANGELOG. (see PR [#228](https://github.com/tetherto/qvac/pull/228))
- Standardize logger & log levels. (see PR [#257](https://github.com/tetherto/qvac/pull/257))

### ⚙️ Infrastructure

- Add GPR scope rewrite action and rename CLI to @qvac/cli. (see PR [#230](https://github.com/tetherto/qvac/pull/230))
