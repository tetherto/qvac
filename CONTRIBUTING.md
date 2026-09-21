# Contributing

We welcome contributions! Feel free to open a pull request, report bugs, or share ideas through issues and discussions.

## API Reference Docs

The SDK's public API summary is generated from TypeScript source by a pipeline under `docs/website/scripts/`. Content lives at `docs/website/content/docs/reference/api/v<X.Y>.x.mdx` (one permanent page per minor series); the canonical URL `/reference/api` is served by a thin `index.mdx` shim that `<include>`s the current-latest series file. To regenerate the current-latest series locally:

```bash
cd docs/website
npm install
npm run docs:generate-api -- 0.9.1  # writes content/docs/reference/api/v0.9.x.mdx
```

Full workflow, CLI flags, determinism guarantees, and troubleshooting are documented in [docs/website/docs-workflow.md](docs/website/docs-workflow.md). `docs:generate-api` requires `bun` on PATH (listed as a devDependency of `docs/website`).

## PR Labels

CI behaviour is driven by PR labels and the `fork-ci` environment. External fork PRs need merge/release-team approval of the `fork-ci` environment on each workflow run before secret-bearing jobs execute — see [`docs/ci/LABELS.md`](docs/ci/LABELS.md) for the full reference (labels, fork trust, per-commit re-approval), and [`docs/ci/TEAMS.md`](docs/ci/TEAMS.md) for the teams that can approve.

## Dependency bumps

Changing a dependency specifier in any `package.json` also changes
`pnpm-lock.yaml`. Regenerate the lockfile in the same commit:

```bash
pnpm install --lockfile-only
```

This resolves and writes the lockfile without linking `node_modules`. Use the
pnpm version pinned in the root `package.json` `packageManager` field; another
major writes a lockfile the pinned version rejects. If your global pnpm differs,
run it through `npx pnpm@<pinned-version>`.

CI installs with `--frozen-lockfile`, so a specifier the lockfile does not carry
aborts the install rather than resolving around it:

```
specifiers in the lockfile don't match specifiers in package.json
```

That install runs before the project matrix is built, so the failure is not
scoped to the package that was bumped. Every PR in the repo stays blocked until
the lockfile is refreshed on the default branch. Verify with a run that must
exit zero before you push:

```bash
pnpm install --frozen-lockfile --lockfile-only
```

Two PRs bumping different packages both rewrite the lockfile's `importers`
block, so the second to merge conflicts. Do not hand-resolve it. Take either
side, re-run `pnpm install --lockfile-only`, and commit the regenerated file.

## Changelog

Version bumps require CHANGELOG.md updates with version, date, changes by category (✨ Features, 🐛 Fixes, 🔧 Changed, etc.), and PR links.

## Development

- For the standard development workflow used in this monorepo, see [`/docs/gitflow.md`](./docs/gitflow.md).
- For development specifics of each QVAC component, refer to the documentation in the respective subdirectory under `/packages`.
- For the QVAC architecture as a whole, see `/docs/architecture`.
- For the QVAC monorepo structure, see `docs/repository-layout.md`.