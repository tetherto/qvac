# Docs Workflow

How the documentation site works: architecture, local development, CI, deployment, and troubleshooting.

For general contribution guidelines (PR labels, changelog format), see the [root CONTRIBUTING.md](../../CONTRIBUTING.md).

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
  - [Docs Release — Minor](#6-docs-release--minor)
  - [Docs Release — Patch](#7-docs-release--patch)
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
| SDK API summary (generated) | `content/docs/reference/api/index.mdx`, `content/docs/reference/api/v<X.Y>.x.mdx` | Yes (committed once per minor release) |
| SDK release notes (generated) | `content/docs/reference/release-notes/index.mdx`, `content/docs/reference/release-notes/v<X.Y>.x.mdx` | Yes (committed on every minor and patch release) |

The SDK API summary and release notes are **generated from TypeScript source / package CHANGELOGs** via [TypeDoc](https://typedoc.org/) and Nunjucks. They live as a single MDX file **per minor series** — the latest minor at `index.mdx`, older minors as sibling `v<X.Y>.x.mdx` files (literal `x` marker; one permanent page per minor line, accumulating patch sections inside). Generation is triggered by the release pipeline; locally a maintainer can regenerate to preview.

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
Phase 2: Nunjucks rendering  ──►  content/docs/reference/api/index.mdx        (latest minor)
                              ──►  content/docs/reference/api/v<X.Y>.x.mdx     (frozen older minor series)
                              ──►  src/lib/versions.ts                          (version switcher)
```

Release notes are **per minor series** too — each minor line owns one
permanent MDX page that accumulates patch sections as `## vX.Y.Z`
directly under the `## vX.Y.0` minor block. The body of each section is
inlined verbatim from each SDK pod package's
`packages/<pkg>/changelog/<version>/CHANGELOG_LLM.md` under a per-package
`### @qvac/<pkg>` subsection (heading levels demoted so they nest under
the page hierarchy).

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
# Re-render the latest summary into content/docs/reference/api/index.mdx
bun run scripts/generate-api-docs.ts 0.11.0 --latest --no-ai

# Render an older minor series into content/docs/reference/api/v0.10.x.mdx (no --latest)
bun run scripts/generate-api-docs.ts 0.10.0 --no-ai

# Bump only the frontmatter title (called by the minor freeze flow):
# no TypeDoc, no AI, no render
bun run scripts/generate-api-docs.ts 0.10.0 --target=v0.10.x.mdx --title-only
```

This will:
1. Run TypeDoc against the SDK entry point (`SDK_PATH/index.ts`) and write `api-data.json`
2. Optionally run AI augmentation to fill content gaps (skipped with `--no-ai`)
3. Render a single MDX via the Nunjucks `single-page.njk` template:
   - `--latest` → `content/docs/reference/api/index.mdx`
   - `--target=<file>` → `content/docs/reference/api/<file>` (explicit override)
   - otherwise → `content/docs/reference/api/v<X.Y>.x.mdx` (series-named)
4. Run a smoke test that checks for `## Functions` and `## Errors` headings

`--title-only` short-circuits this: it skips TypeDoc + AI + render and
only rewrites the `title:` line of the existing target MDX, then runs
the same smoke test.

**Flags:**

| Flag | Description |
|---|---|
| `--latest` | Write to `index.mdx` instead of `v<X.Y>.x.mdx`. |
| `--target=<file>` | Override the output filename inside `api/` (mutually exclusive with `--latest`). |
| `--title-only` | Rewrite the frontmatter title in-place (skips TypeDoc + render). Used by the minor-release freeze step to relabel the outgoing snapshot. |
| `--force-extract` | Bypass the mtime cache and re-run TypeDoc extraction. |
| `--no-ai` | Skip the AI augmentation step (CI default). |

**2. Release a new version end-to-end (freeze outgoing, generate incoming, refresh dropdown):**

```bash
# Minor (X.Y.0)
bun run scripts/release-version-minor.ts <new-version> [--force-extract]

# Patch (X.Y.Z, Z >= 1) — auto-detects patch-latest vs patch-archived
bun run scripts/release-version-patch.ts <new-version>
```

These are the orchestrators the CI pipelines call. They never commit or
open PRs themselves — the wrapping workflow does that. See
[Release-version orchestrators](#release-version-orchestrators) below.

### Updating the Versions List

After generating docs, refresh `src/lib/versions.ts` from disk:

```bash
bun run scripts/update-versions-list.ts [--latest=X.Y.Z]
```

This walks `content/docs/reference/api/` and `content/docs/reference/release-notes/` for `vX.Y.x.mdx` siblings (series-named) and rebuilds the section manifests (`API_SECTION`, `RELEASE_NOTES_SECTION`). The optional `--latest=X.Y.Z` flag overrides which precise patch is recorded as `section.latest` (used for the page title's latest-patch range); the selector itself only shows series labels (`v0.11.x (latest)`, `v0.10.x`, ...). Defaults to the SDK's `package.json` version when `--latest` is omitted.

### Full Generation (Orchestrated)

When running inside the monorepo, use the orchestrator script that reads the SDK version from `packages/sdk/package.json` automatically:

```bash
bun run docs:generate
```

This runs `generate-api-docs.ts --latest` followed by `update-versions-list.ts` in sequence — useful for previewing a regen against the current SDK without bumping the latest pointer.

---

## Versioning

Only the API summary and release notes are versioned. Every other content surface (about-qvac, getting-started, examples, tutorials, addons, cli, http-server, home) lives at a single bare path that always reflects the current SDK.

Each versioned section is one folder under `content/docs/reference/` containing one MDX **per minor series** (literal `x` marker in the filename):

```
content/docs/
├── about-qvac/                              -> not versioned
├── addons/                                  -> not versioned
├── cli.mdx                                  -> not versioned
├── http-server.mdx                          -> not versioned
├── index.mdx                                -> not versioned (home)
├── sdk/                                     -> not versioned
│   ├── examples/                            -> not versioned
│   ├── getting-started/                     -> not versioned
│   └── tutorials/                           -> not versioned
└── reference/
    ├── api/
    │   ├── index.mdx                        -> latest minor series (current SDK)
    │   ├── v0.10.x.mdx                      -> archived minor series
    │   ├── v0.9.x.mdx
    │   ├── v0.8.x.mdx
    │   └── v0.7.x.mdx
    └── release-notes/
        ├── index.mdx                        -> latest minor series
        ├── v0.10.x.mdx                      -> accumulates ## vX.Y.Z patch sections under the minor
        ├── v0.9.x.mdx
        ├── v0.8.x.mdx
        └── v0.7.x.mdx
```

- **Format**: `vX.Y.x` (literal `x` for the patch component). One permanent page per minor line.
- **`index.mdx`**: The current latest minor series, served from the bare basePath (e.g. `/reference/api`, `/reference/release-notes`).
- **`vX.Y.x.mdx`**: Archived minor series, served from `<basePath>/v<X.Y>.x` (e.g. `/reference/api/v0.10.x`). Created by `scripts/create-version-bundle.ts` (called from `release-version-minor.ts`) when a newer minor replaces the outgoing one — it just copies `index.mdx` to a series-named sibling.
- **Version list**: Two `VersionedSection` records (`API_SECTION`, `RELEASE_NOTES_SECTION`) in `src/lib/versions.ts`, refreshed by `scripts/update-versions-list.ts` from disk. Each carries both `latest` (precise patch, e.g. `v0.11.3`) and `latestSeries` (e.g. `v0.11.x`). The selector labels and URLs use the series form; the precise patch only surfaces in titles / description ranges.
- **Sidebar tree**: Single `customTree` in `src/lib/custom-tree.ts`. The `API` and `Release notes` entries are flat single-page links; the version selector beside the page title (only on `/reference/api*` and `/reference/release-notes*`) handles series switching via full-page reload.

The **Docs Release — Minor** and **Docs Release — Patch** workflows split the release flow by branch glob: pushes to `release-sdk-X.Y.0` invoke the minor orchestrator (freeze outgoing → regenerate), while pushes to `release-sdk-X.Y.Z` (with `Z >= 1`) invoke the patch orchestrator (insert `## vX.Y.Z` section under the minor block; API summary is untouched).

### Minor vs patch release behavior

| Trigger | API summary | Release notes | Versions list |
|---|---|---|---|
| `release-sdk-X.Y.0` (minor) | Re-run TypeDoc → new `index.mdx`. Outgoing minor frozen as `v<outgoingMajor>.<outgoingMinor>.x.mdx`. | Full render of the new minor's `## vX.Y.0` block (per-package verbatim `CHANGELOG_LLM.md` under `### @qvac/<pkg>`) into `index.mdx`. Outgoing minor frozen as `v<outgoingMajor>.<outgoingMinor>.x.mdx`. | `latest = X.Y.0`, `latestSeries = vX.Y.x`. |
| `release-sdk-X.Y.Z` matching current latest minor (`patch-latest`) | **Not touched.** Patches by definition don't change public API. | Insert `## v<X.Y.Z>` section directly after the existing `## v<X.Y>.0` block in `index.mdx`. Re-runs are idempotent (the section is replaced in place). Description range bumps to include the new patch. | `latest = X.Y.Z` (selector label unchanged — still `vX.Y.x (latest)`). |
| `release-sdk-X.Y.Z` for an archived minor (`patch-archived`) | **Not touched.** | Insert the same section into the existing `v<X.Y>.x.mdx` page. No rename. | `latest` unchanged (script omits `--latest`). |

Re-running a patch is **idempotent** — the existing `## vX.Y.Z` block is detected and replaced in place rather than appended again. The newest patch always sits directly below the minor block; older patches stay further down.

### Release notes data source

Each `## vX.Y.Z` section's body is read **verbatim** from each SDK pod
package's per-version folder (`packages/<pkg>/changelog/<X.Y.Z>/CHANGELOG_LLM.md`,
falling back to raw `CHANGELOG.md`). The H1 release-notes banner is
stripped and every surviving heading is demoted by two levels so it
nests cleanly under the page's `### @qvac/<pkg>` subsection. Packages
without a folder for that version are skipped (the SDK typically lists
all five pod packages; in practice only `@qvac/sdk` shares the version
namespace with the SDK pod's release cadence).

### Release-version orchestrators

Two scripts, one per release type:

**`release-version-minor.ts`** — for `X.Y.0` releases.

1. Reads the current `latest` from `src/lib/versions.ts` (the outgoing version).
2. Calls `scripts/create-version-bundle.ts <outgoing>` — copies `reference/api/index.mdx` to the series sibling `v<outgoingMajor>.<outgoingMinor>.x.mdx` and the same for release notes.
3. Title-only relabel: rewrites the frozen snapshots' titles to drop the `(latest)` marker.
4. Calls `scripts/generate-api-docs.ts <new> --latest` — overwrites `reference/api/index.mdx` with the new minor's content.
5. Calls `scripts/generate-release-notes.ts <new> --latest` — same for release notes, reading per-package CHANGELOG_LLM.md verbatim.
6. Calls `scripts/update-versions-list.ts --latest=<new>` — refreshes `versions.ts` so the dropdown picks up the new latest series plus the frozen older sibling.

**`release-version-patch.ts`** — for `X.Y.Z` releases with `Z >= 1`. Inspects `src/lib/versions.ts` to choose between `patch-latest` (write to `index.mdx`) and `patch-archived` (write to the existing `vX.Y.x.mdx`). The script never invokes the API summary generator.

Both orchestrators are pure file mutations — they never `git commit` or `gh pr create`. The wrapping GitHub workflow opens the PR.

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
SDK release branch pushed (touches packages/sdk/changelog/**)
    │
    ▼
Docs Release - Minor / Patch workflow runs the orchestrator
    │
    ▼
Workflow opens PR: docs/release-sdk-v<X.Y.Z> -> main
    │
    ▼
Reviewer approves and merges to main
    │
    ▼
Hosting provider detects new commit on main and rebuilds staging
```

The push-to-`main` is mediated by a reviewable PR rather than a bot
auto-commit — the previous "push directly to main" flow has been retired
in favour of `peter-evans/create-pull-request`. Any other push to `main`
(docs content changes, merged PRs from contributors) still triggers the
hosting provider's build the same way.

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

Seven GitHub Actions workflows automate the docs lifecycle:

### 1. Docs Website PR Checks

**File:** `.github/workflows/docs-website-pr-checks.yml`

**Triggers:** Pull requests to `main` that change `docs/website/**`, or manual dispatch.

**What it does:**
- Installs dependencies with Bun
- Ensures a placeholder `content/docs/reference/api/index.mdx` exists when the PR doesn't touch generated content (so `next build` doesn't 404 on the API summary page)
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

### 6. Docs Release — Minor

**File:** `.github/workflows/docs-release-minor.yml`

**Triggers:**
- Push to `release-sdk-*.*.0` branches that touch `packages/sdk/changelog/**`
- Manual dispatch with a version input (must be `X.Y.0`)

**What it does:**
1. **`label-gate`** — authorises secret access via the shared label-gate composite action (PAT required).
2. **`docs-release-setup` composite action** opens the dual checkout (close a race window where a PR landing on `main` mid-pipeline could smuggle a not-yet-released function into the rendered API summary):
   - `main-tree/` — `main` HEAD: docs scripts + commit target.
   - `release-tree/` — frozen at `github.sha`: SDK source + package CHANGELOGs.
   `SDK_PATH` and `CHANGELOG_REPO_ROOT` both point at `release-tree/`, so TypeDoc and the release-notes generator only see the released state. The action also installs Bun + deps and extracts the version.
3. Runs `release-version-minor.ts <version> --force-extract`, which:
   - Freezes the outgoing version's `index.mdx` into a series sibling `v<outgoingMajor>.<outgoingMinor>.x.mdx`
   - Generates the new API summary into `index.mdx` (always `--no-ai` — AI augmentation is intentionally out of the release pipeline; see [AI Augmentation](#ai-augmentation) for ad-hoc manual use)
   - Generates the new release notes into `index.mdx` (per-package verbatim `CHANGELOG_LLM.md` under a single `## v<X.Y.0>` block)
   - Refreshes `src/lib/versions.ts`
4. Runs TSDoc audit in warning mode (non-fatal) and link validation tests.
5. **Opens a PR** `docs/release-sdk-v<X.Y.0>` against `main` via `peter-evans/create-pull-request`. `add-paths` restricts the commit to the generated surfaces only.

Once a reviewer merges the PR, the hosting provider's `main` build picks it up and deploys to staging.

**Purpose:** Automates the full minor release flow — freeze + regenerate + PR.

### 7. Docs Release — Patch

**File:** `.github/workflows/docs-release-patch.yml`

**Triggers:**
- Push to `release-sdk-*` branches **excluding** `release-sdk-*.*.0`, that touch `packages/sdk/changelog/**`
- Manual dispatch with a version input (must be `X.Y.Z` with `Z >= 1`)

The include/exclude glob pair is mutually exclusive with the minor workflow's `release-sdk-*.*.0` glob, so the two workflows never both fire on the same push.

**What it does:**
1. **`label-gate`** — same as minor.
2. **`docs-release-setup` composite action** — same dual checkout, deps install, version extract.
3. Runs `release-version-patch.ts <version>`. The script inspects `src/lib/versions.ts` and chooses:
   - **patch-latest** (incoming `X.Y` == latest `X.Y`): insert `## v<X.Y.Z>` directly after the existing `## v<X.Y>.0` minor block of `index.mdx`. Bumps the manifest's stored `latest` patch.
   - **patch-archived** (incoming `X.Y` != latest `X.Y`): insert the same section into the existing `v<X.Y>.x.mdx`. No rename.
4. Runs link validation tests.
5. **Opens a PR** `docs/release-sdk-v<X.Y.Z>` against `main`. Same `add-paths` restriction.

Patches never touch the API summary page — the public API surface is
frozen at the minor boundary, so a patch by definition adds nothing
there. AI augmentation is correspondingly irrelevant to this flow.

**Purpose:** Automates patch releases without touching unrelated minors. Each minor line owns a single permanent `vX.Y.x.mdx` page that accumulates patch sections forever — the manifest's "one entry per minor series" invariant is maintained by the filename itself, not by renames.

**Required secrets/variables (both 6 and 7):**

| Name | Type | Purpose |
|---|---|---|
| `DOCS_SYNC_BOT_USER` | Variable (optional) | Bot username to short-circuit the workflow if it pushed the trigger commit |
| `DOCS_SYNC_PAT` | Secret (optional) | PAT used by `peter-evans/create-pull-request` to push the docs branch and have the PR trigger downstream workflow checks (falls back to `GITHUB_TOKEN`, in which case the PR is created but downstream PR checks won't fire) |
| `PAT_TOKEN` | Secret (required) | PAT used by `label-gate` for team membership lookups |

The release pipeline does **not** consume `AI_AUGMENT_*` secrets. Those are only used when invoking `generate-api-docs.ts` manually with AI on — see [AI Augmentation](#ai-augmentation).

---

## Script Reference

All scripts live in `docs/website/scripts/` and are designed to run with Bun.

| Script | npm alias | Description |
|---|---|---|
| `release-version-minor.ts` | `docs:release-version-minor` | Minor (X.Y.0) orchestrator: freeze outgoing series → generate new latest from per-package `CHANGELOG_LLM.md` → refresh versions.ts. Called by `docs-release-minor.yml`. |
| `release-version-patch.ts` | `docs:release-version-patch` | Patch (X.Y.Z, Z>=1) orchestrator: insert `## v<X.Y.Z>` after the existing minor block on the appropriate series page. Never touches the API summary. Called by `docs-release-patch.yml`. |
| `generate-api-docs.ts` | `docs:generate-api` | Renders one minor series' API summary MDX. `--title-only` rewrites only the frontmatter title (called from the minor freeze flow); `--target=<file>` overrides the output filename. |
| `api-docs/extract.ts` | -- | Phase 1: TypeDoc analysis, writes `api-data.json` |
| `api-docs/render.ts` | -- | Phase 2: Nunjucks rendering of `single-page.njk` from `api-data.json` |
| `api-docs/ai-augment.ts` | -- | Phase 1.5: Optional AI-powered content gap filling |
| `api-docs/audit-tsdoc.ts` | `docs:audit-tsdoc` | TSDoc completeness audit (standalone or via extraction) |
| `generate-release-notes.ts` | `docs:generate-release-notes` | Generates / augments the release-notes series MDX. Default mode renders the page from scratch with a `## v<X.Y.0>` block; `--append-patch` inserts a `## v<X.Y.Z>` block directly after the minor; `--title-only` relabels the frontmatter title only. |
| `update-versions-list.ts` | `docs:update-versions` | Rebuilds `src/lib/versions.ts` from `reference/api/v*.x.mdx` and `reference/release-notes/v*.x.mdx` siblings on disk. `--latest=X.Y.Z` records the precise patch in `latest` (the selector still labels series-only). |
| `run-docs-generate.ts` | `docs:generate` | Convenience: regenerates the latest summary + refreshes versions.ts using the monorepo SDK's `package.json` version (no version bump) |
| `create-version-bundle.ts` | `docs:create-version` | Copies the current `index.mdx` of each versioned section to `v<X.Y>.x.mdx` (called from `release-version-minor.ts`) |
| `lib/release-shared.ts` | -- | Shared helpers for the two release orchestrators (version parsing, `versions.ts` reader, series-sibling resolver, series-name helpers) |
| `lib/changelog-parser.ts` | -- | Changelog parsing — `readChangelogLLMVerbatim` for the verbatim per-package render plus legacy `parseChangelog` / `parseChangelogFolder` / `mergeChangelogs` exports kept for unit-test fixtures and ad-hoc tooling |
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

For example, `release-notes-overrides/0.11.0.md`. The file should contain `## Heading` sections that are injected at the top of the page (after frontmatter, before the per-version `## vX.Y.Z` blocks). Useful for highlights, migration guides, or breaking-change callouts that don't fit inside any single package's `CHANGELOG_LLM.md`. Overrides only apply to full minor renders (default mode), not to the patch append flow.

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

**Fix:** Run `docs:generate-api -- <version> --latest` (writes `index.mdx`) or `docs:generate-api -- <version>` (writes `vX.Y.Z.mdx`) first, then `docs:update-versions`. For a full release flow use `docs:release-version-minor -- <version>` (for `X.Y.0`) or `docs:release-version-patch -- <version>` (for `X.Y.Z` with `Z >= 1`) instead.

### Build fails in CI (PR checks)

The PR check workflow ensures a placeholder `content/docs/reference/api/index.mdx` exists so `next build` doesn't 404 when a PR doesn't touch generated content. If the build still fails:

1. Check that `source.config.ts` and `next.config.mjs` are valid
2. Run `bun run build` locally to reproduce
3. Look for broken MDX frontmatter or invalid imports in `content/`

### Post-merge sync creates infinite loop

The post-merge sync workflow is currently `workflow_dispatch:` only — its `push:` trigger to `main` is removed because production tracks `main` and auto-commits would loop. When you wire `push:` back on (after production moves to `docs-production`):

1. Set the `DOCS_SYNC_BOT_USER` repository variable to the bot's GitHub username
2. The workflow skips runs when `github.actor` matches this variable
3. Commits also use `[skip ci]` as an additional safeguard

### Recover a broken `index.mdx` after a bad release

If a release ran but produced a broken `reference/api/index.mdx` or `reference/release-notes/index.mdx`, restore it by re-running the orchestrator against the previous version:

```bash
# Minor (X.Y.0): full freeze + regen
bun run scripts/release-version-minor.ts <previous-X.Y.0> --force-extract

# Patch (X.Y.Z, Z>=1): title-only + append (only useful if the patch flow itself is broken)
bun run scripts/release-version-patch.ts <previous-X.Y.Z>
```

Then revert the bad commit / branch state via `git`. There is no automatic backup directory — versioning is the safety net (every previous version exists as a sibling `vX.Y.Z.mdx`).

### Generated MDX contains "undefined" or "[object Object]"

**Cause:** A function's JSDoc is missing or malformed.

**Fix:**
- The generator replaces literal `undefined` strings with `—` as a safety net
- Validation will throw if descriptions contain `undefined` or `[object Object]`
- Add proper JSDoc to the offending function in the SDK source and regenerate
