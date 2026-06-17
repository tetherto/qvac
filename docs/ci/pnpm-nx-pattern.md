# pnpm + Nx CI pattern (spearhead: classification-ggml)

This document describes the monorepo workspace pattern introduced for
`packages/classification-ggml`. Other native addon packages should follow the
same steps when migrating off per-package `npm install`.

## Goals

| Layer | Responsibility |
|-------|----------------|
| **pnpm workspace** | Link in-repo dependencies (`@qvac/infer-base`, `@qvac/logging`) and single lockfile |
| **Nx** | Named, cacheable targets for lint, tests, prebuild steps |
| **GitHub Actions** | Matrix runners, secrets, artifact upload, authorization — thin wrappers around `pnpm nx run` |

Business logic that previously lived inline in workflow `run:` steps (install,
lint, unit tests, dts checks, cpp tests, integration tests, prebuild
generate/build/install) is expressed as **Nx targets** in
`packages/classification-ggml/project.json`.

## Parallel CI tracks

Two workflow families run in parallel for `classification-ggml`:

| Track | PR orchestrator | Task workflows |
|-------|-----------------|----------------|
| **Legacy (npm)** | `on-pr-classification-ggml.yml` | `cpp-tests-classification.yml`, `prebuilds-classification-ggml.yml`, … |
| **Nx (pnpm)** | `on-pr-classification-ggml-nx.yml` | `cpp-tests-classification-ggml-nx.yml`, `prebuilds-classification-ggml-nx.yml`, … |

Legacy workflows use per-package `npm install` + `npm run`. Nx workflows use
`setup-pnpm-workspace` + `pnpm nx run classification-ggml:<target>`. Job names
in the Nx track are suffixed with `-nx` so both tracks appear distinctly in the
GitHub checks UI.

Merge publishing remains on the legacy `on-merge-classification-ggml.yml` path.
`on-merge-classification-ggml-nx.yml` mirrors prebuild/integration/mobile via
Nx for parity validation only.

Legacy path filters list explicit workflow files (no `*-nx*` glob) so edits to
the Nx track do not re-run the npm pipeline.

## Swapping tracks

When the Nx track is green and parity is acceptable:

1. **Branch protection** — Require the `-nx` check names (e.g. `merge-guard-nx`,
   `prebuild-nx`) instead of the legacy names; or require both during a
   transition window.
2. **Merge gate** — Point required status checks at `on-pr-classification-ggml-nx.yml`
   jobs; keep legacy workflows enabled but unrequired for one release cycle if
   desired.
3. **Publish** — Move publish/release jobs from `on-merge-classification-ggml.yml`
   into `on-merge-classification-ggml-nx.yml` (or rename `-nx` → production names
   and retire the legacy files).
4. **Retire legacy** — Delete or `workflow_dispatch`-only the npm orchestrators
   and task workflows once Nx is sole required path.

Until step 4, legacy workflows stay byte-compatible with pre-migration behavior:
per-package `npm install`, `npm run`, and `bare-make` in `packages/classification-ggml/`.
`reusable-prebuilds.yml` branches on optional `nx-project`; legacy callers omit it.

## Workspace layout

```text
qvac/
├── package.json              # qvac.packages manifest + nx devDependency
├── pnpm-workspace.yaml       # workspace members + catalog (version pins)
├── pnpm-lock.yaml
├── nx.json
├── tools/ci/
│   ├── qvac-package-deps.mjs # sync/validate deps from root manifest
│   └── check-package-deps.mjs
└── packages/
    ├── classification-ggml/
    │   ├── project.json      # Nx targets
    │   └── package.json      # synced from root qvac.packages (do not edit deps by hand)
    ├── infer-base/
    └── logging/
```

## Root dependency manifest

Runtime and dev dependency **lists** live in root `package.json` under
`qvac.packages["@qvac/classification-ggml"]`. Version pins for external
packages live in `pnpm-workspace.yaml` → `catalog:` (referenced as `"catalog:"`
in the manifest).

After editing the root manifest:

```bash
pnpm sync:deps          # copy deps into packages/classification-ggml/package.json
pnpm validate:deps      # CI gate — fail if package.json drifted
```

