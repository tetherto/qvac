# @qvac/ggml-coload-smoke

Multi-addon **co-load** smoke harness.

Every native addon that wraps an LLM/speech/diffusion engine bundles its **own**
copy of `ggml`. Each addon's CI (desktop and AWS Device Farm) loads exactly one
addon per run, so it cannot see a whole class of bug: addon `A` passes alone,
addon `B` passes alone, but `A + B` crash when both are `dlopen`'d into the same
process. That is precisely what happened with `@qvac/tts-ggml@0.2.1` (an
unresolved `ggml_backend_is_cpu` symbol that `SIGABRT`'d on Android), and it
only showed up in the SDK end-to-end tests, where the consumer worker loads ~10
addons at once (`packages/sdk/server/worker.ts`).

This package `require()`s several `@qvac` ggml addons into **one** Bare process
and asserts each one loads. It is a cheap, model-free proxy for the SDK consumer
that can run on every PR.

## What it catches

- **`dlopen` / unresolved-symbol failures** when multiple addons share a process
  (the 0.2.1 crash class).
- A failure can never be a false-green: a synchronous `require()` throw or an
  async `unhandledRejection` on the worklet thread both force a non-zero exit.
- With `COLOAD_REQUIRE_INSTALLED=1` a silent fall-back to the monorepo source is
  also fatal, so a green run provably co-loaded the **installed** package (in CI,
  the PR's freshly-built prebuild overlaid onto the published baseline) rather
  than the checkout.

Deeper, compute-level interposition (two ggml copies corrupting each other's
backend registry during inference) is exercised by the SDK e2e suite; this
harness is the fast, model-free first line of defence. `COLOAD_CYCLES` adds a
model-free reload lifecycle for addons that opt in via `addons.js#lifecycle`;
real, model-driven load/unload (with weights) belongs in the SDK e2e.

## Usage

```bash
# from packages/ggml-coload-smoke (after the addons under test are built +
# their prebuilds/ are present)
COLOAD_ADDONS=all bare test/coload.test.js          # every addon (default)
COLOAD_ADDONS=speech bare test/coload.test.js       # one stack
COLOAD_ADDONS=tts-ggml,llm-llamacpp bare test/coload.test.js
```

`COLOAD_ADDONS` accepts `all`, a stack name (`speech` | `fabric` | `diffusion`),
or a comma-separated list of addon short names. Unknown names fail fast.

Environment:

- `COLOAD_ADDONS` -- selection (see above).
- `COLOAD_REQUIRE_INSTALLED=1` -- fail instead of falling back to monorepo
  source; CI sets this so the run must exercise the installed/overlaid package.
- `COLOAD_CYCLES=N` -- run the model-free reload lifecycle `N` times (default 1)
  for addons that opt in via `addons.js#lifecycle`.

The test resolves each addon by its package specifier (`@qvac/<addon>`): it uses
the **installed** package when present -- which is how CI co-loads the published
addons and overlays the PR's freshly-built prebuild -- and falls back to the
monorepo source package under `packages/` only when the addon isn't installed
(e.g. a local run against a freshly-built tree) and `COLOAD_REQUIRE_INSTALLED` is
not set.

The core lives in [`coload.js`](coload.js) (pure, unit-tested under Node via
`npm run test:unit`); `test/coload.test.js` is the thin Bare entrypoint.

## Adding / changing an addon

Edit [`addons.js`](addons.js): add the short name (matching the package
directory) and its `stack`. Keep the inventory in sync with the SDK addon map in
`packages/sdk/schemas/plugin.ts`.

## CI

The co-load runs inside each addon's own on-PR pipeline (`on-pr-<addon>.yml`),
right after that addon's `prebuild`, via two reusable workflows:

- `coload-smoke.yml` (desktop, `linux-x64`) -- co-loads the **published**
  baseline of the other addons and overlays the run's `prebuilds` artifact for
  the changed addon, so the smoke exercises the PR's diff, not the registry
  baseline.
- `coload-smoke-mobile.yml` (Android, AWS Device Farm) -- builds the full-bundle
  SDK consumer with the PR's `android-arm64` prebuild overlaid, and runs it
  on-device (the exact all-addon bootstrap that crashed in 0.2.1).

Gating (via `.github/actions/ci-router`):

- desktop co-load runs when the PR carries `run-coload-tests` (external forks also need `fork-ci` approval on the workflow run);
- the Device Farm co-load additionally requires `run-mobile-addon-tests`, so the
  expensive on-device run is opt-in (new model / new GPU work) rather than
  automatic.

Currently wired into the speech stack (`tts-ggml`, `transcription-parakeet`,
`transcription-whispercpp`) -- the stack of the 0.2.1 bug. Rolling the same two
`coload-smoke` / `coload-smoke-mobile` jobs into the remaining ggml addons'
`on-pr-<addon>.yml` is a mechanical follow-up (mind that some addon pipelines
lack a `context` job or a desktop leg).
