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

The generator walks `test/integration/`, derives a function name per test file, and rewrites `integration.auto.cjs`. If a `test-groups.json` is added later (per-platform iOS/Android shard split), the generator will validate that every runner is covered.

## Running the Tests

The mobile tester app drives the auto-generated entrypoints to execute the desired test scenarios on-device. The CI mobile workflow (`integration-mobile-test-vla.yml`) builds the app, uploads to AWS Device Farm, and shards using `test-groups.json`.
