# Contributing

We welcome contributions! Feel free to open a pull request, report bugs, or share ideas through issues and discussions.

## API Reference Docs

The SDK's public API summary (`content/docs/sdk/api/index.mdx`) is generated from TypeScript source by a pipeline under `docs/website/scripts/`. To regenerate it locally:

```bash
cd docs/website
npm install
npm run docs:generate-api -- 0.9.1 --latest  # writes content/docs/sdk/api/index.mdx
```

Full workflow, CLI flags, AI augmentation, determinism guarantees, and troubleshooting are documented in [docs/docs-workflow.md](docs/docs-workflow.md). `docs:generate-api` requires `bun` on PATH (listed as a devDependency of `docs/website`).

## PR Labels

Labels that control CI workflows:

- `verify` - Adding `verify` label to an open PR runs integration tests, benchmarks, model validation
- `safe-to-test` - Security gate for external fork PRs
- `staging` - Deploys to staging environment
-  Commenting`review` or `/review` within a PR - Triggers approval check
- `tier1`, `tier2` - Approval groups
- `nlp` - NLP-related changes

## Changelog

Version bumps require CHANGELOG.md updates with version, date, changes by category (✨ Features, 🐛 Fixes, 🔧 Changed, etc.), and PR links.
