# POC: pnpm loose linking + nx transitivity (classification-ggml scope)

Scope: `classification-ggml` + its own dependencies (`fabric`, `infer-base`, `logging`). No
`.github/workflows/*` changes, no version bumps, no `workspace:` protocol. Local review only, not
merged to `main`.

## What's new here vs. `main`

- `pnpm-workspace.yaml` — scopes pnpm to these 4 packages, `linkWorkspacePackages: true`.
- root `package.json` — just `nx` as a devDependency.
- `nx.json` — minimal config.

All 4 packages keep their existing plain-semver `@qvac/*` deps exactly as on `main`.

## 1. Loose linking: local packages resolve to live source

```bash
pnpm install
readlink -f packages/classification-ggml/node_modules/@qvac/logging
readlink -f packages/classification-ggml/node_modules/@qvac/infer-base
```

`logging` resolves into `packages/logging` — a real symlink to source in this repo, not a downloaded
copy. Edit it and the change is live immediately.

`infer-base` resolves into `node_modules/.pnpm/...` (a registry copy) instead. Local `infer-base` is
`0.6.2`; classification-ggml declares `^0.4.0` — a `0.x` caret range only allows patch bumps within
`0.4.x`, so they don't overlap. Loose linking falls back to the registry rather than forcing an
incompatible link — a real, pre-existing gap in the monorepo, not staged for this demo.

## 2. Transitivity: nx knows what depends on what

```bash
echo "// scenario-test-marker" >> packages/logging/index.js
pnpm exec nx show projects --affected --uncommitted --json
```

Output includes `@qvac/classification-ggml` — the change propagates through the real dependency
edge to whatever depends on it, so CI can retest/rebuild the whole affected chain instead of just
the one changed package or a hand-maintained path list.

Revert before moving on: `git checkout -- packages/logging/index.js`

### ⚠️ Why this branch's own diff shows *everything* as affected

Diffing `--base=main` from here shows all 4 packages affected, even for a one-line change. Not a
bug — nx's documented failsafe marks every project affected whenever the lockfile changes
(https://nx.dev/docs/features/ci-features/affected), to cover cases its graph might miss on a
dependency update. This branch adds a brand-new `pnpm-lock.yaml`, so the failsafe always fires
against `main`.

**Branch off *this* branch instead**, so the lockfile is already on your base:

```bash
git checkout -b my-test-branch   # from feature-poc-classification-ggml-linking
echo "something" >> packages/fabric/index.js   # or classification-ggml/index.js
git commit -am "test change"
pnpm exec nx show projects --affected --base=feature-poc-classification-ggml-linking --head=HEAD --json
```

- Edit `fabric` (dependency) → shows **both** `fabric` and `classification-ggml`.
- Edit `classification-ggml` (dependent) → shows **only** `classification-ggml`.

### Real validation runs

3 short-lived test PRs against this branch, each closed once confirmed:

| Test | Change | Expected | PR | Run |
|---|---|---|---|---|
| 1 | classification-ggml only | fabric NOT triggered | [#3583](https://github.com/tetherto/qvac/pull/3583) | [run](https://github.com/tetherto/qvac/actions/runs/30650792946/job/91223253707) |
| 2 | fabric only | BOTH fabric and classification-ggml triggered | [#3584](https://github.com/tetherto/qvac/pull/3584) | [run](https://github.com/tetherto/qvac/actions/runs/30650873325/job/91223518340) |
| 3 | `[verify-registry]` marker | lockfile dropped, resolved against registry, still passes | [#3585](https://github.com/tetherto/qvac/pull/3585) | [run](https://github.com/tetherto/qvac/actions/runs/30650906713/job/91223624214) |

All 3 matched expectations; all native prebuild legs passed for real.

## 2b. Running builds/tests for only the affected packages

`nx show projects --affected` only *lists*. To run something, use `nx affected -t <target>` (same
rules apply):

```bash
pnpm exec nx affected -t build test:unit
```

`nx run-many -t <target>` (no `affected`) runs a target for every project — scope to the 4 core
packages:

```bash
pnpm exec nx run-many -t build test:unit -p classification-ggml,fabric,infer-base,logging
```

Green as of this branch: `build` succeeds for the 3 packages with a build step (`logging` is pure
JS, nothing to build). `test:unit` passes 57/57 tests, 116/116 assertions across the 3 packages with
a `test:unit` script (`fabric` only has `test:integration`).

**Real gaps found and fixed** (every `require()`/`import` across all 4 packages was audited against
declared deps up front): `cmake-npm` wasn't a direct devDependency on `classification-ggml`/`fabric`
(CMake's package-relative `find_package` needs it there under pnpm's isolated linker); `logging`'s
tests import `bare-process` undeclared; `classification-ggml`'s `test:integration` imports
`bare-os`/`bare-process` undeclared. All fixed — `test:integration` now passes too (14/14, 140/140).

**Known limitation, not fixed here:** `fabric`'s `test:integration` (proves `llm-llamacpp` and
`embed-llamacpp` share one `@qvac/fabric` runtime, via its own nested `test/integration/package.json`)
doesn't run in this POC's scope — neither package has `node_modules` here, so it fails on missing
`bare-fs`. Confirmed fix: add both to `pnpm-workspace.yaml` and give `fabric` a `project.json` with
`implicitDependencies: ["llm-llamacpp", "embed-llamacpp"]`. Left out on purpose — past that, the test
still needs both natively compiled and a real (likely private) GGUF model download.

## 3. Override: loose linking isn't all-or-nothing

```bash
rm pnpm-lock.yaml   # required - a plain install replays the committed lockfile's link: entry regardless of the flag
pnpm install --config.link-workspace-packages=false
readlink -f packages/classification-ggml/node_modules/@qvac/logging
```

`logging` now resolves into `.pnpm`'s registry store too, like `infer-base` above — useful for
testing against what's actually published. Restore with `git checkout -- pnpm-lock.yaml && pnpm install`.

## 4. Real CI: a workflow consolidation proving both ideas together

`.github/workflows/poc-prebuilds-nx.yml` merges `prebuilds-classification-ggml.yml` +
`prebuilds-fabric.yml` (identical thin wrappers around `reusable-prebuilds.yml`) into one
`nx affected`-driven matrix, `pull_request`-triggered.

Supports either linking mode from the same file. Default is loose. To resolve against the registry
for one run, put `[verify-registry]` anywhere in the PR title/body, or set the
`verify-against-registry` input on a manual `workflow_dispatch`.

## Why this scope, why this approach

- "Loose" linking chosen over the stricter `workspace:` protocol, which would've forced the
  `infer-base` link regardless of the version mismatch.
- Work stays on a branch, zero effect on the real `classification-ggml`/`fabric` release path.
- Scope is classification-ggml + its dependencies — a real 4-package slice of the monorepo.
