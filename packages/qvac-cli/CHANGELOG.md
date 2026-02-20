# Changelog 

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

- Add qvac-cli to sdk pod & remove manual CHANGELOG. (see PR [#228](https://github.com/tetherto/qvac/pull/228))
- Standardize logger & log levels. (see PR [#257](https://github.com/tetherto/qvac/pull/257))

### ⚙️ Infrastructure

- Add GPR scope rewrite action and rename CLI to @qvac/cli. (see PR [#230](https://github.com/tetherto/qvac/pull/230))

