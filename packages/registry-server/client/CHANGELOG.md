# Changelog

## [0.3.1]

Release Date: 2026-03-30

### 📚 Documentation

- README: removed outdated npm Personal Access Token / `.npmrc` setup instructions for installing `@qvac/registry-client`.

## [0.3.0]

Release Date: 2026-03-24

### ✨ Features

- Add download profiler for registry blob performance diagnostics — measures per-peer throughput, block timing, and connection stats for troubleshooting slow downloads (#1040)

### 🐛 Fixed

- Lazy-load Node.js builtins (`perf_hooks`, `worker_threads`) in profiler module for Bare runtime compatibility (#1096)
- Update package.json repository URLs to point to the monorepo (#1088)

## [0.2.1]

Release Date: 2026-03-16

### 🐛 Fixed

- Add bulk block prefetch (`core.download()`) before `blobs.createReadStream()` to restore download throughput lost in the migration from Hyperdrive to the registry — benchmarked at ~2.4x faster (#835)
- Clear downloaded blob blocks from corestore after successful download using `core.clear()` + `core.compact()` to reclaim disk space — prevents the `registry-corestore` folder from growing indefinitely (#835)
- Switch stream cleanup from `'close'` to `'end'` event so corestore cleanup triggers automatically when the consumer finishes reading, without requiring explicit `stream.destroy()` (#835)

## [0.2.0]

Release Date: 2026-02-26

### ✨ Features

- Add `downloadBlob(blobBinding, options)` method for direct blob download without metadata core sync — bypasses ~4s swarm discovery when blob coordinates are already known (#556)
- Split `_open()` into fast network init and background metadata connection for improved startup latency (#556)

### 🔧 Changed

- `_getBlobsCore` now accepts z-base-32 encoded keys via `IdEnc.decode` in addition to hex and Buffer inputs (#556)

## [0.1.8]

Release Date: 2026-02-25

### 🐛 Fixed

- Fix Pear app crash (`MODULE_NOT_FOUND: Cannot find module 'os'`) by replacing npm aliases with `#`-prefixed subpath imports for cross-runtime Bare/Node.js compatibility (#446)
- Update stale `DEFAULT_REGISTRY_CORE_KEY` to current production registry (#446)

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
