# Mobile tests

Mobile-specific test infrastructure for `@qvac/ocr-ggml`. Runs the same
integration suite as desktop (`test/integration/*.test.js`) on Android and
iOS devices via the shared `qvac-test-addon-mobile` framework.

## Structure

- `integration-runtime.cjs` — loaded by the mobile framework at boot.
  Exposes `global.runIntegrationModule(relPath, options)`, which imports
  one integration module, triggers a GC pass, and sleeps for a short
  cooldown before returning.
- `integration.auto.cjs` — **auto-generated** wrapper file. Contains one
  `async function runXxx(options)` per `*.test.js` file under
  `test/integration/`. **Do not edit manually.** Re-generate with
  `npm run test:mobile:generate`.
- `testAssets/` — GGUF model blobs and the sample image, populated by
  `npm run mobile:copy-prebuilds`. Files are renamed to `*.gguf.bin` so
  the React Native bundler (metro) treats them as binary assets rather
  than JS source. The sample image (`english.png`) keeps its extension
  because `.png` is in metro's default asset list.

## Regenerating

```bash
npm run test:mobile:generate   # bare ./scripts/generate-mobile-integration-tests.js
npm run test:mobile:validate   # node ./scripts/validate-mobile-tests.js
```

## Model delivery

Unlike `classification-ggml` (which bundles weights in the npm package),
`ocr-ggml` downloads GGUF models from S3 at CI time. The mobile workflow:

1. Downloads models from S3 into `models/` (same S3 paths as desktop CI).
2. Runs `npm run mobile:copy-prebuilds` which calls
   `scripts/copy-mobile-test-assets.js`. That script copies the four
   required GGUFs into `test/mobile/testAssets/` with the `.gguf.bin`
   suffix, and copies `samples/english.png`.
3. The test framework pushes `testAssets/` to the device and exposes
   on-device paths via `global.assetPaths`.

## What ships in npm

The package publishes `test/mobile/` **and** `test/integration/` (see the
`files` field in `package.json`) so the mobile framework can resolve the
`../integration/*.test.js` imports from the installed npm tree.
