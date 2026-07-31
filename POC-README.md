# POC: pnpm loose linking + nx transitivity (classification-ggml scope)

Scope: `classification-ggml` + its own dependencies (`fabric`, `infer-base`, `logging`).
Nothing else in the monorepo is touched — no `.github/workflows/*` changes, no version bumps,
no `workspace:` protocol anywhere. This branch is for local review only, not merged to `main`.

## What's new here vs. `main`

- `pnpm-workspace.yaml` — scopes pnpm to these 4 packages, `linkWorkspacePackages: true`.
- root `package.json` — just `nx` as a devDependency.
- `nx.json` — minimal config.

All 4 packages keep their existing plain-semver `@qvac/*` dependency versions exactly as on `main` —
nothing to convert, nothing to break.

## 1. Loose linking: local packages resolve to live source

```bash
pnpm install
readlink -f packages/classification-ggml/node_modules/@qvac/logging
readlink -f packages/classification-ggml/node_modules/@qvac/fabric
readlink -f packages/classification-ggml/node_modules/@qvac/infer-base
```

`logging` and `fabric` resolve straight into `packages/logging` / `packages/fabric` — a real
symlink to the source in this repo, not a downloaded copy. Edit either one and the change is live
immediately, no publish/install cycle needed.

`infer-base` is the interesting one: it resolves into `node_modules/.pnpm/...` (a real registry
copy), **not** the local source. That's because local `infer-base` is at `0.6.2`, and
classification-ggml declares `^0.4.0` — those don't overlap (a `0.x` caret range only allows patch
bumps within `0.4.x`). Loose linking respects that and safely falls back to the registry instead of
forcing an incompatible link. This is a real, pre-existing gap in the monorepo today, not something
staged for this demo.

## 2. Transitivity: nx knows what depends on what

```bash
echo "// scenario-test-marker" >> packages/logging/index.js
pnpm exec nx show projects --affected --uncommitted --json
```

Output includes `@qvac/classification-ggml` — nx correctly walked the dependency graph and flagged
the consumer of the package you touched, not just the package itself. This is what would let CI
retest/rebuild only what's actually affected by a change, instead of everything or a hand-maintained
path list.

Revert the demo edit before moving on:

```bash
git checkout -- packages/logging/index.js
```

## 3. Override: loose linking isn't all-or-nothing

```bash
pnpm install --config.link-workspace-packages=false
readlink -f packages/classification-ggml/node_modules/@qvac/logging
```

Now `logging` resolves into `.pnpm`'s registry store too, exactly like `infer-base` did above — the
same flag flips *every* package back to "resolve like a normal npm dependency," which is useful if
you specifically want to test against what's actually published, not what's on your branch.

Restore the default (loose) state afterwards:

```bash
pnpm install
```

## Why this scope, why this approach

- "Loose" linking (`linkWorkspacePackages`) was chosen over the stricter `workspace:` protocol,
  which would have forced the `infer-base` link above regardless of the version mismatch — proven
  separately, not included in this POC to keep it focused.
- Work stays on a branch, zero effect on the real `classification-ggml`/`fabric` release path — no
  CI changes, no version changes, nothing that could block a real release.
- Scope is classification-ggml + its dependencies, a real 4-package slice of the actual monorepo.
