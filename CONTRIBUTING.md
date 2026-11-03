# Contributing

We welcome contributions! Feel free to open a pull request, report bugs, or share ideas through issues and discussions.

## API Reference Docs

The SDK's public API summary is generated from TypeScript source by a pipeline under `docs/website/scripts/`. It is written into the SDK's development line, at `docs/website/content/_unpublished/sdk/next/reference/api.mdx` — the version being written, which the release cutoff publishes. To regenerate it locally:

```bash
cd docs/website
npm install
npm run docs:generate-api -- 0.9.1 --latest  # writes the development line's reference/api.mdx
```

Full workflow, CLI flags, determinism guarantees, and troubleshooting are documented in [docs/website/docs-workflow.md](docs/website/docs-workflow.md). `docs:generate-api` requires `bun` on PATH (listed as a devDependency of `docs/website`).

## Documentation lines

The SDK and the CLI are each documented one folder per minor release. Every folder under `docs/website/content/docs/sdk/` and `.../cli/` is a release that already shipped, and documents that release and nothing else. The one in parentheses — `sdk/(vX.Y)` — is the most recent, and answers the version-less URLs.

**Your feature's documentation goes in the development line**, which is outside the site:

```
docs/website/content/_unpublished/sdk/next/
docs/website/content/_unpublished/cli/next/
```

Nothing under `_unpublished/` is built or served, so your prose is invisible on the site until the release cutoff publishes that line, with the version it belongs to. Review it in the PR diff, or preview it locally with the symlink described in [docs/website/docs-workflow.md](docs/website/docs-workflow.md), "Previewing the development line".

The path never changes. A cutoff copies the development line into the collection rather than renaming it, so a feature PR opened before a cutoff and merged after it needs no relocation: its edits land in the path they were written to, either way.

**What a cutoff does change is which release that path belongs to.** Your feature's documentation ships with your feature only if it merges before the cutoff of that release. Write it in the same PR as the code, which is what makes the two move together. If it follows in a separate PR and a cutoff lands first, the prose stays in the development line and reaches users a release late: move it into the published line's folder — `content/docs/<collection>/<line>/` — and tell the documentation engineer, because production serves the line promoted at the release, not `main`.

The `Documentation lines` job reads `content/docs/` only, so a PR that writes the development line and nothing else is never flagged. If you do edit `content/docs/`, it:

- **warns**, always. Correcting a published release there is fine, and reaches production with the next promotion; the warning exists so a feature's documentation does not land there by mistake.
- **fails** if a cutoff landed after your branch came off, because the cut renamed the folder you wrote against. Rebase to clear it — rebase, not *Update branch*, which lets git relocate the edits by similarity. The job is not required, so it asks rather than blocks; merging it red carries the misplacement in.

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