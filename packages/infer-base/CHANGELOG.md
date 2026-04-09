## [0.4.0] - 2026-03-31

### Added

- `exclusiveRunQueue()` standalone utility — serialized async execution queue, extracted from `WeightsProvider/BaseInference._withExclusiveRun`
- `getApiDefinition()` standalone utility — platform-to-graphics-API mapper, extracted from `BaseInference.getApiDefinition`
- `createJobHandler()` utility — composable single-job lifecycle manager (`start`, `output`, `end`, `fail`, `active`) that replaces the `_jobToResponse` Map / `_saveJobToResponseMapping` / `_deleteJobMapping` boilerplate
- All three utilities exported as named exports from `@qvac/infer-base`

### Deprecated

- `QvacResponse.pause()` — single-job addon model has no pause semantics; will be removed in a future version
- `QvacResponse.continue()` — same as above
- `QvacResponse.getStatus()` — use response event listeners instead; will be removed in a future version
- `QvacResponse.onPause()` / `QvacResponse.onContinue()` — will be removed in a future version
- `pauseHandler` / `continueHandler` constructor parameters — now optional

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
