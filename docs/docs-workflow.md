# Docs Workflow

How the documentation site works: architecture, local development, CI, deployment, and troubleshooting.

For general contribution guidelines (PR labels, changelog format), see the [root CONTRIBUTING.md](../CONTRIBUTING.md).

---

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Local Development](#local-development)
  - [Quick Start](#quick-start)
  - [Generating API Docs Locally](#generating-api-docs-locally)
  - [Updating the Versions List](#updating-the-versions-list)
  - [Full Generation (Orchestrated)](#full-generation-orchestrated)
- [Versioning](#versioning)
- [Branch Strategy and Deployment](#branch-strategy-and-deployment)
  - [Branch Strategy](#branch-strategy)
  - [Staging (automatic)](#staging-automatic)
  - [Production (manual PR)](#production-manual-pr)
- [CI Workflows](#ci-workflows)
  - [PR Checks](#1-docs-website-pr-checks)
  - [Post-Merge Sync](#2-docs-post-merge-sync)
  - [Generate API Documentation](#3-generate-api-documentation)
  - [Deploy Notify](#4-docs-deploy-notify)
  - [CI Doctor](#5-docs-ci-doctor)
- [Script Reference](#script-reference)
- [Troubleshooting](#troubleshooting)

---

## Overview

The docs site lives in `docs/website/`. It is a fully static site (Next.js `output: 'export'`) served via CDN by the hosting provider. GitHub stores only the source code -- the hosting provider watches repo branches, runs the build (SSG), and deploys automatically. There are no GitHub Actions deploy workflows; GitHub Actions handles validation and gating only.

| Component | Details |
|-----------|---------|
| Framework | Next.js 15 (App Router) + React 19 |
| Docs framework | Fumadocs (`fumadocs-core`, `fumadocs-mdx`, `fumadocs-ui`) |
| Styling | Tailwind CSS |
| Content | MDX files in `docs/website/content/docs/` |
| API docs | Auto-generated via TypeDoc (`docs/website/scripts/generate-api-docs.ts`) |
| Build output | `docs/website/dist/` (static HTML/CSS/JS) |
| Hosting | Static site CDN (hosting provider runs the build and serves the output) |
| Config | `next.config.mjs` (`output: 'export'`, `distDir: 'dist'`, `trailingSlash: true`) |

Content falls into two categories:

| Category | Path | Committed? |
|---|---|---|
| Manual content (guides, tutorials, addons) | `content/docs/(latest)/sdk/`, `content/docs/(latest)/addons/`, etc. | Yes |
| SDK API reference (generated) | `content/docs/(latest)/sdk/api/`, `content/docs/v{X.Y.Z}/sdk/api/` | No (`.gitignore`) |

SDK API docs are **generated from TypeScript source** via [TypeDoc](https://typedoc.org/) and written as MDX files. They are not committed to the repository -- generate them locally or let CI handle it.

### How the Pipeline Works

```
SDK source (packages/sdk)
  │
  ▼
TypeDoc analysis  ──►  MDX generation  ──►  content/docs/v{X.Y.Z}/sdk/api/
                                       ──►  content/docs/(latest)/sdk/api/
                                       ──►  src/lib/versions.ts (version switcher)
```

---

## Prerequisites

- [Bun](https://bun.sh/) (scripts use `bun` for `.env` loading and TypeScript execution)
- [Node.js](https://nodejs.org/) (for `npm run dev` / `npm run build`)
- Access to the SDK package source (`packages/sdk` in the monorepo, or a standalone clone)

---

## Local Development

### Quick Start

```bash
cd docs/website
npm install
cp .env.example .env       # then set SDK_PATH (see below)
npm run dev                 # http://localhost:3000
```

Without generating API docs, the site loads but SDK API links will 404.

### Setting `SDK_PATH`

The generation scripts need `SDK_PATH` to point at the SDK package root (the directory containing `index.ts` and `tsconfig.json`).

Copy `.env.example` to `.env` and set the path:

```bash
# Windows
SDK_PATH=D:\QVAC\qvac\packages\sdk

# Linux / macOS
SDK_PATH=/path/to/qvac/packages/sdk
```

Bun loads `.env` automatically when running scripts.

### Generating API Docs Locally

Generate docs for a specific version:

```bash
bun run scripts/generate-api-docs.ts <version>
```

Examples:

```bash
# Generate v0.7.0 and update (latest)/sdk/api/
bun run scripts/generate-api-docs.ts 0.7.0

# Backfill an older version without overwriting (latest)/sdk/api/
bun run scripts/generate-api-docs.ts 0.5.0 --no-update-latest

# Rollback (latest)/sdk/api/ to the previous version
bun run scripts/generate-api-docs.ts --rollback
```

This will:
1. Run TypeDoc against the SDK entry point (`SDK_PATH/index.ts`)
2. Extract exported functions and their JSDoc comments
3. Write MDX files to `content/docs/v<version>/sdk/api/`
4. Copy the version to `content/docs/(latest)/sdk/api/` (unless `--no-update-latest`)
5. Run a smoke test to verify generated files

### Updating the Versions List

After generating docs, update the version switcher:

```bash
bun run scripts/update-versions-list.ts [version]
```

This scans `content/docs/` for `vX.Y.Z` directories and regenerates `src/lib/versions.ts`. The optional `version` argument validates that the specified version exists.

### Full Generation (Orchestrated)

When running inside the monorepo, use the orchestrator script that reads the SDK version from `packages/sdk/package.json` automatically:

```bash
bun run docs:generate
```

This runs `generate-api-docs.ts` followed by `update-versions-list.ts` in sequence.

---

## Versioning

The docs site uses Fumadocs' folder convention for versioning. All content is versioned together (SDK, addons, guides, tutorials) under top-level version folders:

```
content/docs/
├── (latest)/       -> current working version (Fumadocs strips the parenthesized name from URLs)
│   ├── sdk/
│   │   ├── api/    -> generated API reference (not committed)
│   │   └── ...     -> manual content (committed)
│   └── addons/
└── v0.7.0/         -> frozen snapshot of the previous version
    ├── sdk/
    │   ├── api/
    │   └── ...
    └── addons/
```

- **Format**: `vX.Y.Z` (always 3-part semver with `v` prefix)
- **`(latest)/`**: The current working version. Fumadocs strips the parenthesized folder name, so content is served at root paths (e.g. `/sdk/quickstart`). API docs in `(latest)/sdk/api/` are kept in sync automatically.
- **`vX.Y.Z/`**: Frozen snapshots of previous versions. Created by `scripts/create-version-bundle.ts` when a newer version replaces the outgoing one. Content is served at versioned paths (e.g. `/v0.7.0/sdk/quickstart`).
- **Version list**: Managed in `src/lib/versions.ts`, updated by `scripts/update-versions-list.ts`
- **Sidebar trees**: Each version has its own tree file in `src/lib/trees/`. The `latest.ts` tree uses unversioned URLs; versioned trees (e.g. `v0.7.0.ts`) prefix all URLs.

When SDK code changes are merged to `main`, the **Docs Post-Merge Sync** workflow regenerates API docs and commits to `main`. This commit triggers the hosting provider to rebuild staging automatically.

---

## Branch Strategy and Deployment

### Branch Strategy

```
main = staging              docs-production = production
──────────────              ────────────────────────────

New commit on main          Merge PR: main -> docs-production
      │                              │
      ▼                              ▼
Hosting provider builds     Hosting provider builds
& deploys to staging        & deploys to production
```

- **`main`** is the staging environment. The hosting provider watches this branch; any new commit triggers a build and deploy to the staging site.
- **`docs-production`** is the production environment. The hosting provider watches this branch; any new commit (via merged PR from `main`) triggers a build and deploy to the production site.

With `main` + `docs-production`, every production deploy has a reviewable PR showing exactly what changed. The CI Doctor workflow gates PRs to `docs-production`, verifying all docs CI jobs are green before the merge is allowed.

### Staging (automatic)

```
SDK release merged to main
    │
    ▼
Docs Post-Merge Sync runs (regenerates API docs, commits to main)
    │
    ▼
Hosting provider detects new commit on main
    │
    ▼
Hosting provider builds the static site and deploys to staging
```

Any push to `main` -- whether from a merged PR, a docs content change, or the post-merge sync bot -- triggers the hosting provider to rebuild staging. No GitHub Actions deploy workflow is involved.

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
Hosting provider detects new commit on docs-production
    │
    ▼
Hosting provider builds the static site and deploys to production
```

**Gate**: The `Docs CI Doctor` workflow (`.github/workflows/docs-ci-doctor.yml`) must pass before the PR can be merged.

When a `release-*` branch is pushed, the **Docs Deploy Notify** workflow creates a GitHub issue reminding the docs owner to open a PR from `main` to `docs-production`.

---

## CI Workflows

Five GitHub Actions workflows automate the docs lifecycle:

### 1. Docs Website PR Checks

**File:** `.github/workflows/docs-website-pr-checks.yml`

**Triggers:** Pull requests to `main` that change `docs/website/**`, or manual dispatch.

**What it does:**
- Installs dependencies with Bun
- Creates a placeholder `(latest)/sdk/api/index.mdx` (since generated API docs aren't committed)
- Runs `bun run build` to validate the site compiles

**Purpose:** Catches build errors in docs PRs before merge.

### 2. Docs Post-Merge Sync

**File:** `.github/workflows/docs-post-merge-sync.yml`

**Triggers:** Push to `main` when files change in `packages/sdk/**` or `docs/website/scripts/**`.

**What it does:**
1. Checks out the repo
2. Installs dependencies for both docs and SDK
3. Runs `bun run docs:generate` (full orchestrated generation)
4. If generated files changed, commits and pushes to `main` with `[skip ci]`

**Purpose:** Keeps generated API docs on `main` in sync whenever the SDK source or generation scripts change.

**Required secrets/variables:**
| Name | Type | Purpose |
|---|---|---|
| `DOCS_SYNC_BOT_USER` | Variable (optional) | Bot username to prevent infinite loops |
| `DOCS_SYNC_BOT_NAME` | Variable (optional) | Git commit author name (default: `docs-sync-bot`) |
| `DOCS_SYNC_BOT_EMAIL` | Variable (optional) | Git commit author email |
| `DOCS_SYNC_PAT` | Secret (optional) | PAT for pushing (falls back to `GITHUB_TOKEN`) |

### 3. Generate API Documentation

**File:** `.github/workflows/docs-generate-api.yml`

**Triggers:**
- **Manual:** Actions tab → "Generate API Documentation" → enter version (e.g. `0.7.0`)
- **Dispatch:** `repository_dispatch` event with type `generate-api-docs` and `client_payload.version`

**What it does:**
1. Resolves the version from input or dispatch payload
2. Clones the SDK repo (tries branch `release-qvac-sdk-<version>`, then tag `v<version>`, then `main`)
3. Generates API docs and updates the versions list
4. Opens a PR on branch `docs/api-v<version>`

**Purpose:** On-demand API docs generation for specific SDK releases, especially useful for cross-repo setups.

**Required secrets/variables:**
| Name | Type | Purpose |
|---|---|---|
| `SDK_REPOSITORY` | Variable (required) | `owner/repo` of the SDK (e.g. `myorg/qvac`) |
| `SDK_SUBPATH` | Env default | Path to SDK inside the repo (default: `packages/sdk`) |

### 4. Docs Deploy Notify

**File:** `.github/workflows/docs-deploy-notify.yml`

**Triggers:** Push to any `release-*` branch, or manual dispatch.

**What it does:**
- Creates a `docs-deploy` label (if it doesn't exist)
- Opens a GitHub issue notifying the docs owner that a release is ready for deploy

**Purpose:** Alerts the team to deploy docs after a release branch is pushed.

**Required secrets/variables:**
| Name | Type | Purpose |
|---|---|---|
| `DOCS_DEPLOY_NOTIFY_USER` | Secret | GitHub username to `@mention` in the deploy issue |

### 5. Docs CI Doctor

**File:** `.github/workflows/docs-ci-doctor.yml`

**Triggers:** Pull requests targeting `docs-production`, or manual dispatch.

**What it does:**
- Runs `.github/scripts/docs-ci-doctor.sh`
- Queries the GitHub API for the latest runs of all docs-related workflows on `main`
- Reports pass/fail status for each and exits non-zero if any are not green

**Purpose:** Gates merges to `docs-production` by verifying all docs CI jobs succeeded.

**Running locally:**

Requires [GitHub CLI](https://cli.github.com) and a token with repo read access:

```bash
GH_TOKEN=ghp_... bash .github/scripts/docs-ci-doctor.sh
```

---

## Script Reference

All scripts live in `docs/website/scripts/` and are designed to run with Bun.

| Script | npm alias | Description |
|---|---|---|
| `generate-api-docs.ts` | `docs:generate-api` | TypeDoc → MDX for a given version |
| `update-versions-list.ts` | `docs:update-versions` | Rebuilds `src/lib/versions.ts` from version directories |
| `run-docs-generate.ts` | `docs:generate` | Orchestrates both scripts using the monorepo SDK version |
| `create-version-bundle.ts` | `docs:create-version` | Freezes `(latest)` as a versioned bundle for the outgoing version |

---

## Troubleshooting

### SDK entry point not found

```
SDK entry point not found: /path/to/sdk/index.ts
```

**Cause:** `SDK_PATH` is not set or points to the wrong directory.

**Fix:**
1. Verify `.env` exists in `docs/website/` (copy from `.env.example`)
2. Ensure `SDK_PATH` points to the SDK package root containing `index.ts` and `tsconfig.json`
3. On Windows, use backslashes or forward slashes — both work with Bun

### No API functions extracted

```
No API functions extracted. Check that:
  1. Functions are exported in index.ts
  2. Functions have JSDoc comments
  3. TypeScript compiles without errors
```

**Cause:** TypeDoc couldn't find any exported, documented functions.

**Fix:**
- Confirm the SDK `index.ts` exports public functions
- Ensure exported functions have JSDoc comments (TypeDoc skips undocumented items with `excludePrivate`)
- Check that the SDK's `tsconfig.json` is valid

### TypeDoc failed to convert project

**Cause:** TypeDoc encountered a fatal error parsing the SDK source.

**Fix:**
- Run `tsc --noEmit` in the SDK package to check for TypeScript errors
- The generation script uses `skipErrorChecking: true`, so minor TS errors are tolerated — this usually indicates a structural issue

### Version not found after generation

```
Version vX.Y.Z was not found in content/docs/
```

**Cause:** `update-versions-list.ts` ran but the version directory doesn't exist.

**Fix:** Run `docs:generate-api` for the version first, then `docs:update-versions`.

### Build fails in CI (PR checks)

The PR check workflow creates a placeholder `(latest)/sdk/api/index.mdx` to avoid 404s during build. If the build still fails:

1. Check that `source.config.ts` and `next.config.mjs` are valid
2. Run `bun run build` locally to reproduce
3. Look for broken MDX frontmatter or invalid imports in `content/`

### Post-merge sync creates infinite loop

If the sync bot's commits keep triggering the workflow:

1. Set the `DOCS_SYNC_BOT_USER` repository variable to the bot's GitHub username
2. The workflow skips runs when `github.actor` matches this variable
3. Commits also use `[skip ci]` as an additional safeguard

### Rollback (latest)/sdk/api/ to previous version

If a generation corrupted `(latest)/sdk/api/`:

```bash
bun run scripts/generate-api-docs.ts --rollback
```

This restores `(latest)/sdk/api/` from the `.latest-api-backup/` directory created during the previous generation.

### Generated MDX contains "undefined" or "[object Object]"

**Cause:** A function's JSDoc is missing or malformed.

**Fix:**
- The generator replaces literal `undefined` strings with `—` as a safety net
- Validation will throw if descriptions contain `undefined` or `[object Object]`
- Add proper JSDoc to the offending function in the SDK source and regenerate
