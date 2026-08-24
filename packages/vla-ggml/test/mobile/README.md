# Mobile Testing for VLA

This directory contains the mobile test entrypoint for the `@qvac/vla-ggml` addon.

> ⚠️ **Note**: This test directory is included in the published npm package to support the mobile testing framework. These test files are NOT part of the public API and should only be used by the internal mobile testing infrastructure.

## Test Structure

- `integration-runtime.cjs` — Bare-runtime helper. Exposes a global `runIntegrationModule()` so each generated test entry can dynamically import a single file under `../integration/`. Also exposes `__shouldRunTest()`, which lets CI push a `testFilter.txt` (regex) onto the device and only run tests whose name matches the pattern.
- `integration.auto.cjs` — **Auto-generated** by `npm run test:mobile:generate`. Each function mirrors one `.test.js` under `test/integration/` and calls into the runtime helper. Do not edit by hand; regenerate after adding or renaming integration tests.

## Regenerating `integration.auto.cjs`

After adding a new file under `test/integration/`, regenerate the mobile entries:

```bash
npm run test:mobile:generate
```

The generator walks `test/integration/`, derives a function name per test file, and rewrites `integration.auto.cjs`. It **only generates** — it performs no `test-groups.json` validation, because `npm run test:integration` chains it, so anything that throws there takes desktop integration tests down on every platform.

## `test-groups.json` and deferred runners

`test-groups.json` is the per-platform Device Farm shard split. Every runner in `integration.auto.cjs` must either appear in a group for each platform, or be listed under the top-level `deferred` key:

```json
{
  "ios":      { "smolvla": ["runAddonTest"], "groot": ["runGrootTest"] },
  "android":  { "smolvla": ["runAddonTest"], "groot": ["runGrootTest"] },
  "deferred": ["runPi05Test"]
}
```

`deferred` records runners that are intentionally not scheduled on device — pi05 mobile coverage is deferred pending a project-owned CDN-fronted mirror, and `pi05.test.js` is gated on-device by `_skipMobilePi05`. Declaring it keeps "not scheduled" distinguishable from "forgotten"; deleting the runner from the file instead makes those two indistinguishable.

`deferred` **must stay a top-level key**. The CI composites consume only `.<platform>` and ignore every other top-level key (as OCR's `perf_report_filter` already relies on), so nesting `deferred` inside `ios`/`android` would schedule it as a real Device Farm shard.

Coverage is enforced by:

```bash
npm run test:mobile:validate   # also runs as part of `npm run test:unit`
```

which runs in the ungated `ts-checks` PR job, so a scheduling mistake is caught on every PR instead of only inside the expensive, label-gated integration suite.

## Running the Tests

The mobile tester app drives the auto-generated entrypoints to execute the desired test scenarios on-device. The CI mobile workflow (`integration-mobile-test-vla.yml`) builds the app, uploads to AWS Device Farm, and shards using `test-groups.json`.
