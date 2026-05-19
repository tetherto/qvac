# Changelog

## [0.2.0]

Release Date: 2026-05-14

### 🔧 Changed

- **BREAKING (install-time)**: Move `hyperdb` from `dependencies` to `peerDependencies` so consumer apps don't get a duplicate copy of the singleton when installed alongside `@qvac/sdk` (#1905). Most consumers (npm 7+, pnpm, bun) auto-install peers and need no action. Standalone consumers using yarn 1 or `legacy-peer-deps=true` must now add `hyperdb` to their own dependencies.

## [0.1.2]

Release Date: 2026-03-19

### 🐛 Bug Fixes

- Add `QVAC_S3_BUCKET` to `ENV_KEYS` — previously missing, causing `getS3Bucket()` in downstream consumers to silently return `null`

### 📦 Packaging

- Include LICENSE and NOTICE files in published package

## [0.1.1]

Release Date: 2026-02-13

### ✨ Features

- HyperDB schema and database wrapper for QVAC Registry
- `findBy()` method for unified model querying with optional filters (`name`, `engine`, `quantization`, `includeDeprecated`)
- `findModelsByEngineQuantization()` method for compound index queries
- `models-by-engine-quantization` compound HyperDB index for efficient multi-field lookups
