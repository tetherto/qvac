# Changelog

## [0.1.0] - 2026-06-04

### Added

- Initial release
- `pending-approvals` subcommand: checks PR approval status and posts a review-status comment
- Modular command architecture with `Command` base class and per-command directory layout
- Security model: secrets via env vars only, `redact()` + `sanitizeError()` on all output
