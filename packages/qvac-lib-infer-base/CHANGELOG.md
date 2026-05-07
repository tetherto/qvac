## [0.5.0] - 2026-05-05

Breaking release: `@qvac/infer-base` is slimmed down to `QvacResponse` and the standalone utilities introduced in `0.4.0`. The `BaseInference` class, the `WeightsProvider` helper, and the deprecated `pause` / `continue` / `getStatus` surface on `QvacResponse` are all removed. Addons that extended `BaseInference` should now compose `exclusiveRunQueue`, `getApiDefinition`, and `createJobHandler` directly.

### Breaking Changes

#### `BaseInference` class removed

The class and its supporting TypeScript types — `BaseInferenceArgs`, `ProgressData`, `InferenceClientState`, and `ReportProgressCallback` — are no longer exported. Migrate by composing the standalone utilities:

```js
const {
  QvacResponse,
  exclusiveRunQueue,
  getApiDefinition,
  createJobHandler
} = require('@qvac/infer-base')
```

`getApiDefinition()` (`metal` / `vulkan` / `vulkan-32` per platform) replaces `BaseInference#getApiDefinition()`.

#### `WeightsProvider` removed

The class is no longer exported and the `WeightsProvider/` directory is no longer published. The `DOWNLOAD_FAILED` (4001) error code is removed alongside it.

#### `QvacInferenceBaseError` / `ERR_CODES` no longer shipped

`src/error.js` is removed. The codes it registered (`NOT_IMPLEMENTED` `3101`, `LOAD_NOT_IMPLEMENTED` `3102`, `ADDON_METHOD_NOT_IMPLEMENTED` `3103`, `LOADER_NOT_FOUND` `3104`, `ADDON_INTERFACE_REQUIRED` `3105`, `ADDON_NOT_INITIALIZED` `3106`) were only thrown from `BaseInference` / `WeightsProvider` and were never re-exported from the package entry, so consumers cannot have been throwing them through `@qvac/infer-base`.

#### `QvacResponse` pause / continue / status removed

Removed: `pause()`, `continue()`, `getStatus()`, `onPause()`, `onContinue()`, the `pauseHandler` / `continueHandler` constructor parameters, and the internal `paused` / `cancelled` status values. Use the existing event listeners (`onUpdate`, `onFinish`, `onError`, `onCancel`) and the addon's own cancel path.

#### `Loader` type export removed

The `Loader` interface — promoted into this package in `0.4.1` as a public type — is no longer exported. Downstream addons typing their loader implementations with `import type { Loader } from '@qvac/infer-base'` should inline the interface or import it from the loader package they actually use.

#### CommonJS export shape changed

Previously the entry was `module.exports = BaseInference` (the class, with the named utilities attached as properties), so `const BaseInference = require('@qvac/infer-base'); new BaseInference(...)` worked. The entry now exports a plain object with named exports only — `QvacResponse`, `exclusiveRunQueue`, `getApiDefinition`, and `createJobHandler`. Switch to destructured named imports.

### Other changes

- Internal `src/utils/progressReport` module removed. The only in-package consumer was `WeightsProvider`; `@qvac/dl-hyperdrive` still deep-imports `@qvac/infer-base/src/utils/progressReport` from its own runtime and tests and is pinned to `^0.1.0`, so it is unaffected by this release and will migrate (vendor or replace `progressReport`) before bumping its `infer-base` pin to `^0.5.0`.
- Dropped runtime dependencies on `@qvac/error`, `@qvac/logging`, and `bare-path`, and the optional dependency on `@qvac/diagnostics`. None were re-exported, so consumers should only see a smaller install footprint.

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
