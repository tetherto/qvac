## [0.3.1] - 2026-03-30

### Changed

- README: removed outdated npm Personal Access Token and `.npmrc` authentication instructions; scoped `@qvac` packages install from the public registry without extra setup.

## [0.3.0] - 2026-03-03

### Added

- FinetuneProgress event handling in _outputCallback to forward per-iteration stats via updateStats
- ended() accepts optional terminal result argument for resolving await() with structured payloads

### Changed

- onFinish callback receives the end event result instead of always using this.output
- JobEnded skips updateStats for finetune terminal payloads to avoid wrong shape on stats listeners

## [0.0.1]

- feat: initial structure
- feat: consolidate QvacResponse from @qvac/response into infer-base
