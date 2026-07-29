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

- `binding.cpp` / `CMakeLists.txt` — unified Bare module (`add_bare_module`)
  aggregating **all three** desktop sub-package bindings, plus the header-only
  library from `../src`. `test_logger.cpp` and `output_callback_lifetime.cpp` are
  ports of the logger / output-callback-lifetime binding bodies.
- `index.js` / `binding.js` / `addon.js` — `require.addon()` glue.
- `test/integration/<suite>/**` — **GENERATED and NOT COMMITTED** (see
  `.gitignore`). Mirrors `../tests/integration_js/<suite>/` (tests + their
  `bare-thread` workers). CI regenerates it before building the app; locally run
  `npm run test:mobile:generate` first. Never hand-edit — change the desktop test.
- `test/mobile/integration-runtime.cjs` — installs Bare
  `unhandledRejection`/`uncaughtException`/`beforeExit` handlers that force a
  non-zero exit on device (so a dlopen/ABI crash fails the Device Farm run
  instead of going false-green) and exposes `runIntegrationModule`.
- `test/mobile/integration.auto.cjs` — **generated, not committed**; one
  `run<Name>Test` wrapper per desktop test entry. The harness invokes these as
  on-device tests.
- `test/mobile/test-groups.json` — **generated, not committed**; one Device Farm
  group per desktop suite, so each suite runs in its own app process (see
  "Coverage caveats").
- `scripts/lib/desktop-suites.js` — the single source of truth for the port
  (which files, and the two mechanical rewrites). Shared by:
  `scripts/generate-mobile-integration-tests.js` (writes the tree) and
  `scripts/validate-mobile-tests.js` (re-derives it and fails on any difference).
  `scripts/run-desktop-tests.js` runs every generated entry locally under `bare`.

## No mobile-only tests: the suite is generated from desktop

There are **no hand-written mobile tests**. Every on-device test IS a desktop
test, copied by `npm run test:mobile:generate` from
`../tests/integration_js/<suite>/` with exactly **two mechanical rewrites**:

1. `require('.')` → `require('../../../index.js')` — the desktop sub-packages each
   load their own addon; on mobile there is one aggregated addon.
2. `new Thread('./worker-x.js')` → `new Thread(require.resolve('./worker-x.js'))` —
   the desktop suite only gets away with a CWD-relative worker path because it
   runs with cwd set to its own sub-package dir. Anchoring to the module's own
   directory is correct in any cwd (and on device).

The generated tree is **not committed** — CI regenerates it (in `host-test`, and
again in `build` before the app is packed), so it cannot go stale and no
regenerate-and-commit step can be forgotten. `npm run test:mobile:validate` still
re-derives the expected tree and fails on any difference, which is what catches a
stale *local* generation before you run the tests.

The generator also refuses to produce two runners with the same name (e.g. a
future `logger-teardown/test.js` would collide with `logger/teardown.test.js`) —
duplicate `async function` declarations are valid JS, so the second would silently
win and a test would vanish.

Why copy at all? The llamacpp mobile addons share one `test/integration/` between
desktop and mobile. inference-addon-cpp can't: it's a header-only *library* whose
desktop suite is three **standalone one-addon-per-package** sub-packages, and the
harness only bundles files under this addon's own `test/` dir. Generation gives us
the same single-source-of-truth guarantee without restructuring the desktop suite.

> Generated files are excluded from `prettier`/`lunte` (see `.prettierignore`) —
> reformatting them would register as drift.

## Coverage caveats (device vs desktop)

**Process isolation.** On desktop each sub-package is its own process, so global
state can't leak between suites. On device the harness runs every entry in **one**
app process sharing one `JsLogger` singleton — and `logger/worker-set-norelease.js`
deliberately never calls `releaseLogger`, so logger state could bleed into the
other suites. The generated `test-groups.json` therefore puts **each suite in its
own Device Farm group**, i.e. its own run and its own fresh app process,
reproducing desktop's isolation. (Cost: one run per suite per platform instead of
one overall; these suites are seconds of device compute, so it's cheap.)

**`JS_LOGGER` is target-wide.** Desktop enables it only for the logger
sub-package; here one target means one setting, so `output-callback-lifetime`'s
internal `QLOG` also routes through `JsLogger`. Per-source scoping would be an ODR
violation — `QLOG` is called from inline bodies in shared headers — see the comment
in `CMakeLists.txt`. With no logger installed those calls take the no-owner path,
and group isolation keeps logger state out of the suite.

All five desktop test entries run on device, but two carry less signal there than
on desktop — worth knowing before treating a green mobile run as equivalent:

- **`output-callback-lifetime/test.js`** is a heap-use-after-free stress test whose
  detection depends on **AddressSanitizer**, which is not available in the mobile
  app. On device it is effectively a "does not crash" smoke test (a crash *is*
  still caught, via `integration-runtime.cjs`'s crash-to-failure handlers). The
  real UAF signal remains the desktop `linux-x64-asan` leg.
- **`logger/teardown.test.js` and `logger/reject.test.js`** drive `bare-thread`
  worker envs with timing-sensitive `terminate()` races. They pass locally after
  the worker-path rewrite, but `bare-thread` behaviour in the on-device Bare
  runtime is unverified until the first Device Farm run. Timeouts are inherited
  from the desktop sources; if the device proves too slow, raise them **in the
  desktop test** so both platforms stay in sync (never patch the generated copy).

## Local development

```sh
npm install
npm run test:mobile:generate   # REQUIRED FIRST — the suite is not committed
npm run build                  # bare-make generate && build && install (desktop)
npm test                       # runs every generated test on desktop
npm run test:mobile:validate   # optional: confirms your generation is current

# cross-compile smoke (needs NDK / macOS+Xcode):
bare-make generate --platform android --arch arm64 -D ANDROID_STL=c++_shared
bare-make generate --platform ios --arch arm64
```

CI: `.github/workflows/integration-mobile-test-inference-addon-cpp.yml` builds
the `android-arm64` / `ios-arm64` prebuilds and runs the suite on Device Farm;
`.github/workflows/on-pr-inference-addon-cpp.yml` gates it behind the `verified`
+ `run-mobile-addon-tests` labels.
