# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-03-10

### Added

- `DiagnosticReport` schema defining the structure of a diagnostic report
- Contributor pattern API: `registerAddon` function accepting a `getDiagnostics` callback for per-addon diagnostic contributions
- Environment and hardware auto-detection via `bare-os` (platform, architecture, OS release)
- Unit tests covering report schema validation, addon registration, and environment detection
