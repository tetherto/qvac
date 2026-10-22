# Mobile tests

Mobile-specific test infrastructure for `@qvac/classification-ggml`. Runs
the same integration suite as desktop (`test/integration/*.test.js`) on
Android and iOS devices via the shared `qvac-test-addon-mobile`
framework.

## Structure

- `integration-runtime.cjs` — loaded by the mobile framework at boot.
  Exposes `global.runIntegrationModule(relPath, options)`, which
  imports one integration module, triggers a GC pass, and sleeps for
  a short cooldown before returning.
- `integration.auto.cjs` — **auto-generated** wrapper file. Contains
  one `async function runXxx(options)` per `*.test.js` file under
  `test/integration/`. **Do not edit manually.** Re-generate with
  `npm run test:mobile:generate`.
- `testAssets/` — staged model files, test images and reference descriptors.
  Manually convert both MegaLoc models as described in
  [the conversion guide](../../docs/megaloc.md#local-gguf-conversion), then run
  `npm run mobile:copy-prebuilds`. It reads `test/fixtures/megaloc-f16.gguf`
  and `test/fixtures/megaloc-mixed.gguf`, or the paths supplied through
  `QVAC_MEGALOC_F16_MODEL_PATH` and `QVAC_MEGALOC_MIXED_MODEL_PATH`.

## Regenerating

```bash
npm run test:mobile:generate   # bare ./scripts/generate-mobile-integration-tests.js
npm run test:mobile:validate   # node ./scripts/validate-mobile-tests.js
```

## What ships in npm

The package publishes `test/mobile/` **and** `test/integration/` (see
the `files` field in `package.json`) so the mobile framework can
resolve the `../integration/*.test.js` imports from the installed npm
tree. Only the MobileNet model is bundled under `weights/`. MegaLoc GGUFs,
including their staged `.gguf.bin` mobile copies, are excluded from the npm
package. The mobile test harness must receive the staged assets separately;
the tests resolve their device paths through `global.assetPaths`.

## Lifecycle caveat on mobile

The underlying `@qvac/qvac-lib-inference-addon-cpp` `JsLogger` holds a
process-wide static `uv_async_t` whose lifecycle is not safe across
rapid classifier create/destroy cycles. The `ImageClassifier`
`nativeLogger` option is therefore **off by default** on all platforms,
including mobile. JS-level logging still flows through the caller's
`logger`.
