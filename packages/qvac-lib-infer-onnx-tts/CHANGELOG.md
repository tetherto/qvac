# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [0.2.10] - 2026-01-13

### Added
- TypeScript type declarations for `addonLogging` subpath export

## [0.2.9] - 2026-01-06

### Added
- Mobile device farm integration testing for AWS Device Farm (#118)
- Linux ARM64 prebuild support using `ubuntu-24.04-arm` runner (#117)
- vcpkg and ccache caching in prebuilds workflow for dramatically faster build times (#116)
- Reload functionality for TTS model with example and integration tests (#112)
- WER (Word Error Rate) tests (#109)
- Workflow dispatch to integration tests (#107)
- Unit tests for TTS interface (#98)

### Fixed
- Error reporting using @qvac/error package for consistent error handling (#114)
- Workflow dispatch on integration test (#111)
- Permissions for workflows (#110)
- Sanity checks workflow (#106)
- Use Hugging Face to download models (#96)

### Changed
- Freeze vcpkg version on macOS for build reproducibility (#113)
- Updated CODEOWNERS with ai-runtime-merge team (#99)

## [0.2.8] - 2025-12-03

### Added
- Addon logging JS interface export (#93)

---

## How to Update This Changelog

When releasing a new version:

1. Move items from `[Unreleased]` to a new version section
2. Add the version number and date: `## [X.Y.Z] - YYYY-MM-DD`
3. Keep the `[Unreleased]` section at the top for ongoing changes
4. Group changes by category: Added, Changed, Deprecated, Removed, Fixed, Security

### Categories

- **Added** for new features
- **Changed** for changes in existing functionality
- **Deprecated** for soon-to-be removed features
- **Removed** for now removed features
- **Fixed** for any bug fixes
- **Security** in case of vulnerabilities
