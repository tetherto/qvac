# Contributing

We welcome contributions! Feel free to open a pull request, report bugs, or share ideas through issues and discussions.

## API Reference Docs

The SDK's public API summary is generated from TypeScript source by a pipeline under `docs/website/scripts/`. It is written into the SDK's current documentation line, at `docs/website/content/docs/sdk/<current line>/reference/api.mdx`, resolved from the version manifest in `docs/website/src/lib/versions.ts`. To regenerate it locally:

```bash
cd docs/website
npm install
npm run docs:generate-api -- 0.9.1 --latest  # writes the current line's reference/api.mdx
```

Full workflow, CLI flags, determinism guarantees, and troubleshooting are documented in [docs/website/docs-workflow.md](docs/website/docs-workflow.md). `docs:generate-api` requires `bun` on PATH (listed as a devDependency of `docs/website`).

## Documentation lines

The SDK and the CLI are each documented one folder per minor release under `docs/website/content/docs/`. The folder in parentheses — `sdk/(v0.23)` — is the **current line**: the release under development, and the one that answers the version-less URLs. Every other folder is a release that already shipped, and it documents that release and nothing else.

Write to the current line. If your PR touches documentation content, the `Docs lines up to date with main` check compares the set of line folders at your branch point against main's and fails when main has cut a new line since. That failure means your edits would land in a shipped release's folder: git relocates them there by rename detection, without a conflict and with a green merge. Run `git merge origin/main` and move the edits to the current line.

Editing a shipped release's folder on purpose is fine — a factual correction to published documentation belongs there. The check allows it as long as your branch is current on the line set; it only prints a warning, so that a change that also applies to the current line is not forgotten.

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