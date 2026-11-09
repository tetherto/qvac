# Contributing

We welcome contributions! Feel free to open a pull request, report bugs, or share ideas through issues and discussions.

## Documentation

A package the documentation site documents keeps its user documentation beside its code, in `packages/<package>/docs/users/` — `@qvac/sdk` and `@qvac/cli` today, each declared by a versions file in `docs/website/versions/`. On `main` that folder documents the version being written. Each released minor is published from the commit its versions file pins.

- **Document your change in the same PR as the code**, in `packages/<package>/docs/users/`. `/qv-docs-update` does it: it regenerates the API data, finds the pages your change made stale, and proposes the edits.
- **API facts are generated, never written.** Run the package's data script from `docs/website` (`npm run docs:sdk-api`, `npm run docs:cli-api`) and commit `_generated/` and the reference pages. The package's checks fail when they are stale.
- **Pages bind the API they describe**, in a `binds:` frontmatter list. A change to a bound surface fails `npm run docs:bindings` and names the pages; review them, run `npm run docs:lock`, and commit the lock. A public symbol of the SDK or the CLI that no page binds fails it too.
- **Preview** with `npm run dev` in `docs/website`: each package's documentation renders at `/<collection>/preview/`.
- **To correct a released version**, open a PR into the release branch of the highest patch in its minor that touches only `packages/<package>/docs/users/`. It needs no version bump or changelog entry, publishes no package, and reaches the site through a pin PR on `main` ([`docs/gitflow.md`](docs/gitflow.md), "Documentation of a released version").

Lines published before their package's documentation moved into it are still held in place under `docs/website/content/docs/<collection>/`; correct those there. The "Lines held in place" job warns on such edits, so a feature's documentation does not land in a released version by mistake.

The full workflow is in [docs/website/docs-workflow.md](docs/website/docs-workflow.md).

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

## Error code reservations

Before adding a package's first numeric error code, reserve its block in
[`packages/error/code-ranges.json`](packages/error/code-ranges.json), including
packages maintained outside this repository. Follow the
[`@qvac/error` allocation workflow](packages/error/README.md#error-code-conventions)
and run `npm run errors:check`. The `/qv-error-code-reserve` skill can prepare the
change. Retired and unused reserved numbers remain occupied.

## Development

- For the standard development workflow used in this monorepo, see [`/docs/gitflow.md`](./docs/gitflow.md).
- For development specifics of each QVAC component, refer to the documentation in the respective subdirectory under `/packages`.
- For the QVAC architecture as a whole, see `/docs/architecture`.
- For the QVAC monorepo structure, see `docs/repository-layout.md`.
