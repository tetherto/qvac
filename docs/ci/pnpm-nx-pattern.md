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

## Workspace layout

```text
qvac/
├── package.json              # private root; nx devDependency
├── pnpm-workspace.yaml       # workspace members (expand per migration)
├── pnpm-lock.yaml
├── nx.json
├── tools/ci/                 # shared CI scripts invoked by Nx
└── packages/
    ├── classification-ggml/
    │   ├── project.json      # Nx targets
    │   └── package.json      # workspace:* deps on infer-base, logging
    ├── infer-base/
    └── logging/
```

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

Pass `nx-project: classification-ggml` from `prebuilds-classification-ggml.yml`.
When set, the reusable workflow installs via pnpm and calls Nx prebuild targets
instead of `npm install` + bare-make in the package directory.

## Migrating another package

1. Add the package (and its in-repo deps) to `pnpm-workspace.yaml`.
2. Switch `package.json` dependencies to `workspace:*` where applicable.
3. Add `packages/<pkg>/project.json` mirroring existing `scripts` as Nx targets.
4. Extend `on-pr-<pkg>.yml` path filters for workspace root files.
5. Replace `npm install` / `npm run` steps with `setup-pnpm-workspace` + `nx-run`.
6. Pass `nx-project: <pkg>` to `sanity-checks` and `reusable-prebuilds` when ready.
7. Run `pnpm install` at repo root and commit `pnpm-lock.yaml`.

Keep in GitHub Actions: runner matrices, OIDC, vcpkg/bare host setup, artifact
upload, label gates, merge guards.

## What stays in workflows

- Authorization, label-gate, path filters, concurrency
- Self-hosted runner workspace cleanup
- AWS OIDC, vcpkg, Vulkan SDK, Apple clang setup
- Prebuild artifact strip/upload/merge
- Mobile Device Farm orchestration
- Publishing and release logic on merge
