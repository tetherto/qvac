# Changelog

## [0.1.1]

Release Date: 2026-02-13

### ✨ Features

- HyperDB schema and database wrapper for QVAC Registry
- `findBy()` method for unified model querying with optional filters (`name`, `engine`, `quantization`, `includeDeprecated`)
- `findModelsByEngineQuantization()` method for compound index queries
- `models-by-engine-quantization` compound HyperDB index for efficient multi-field lookups
