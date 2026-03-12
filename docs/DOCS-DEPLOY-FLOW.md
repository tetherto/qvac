# Documentation Deploy Flow

How the QVAC docs website is built, versioned, and deployed.

For the full implementation guide, see [API-DOCS-AUTOMATION-COMPLETE-GUIDE.md](../API-DOCS-AUTOMATION-COMPLETE-GUIDE.md).

## Overview

The docs site lives in `docs/website/`. It is a static site built with **Next.js 15** + **Fumadocs** via `output: 'export'` (SSG). The site is hosted and served via CDN by **Sevalla**.

GitHub stores only the source code -- Sevalla handles the build (SSG) and deployment. There are no GitHub Actions deploy workflows; Sevalla watches the repo branches directly.

## Architecture

| Component | Details |
|-----------|---------|
| Framework | Next.js 15 (App Router) + React 19 |
| Docs framework | Fumadocs (`fumadocs-core`, `fumadocs-mdx`, `fumadocs-ui`) |
| Styling | Tailwind CSS |
| Content | MDX files in `docs/website/content/docs/` |
| API docs | Auto-generated via TypeDoc (`docs/website/scripts/generate-api-docs.ts`) |
| Build output | `docs/website/dist/` (static HTML/CSS/JS, built by Sevalla) |
| Hosting | Sevalla (static site CDN) |
| Config | `next.config.mjs` (`output: 'export'`, `distDir: 'dist'`, `trailingSlash: true`) |

## Branch Strategy

```
main = staging              docs-production = production
──────────────              ────────────────────────────

New commit on main          Merge PR: main -> docs-production
      │                              │
      ▼                              ▼
Sevalla builds & deploys    Sevalla builds & deploys
to staging env              to production env
```

- **`main`** is the staging environment. Sevalla watches this branch; any new commit triggers a build and deploy to the staging site.
- **`docs-production`** is the production environment. Sevalla watches this branch; any new commit (via merged PR from `main`) triggers a build and deploy to the production site.

### Why two branches?

With `main` + `docs-production`, every production deploy has a reviewable PR showing exactly what changed. The CI Doctor workflow gates PRs to `docs-production`, verifying all docs CI jobs are green before the merge is allowed.

## How Docs Are Built

Sevalla runs the build automatically on each push to the watched branch. The build command is:

```bash
cd docs/website
bun install
bun run build        # runs: next build && npx @vahor/next-broken-links
```

The `build` script:
1. Runs `next build` which statically generates all pages into `dist/`
2. Runs `@vahor/next-broken-links` to detect broken internal links

The site requires no server at runtime -- it is purely static and served via CDN.

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

This commit to `main` triggers Sevalla to rebuild and deploy to staging automatically.

## Deployment Flow

### Staging (automatic)

```
SDK release merged to main
    │
    ▼
Docs Post-Merge Sync runs (regenerates API docs, commits to main)
    │
    ▼
Sevalla detects new commit on main
    │
    ▼
Sevalla builds the static site and deploys to staging
```

Any push to `main` -- whether from a merged PR, a docs content change, or the post-merge sync bot -- triggers Sevalla to rebuild staging. No GitHub Actions deploy workflow is involved.

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
Sevalla detects new commit on docs-production
    │
    ▼
Sevalla builds the static site and deploys to production
```

**Gate**: The `Docs CI Doctor` workflow must pass before the PR can be merged.

### Release notifications

When a `release-*` branch is pushed, the **Docs Deploy Notify** workflow creates a GitHub issue reminding the docs owner to open a PR from `main` to `docs-production`.

## CI Workflows Reference

GitHub Actions handles validation and gating only -- not building or deploying.

| Workflow | File | Trigger | Purpose |
|----------|------|---------|---------|
| Docs Website PR Checks | `docs-website-pr-checks.yml` | PR to `main` (docs/website/**) | Build validation on PRs |
| Docs Post-Merge Sync | `docs-post-merge-sync.yml` | Push to `main` (packages/sdk/**, docs/website/scripts/**) | Regenerate SDK API docs, commit to main |
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

The following GitHub secrets and variables are used by the docs CI workflows:

### Repository Variables

| Variable | Used by | Purpose |
|----------|---------|---------|
| `DOCS_SYNC_BOT_USER` | Post-Merge Sync | Bot username to prevent infinite CI loops |
| `DOCS_SYNC_BOT_NAME` | Post-Merge Sync | Git commit author name for generated docs |
| `DOCS_SYNC_BOT_EMAIL` | Post-Merge Sync | Git commit author email for generated docs |

### Repository Secrets

| Secret | Used by | Purpose |
|--------|---------|---------|
| `DOCS_SYNC_PAT` | Post-Merge Sync | PAT for pushing generated docs to main |
| `DOCS_DEPLOY_NOTIFY_USER` | Deploy Notify | GitHub username to @ mention in deploy issues |

### Environment file

For local development, copy `.env.example` to `.env.local`:

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_INKEEP_API_KEY` | Search and chat functionality |
| `SDK_PATH` | Path to SDK package (used by doc generation scripts) |
