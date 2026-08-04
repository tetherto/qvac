## [0.7.0] - 2026-07-31

TypeScript is now the source of truth for `@qvac/infer-base`. `index.ts` and `src/**/*.ts` are compiled with `tsc` into the `index.js` / `src/**/*.js` runtime and the `.d.ts` declarations that ship on npm, so the published types can no longer drift from the implementation. The runtime behaviour and the CommonJS export shape are intentionally unchanged — the only consumer-visible difference is in the declarations.

### Breaking Changes

#### `QvacResponse#getLatest()` is now typed as nullable

`getLatest(): Output` became `getLatest(): Output | null`. The runtime always could return `null` (there is no output until the first `updateOutput()`), so this corrects the declaration rather than changing behaviour. TypeScript consumers that read the result directly now have to narrow it:

```ts
// Given a `QvacResponse<string>`:
const latest = response.getLatest()

// Before — this compiled
const uncheckedLatest: string = latest
void uncheckedLatest

// After — narrow the result before assigning it
if (latest !== null) {
  const checkedLatest: string = latest
  void checkedLatest
}
```

JavaScript consumers are unaffected.

### Fixes

#### The published declarations now type-check without DOM

On 0.6.2 the shipped `.d.ts` files did not compile for a Bare-style consumer - one using `lib: ["ES2022"]` with no DOM and `skipLibCheck: false`. `index.d.ts` and `src/QvacResponse.d.ts` referenced the DOM global `AbortSignal` (`TS2304`), and `bare-events` imports `AbortSignal` from `bare-abort-controller` in its own declarations while listing it only as an optional peer dependency, so it was absent from the install tree (`TS2307`).

Both are fixed. The `signal` option on the `QvacResponse` constructor and on `createJobHandler().start()` is now typed as `AbortSignalLike` - a structural type covering only the members this package touches (`aborted`, `reason`, `addEventListener('abort', ...)`, `removeEventListener('abort', ...)`) - so Bare, DOM, and Node signals are all accepted. And `bare-abort-controller` (`^1.1.2`) is declared in `dependencies` so the `bare-events` declarations resolve. The runtime is unchanged: it already accepted any signal with those four members. The type is re-exported from the package entry:

```ts
import type { AbortSignalLike } from '@qvac/infer-base'
```

This widens the accepted input, so existing call sites keep compiling.

## [0.6.2] - 2026-07-29

fix: settle a `QvacResponse` before invoking its listener callbacks, so a listener that throws can no longer strand the response promise. `_end` resolves before emitting `end`, and both failure paths (`_fail` and the abort path) reject before emitting `error`. Previously a throwing `end` / `error` listener left the promise neither resolved nor rejected, hanging every caller awaiting it.

`createJobHandler` now runs `updateStats` under a `try`/`finally` so a failure there still ends the job instead of leaking an active handler.

Listener exceptions still propagate unchanged, and no public API changed — only the order of settling versus emitting.

## [0.6.1] - 2026-06-12

chore: replace the exact `bare-events` pin (`2.4.2`) with caret `^2.9.1` so it resolves to the latest 2.x at install. No public API change — only the dependency version range is widened. `bare-os` is left untouched (`^3.2.0`).

## [0.6.0] - 2026-05-28

Threads an optional `AbortSignal` into `QvacResponse` so addons can settle a job from external timeout / crash paths without polling.

## New APIs

`QvacResponse` and `createJobHandler().start()` accept an optional `signal`. When aborted, the response is failed with the abort `reason` — an `Error` reason is passed through unchanged, anything else is wrapped in `Error('Aborted: ...')`. Addons typically forward the signal they received from `model.run(input, { signal })`:

```js
const response = jobs.start({ signal: opts.signal })
```

The abort listener is detached when the response settles, so sharing a long-lived signal (e.g. a process-wide crash controller) does not leak listeners.

## Features

- `failed()` / `ended()` are now idempotent — repeat calls after settlement are no-ops, so the abort path can race the addon's own settlement without double-rejects or double-emits.
- `iterate()` wakes immediately on `output` / `end` / `error` events instead of polling out `pollInterval`, and attaches a single pair of listeners for the iterator's lifetime instead of per yielded chunk.

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
