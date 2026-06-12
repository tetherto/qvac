## [0.4.2] - 2026-06-12

Widen the `bare-events` dependency from the exact pin `2.4.2` to the caret `^2.9.1` so installs resolve the latest `2.x`. This is the version the published inference addons resolve via their `@qvac/infer-base: ^0.4.0` range, so it clears the exact `bare-events` pin from the `@qvac/sdk` runtime tree without an API-breaking move to `0.5.x`/`0.6.x`. Package contents are otherwise identical to `0.4.1` (verified byte-identical against the npm `0.4.1` tarball).

### Changed

- `dependencies.bare-events`: `2.4.2` → `^2.9.1` (exact pin → caret).

## [0.4.1] - 2026-04-28

This release drops the vestigial `@qvac/dl-hyperdrive` peer dependency from `@qvac/infer-base`'s manifest. Since the `Loader` interface moved into this package and `ready()`/`close()` became optional in `0.4.0`, the peer-dep declaration was no longer required by anything in the runtime — consumers no longer carry an `@qvac/dl-hyperdrive` peer-dep through `@qvac/infer-base` when installing it.

### Changed

- Removed `peerDependencies."@qvac/dl-hyperdrive"` from `package.json`. No runtime behavior change — the `BaseInference` class, public methods, and standalone utilities (`createJobHandler`, `exclusiveRunQueue`, `getApiDefinition`) are all unchanged. Lint and the full `brittle-bare` unit suite (118/118) pass with the declaration removed.

## Pull Requests

- [#1761](https://github.com/tetherto/qvac/pull/1761) - QVAC-14392 chore: drop @qvac/dl-hyperdrive peer-dep chain in infer-base + decoder-audio

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
