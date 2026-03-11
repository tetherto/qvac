# Docs Workflow

How the documentation site automation works: generating API docs locally, CI triggers, and troubleshooting.

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
- [CI Workflows](#ci-workflows)
  - [PR Checks](#1-docs-website-pr-checks)
  - [Post-Merge Sync](#2-docs-post-merge-sync)
  - [Generate API Documentation](#3-generate-api-documentation)
  - [Deploy Notify](#4-docs-deploy-notify)
- [Script Reference](#script-reference)
- [Troubleshooting](#troubleshooting)

---

## Overview

The docs site is a [Next.js](https://nextjs.org/) app using [Fumadocs](https://www.fumadocs.dev) for MDX-based documentation. Content lives in `content/docs/` and falls into two categories:

| Category | Path | Committed? |
|---|---|---|
| Baseline pages (Overview, Health, Workbench, Contributors) | `content/docs/overview/`, `content/docs/health/`, etc. | Yes |
| SDK API reference (generated) | `content/docs/sdk/api/vX.Y.Z/`, `content/docs/sdk/api/latest/` | No (`.gitignore`) |

SDK API docs are **generated from TypeScript source** via [TypeDoc](https://typedoc.org/) and written as MDX files. They are not committed to the repository — generate them locally or let CI handle it.

### How the Pipeline Works

```
SDK source (packages/sdk)
  │
  ▼
TypeDoc analysis  ──►  MDX generation  ──►  content/docs/sdk/api/vX.Y.Z/
                                       ──►  content/docs/sdk/api/latest/
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
# Generate v0.7.0 and update latest/
bun run scripts/generate-api-docs.ts 0.7.0

# Backfill an older version without overwriting latest/
bun run scripts/generate-api-docs.ts 0.5.0 --no-update-latest

# Rollback latest/ to the previous version
bun run scripts/generate-api-docs.ts --rollback
```

This will:
1. Run TypeDoc against the SDK entry point (`SDK_PATH/index.ts`)
2. Extract exported functions and their JSDoc comments
3. Write MDX files to `content/docs/sdk/api/v<version>/`
4. Copy the version to `content/docs/sdk/api/latest/` (unless `--no-update-latest`)
5. Run a smoke test to verify generated files

### Updating the Versions List

After generating docs, update the version switcher:

```bash
bun run scripts/update-versions-list.ts [version]
```

This scans `content/docs/sdk/api/` for `vX.Y.Z` directories and regenerates `src/lib/versions.ts`. The optional `version` argument validates that the specified version exists.

### Full Generation (Orchestrated)

When running inside the monorepo, use the orchestrator script that reads the SDK version from `packages/qvac-sdk/package.json` automatically:

```bash
bun run docs:generate
```

This runs `generate-api-docs.ts` followed by `update-versions-list.ts` in sequence.

---

## CI Workflows

Four GitHub Actions workflows automate the docs lifecycle:

### 1. Docs Website PR Checks

**File:** `.github/workflows/docs-website-pr-checks.yml`

**Triggers:** Pull requests to `main` that change `docs/website/**`, or manual dispatch.

**What it does:**
- Installs dependencies with Bun
- Creates a placeholder `latest/index.mdx` (since generated API docs aren't committed)
- Runs `bun run build` to validate the site compiles

**Purpose:** Catches build errors in docs PRs before merge.

### 2. Docs Post-Merge Sync

**File:** `.github/workflows/docs-post-merge-sync.yml`

**Triggers:** Push to `main` when files change in `packages/qvac-sdk/**` or `docs/website/scripts/**`.

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

---

## Script Reference

All scripts live in `docs/website/scripts/` and are designed to run with Bun.

| Script | npm alias | Description |
|---|---|---|
| `generate-api-docs.ts` | `docs:generate-api` | TypeDoc → MDX for a given version |
| `update-versions-list.ts` | `docs:update-versions` | Rebuilds `src/lib/versions.ts` from version directories |
| `run-docs-generate.ts` | `docs:generate` | Orchestrates both scripts using the monorepo SDK version |

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
Version vX.Y.Z was not found in content/docs/sdk/api/
```

**Cause:** `update-versions-list.ts` ran but the version directory doesn't exist.

**Fix:** Run `docs:generate-api` for the version first, then `docs:update-versions`.

### Build fails in CI (PR checks)

The PR check workflow creates a placeholder `latest/index.mdx` to avoid 404s during build. If the build still fails:

1. Check that `source.config.ts` and `next.config.mjs` are valid
2. Run `bun run build` locally to reproduce
3. Look for broken MDX frontmatter or invalid imports in `content/`

### Post-merge sync creates infinite loop

If the sync bot's commits keep triggering the workflow:

1. Set the `DOCS_SYNC_BOT_USER` repository variable to the bot's GitHub username
2. The workflow skips runs when `github.actor` matches this variable
3. Commits also use `[skip ci]` as an additional safeguard

### Rollback latest to previous version

If a generation corrupted `latest/`:

```bash
bun run scripts/generate-api-docs.ts --rollback
```

This restores `latest/` from the `.latest-backup/` directory created during the previous generation.

### Generated MDX contains "undefined" or "[object Object]"

**Cause:** A function's JSDoc is missing or malformed.

**Fix:**
- The generator replaces literal `undefined` strings with `—` as a safety net
- Validation will throw if descriptions contain `undefined` or `[object Object]`
- Add proper JSDoc to the offending function in the SDK source and regenerate
