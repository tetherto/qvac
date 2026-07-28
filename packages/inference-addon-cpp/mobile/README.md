# inference-addon-cpp — mobile integration test addon

Runs the `inference-addon-cpp` integration suite on real iOS + Android devices
in CI (AWS Device Farm), via the shared `qvac-test-addon-mobile` harness — the
same test-app the other addon mobile integration tests use.

## Why this is a separate package

`inference-addon-cpp` itself is a header-only C++ library (no root
`package.json`; the desktop integration suite in `../tests/integration_js/*` is
three standalone Bare addons). The mobile harness is strictly **one addon per
app**, so this directory is a single self-contained Bare addon that aggregates
the integration bindings' native hooks (`binding.cpp`) and re-exposes each
desktop integration test as an on-device test.

## Layout

- `binding.cpp` / `CMakeLists.txt` — unified Bare module (`add_bare_module`),
  including the header-only library from `../src`.
- `index.js` / `binding.js` — `require.addon()` glue.
- `test/integration/*.test.js` — the brittle tests, ported to run on-device
  (each `require`s `../../index.js`).
- `test/mobile/integration-runtime.cjs` — installs Bare
  `unhandledRejection`/`uncaughtException`/`beforeExit` handlers that force a
  non-zero exit on device (so a dlopen/ABI crash fails the Device Farm run
  instead of going false-green) and exposes `runIntegrationModule`.
- `test/mobile/integration.auto.cjs` — **generated**; one `run<Name>` wrapper
  per `test/integration/*.test.js`. The harness invokes these as on-device
  tests.
- `scripts/generate-mobile-integration-tests.js` — regenerates
  `integration.auto.cjs`. `scripts/validate-mobile-tests.js` — checks it is in
  sync (CI runs this, advisory).

## Keeping in sync with the desktop suite ⚠️

`binding.cpp` and `test/integration/*.test.js` are **manual ports** of the
standalone desktop sub-packages under `../tests/integration_js/*` (phase 1:
`js-create-double-first-call/`). The llamacpp mobile addons avoid this by sharing
one `test/integration/` between desktop and mobile; inference-addon-cpp can't,
because its desktop suite is separate one-addon-per-package bindings, so the port
is a copy.

**There is no automated check tying these copies to their desktop originals**
(`validate-mobile-tests.js` only verifies `integration.auto.cjs` ↔
`test/integration/`). So when a desktop binding or test changes, update the copy
here too — otherwise the on-device test silently drifts from what desktop
asserts. A normalized drift-check (the files aren't byte-identical — require
paths differ and `binding.cpp` is aggregated/renamed) is tracked for the phase-2
port, when several bindings aggregate and the risk grows.

## Test scope (phased)

- **Phase 1:** `js-create-double` — pure js::Number / js_create_int32
  marshalling; no threads/timing/I/O, so near-zero on-device flake. Proves the
  full pipeline (prebuild → app → Device Farm → PASS/FAIL).
- **Phase 2 (current):** the `logger` **bridge** tests (`logger.test.js`, ported
  from `tests/integration_js/logger/test.js`) — C++→JS logger delivery via
  `setLogger`/`cppLog`/`dummyCppLogWork`/`dummyMultiThreadedCppLogWork`/
  `releaseLogger`, with `test_logger.cpp` folded into the unified binding
  (`JS_LOGGER`). These use only native `std::thread`, no `bare-thread`, so
  they're portable; timeouts are widened for device.
- **Deferred (phase-2 follow-up):** logger's `teardown.test.js` /
  `reject.test.js` — they spawn `bare-thread` workers loaded by relative path.
  Their on-device viability (worker-file bundling + `bare-thread` runtime
  support in the mobile Bare runtime) is unconfirmed and may need harness
  changes, so they land only after the first Device Farm dispatch validates
  `bare-thread` on device.
- The `output-callback-lifetime` UAF stress test stays desktop-ASan-only — no
  reliable signal without AddressSanitizer, which is unavailable on device.

## Local development

```sh
npm install
npm run build              # bare-make generate && build && install (desktop)
npm run test:mobile:generate
npm run test:mobile:validate
npm test                   # runs the ported tests on desktop

# cross-compile smoke (needs NDK / macOS+Xcode):
bare-make generate --platform android --arch arm64 -D ANDROID_STL=c++_shared
bare-make generate --platform ios --arch arm64
```

CI: `.github/workflows/integration-mobile-test-inference-addon-cpp.yml` builds
the `android-arm64` / `ios-arm64` prebuilds and runs the suite on Device Farm;
`.github/workflows/on-pr-inference-addon-cpp.yml` gates it behind the `verified`
+ `run-mobile-addon-tests` labels.
