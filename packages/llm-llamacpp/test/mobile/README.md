# Mobile Testing for LLM Llamacpp

This directory contains the mobile test entrypoint for the `@qvac/llm-llamacpp` addon.

> ⚠️ **Note**: This test directory is included in the published npm package to support the mobile testing framework. These test files are NOT part of the public API and should only be used by the internal mobile testing infrastructure.

## Test Structure

- `integration-runtime.cjs` — Bare-runtime helper that exposes a global `runIntegrationModule()` so each generated test entry can dynamically import a single file under `../integration/`.
- `integration.auto.cjs` — **Auto-generated** by `npm run test:mobile:generate`. Each function in this file mirrors one `.test.js` under `test/integration/` and invokes it through the runtime helper. Do not edit by hand; regenerate after adding or renaming integration tests.
- `testAssets/` — Directory for model files and test data referenced by the integration tests.

## What the Mobile Tests Do

The mobile tests run the **same integration suite** that lives under `test/integration/`. They exercise the public `LlmLlamacpp` API end-to-end:

1. **Construct the addon** with the new constructor shape — `new LlmLlamacpp({ files: { model: [absolutePath] }, config, logger?, opts? })`. For sharded GGUF models the caller pre-resolves the shard list (`tensors.txt` + every `*-NNNNN-of-MMMMM.gguf` file).
2. **Load** the model into memory via `model.load()`.
3. **Run** inference, finetuning, generation-parameter, KV-cache, and other scenarios depending on which test entry is invoked.
4. **Unload** the model via `model.unload()` (or via `t.teardown()` in brittle tests).

There is **no separate `test.cjs` file** and the addon no longer takes a `Loader` instance — file paths are passed directly to the constructor by the test (or by the test helper in `test/integration/utils.js`). Mobile testing reuses these helpers unchanged.

## Test Groups & the Weekend Suite

`test-groups.json` shards the suite into Device Farm runs. The per-PR mobile
workflow auto-detects **only** the `android` and `ios` keys — every group under
them runs on each labelled PR.

The sibling `androidWeekly` / `iosWeekly` keys are **ignored by the PR path** and
are consumed only by `.github/workflows/weekend-mobile-test-llm-llamacpp.yml`
(Sundays 06:00 UTC + manual dispatch), which feeds them to the reusable mobile
workflow as a `test_groups` override. The heavier/slower tests (both OCR tests,
the Elephant + HighResAurora image functional tests, and the full
`vlmPerf{Gemma4,Qwen35}` perf groups) live there to keep PR runs fast.

To move a test between the per-PR and weekend cadence, just move its entry
between the `android`/`ios` and `androidWeekly`/`iosWeekly` sections — no
workflow edits required. The weekend run posts a pass/fail report to a
`weekly-mobile-report`-labelled GitHub issue and to the run's Summary page.

## Setup

### Test Assets

Each integration test downloads or expects its own model under `test/integration/...` (or under `testAssets/`). See the individual test files for the exact model required. Most tests rely on `setupModel()` / `setupTinyModel()` helpers in `test/integration/utils.js`, which resolve the absolute file paths and pass them through `files.model`.

## Regenerating `integration.auto.cjs`

After adding a new file under `test/integration/`, regenerate the mobile entries:

```bash
npm run test:mobile:generate
```

This walks `test/integration/`, derives a function name per test file, and rewrites `integration.auto.cjs`. The generator script also runs from CI to ensure mobile and desktop test inventories stay in sync.

## Running the Tests

From the mobile tester app root:

```bash
# Build the test app with llm-llamacpp
npm run build ../llm-llamacpp

# Run on Android
npm run android

# Run on iOS
npm run ios
```

The app drives the auto-generated entrypoints to execute the desired test scenarios on-device.

## Troubleshooting

### Model file not found
- Ensure the test asset referenced by the failing integration test is present under `test/integration/` (or `testAssets/`).
- For sharded models, every shard plus the `*.tensors.txt` file must be present — the caller is responsible for the full file set since the addon no longer downloads weights.

### Out of memory
- Mobile devices have limited RAM. Prefer the smaller test models (e.g. tinyllama / Qwen-0.6B) for on-device runs and skip large-model tests where possible.

### Timeout errors
- Generation timeouts can be tuned per test file in `test/integration/...` via the brittle `{ timeout }` option.
