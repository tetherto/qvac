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
  - [Release Pipeline](#6-docs-release-pipeline)
- [Script Reference](#script-reference)
- [AI Augmentation](#ai-augmentation)
- [Release-Notes Overrides](#release-notes-overrides)
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

Content falls into two categories:

| Category | Path | Committed? |
|---|---|---|
| Manual content (guides, tutorials, addons) | `content/docs/sdk/`, `content/docs/addons/`, `content/docs/about-qvac/`, etc. | Yes |
| SDK API summary (generated) | `content/docs/sdk/api/index.mdx`, `content/docs/sdk/api/v<X.Y.Z>.mdx` | Yes (committed once per release) |
| SDK release notes (generated) | `content/docs/sdk/release-notes/index.mdx`, `content/docs/sdk/release-notes/v<X.Y.Z>.mdx` | Yes (committed once per release) |

The SDK API summary and release notes are **generated from TypeScript source / package CHANGELOGs** via [TypeDoc](https://typedoc.org/) and Nunjucks. They live as a single MDX file per version (latest at `index.mdx`, frozen older versions as sibling `vX.Y.Z.mdx` files). Generation is triggered by the release pipeline; locally a maintainer can regenerate to preview.

### How the Pipeline Works

The generation pipeline has two phases (extraction and rendering) with an optional AI augmentation step in between:

```
SDK source (packages/sdk)
  │
  ▼
Phase 1: TypeDoc extraction  ──►  api-data.json
  │
  ▼
Phase 1.5: AI augmentation (optional, off by default)
  │
  ▼
Phase 2: Nunjucks rendering  ──►  content/docs/sdk/api/index.mdx        (latest)
                              ──►  content/docs/sdk/api/v<X.Y.Z>.mdx     (frozen older versions)
                              ──►  src/lib/versions.ts                    (version switcher)
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

Two entry points depending on what you want to do:

**1. Render the API summary for a single version (no version-bumping):**

```bash
bun run scripts/generate-api-docs.ts <version> [flags]
```

Examples:

```bash
# Re-render the latest summary into content/docs/sdk/api/index.mdx
bun run scripts/generate-api-docs.ts 0.9.1 --latest --no-ai

# Render an older version into content/docs/sdk/api/v0.8.0.mdx (no --latest)
bun run scripts/generate-api-docs.ts 0.8.0 --no-ai
```

This will:
1. Run TypeDoc against the SDK entry point (`SDK_PATH/index.ts`) and write `api-data.json`
2. Optionally run AI augmentation to fill content gaps (skipped with `--no-ai`)
3. Render a single MDX via the Nunjucks `single-page.njk` template:
   - `--latest` → `content/docs/sdk/api/index.mdx`
   - otherwise → `content/docs/sdk/api/v<version>.mdx`
4. Run a smoke test that checks for `## Functions` and `## Errors` headings

**Flags:**

| Flag | Description |
|---|---|
| `--latest` | Write to `index.mdx` instead of `v<version>.mdx`. |
| `--force-extract` | Bypass the mtime cache and re-run TypeDoc extraction. |
| `--no-ai` | Skip the AI augmentation step (CI default). |

**2. Release a new version end-to-end (freeze outgoing, generate incoming, refresh dropdown):**

```bash
bun run scripts/release-version.ts <new-version> --no-commit --no-pr [--force-extract] [--ai]
```

This is the orchestrator the CI pipelines call. Locally, pass `--no-commit --no-pr` to skip the git steps and just produce the file changes. See [Release-version orchestrator](#release-version-orchestrator) below.

### Updating the Versions List

After generating docs, refresh `src/lib/versions.ts` from disk:

```bash
bun run scripts/update-versions-list.ts [--latest=X.Y.Z]
```

This walks `content/docs/sdk/api/` and `content/docs/sdk/release-notes/` for `vX.Y.Z.mdx` siblings and rebuilds the section manifests (`API_SECTION`, `RELEASE_NOTES_SECTION`). The optional `--latest=X.Y.Z` flag overrides which version is shown as `(latest)` in the dropdown labels (defaults to the SDK's `package.json` version).

### Full Generation (Orchestrated)

When running inside the monorepo, use the orchestrator script that reads the SDK version from `packages/sdk/package.json` automatically:

```bash
bun run docs:generate
```

This runs `generate-api-docs.ts --latest` followed by `update-versions-list.ts` in sequence — useful for previewing a regen against the current SDK without bumping the latest pointer.

---

## Versioning

Only the API summary and release notes are versioned. Every other content surface (about-qvac, getting-started, examples, tutorials, addons, cli, http-server, home) lives at a single bare path that always reflects the current SDK.

Each versioned section is one folder under `content/docs/sdk/` containing one MDX per version:

```
content/docs/
├── about-qvac/                              -> not versioned
├── addons/                                  -> not versioned
├── cli.mdx                                  -> not versioned
├── http-server.mdx                          -> not versioned
├── index.mdx                                -> not versioned (home)
└── sdk/
    ├── api/
    │   ├── index.mdx                        -> latest API summary (current SDK)
    │   ├── v0.8.0.mdx                       -> frozen older version
    │   └── v0.7.0.mdx
    ├── release-notes/
    │   ├── index.mdx                        -> latest release notes
    │   ├── v0.9.0.mdx
    │   ├── v0.8.0.mdx
    │   └── v0.7.0.mdx
    ├── examples/                            -> not versioned
    ├── getting-started/                     -> not versioned
    └── tutorials/                           -> not versioned
```

- **Format**: `vX.Y.Z` (always 3-part semver with `v` prefix). Only the latest patch per minor is kept.
- **`index.mdx`**: The current latest version, served from the bare basePath (e.g. `/sdk/api`, `/sdk/release-notes`).
- **`vX.Y.Z.mdx`**: Frozen snapshots of previous versions, served from `<basePath>/v<X.Y.Z>` (e.g. `/sdk/api/v0.8.0`). Created by `scripts/create-version-bundle.ts` (called from `release-version.ts`) when a newer version replaces the outgoing one — it just copies `index.mdx` to a sibling.
- **Version list**: Two `VersionedSection` records (`API_SECTION`, `RELEASE_NOTES_SECTION`) in `src/lib/versions.ts`, refreshed by `scripts/update-versions-list.ts` from disk.
- **Sidebar tree**: Single `customTree` in `src/lib/custom-tree.ts`. The `JS API` and `Release notes` entries are flat single-page links; the version selector beside the page title (only on `/sdk/api*` and `/sdk/release-notes*`) handles version switching via full-page reload.

The **Docs Release Pipeline** workflow runs `release-version.ts` end-to-end on a release branch push, which freezes the outgoing index.mdx, generates the new latest, and commits to `main` — triggering the hosting provider to rebuild staging.

### Release-version orchestrator

`release-version.ts` is the single entry point for releasing a new docs version. It:

1. Reads the current `latest` from `src/lib/versions.ts` (the outgoing version).
2. Calls `scripts/create-version-bundle.ts <outgoing>` — copies `sdk/api/index.mdx` to `sdk/api/v<outgoing>.mdx` and the same for release notes.
3. Calls `scripts/generate-api-docs.ts <new> --latest` — overwrites `sdk/api/index.mdx` with the new version's content.
4. Calls `scripts/generate-release-notes.ts <new> --latest --aggregate-minor` — same for release notes.
5. Calls `scripts/update-versions-list.ts --latest=<new>` — refreshes `versions.ts` so the dropdown lists the new latest plus the now-frozen older sibling.
6. Optionally `git commit` and `gh pr create` (skipped in CI; the workflow handles those steps with its bot identity).

This single orchestration point is what guarantees the outgoing version is always frozen before the new latest overwrites `index.mdx`.

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

Six GitHub Actions workflows automate the docs lifecycle:

### 1. Docs Website PR Checks

**File:** `.github/workflows/docs-website-pr-checks.yml`

**Triggers:** Pull requests to `main` that change `docs/website/**`, or manual dispatch.

**What it does:**
- Installs dependencies with Bun
- Ensures a placeholder `content/docs/sdk/api/index.mdx` exists when the PR doesn't touch generated content (so `next build` doesn't 404 on the API summary page)
- Runs `bun run build` to validate the site compiles
- Runs Vitest tests (sidebar consistency, link integrity, single-page rendering, changelog parser) excluding TSDoc completeness tests that require SDK source

**Purpose:** Catches build errors and broken links in docs PRs before merge.

### 2. Docs Post-Merge Sync (manual-only)

**File:** `.github/workflows/docs-post-merge-sync.yml`

**Status:** Currently `workflow_dispatch:` only. The original `push:` trigger to `main` is intentionally not wired up — production tracks `main`, so auto-committing regenerated docs back to `main` would loop the workflow back into itself on every push. Restore the `push:` trigger once production moves to `docs-production`.

**Triggers (current):** Manual dispatch from the Actions tab. **Triggers (intended once re-enabled):** Push to `main` when files change in `packages/sdk/**` or `docs/website/scripts/**`.

**What it does (when enabled):**
1. Checks out the repo
2. Installs dependencies for both docs and SDK
3. Runs `bun run docs:generate` (full orchestrated generation)
4. If generated files changed, commits and pushes to `main` with `[skip ci]`

**Purpose:** Keeps generated API docs and release notes on `main` in sync whenever the SDK source or generation scripts change.

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

### 6. Docs Release Pipeline

**File:** `.github/workflows/docs-release-pipeline.yml`

**Triggers:**
- Push to `release-qvac-sdk-*` branches
- GitHub release events (type: `published`)
- Manual dispatch with a version input

**What it does:**
1. **Dual checkout** to close a race window where a PR landing on `main` mid-pipeline could smuggle a not-yet-released function into the rendered API summary:
   - `main-tree/` — `main` HEAD: docs scripts + commit/push target.
   - `release-tree/` — frozen at `github.sha` (the trigger commit): SDK source + package CHANGELOGs.
   `SDK_PATH` and `CHANGELOG_REPO_ROOT` both point at `release-tree/`, so TypeDoc and `generate-release-notes.ts` only ever see the released state.
2. Extracts the version from the branch name, release tag, or manual input
3. Runs `release-version.ts <version> --no-commit --no-pr --force-extract [--ai]`, which:
   - Freezes the outgoing version's `index.mdx` into a sibling `vX.Y.Z.mdx`
   - Generates the new API summary into `index.mdx`
   - Generates the new release notes (aggregating minor) into `index.mdx`
   - Refreshes `src/lib/versions.ts`
4. Runs TSDoc audit in warning mode (non-fatal)
5. Runs link validation tests
6. Commits generated content and pushes to `main` with `[skip ci]`

The push to `main` triggers the hosting provider to rebuild staging automatically.

**AI augmentation:** Controlled by the `skip_ai` input (default: `true`). When `skip_ai` is `false` AND `AI_AUGMENT_API_KEY` is configured, the workflow forwards `--ai` to `release-version.ts`.

**Purpose:** Automates the full docs generation pipeline when an SDK release is created — including the freeze step that preserves the outgoing version as a sibling MDX, which the previous per-step setup silently skipped.

**Required secrets/variables:**

| Name | Type | Purpose |
|---|---|---|
| `DOCS_SYNC_BOT_USER` | Variable (optional) | Bot username to prevent infinite loops |
| `DOCS_SYNC_BOT_NAME` | Variable (optional) | Git commit author name |
| `DOCS_SYNC_BOT_EMAIL` | Variable (optional) | Git commit author email |
| `DOCS_SYNC_PAT` | Secret (optional) | PAT for pushing to main |
| `AI_AUGMENT_BASE_URL` | Secret (optional) | OpenAI-compatible API endpoint |
| `AI_AUGMENT_API_KEY` | Secret (optional) | API key for AI augmentation |
| `AI_AUGMENT_MODEL` | Variable (optional) | Model identifier (e.g. `gpt-4o`) |

---

## Script Reference

All scripts live in `docs/website/scripts/` and are designed to run with Bun.

| Script | npm alias | Description |
|---|---|---|
| `release-version.ts` | `docs:release-version` | End-to-end release orchestrator: freeze outgoing → generate new latest → refresh versions.ts. **Use this for releasing a new version** (the CI pipelines call it). |
| `generate-api-docs.ts` | `docs:generate-api` | Renders one version's API summary MDX. Does NOT freeze prior versions; that's `release-version.ts`'s job. |
| `api-docs/extract.ts` | -- | Phase 1: TypeDoc analysis, writes `api-data.json` |
| `api-docs/render.ts` | -- | Phase 2: Nunjucks rendering of `single-page.njk` from `api-data.json` |
| `api-docs/ai-augment.ts` | -- | Phase 1.5: Optional AI-powered content gap filling |
| `api-docs/audit-tsdoc.ts` | `docs:audit-tsdoc` | TSDoc completeness audit (standalone or via extraction) |
| `generate-release-notes.ts` | `docs:generate-release-notes` | Generates release notes MDX from package changelogs (supports `--aggregate-minor`) |
| `update-versions-list.ts` | `docs:update-versions` | Rebuilds `src/lib/versions.ts` from `sdk/api/v*.mdx` and `sdk/release-notes/v*.mdx` siblings on disk |
| `run-docs-generate.ts` | `docs:generate` | Convenience: regenerates the latest summary + refreshes versions.ts using the monorepo SDK's `package.json` version (no version bump) |
| `create-version-bundle.ts` | `docs:create-version` | Copies the current `index.mdx` of each versioned section to `vX.Y.Z.mdx` (called from `release-version.ts`) |
| `lib/link-validator.ts` | -- | Internal link extraction + resolution (used by the link-integrity test) |

---

## AI Augmentation

The generation pipeline includes an optional AI step that identifies functions with thin descriptions or missing examples and generates first-draft content using an LLM. This step runs between extraction and rendering, modifying `api-data.json` in place before templates consume it.

**Skipping:** Pass `--no-ai` to `generate-api-docs.ts`, or omit the required environment variables. The step is skipped silently when env vars are not configured.

**Required environment variables:**

| Variable | Description |
|---|---|
| `AI_AUGMENT_BASE_URL` | OpenAI-compatible API endpoint (e.g. `https://api.openai.com/v1`) |
| `AI_AUGMENT_API_KEY` | API key for the provider |
| `AI_AUGMENT_MODEL` | Model identifier (e.g. `gpt-4o`, `claude-sonnet-4-20250514`) |

**Source tagging:** Every AI-generated field is tagged in `api-data.json` with `"descriptionSource": "ai"` or `"examplesSource": "ai"`. Fields populated by TypeDoc extraction have no source tag (or `"extracted"`). Reviewers can search for `"source": "ai"` in the JSON or look for the AI-generated content on the staging site before promoting to production.

**Determinism:** AI augmentation calls a remote LLM, so the same SDK input produces **different** output across runs. Any workflow that depends on reproducible output (CI byte-identity checks, `docs:validate-e2e`, QA review runs) **must** pass `--no-ai`. Use AI augmentation only for curated manual runs where the author reviews and polishes the AI output before committing.

For fully reproducible `api-data.json` also set `SOURCE_DATE_EPOCH` to a fixed Unix timestamp (reproducible-builds convention). Without it, `ApiData.generatedAt` is the literal string `"unspecified"` so byte-identity checks still pass.

**Prompt templates** live in `scripts/api-docs/prompts/` and use `{{variable}}` placeholders:
- `function-description.txt` -- generates a 2-4 sentence function description
- `usage-example.txt` -- generates a TypeScript usage example
- `release-note-summary.txt` -- generates a release note summary (reserved for future use)

---

## Release-Notes Overrides

To customize the generated release notes page for a specific version, create a markdown file at:

```
docs/website/release-notes-overrides/<version>.md
```

For example, `release-notes-overrides/0.8.1.md`. The file should contain `## Heading` sections that are injected before the auto-generated changelog categories. This is useful for adding highlights, migration guides, or breaking change callouts that don't fit in the standard changelog format.

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
Version vX.Y.Z was not found
```

**Cause:** `update-versions-list.ts` ran but the version's MDX file doesn't exist on disk.

**Fix:** Run `docs:generate-api -- <version> --latest` (writes `index.mdx`) or `docs:generate-api -- <version>` (writes `vX.Y.Z.mdx`) first, then `docs:update-versions`. For a full release flow use `docs:release-version -- <version> --no-commit --no-pr` instead.

### Build fails in CI (PR checks)

The PR check workflow ensures a placeholder `content/docs/sdk/api/index.mdx` exists so `next build` doesn't 404 when a PR doesn't touch generated content. If the build still fails:

1. Check that `source.config.ts` and `next.config.mjs` are valid
2. Run `bun run build` locally to reproduce
3. Look for broken MDX frontmatter or invalid imports in `content/`

### Post-merge sync creates infinite loop

The post-merge sync workflow is currently `workflow_dispatch:` only — its `push:` trigger to `main` is removed because production tracks `main` and auto-commits would loop. When you wire `push:` back on (after production moves to `docs-production`):

1. Set the `DOCS_SYNC_BOT_USER` repository variable to the bot's GitHub username
2. The workflow skips runs when `github.actor` matches this variable
3. Commits also use `[skip ci]` as an additional safeguard

### Recover a broken `index.mdx` after a bad release

If a release ran but produced a broken `sdk/api/index.mdx` or `sdk/release-notes/index.mdx`, restore it by re-running the orchestrator against the previous version:

```bash
bun run scripts/release-version.ts <previous-version> --no-commit --no-pr --force-extract
```

Then revert the bad commit / branch state via `git`. There is no automatic backup directory — versioning is the safety net (every previous version exists as a sibling `vX.Y.Z.mdx`).

### Generated MDX contains "undefined" or "[object Object]"

**Cause:** A function's JSDoc is missing or malformed.

**Fix:**
- The generator replaces literal `undefined` strings with `—` as a safety net
- Validation will throw if descriptions contain `undefined` or `[object Object]`
- Add proper JSDoc to the offending function in the SDK source and regenerate
