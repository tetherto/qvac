# Changelog

All notable changes to `@tetherto/qvac-lib-registry-client` will be documented in this file.

## [0.2.0] - 2026-02-12

### Added

- `findBy(params)` method on `QVACRegistryClient` for efficient indexed queries by name, engine, and quantization (#184)
- `FindByParams` interface for typed query parameters (name, engine, quantization, includeDeprecated)
- `findBy` type definition in `index.d.ts`

### Changed

- Bumped `@tetherto/qvac-registry-schema-mono` dependency from `^0.1.x` to `^0.2.1`

## [0.1.3] - Previous release

- Initial stable release with `findModels`, `getModel`, `downloadModel`, and query-by-index methods
