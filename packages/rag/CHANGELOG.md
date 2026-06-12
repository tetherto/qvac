# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.3]

### Changed

- Bump `bare-fetch` to `^3.0.1` (adopt the 3.x major; public fetch API unchanged).

## [0.6.2]

### Fixed

- Add `./errors.js` export alias so TypeScript ESM emit (`@qvac/rag/errors.js`) resolves under Node package exports.

## [0.6.1]

### Added

- Published `@qvac/rag/errors` subpath for importing `ERR_CODES` and `QvacErrorRAG` without loading the full package entry (#2303).

### Fixed

- Load RAG hard dependencies (`hyperdb`, `hyperschema`, `llm-splitter`, `#fetch`) via synchronous `require()` instead of dynamic `await import()` for Pear/CJS compatibility (#2284).

## [0.6.0]

### Changed

- Upgrade to HyperDB 6 (`hyperdb@^6.7.0`), regenerate RAG HyperDB specs for the v6 toolchain, and move runtime Holepunch libraries from `peerDependencies` to direct `dependencies` (#2255).
- Bump `@qvac/registry-client` dev dependency to `^0.6.0`.

## [0.5.0]

### Fixed

- React Native / Expo bundling: routed `bare-crypto` and `bare-fetch` through `package.json#imports` (`#crypto`, `#fetch`) with lazy shims, so non-Bare bundlers no longer corrupt the package output (e.g. `SyntaxError: 'LLMChunkAdapter' not exported`). Missing capabilities now throw `QvacErrorRAG { DEPENDENCY_REQUIRED }` only when invoked.
- `generateId()` no longer mutates a global `crypto` or depends on `uuid-random`; UUID v4s are generated locally using secure randomness from `globalThis.crypto.getRandomValues` or `#crypto.randomBytes` / `getRandomValues`.
- `QvacErrorRAG` construction in RAG crypto fallbacks now uses the canonical `{ code, adds }` options object so the documented `DEPENDENCY_REQUIRED` (14015) error code is actually thrown (previously degraded to code `0` / `"Unknown QVAC error"`).

### Changed

- Holepunch singletons (`hyperdb`, `hyperdht`, `hyperschema`, `bare-crypto`, `bare-fetch`, `llm-splitter`) moved from `dependencies` to `peerDependencies` so consumer trees install a single copy aligned with `@qvac/sdk`'s ranges. `hyperdht` is marked optional (reserved for the unwired `replicateWith` path).
- Examples and integration tests migrated off `@qvac/dl-hyperdrive` to `@qvac/registry-client` (files-based addon construction). `devDependencies` updated accordingly: removed `@qvac/dl-hyperdrive`, added `@qvac/registry-client@^0.4.1`, bumped `@qvac/embed-llamacpp` `^0.7.6 → ^0.14.0` and `@qvac/llm-llamacpp` `^0.5.7 → ^0.16.0`.

### Added

- `crypto-browserify` as an optional peer dependency for browser / React Native consumers that need Node-style `crypto.createHash` (notably for HyperDB document hashing).

## [0.4.4]

### Changed

- README: replaced `@tetherto` npm references with `@qvac` namespace references.
- Dependencies: bumped `bare-crypto` to `^1.13.4` and cleaned up RAG package dependency declarations.

## [0.4.3]

### Changed

- README: removed outdated npm Personal Access Token / `.npmrc` setup instructions for installing `@qvac/rag`.
