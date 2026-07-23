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

Deeper, compute-level interposition (two ggml copies corrupting each other's
backend registry during inference) is exercised by the SDK e2e suite; this
harness is the fast, model-free first line of defence and can be extended with
per-addon inference hooks later.

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

The test resolves each addon by its package specifier (`@qvac/<addon>`): it uses
the **installed** package when present -- which is how CI co-loads the published
addons -- and falls back to the monorepo source package under `packages/` only
when the addon isn't installed (e.g. a local run against a freshly-built tree).

## Adding / changing an addon

Edit [`addons.js`](addons.js): add the short name (matching the package
directory) and its `stack`. Keep the inventory in sync with the SDK addon map in
`packages/sdk/schemas/plugin.ts`.

## CI

A desktop matrix runs this on PRs that touch any ggml addon -- the "all" combo
plus per-stack, cross-stack, and changed-addon-focused combos. On a PR it
co-loads the **published** addons (a registry-baseline net), not the PR's own
build; the PR's freshly-built change is guarded by the Phase-1 prebuild symbol
gate. A Device Farm variant reuses the SDK mobile bundle machinery to reproduce
the Android paths.
