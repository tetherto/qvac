# Contributing

We welcome contributions! Feel free to open a pull request, report bugs, or share ideas through issues and discussions.

## API Reference Docs

The SDK's public API summary (`docs/website/content/docs/reference/api/index.mdx`) is generated from TypeScript source by a pipeline under `docs/website/scripts/`. To regenerate it locally:

```bash
cd docs/website
npm install
npm run docs:generate-api -- 0.9.1 --latest  # writes content/docs/reference/api/index.mdx
```

Full workflow, CLI flags, determinism guarantees, and troubleshooting are documented in [docs/website/docs-workflow.md](docs/website/docs-workflow.md). `docs:generate-api` requires `bun` on PATH (listed as a devDependency of `docs/website`).

## PR Labels

CI behaviour is driven by PR labels and the `fork-ci` environment. External fork PRs need merge/release-team approval of the `fork-ci` environment on each workflow run before secret-bearing jobs execute — see [`docs/ci/LABELS.md`](docs/ci/LABELS.md) for the full reference (labels, fork trust, per-commit re-approval), and [`docs/ci/TEAMS.md`](docs/ci/TEAMS.md) for the teams that can approve.

## Changelog

Version bumps require CHANGELOG.md updates with version, date, changes by category (✨ Features, 🐛 Fixes, 🔧 Changed, etc.), and PR links.

## Development

- For the standard development workflow used in this monorepo, see [`/docs/gitflow.md`](./docs/gitflow.md).
- For development specifics of each QVAC component, refer to the documentation in the respective subdirectory under `/packages`.
- For the QVAC architecture as a whole, see `/docs/architecture`.
- For the QVAC monorepo structure, see `docs/repository-layout.md`.