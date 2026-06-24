# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [0.1.2] - 2026-06-04

This patch aligns `@qvac/diagnostics` with the monorepo’s simplified package layout and streamlines runtime and OS detection when building diagnostic reports.

## Features

### Monorepo layout alignment

The package now lives under the standard `packages/diagnostics` tree from the monorepo path simplification. Published entry points are unchanged; release and CI follow the same patterns as other QVAC add-on libraries.

## Other

### Simpler runtime and environment detection

Environment collection uses `which-runtime` for platform, architecture, and runtime version, and resolves `os` through package `imports` so Bare and Node get the right implementation without probing `bare-process` or multiple fallback `require` paths at load time.

```javascript
const w = require('which-runtime')
const os = (w.isNode || w.isBare) ? require('os') : null
```

Hardware probing (CPU model, core count, memory) still uses `os` when available.

## Pull Requests

- [#1860](https://github.com/tetherto/qvac/pull/1860) - QVAC-16441 feat: simplify package folders, files and paths in the monorepo
- [#2157](https://github.com/tetherto/qvac/pull/2157) - simplify

## [0.1.0] - 2026-03-10

### Added

- `DiagnosticReport` schema defining the structure of a diagnostic report
- Contributor pattern API: `registerAddon` function accepting a `getDiagnostics` callback for per-addon diagnostic contributions
- Environment and hardware auto-detection via `bare-os` (platform, architecture, OS release)
- Unit tests covering report schema validation, addon registration, and environment detection
