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
- `testAssets/` — optional non-test resources that must be pushed to
  the device (none required for this addon; the GGUF weights ship
  inside the npm package at `weights/`).

## Regenerating

```bash
npm run test:mobile:generate   # bare ./scripts/generate-mobile-integration-tests.js
npm run test:mobile:validate   # node ./scripts/validate-mobile-tests.js
```

## What ships in npm

The package publishes `test/mobile/` **and** `test/integration/` (see
the `files` field in `package.json`) so the mobile framework can
resolve the `../integration/*.test.js` imports from the installed npm
tree. The GGUF model is bundled under `weights/` and is resolved by the
same default-path logic used on desktop.

## Lifecycle caveat on mobile

The underlying `@qvac/qvac-lib-inference-addon-cpp` `JsLogger` holds a
process-wide static `uv_async_t` whose lifecycle is not safe across
rapid classifier create/destroy cycles. The `ImageClassifier`
`nativeLogger` option is therefore **off by default** on all platforms,
including mobile. JS-level logging still flows through the caller's
`logger`.
