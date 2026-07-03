# Changelog

## [0.2.1] - 2026-06-30

### Fixed

- README: remove stale GPR/`ci-mono` distribution note, correct `lib/commands/index.js` registration step (explicit import + push to commands array)

## [0.2.0] - 2026-06-24

### Added

- `--version` / `-v` flag: prints `qvac-ci v<version>` and exits

### Changed

- Replace `paparam` runtime dependency with a zero-dependency internal CLI builder (`lib/cli.js`); no change to command behaviour or flags

## [0.1.0] - 2026-06-04

### Added

- Initial release
- `pending-approvals` subcommand: checks PR approval status and posts a review-status comment
- Modular command architecture with `Command` base class and per-command directory layout
- Security model: secrets via env vars only, `redact()` + `sanitizeError()` on all output
