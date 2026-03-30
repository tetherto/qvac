# Changelog

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
