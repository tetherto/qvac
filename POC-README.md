# POC: pnpm loose linking + nx transitivity (classification-ggml scope)

Scope: `classification-ggml` + its own dependencies (`fabric`, `infer-base`, `logging`). Nothing
else touched — no `.github/workflows/*` changes, no version bumps, no `workspace:` protocol. Local
review only, not merged to `main`.

## What's new here vs. `main`

- `pnpm-workspace.yaml` — scopes pnpm to these 4 packages, `linkWorkspacePackages: true`.
- root `package.json` — just `nx` as a devDependency.
- `nx.json` — minimal config.

All 4 packages keep their existing plain-semver `@qvac/*` deps exactly as on `main` — nothing to
convert, nothing to break.

## 1. Loose linking: local packages resolve to live source

```bash
pnpm install
readlink -f packages/classification-ggml/node_modules/@qvac/logging
readlink -f packages/classification-ggml/node_modules/@qvac/fabric
readlink -f packages/classification-ggml/node_modules/@qvac/infer-base
```

`logging`/`fabric` resolve straight into `packages/logging`/`packages/fabric` — real symlinks to
source in this repo, not downloaded copies. Edit either and the change is live immediately.

`infer-base` is the interesting one: resolves into `node_modules/.pnpm/...` (a registry copy), not
local source. Local `infer-base` is `0.6.2`; classification-ggml declares `^0.4.0` — a `0.x` caret
range only allows patch bumps within `0.4.x`, so they don't overlap. Loose linking respects that and
falls back to the registry instead of forcing an incompatible link — a real, pre-existing gap in the
monorepo, not staged for this demo.

## 2. Transitivity: nx knows what depends on what

```bash
echo "// scenario-test-marker" >> packages/logging/index.js
pnpm exec nx show projects --affected --uncommitted --json
```

Output includes `@qvac/classification-ggml` — nx flags the consumer of what you touched, not just
the package itself. This is the transitivity: a change propagates up through real dependency edges
to whatever depends on it, so CI can retest/rebuild the whole affected chain instead of just the one
changed package or a hand-maintained path list.

Revert before moving on: `git checkout -- packages/logging/index.js`

### ⚠️ Why this branch's own diff shows *everything* as affected

Diffing `--base=main` from here shows all 4 packages affected, even for a one-line change. Not a
bug — nx's documented failsafe marks every project affected whenever the package manager's lockfile
changes (https://nx.dev/docs/features/ci-features/affected), specifically to cover cases nx's own
graph might miss on a dependency update. This branch adds a brand-new `pnpm-lock.yaml`, so that
failsafe always fires when diffing against `main`.

**Branch off *this* branch instead**, so those files are already on your base and drop out of the
diff:

```bash
git checkout -b my-test-branch   # from feature-poc-classification-ggml-linking
echo "something" >> packages/fabric/index.js   # or classification-ggml/index.js
git commit -am "test change"
pnpm exec nx show projects --affected --base=feature-poc-classification-ggml-linking --head=HEAD --json
```

- Edit `fabric` (dependency) → shows **both** `fabric` and `classification-ggml`.
- Edit `classification-ggml` (dependent) → shows **only** `classification-ggml`.

This is how the 3 real validation PRs for this POC were structured (see §4).

## 2b. Running builds/tests for only the affected packages

`nx show projects --affected` only *lists*. To actually run something, use `nx affected -t <target>`
(same rules apply — a `fabric` edit builds both, a `classification-ggml` edit builds only itself):

```bash
pnpm exec nx affected -t build
pnpm exec nx affected -t test:unit
pnpm exec nx affected -t build test:unit   # or both
```

`nx run-many -t <target>` (no `affected`) runs a target for *every* project — useful for a full local
sanity check. Scope to the core 4 to skip `llm-llamacpp`/`embed-llamacpp` (see the known limitation
below for why they'd even come up):

```bash
pnpm exec nx run-many -t build -p classification-ggml,fabric,infer-base,logging
pnpm exec nx run-many -t test:unit -p classification-ggml,fabric,infer-base,logging
```

Both green as of this branch: `build` succeeds for the 3 packages with a build step (`logging` is
pure JS, nothing to build — expected). `test:unit` passes 57/57 tests, 116/116 assertions across the
3 packages with a `test:unit` script (`fabric` only has `test:integration` — also expected).

**Real gaps found this way and fixed** (workspace linking exposing real local source instead of a
stale registry snapshot — same class as the `infer-base` mismatch above; every `require()`/`import`
across all 4 packages was audited up front rather than fixed one at a time):
- `cmake-npm` wasn't a direct devDependency on `classification-ggml`/`fabric` — CMake's
  package-relative `find_package` needs it there under pnpm's isolated linker, else `build` fails.
- `logging`'s tests import `bare-process` undeclared — `MODULE_NOT_FOUND` until added as a
  devDependency (test-only).
- `classification-ggml`'s `test:integration` imports `bare-os`/`bare-process` undeclared — same fix.
  Now passes: 14/14 tests, 140/140 assertions.

**Known limitation, not fixed here:** `fabric`'s `test:integration` doesn't run in this POC. It's a
real cross-package test (proves `llm-llamacpp` and `embed-llamacpp` share one `@qvac/fabric` runtime)
via its own nested `test/integration/package.json`. Neither package has `node_modules` in this POC's
scope, so it fails on missing `bare-fs`. Fix: add both to `pnpm-workspace.yaml` and give `fabric` a
`project.json` with `implicitDependencies: ["llm-llamacpp", "embed-llamacpp"]` (nx needs telling
explicitly, since it's not a real `package.json` dependency) — tried, confirmed it resolves `bare-fs`.
Left out on purpose: past that, the test still needs both packages natively compiled and a real
(likely private, S3-hosted) GGUF model download — out of scope here.

## 3. Override: loose linking isn't all-or-nothing

```bash
pnpm install --config.link-workspace-packages=false
readlink -f packages/classification-ggml/node_modules/@qvac/logging
```

`logging` now resolves into `.pnpm`'s registry store too, like `infer-base` above — the flag flips
*every* package back to normal-dependency resolution, useful for testing against what's actually
published. Restore with `pnpm install`.

## 4. Real CI: a workflow consolidation proving both ideas together

`.github/workflows/poc-prebuilds-nx.yml` merges `prebuilds-classification-ggml.yml` +
`prebuilds-fabric.yml` (identical thin wrappers around `reusable-prebuilds.yml`) into one
`nx affected`-driven matrix, `pull_request`-triggered.

Supports either linking mode from the same file. Default is loose. To resolve against the registry
for one run, put this exact text anywhere in the PR title/body: `[verify-registry]` — or set the
`verify-against-registry` input on a manual `workflow_dispatch`. (Don't repeat that bracketed text in
an unrelated PR description — it's a plain substring match against title+body.)

## Why this scope, why this approach

- "Loose" linking chosen over the stricter `workspace:` protocol, which would've forced the
  `infer-base` link regardless of the version mismatch — proven separately, not included here.
- Work stays on a branch, zero effect on the real `classification-ggml`/`fabric` release path.
- Scope is classification-ggml + its dependencies — a real 4-package slice of the monorepo.
