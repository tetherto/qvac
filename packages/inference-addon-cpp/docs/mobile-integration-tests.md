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
(`workflow_call`) + `workflow_dispatch`. Two stages in one run:

1. **`prebuild` job** → `prebuilds-inference-addon-cpp.yml` (see below) produces
   the mobile `.bare` binaries.
2. **`build-and-test` job** (`needs: prebuild`) matrixes {Android, iOS} × the
   three test addons and drives the shared
   `.github/actions/run-mobile-integration-tests/*` composites (setup →
   build-mobile-app → upload-to-devicefarm → schedule [single-pool] → monitor).
   One Device Farm app + run per addon per platform (6).

### Prebuilds

The mobile harness does **not** cross-compile on the device runner — its
`build-mobile-app` step only *bundles* an existing `prebuilds/` dir. On desktop
the addon is compiled in place (host == target); on mobile the build host ≠ the
device, so each addon's native `.bare` must be cross-compiled ahead of time and
shipped into the app.

`.github/workflows/prebuilds-inference-addon-cpp.yml` does exactly that, scoped
to the **two mobile device targets only** (android-arm64 + ios-arm64) for the
three test addons — 6 jobs. It mirrors `reusable-prebuilds.yml`'s setup sequence
(`setup-build-host` / `setup-bare-tooling` / `bare-make generate|build|install`)
but drops vcpkg/AWS/Vulkan/Rust: these addons are dependency-free (`cmake-bare` +
`add_bare_module` + the base lib's `../../../src` headers), as the desktop
`pr-test-inference-addon-cpp-js.yml` build already proves. It is **not** routed
through `reusable-prebuilds.yml` on purpose — that would run its full 9-platform
release matrix × 3 addons = 27 jobs, 21 of them unused by (and extra failure
surface for) the mobile test. Each job uploads a per-addon, per-platform
artifact (`<prefix>android-arm64` / `<prefix>ios-arm64`) that the
`build-and-test` setup phase downloads by the matching `prebuild-artifact-prefix`.

### Device Farm secrets (no new infra required)

These are trivial functional test addons — no model inference, no
device-specific requirement — so they **reuse the shared LLM Device Farm
project + pools** rather than provisioning a dedicated project:

- `LLM_AWS_DEVICE_FARM_PROJECT_ARN`
- `LLM_ANDROID_DEVICE_POOL_ARN`
- `LLM_IOS_DEVICE_POOL_ARN`

This is the same group `classification-ggml` and `diffusion-cpp` already
piggyback on. Shared secrets `AWS_OIDC_ROLE_ARN`, `PAT_TOKEN`, and the iOS
signing set are reused as-is. No infra ticket needed.

## PR trigger

`on-pr-inference-addon-cpp.yml` — a `pull_request_target` workflow (path-filtered
to `packages/inference-addon-cpp/**`) that runs the shared `label-gate` /
`ci-router` / `authorize-pr` gates and then calls the mobile workflow with
`secrets: inherit`. `pull_request_target` (not `pull_request`) is required
because the mobile suite needs secrets — Device Farm ARNs, AWS OIDC, Apple
signing, PAT — which GitHub does not expose to fork `pull_request` runs; the
gates make running fork code with secrets safe. It is intentionally MOBILE-ONLY:
the desktop/native suites already run on `pull_request` via
`pr-test-inference-addon-cpp{,-js}.yml`, and it carries no prebuild job because
the mobile workflow self-contains its own.

The Device Farm run is opt-in: `ci-router` only sets `run_mobile` when the PR
carries **both** the `verified` label (authorises) and the `run-mobile-addon-tests`
label (selects the stage). A trusted reviewer applies them after reviewing the diff.

## ⚠️ Open item (not a blocker)

**npm names are unscoped** (`test-logger`, `test-js-create-double-first-call`,
`output-callback-lifetime`) whereas the harness was written for `@qvac/*`. In
practice this is low-risk: desktop builds these purely by local path (never by
npm name), and the mobile harness likewise packs/builds from the local dir — the
only name-sensitive path is `setup`'s npm fallback (`npm pack <name>@latest`),
which is disabled on PRs and bypassed whenever prebuild artifacts are present (now
always). Worth confirming the fallback never fires, or scoping the three addons to
`@qvac/*` for consistency — but not a correctness blocker.

## Not validated locally

The addon-side scaffolding follows the embed-llamacpp reference exactly, and the
prebuild workflow mirrors the proven `reusable-prebuilds.yml` sequence, but the
Device Farm run, the on-device app build, and the android/ios cross-compile of
these specific addons could not be exercised locally (they need the private
`tetherto/qvac-test-addon-mobile` framework, the CI toolchain, and a device).
First CI run of the prebuild + mobile pipeline is the validation step; iterate
from its logs.
