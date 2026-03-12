# Documentation Deploy Flow

How the QVAC docs website is built, versioned, and deployed.

For the full implementation guide, see [API-DOCS-AUTOMATION-COMPLETE-GUIDE.md](../API-DOCS-AUTOMATION-COMPLETE-GUIDE.md).

## Overview

The docs site lives in `docs/website/`. It is a static site generated with **Next.js 15** + **Fumadocs** via `output: 'export'` (SSG). The build produces a `dist/` directory that can be served by any static hosting platform.

## Architecture

| Component | Details |
|-----------|---------|
| Framework | Next.js 15 (App Router) + React 19 |
| Docs framework | Fumadocs (`fumadocs-core`, `fumadocs-mdx`, `fumadocs-ui`) |
| Styling | Tailwind CSS |
| Content | MDX files in `docs/website/content/docs/` |
| API docs | Auto-generated via TypeDoc (`docs/website/scripts/generate-api-docs.ts`) |
| Build output | `docs/website/dist/` (static HTML/CSS/JS) |
| Config | `next.config.mjs` (`output: 'export'`, `distDir: 'dist'`, `trailingSlash: true`) |

## Branch Strategy

```
main = staging          docs-production = production
────────────────        ────────────────────────────

Push to main            PR: main -> docs-production
(docs/website/**)       (review diff, CI doctor gates)
      │                          │
      ▼                          ▼
Staging deploy           Production deploy
```

- **`main`** is the staging environment. Any push to `main` that touches `docs/website/**` triggers a build and deploy to staging.
- **`docs-production`** is the production environment. To deploy to production, open a PR from `main` to `docs-production`. After review and merge, production deploys.

This two-branch approach provides a Git-based diff to review before production, unlike artifact-only promotion.

### Why two branches?

With `main` + `docs-production`, every production deploy has a reviewable PR showing exactly what changed. This prevents accidental deployment of incomplete or broken docs.

## How Docs Are Built

```bash
cd docs/website
bun install
bun run build        # runs: next build && npx @vahor/next-broken-links
```

The `build` script:
1. Runs `next build` which statically generates all pages into `dist/`
2. Runs `@vahor/next-broken-links` to detect broken internal links

The site requires no server at runtime -- it is purely static.

## How Docs Are Versioned

SDK API documentation is versioned per release. Each version lives in its own directory:

```
content/docs/sdk/api/
├── latest/         -> physical copy of the most recent version
├── v0.5.0/
├── v0.6.0/
├── v0.6.1/
└── v0.7.0/
```

- **Format**: `vX.Y.Z` (always 3-part semver with `v` prefix)
- **`latest/`**: A physical copy (not symlink) of the most recent version, kept in sync automatically
- **Version list**: Managed in `src/lib/versions.ts`, updated by `scripts/update-versions-list.ts`

### Automatic generation

When SDK code changes are merged to `main`, the **Docs Post-Merge Sync** workflow:
1. Regenerates API docs from the SDK source using TypeDoc
2. Updates `content/docs/sdk/api/` and `src/lib/versions.ts`
3. Commits and pushes directly to `main` (no PR)

This means staging always reflects the latest released SDK docs.

## Deployment Flow

### Staging (automatic)

```
SDK release merged to main
    │
    ▼
Docs Post-Merge Sync runs (regenerates API docs, commits to main)
    │
    ▼
Push to main triggers Docs Deploy Staging workflow
    │
    ▼
Site is built and deployed to staging
```

**Trigger**: Push to `main` when `docs/website/**` files change.
**Workflow**: `.github/workflows/docs-deploy-staging.yml`

### Production (manual PR)

```
Staging is verified and ready
    │
    ▼
Open PR: main -> docs-production
    │
    ▼
CI Doctor runs (verifies all docs workflows are green)
    │
    ▼
Review the diff, approve, merge
    │
    ▼
Docs Deploy Production workflow triggers
    │
    ▼
Site is built and deployed to production
```

**Trigger**: Push to `docs-production` (via merged PR).
**Workflow**: `.github/workflows/docs-deploy-production.yml`
**Gate**: `Docs CI Doctor` must pass before merge.

### Release notifications

When a `release-*` branch is pushed, the **Docs Deploy Notify** workflow creates a GitHub issue reminding the docs owner to open a PR from `main` to `docs-production`.

## CI Workflows Reference

| Workflow | File | Trigger | Purpose |
|----------|------|---------|---------|
| Docs Website PR Checks | `docs-website-pr-checks.yml` | PR to `main` (docs/website/**) | Build validation on PRs |
| Docs Post-Merge Sync | `docs-post-merge-sync.yml` | Push to `main` (packages/sdk/**, docs/website/scripts/**) | Regenerate SDK API docs, commit to main |
| Docs Deploy Staging | `docs-deploy-staging.yml` | Push to `main` (docs/website/**) | Build and deploy to staging |
| Docs Deploy Production | `docs-deploy-production.yml` | Push to `docs-production` | Build and deploy to production |
| Docs CI Doctor | `docs-ci-doctor.yml` | PR to `docs-production` | Gate: verify all docs workflows are green |
| Docs Deploy Notify | `docs-deploy-notify.yml` | Push to `release-*` | Create issue to notify docs owner |
| Generate API Documentation | `docs-generate-api.yml` | Manual / repository_dispatch | Generate API docs for a specific version |

## Running Locally

### Prerequisites

- Node.js >= 22.17.0
- Bun (latest)

### Development server

```bash
cd docs/website
bun install
bun run dev          # starts on http://localhost:3001
```

### Build and preview

```bash
cd docs/website
bun run build        # generates dist/
bun run serve        # serves dist/ on http://localhost:8080
```

### Generate API docs

```bash
cd docs/website
SDK_PATH=/path/to/packages/sdk bun run docs:generate
```

Or for a specific version:

```bash
bun run docs:generate-api 0.7.0
```

### Run CI doctor locally

Requires the [GitHub CLI](https://cli.github.com) and a token with repo read access:

```bash
GH_TOKEN=ghp_... bash .github/scripts/docs-ci-doctor.sh
```

## Secrets and Configuration

The following GitHub secrets and variables are used by the docs workflows:

### Repository Variables

| Variable | Used by | Purpose |
|----------|---------|---------|
| `DOCS_SYNC_BOT_USER` | Post-Merge Sync, Deploy Staging | Bot username to prevent infinite CI loops |
| `DOCS_SYNC_BOT_NAME` | Post-Merge Sync | Git commit author name for generated docs |
| `DOCS_SYNC_BOT_EMAIL` | Post-Merge Sync | Git commit author email for generated docs |

### Repository Secrets

| Secret | Used by | Purpose |
|--------|---------|---------|
| `DOCS_SYNC_PAT` | Post-Merge Sync | PAT for pushing generated docs to main |
| `DOCS_DEPLOY_NOTIFY_USER` | Deploy Notify | GitHub username to @ mention in deploy issues |

### GitHub Environment

The `docs-production` environment (configured in GitHub repo settings) can be used to:
- Require manual approval before production deploys
- Scope production-only secrets (e.g., hosting platform credentials)

### Environment file

For local development, copy `.env.example` to `.env.local`:

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_INKEEP_API_KEY` | Search and chat functionality |
| `SDK_PATH` | Path to SDK package (used by doc generation scripts) |
