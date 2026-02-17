# Changelog

## [0.1.6]

Release Date: 2026-02-16

### ✨ Features

- Download resume support via corestore block persistence: when using a persistent storage path, previously downloaded Hypercore blocks are cached locally — subsequent `downloadModel` calls only fetch missing blocks from the network (#387)
- `onProgress` callback and `signal` (AbortController) options for `downloadModel` in `outputFile` mode, enabling cancellation and real-time progress tracking with accurate initial offset for resumed downloads (#387)
- CLI tool (`qvac-registry`) with `list`, `get`, and `download` subcommands for querying and downloading models directly from the terminal (#315)

### 🔧 Changed

- Default registry core key fallback: client no longer requires `QVAC_REGISTRY_CORE_KEY` to be set — falls back to the production registry key when no explicit key is provided (#360)
- Updated CLI install docs with GitHub Packages setup instructions (#360)

### 🧪 Tests

- Added integration tests for download resume: full download, cancel + resume, and progress reporting on resume (#387)

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