`pnpm pack` (via `pnpm nx run classification-ggml:pack`) produces a tarball
containing **only** the files listed in the package `files` field. Workspace
siblings (`infer-base`, `logging`) are **not** bundled — they appear as
semver/`workspace:`-resolved dependencies in the packed `package.json`.

## Nx targets (classification-ggml)

| Target | Maps to | Used in CI job |
|--------|---------|----------------|
| `lint` | `npm run lint` | sanity-checks (`ci-lint-and-unit`) |
| `test-unit` | `npm run test:unit` | sanity-checks |
| `test-dts` | `npm run test:dts` | `ts-checks` |
| `test-cpp` | build + run cpp tests | `cpp-tests-classification` |
| `test-integration` | `npm run test:integration` | `integration-test-classification-ggml` |
| `test-mobile-validate` | mobile fixture drift check | mobile integration workflow |
| `prebuild-generate` | `bare-make generate` (env: `NX_PLATFORM`, `NX_ARCH`, `NX_FLAGS`, `DEFINES`) | reusable prebuilds |
| `prebuild-build` | `bare-make build` | reusable prebuilds |
| `prebuild-install` | `bare-make install` | reusable prebuilds |
| `ci-check-deps` | `tools/ci/check-package-deps.mjs` | sanity-checks |
| `ci-lint-and-unit` | lint then test-unit | sanity-checks |

Run locally from repo root:

```bash
corepack enable
pnpm install
pnpm nx run classification-ggml:lint
pnpm nx run classification-ggml:test-unit
pnpm nx graph   # dependency graph
```

## GitHub Actions building blocks

### `setup-pnpm-workspace`

Composite action at `.github/actions/setup-pnpm-workspace/action.yml`:

- Enables pnpm via corepack (`packageManager` in root `package.json`)
- Writes `.npmrc` at runtime (never committed)
- `pnpm install --frozen-lockfile`
- Optional global `bare` install

Input `workspace-root` defaults to `.`; mobile jobs pass `addon` when the
repository is checked out to a subdirectory.

### `nx-run`

Composite action at `.github/actions/nx-run/action.yml`:

```yaml
- uses: ./.github/actions/nx-run
  with:
    target: classification-ggml:test-dts
```

### `sanity-checks` + `nx-project`

Pass `nx-project: classification-ggml` to run deps/lint/unit via Nx instead of
per-package npm. Other packages omit the input until migrated.

### `reusable-prebuilds` + `nx-project`

Pass `nx-project: classification-ggml` from `prebuilds-classification-ggml-nx.yml`
(not the legacy wrapper). When set, the reusable workflow installs via pnpm and
calls Nx prebuild targets instead of `npm install` + bare-make in the package
directory. Legacy `prebuilds-classification-ggml.yml` omits `nx-project`.

## Migrating another package

1. Add the package (and its in-repo deps) to `pnpm-workspace.yaml`.
2. Add a `qvac.packages["@qvac/<name>"]` entry in root `package.json` (dependencies + devDependencies).
3. Add external version pins to `pnpm-workspace.yaml` → `catalog:`.
4. Run `pnpm sync:deps` and commit the synced `packages/<pkg>/package.json`.
5. Add `packages/<pkg>/project.json` mirroring existing `scripts` as Nx targets.
6. Add parallel `*-nx.yml` workflows; keep legacy npm workflows as the required
   merge gate until swap (see [Swapping tracks](#swapping-tracks)).
7. Extend `on-pr-<pkg>-nx.yml` path filters for workspace root files.
8. Run `pnpm install` at repo root and commit `pnpm-lock.yaml`.

Keep in GitHub Actions: runner matrices, OIDC, vcpkg/bare host setup, artifact
upload, label gates, merge guards.

## What stays in workflows

- Authorization, label-gate, path filters, concurrency
- Self-hosted runner workspace cleanup
- AWS OIDC, vcpkg, Vulkan SDK, Apple clang setup
- Prebuild artifact strip/upload/merge
- Mobile Device Farm orchestration
- Publishing and release logic on merge
