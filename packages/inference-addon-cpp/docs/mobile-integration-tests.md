# Mobile integration tests (QVAC-21737)

Runs the `inference-addon-cpp` JS integration suites on mobile (iOS + Android)
via AWS Device Farm, so mobile-specific regressions (backend selection, ABI,
device runtime, addon load/unload) are caught in CI instead of downstream
consumer rollouts.

## Layout

`inference-addon-cpp` is a base C++ library with **no top-level npm package**.
Its JS integration tests are three self-contained bare addons under
`tests/integration_js/`. Rather than merge them, each addon was made
mobile-harness-shaped and the CI workflow matrixes over all three:

```
tests/integration_js/<addon>/
  test.js                     # desktop entry — thin re-export of the suite below
  test/integration/<addon>.test.js   # the actual brittle suite (require('../../index.js'))
  test/mobile/
    integration-runtime.cjs   # harness: dynamic-imports each suite, fails run on unhandled error
    integration.auto.cjs      # generated: one runXxxTest() per test/integration/*.test.js
  scripts/
    generate-mobile-integration-tests.js   # regenerates integration.auto.cjs
    validate-mobile-tests.js               # CI check: auto.cjs in sync with test/integration
```

`<addon>` ∈ {`logger`, `js-create-double-first-call`, `output-callback-lifetime`}.

Desktop `bare test.js` still runs each suite unchanged (the root `test.js`
re-exports `test/integration/<addon>.test.js`), so `pr-test-inference-addon-cpp-js.yml`
is unaffected. Regenerate the mobile shim after adding/renaming a test:
`npm run test:mobile:generate` (validated in CI by `npm run test:mobile:validate`).

## CI

`.github/workflows/integration-mobile-test-inference-addon-cpp.yml` — reusable
(`workflow_call`) + `workflow_dispatch`. Matrixes {Android, iOS} × the three
test addons and drives the shared `.github/actions/run-mobile-integration-tests/*`
composites (setup → build-mobile-app → upload-to-devicefarm → schedule
[single-pool] → monitor). One Device Farm app + run per addon per platform (6).

## ⛔ Blocked on infra — required before this can go green

1. **AWS Device Farm project + device pools**, added as GitHub secrets
   (naming follows the existing convention, e.g. `AWS_DEVICE_FARM_PROJECT_ARN_LLAMACPP_EMBED`):
   - `AWS_DEVICE_FARM_PROJECT_ARN_INFERENCE_ADDON_CPP`
   - `ANDROID_DEVICE_POOL_ARN_INFERENCE_ADDON_CPP`
   - `IOS_DEVICE_POOL_ARN_INFERENCE_ADDON_CPP`
   - (reuses existing `AWS_OIDC_ROLE_ARN`, `PAT_TOKEN`, and the iOS signing secrets)
2. **Mobile build of the test addons.** These addons have no prebuild pipeline,
   so the workflow sets `skip-prebuilds: true` to build from source for the
   device target. Confirm the harness cross-compiles a bare addon (with
   `add_bare_module` + the `../../../src` include of inference-addon-cpp) for
   android-arm64 / ios-arm64 during app build; if not, add a prebuilds workflow
   for each test addon and drop `skip-prebuilds`.
3. **npm names are unscoped** (`test-logger`, `test-js-create-double-first-call`,
   `output-callback-lifetime`). The harness/`build-mobile-app` was written for
   `@qvac/*` packages; verify packing/app-build works for unscoped names (or
   scope them).
4. **PR trigger wiring.** This workflow is currently `workflow_dispatch` +
   `workflow_call` only. To run on PRs like the other addons it needs a
   `pull_request_target` `on-pr-inference-addon-cpp.yml` with the
   label-gate / authorize / verified gates (those provide the secret + OIDC
   access forks can't get from `pull_request`). Wire the mobile job there,
   `needs`-gated on the existing build.

## Not validated locally

The addon-side scaffolding follows the embed-llamacpp reference exactly, but the
Device Farm run, the on-device app build, and the cross-compile path could not
be exercised without the ARNs, the private `tetherto/qvac-test-addon-mobile`
framework, and a device. Treat the workflow as a starting point to iterate on
once infra (1) is in place.
