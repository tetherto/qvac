# Changelog

## [0.1.6]

Release Date: 2026-02-17

### ✨ Features

- Download resume support: interrupted model downloads can now be resumed instead of restarting from scratch (#387)

### 🔧 Changed

- Added NOTICE file and updated license metadata for sub-package compliance (#394)

### 🐛 Fixed

- Added missing `@qvac/error` devDependency to `@qvac/registry-server`, fixing CI integration test failures (#405)

## [0.1.5]

Release Date: 2026-02-14

### 🔧 Changed

- Upgraded Bare ecosystem dependencies:
  - `bare-fs`: ^2.1.5 → ^4.5.2
  - `bare-os`: ^2.2.0 → ^3.6.2
  - `bare-process`: ^1.3.0 → ^4.2.2
  - `corestore`: ^6.18.4 → ^7.4.5

## [0.1.4]

Release Date: 2026-02-13

### ✨ Features

- Read-only QVAC Registry client for model discovery via Hyperswarm
- `findBy()` method for unified model queries with filters (`name`, `engine`, `quantization`, `includeDeprecated`)
- Model metadata retrieval from the distributed registry
- Automatic peer discovery and replication via Hyperswarm
- Compatible with Bare and Node.js runtimes
