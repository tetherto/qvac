# Mobile Testing for LLM Llamacpp

This directory contains the mobile test entrypoint for the `@qvac/llm-llamacpp` addon.

> ⚠️ **Note**: This test directory is included in the published npm package to support the mobile testing framework. These test files are NOT part of the public API and should only be used by the internal mobile testing infrastructure.

## Test Structure

- `integration-runtime.cjs` — Bare-runtime helper that exposes a global `runIntegrationModule()` so each generated test entry can dynamically import a single file under `../integration/`.
- `integration.auto.cjs` — **Auto-generated** by `npm run test:mobile:generate`. Each function in this file mirrors one `.test.js` under `test/integration/` and invokes it through the runtime helper. Do not edit by hand; regenerate after adding or renaming integration tests.
- `model-manifest.json` — **Hand-maintained** Android pre-stage map (see below).
- `test-groups.json` — Device Farm shard definitions (see below).
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

## Model Pre-Staging (`model-manifest.json`)

Android Device Farm runs never let the phone download weights. The host
`pre_test` phase — where the network is reliable — fetches exactly the models
the shard needs and `adb push`es them to `/data/local/tmp/prestaged-models`;
`ensureModel()` in `test/integration/utils.js` picks them up from there.

`model-manifest.json` maps **mobile test function name → the models that test
needs**, and `scripts/generate-prestage-block.js` unions the entries for the
tests in the shard's grep to build that download list.

Two things are easy to get wrong, and neither fails loudly:

- **A test in `test-groups.json` with no manifest entry** does not error — the
  phone just downloads its models mid-test over the Device Farm's flaky
  network, which is the exact failure mode pre-staging exists to remove.
- **URLs here are informational.** The pre-stage resolves every download from
  the commit-pinned `test/integration/models.manifest.json` by `name`. Keep
  them identical anyway so the file cannot mislead the next reader.

Both are enforced by `scripts/validate-mobile-manifest.js`, which runs as part
of `npm run test:mobile:validate` (hard-fails the mobile workflow) and as unit
tests under `npm run test:prestage`:

```bash
node scripts/validate-mobile-manifest.js         # check
node scripts/validate-mobile-manifest.js --fix   # repin urls from models.manifest.json
```

It also checks that every model a grouped test names in its own source is
staged by every shard that runs it. When a model is referenced but must
deliberately *not* be pre-staged (desktop-only, opt-in behind an env flag, too
large for a phone), say so at the declaration:

```js
// prestage-ignore: gemma-4-26B-A4B-it-Q8_0.gguf — desktop opt-in only (~27 GB)
```

The reason is required. Adding a model to a test therefore means adding it to
the manifest entry — or explaining, in the test, why not.

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
