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
  - [Production (manual promotion)](#production-manual-promotion)
- [CI Workflows](#ci-workflows)
  - [PR Checks](#1-docs-website-pr-checks)
  - [Promote docs to production (manual)](#2-promote-docs-to-production-manual)
  - [SDK release docs (local, skill-driven)](#3-sdk-release-docs-local-skill-driven)
  - [Production health check (scheduled)](#4-production-health-check-scheduled)
- [Script Reference](#script-reference)
- [Release-Notes Overrides](#release-notes-overrides)
- [Troubleshooting](#troubleshooting)

---

## Overview

The docs site lives in `docs/website/`. It is a fully static site (Next.js `output: 'export'`) served via CDN by the hosting provider. GitHub stores only the source code -- the hosting provider watches repo branches, runs the build (SSG), and deploys automatically. GitHub Actions never builds or deploys the site; it handles validation, gating, and a manual **promotion** workflow that advances the `docs-production` pointer (it moves the branch, the hosting provider does the deploy).

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
| SDK API summary (generated) | `content/docs/reference/api/v<X.Y>.x.mdx` (all series, latest included), plus the shim `content/docs/reference/api/index.mdx` | Yes (committed once per minor release) |
| SDK release notes (generated) | `content/docs/reference/release-notes/v<X.Y>.x.mdx` (all series, latest included), plus the shim `content/docs/reference/release-notes/index.mdx` | Yes (committed on every minor and patch release) |

The SDK API summary and release notes are **generated from TypeScript source / package CHANGELOGs** via [TypeDoc](https://typedoc.org/) and Nunjucks. Every minor series — including the current latest — lives as a single permanent MDX file `v<X.Y>.x.mdx` (literal `x` marker; accumulating patch sections inside as `## vX.Y.Z`). The canonical bare URL (`/reference/api`, `/reference/release-notes`) is served by a tiny fixed `index.mdx` **shim** that `<include>`s the current latest series file via Fumadocs' native `remarkInclude` plugin. Rotating latest is therefore a shim rewrite (one changed line in the include target, plus frontmatter refresh) + a managed block update in `public/_redirects` — the outgoing series' MDX is never touched. Generation is triggered by the release pipeline; locally a maintainer can regenerate to preview.

### How the Pipeline Works

The generation pipeline has two phases — TypeDoc extraction and Nunjucks
rendering. Output is deterministic: identical SDK input always produces
identical MDX. (AI-assisted authoring happens locally via Cursor skills,
never inside this pipeline.)

```
SDK source (packages/sdk)
  │
  ▼
Phase 1: TypeDoc extraction  ──►  api-data.json
  │
  ▼
Phase 2: Nunjucks rendering  ──►  content/docs/reference/api/v<X.Y>.x.mdx     (versioned series page — same shape for latest and archived)
                              ──►  src/lib/versions.ts                          (version switcher)
```

Release notes are **per minor series** too — each minor line owns one
permanent MDX page that accumulates patch sections as `## vX.Y.Z`
directly under the `## vX.Y.0` minor block. The body of each section is
inlined verbatim from each SDK pod package's
`packages/<pkg>/changelog/<version>/CHANGELOG_LLM.md` under a per-package
`### @qvac/<pkg>` subsection (heading levels demoted so they nest under
the page hierarchy).

The canonical bare URL for each section is served by a permanent shim
`index.mdx` that contains just frontmatter + one `<include>` line. The
shim is rewritten on every minor rotation to point at the new
`v<X.Y>.x.mdx`; patch releases don't touch it except for the description
range in release notes. See [Versioning](#versioning) below for the
full model.

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
# Re-render a minor series into content/docs/reference/api/v<X.Y>.x.mdx
bun run scripts/generate-api-docs.ts 0.11.0

# Same, but explicitly targeting an existing file (used by ad-hoc relabel)
bun run scripts/generate-api-docs.ts 0.10.0 --target=v0.10.x.mdx --title-only
```

This will:
1. Run TypeDoc against the SDK entry point (`SDK_PATH/index.ts`) and write `api-data.json`
2. Render a single MDX via the Nunjucks `single-page.njk` template:
   - default → `content/docs/reference/api/v<X.Y>.x.mdx` (series-named — same file whether the series is latest or archived)
   - `--target=<file>` → `content/docs/reference/api/<file>` (explicit override)
3. Run a smoke test that checks for `## Functions` and `## Errors` headings

`--title-only` short-circuits this: it skips TypeDoc + render and only
rewrites the `title:` line of the existing target MDX, then runs the
same smoke test.

The generator never writes to `index.mdx` — that path is the shim,
managed exclusively by `release-version-minor.ts`.

**Flags:**

| Flag | Description |
|---|---|
| `--target=<file>` | Override the output filename inside `api/` (defaults to `v<X.Y>.x.mdx`). |
| `--title-only` | Rewrite the frontmatter title in-place (skips TypeDoc + render). Handy for one-off relabel. |
| `--force-extract` | Bypass the mtime cache and re-run TypeDoc extraction. |

**2. Release a new version end-to-end (generate incoming, rewrite shims, rotate redirects, refresh dropdown):**

```bash
# Auto-detects minor (X.Y.0) vs patch (X.Y.Z, Z >= 1)
bun run scripts/release-version.ts <new-version> [--force-extract]
```

This is the orchestrator the CI pipeline calls. It dispatches to the
focused `release-version-minor.ts` / `release-version-patch.ts` modules
based on the patch number, and never commits or opens PRs itself — the
wrapping workflow does that. See
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

This runs `generate-api-docs.ts` followed by `update-versions-list.ts` in sequence — useful for previewing a regen against the current SDK without bumping the latest pointer. It writes to the current series' `v<X.Y>.x.mdx` (which the shim already `<include>`s), so the shim and `_redirects` block never need to move during a preview regen.

---

## Versioning

Only the API summary and release notes are versioned. Every other content surface (about-qvac, getting-started, examples, tutorials, addons, cli, http-server, home) lives at a single bare path that always reflects the current SDK.

Each versioned section is one folder under `content/docs/reference/` containing:

- One permanent MDX **per minor series** (literal `x` marker in the filename), including the current latest — every minor line has exactly one on-disk page for its entire lifetime.
- A tiny fixed `index.mdx` **shim** that serves the canonical bare URL and `<include>`s the current latest series file via Fumadocs' `remarkInclude` plugin.

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
    │   ├── index.mdx                        -> shim: <include>./v<latestSeries>.x.mdx
    │   ├── v0.18.x.mdx                      -> current latest minor series (content lives here)
    │   ├── v0.17.x.mdx                      -> archived minor series
    │   ├── v0.10.x.mdx
    │   └── ...
    └── release-notes/
        ├── index.mdx                        -> shim: <include>./v<latestSeries>.x.mdx
        ├── v0.18.x.mdx                      -> current latest series (accumulates ## vX.Y.Z patches)
        ├── v0.17.x.mdx                      -> archived minor series
        ├── v0.10.x.mdx
        └── ...
```

- **Format**: `vX.Y.x` (literal `x` for the patch component). One permanent page per minor line — the current latest is not special on disk.
- **`index.mdx` shim**: Serves the canonical bare URL (`/reference/api`, `/reference/release-notes`). Body is one line: `<include>./v<latestSeries>.x.mdx</include>`. Rewritten by `release-version-minor.ts` when latest rotates; otherwise touched only by `release-version-patch.ts` in `patch-latest` mode to mirror the versioned page's `description:` (release-notes range grows) — API's shim description is static, so patches never touch the API shim.
- **`vX.Y.x.mdx`**: Every minor series' permanent page, served from `<basePath>/v<X.Y>.x` (e.g. `/reference/api/v0.10.x`). Same shape for latest and archived — the difference is only in which file the shim points at. Frontmatter titles are always the plain series label (`vX.Y.x`, no "(latest)" marker — that lives exclusively on the shim).
- **Latest-series alias redirect**: The versioned URL of the current latest (e.g. `/reference/api/v0.18.x`) 301-aliases to the bare canonical (`/reference/api/`) via a managed block in `public/_redirects`, delimited by `# ==== BEGIN latest-series alias (managed) ====` / `# ==== END latest-series alias (managed) ====` markers. `release-version-minor.ts` rewrites the block on every rotation. Search engines and crawlers therefore consolidate on the canonical bare URL — the versioned URL is only "real" once the series is archived (i.e., no longer the current latest).
- **Version list**: Two `VersionedSection` records (`API_SECTION`, `RELEASE_NOTES_SECTION`) in `src/lib/versions.ts`, refreshed by `scripts/update-versions-list.ts` from disk. Each carries both `latest` (precise patch, e.g. `v0.18.3`) and `latestSeries` (e.g. `v0.18.x`). The selector labels and URLs use the series form; the precise patch only surfaces in titles / description ranges.
- **Sidebar tree**: Single `customTree` in `src/lib/custom-tree.ts`. The `API` and `Release notes` entries are flat single-page links pointing at the shim; the version selector beside the page title (only on `/reference/api*` and `/reference/release-notes*`) handles series switching via full-page reload.

SDK release docs are generated **locally** as part of the release prep, not by a CI workflow. The `qv-sdk-changelog` skill (Step 8) runs the `release-version.ts` dispatcher in the same working tree as the changelog, so both land in a single release PR. The dispatcher reads the version, picks minor (generate incoming versioned files → rewrite both shims → rotate `_redirects` alias block) for `X.Y.0` and patch (insert `## vX.Y.Z` section into the versioned page — API summary untouched) for `X.Y.Z` with `Z >= 1`, and forwards to the focused orchestrator.

### Minor vs patch release behavior

| Trigger | API summary | Release notes | Shim + redirects | Versions list |
|---|---|---|---|---|
| `release-sdk-X.Y.0` (minor) | Re-run TypeDoc → new `v<X.Y>.x.mdx`. Outgoing series' MDX is not touched. | Full render of the new minor's `## vX.Y.0` block (per-package verbatim `CHANGELOG_LLM.md` under `### @qvac/<pkg>`) into `v<X.Y>.x.mdx`. Outgoing series' MDX is not touched. | Both shims rewritten to `<include>` the new series file with fresh title / description. Managed `latest-series alias` block in `public/_redirects` swapped from outgoing to incoming series. | `latest = X.Y.0`, `latestSeries = vX.Y.x`. |
| `release-sdk-X.Y.Z` matching current latest minor (`patch-latest`) | **Not touched.** Patches by definition don't change public API. | Insert `## v<X.Y.Z>` section directly after the existing `## v<X.Y>.0` block in `v<X.Y>.x.mdx`. Re-runs are idempotent (the section is replaced in place). Description range bumps to include the new patch. | Release-notes shim's `description:` line mirrored from the versioned page's new range. API shim is not touched (its description is static). Redirect block unchanged. | `latest = X.Y.Z` (selector label unchanged — still `vX.Y.x (latest)`). |
| `release-sdk-X.Y.Z` for an archived minor (`patch-archived`) | **Not touched.** | Insert the same section into the existing `v<X.Y>.x.mdx` page. No rename. | Not touched (the archived series is not the shim's target). | `latest` unchanged (script omits `--latest`). |

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

A thin dispatcher (`release-version.ts`) auto-detects minor vs patch from the version's patch number and forwards to one of two focused modules:

**`release-version-minor.ts`** — for `X.Y.0` releases.

1. Reads the current `latest` from `src/lib/versions.ts` (the outgoing version, only used for logging / sanity checks — the outgoing series' MDX is never touched).
2. Calls `scripts/generate-api-docs.ts <new>` — runs TypeDoc + render and writes the new `reference/api/v<X.Y>.x.mdx`.
3. Calls `scripts/generate-release-notes.ts <new>` — reads per-package `CHANGELOG_LLM.md` verbatim and writes the new `reference/release-notes/v<X.Y>.x.mdx`.
4. Rewrites `reference/api/index.mdx` — the shim now `<include>`s `v<newMajor>.<newMinor>.x.mdx` and advertises the new `(latest)` label in its frontmatter.
5. Rewrites `reference/release-notes/index.mdx` — same for release notes.
6. Rewrites the managed `latest-series alias` block in `public/_redirects` so the incoming series' versioned URL 301s to the canonical bare path (the outgoing series' block is replaced in place).
7. Calls `scripts/update-versions-list.ts --latest=<new>` — refreshes `versions.ts` so the dropdown marks the new series as `(latest)` and keeps every other on-disk series listed.

**`release-version-patch.ts`** — for `X.Y.Z` releases with `Z >= 1`. Inspects `src/lib/versions.ts` to choose between `patch-latest` (write to the current latest's `v<X.Y>.x.mdx`, then mirror its updated `description:` onto the release-notes shim) and `patch-archived` (write to the existing archived `v<X.Y>.x.mdx`; no shim touch). The script never invokes the API summary generator (patches don't change public API) and never touches `public/_redirects` (patch releases don't rotate latest).

All three modules are pure file mutations — they never `git commit` or `gh pr create`. The wrapping GitHub workflow opens the PR.

---

## Branch Strategy and Deployment

### Branch Strategy

```
main = staging              docs-production = production
──────────────              ────────────────────────────

New commit on main          Manual workflow: fast-forward
      │                     docs-production to main (ff-only)
      ▼                              │
Hosting provider builds              ▼
& deploys to staging        Hosting provider builds
                            & deploys to production
```

- **`main`** is the staging environment. The hosting provider watches this branch; any new commit triggers a build and deploy to the staging site.
- **`docs-production`** is the production environment. The hosting provider watches this branch; any new commit triggers a build and deploy to the production site.
- `docs-production` is **not a development branch**: it is a delayed production pointer that only ever advances to a commit that already exists on `main`. It receives commits **only** through the manual promotion workflow (never a PR, squash-merge, cherry-pick, or direct push).

With `main` + `docs-production`, production is always a fast-forward of a reviewed, already-on-`main` state — so the two branches never diverge historically and staging is always what production will become.

### Staging (automatic)

```
SDK release prep: qv-sdk-changelog skill (Step 8) generates docs locally
    │
    ▼
Generated docs committed in the SDK release PR (alongside the changelog)
    │
    ▼
Release PR (and its backmerge) merges to main
    │
    ▼
Hosting provider detects new commit on main and rebuilds staging
```

Generated docs ship inside the reviewable SDK release PR rather than via a
separate auto-opened docs PR — so the API reference and release notes are
reviewed together with the changelog that produced them. Any other push to
`main` (docs content changes, merged PRs from contributors) still triggers the
hosting provider's build the same way.

### Production (manual promotion)

```
Staging is verified and ready at a known commit
    │
    ▼
Manually run the "Promote docs to production" workflow (workflow_dispatch),
passing that commit as the `commit` input
    │
    ▼
Preflight job (ungated) validates the commit and publishes the
commit list to the run summary
    │  (fails here if the commit is not on main, or the ff is not possible)
    ▼
Promote job pauses for docs-production environment approval
    │  (required reviewer: qvac-internal-release)
    ▼
Workflow fast-forwards docs-production to the commit (--ff-only)
    │
    ▼
Push to docs-production (as the GitHub App — ruleset bypass identity)
    │
    ▼
Hosting provider detects new commit on docs-production
    │
    ▼
Hosting provider builds the static site and deploys to production
```

Production is promoted by manually running the **Promote docs to
production** workflow (`.github/workflows/promote-docs-production.yml`),
never by merging a PR into `docs-production`. The workflow advances
`docs-production` to the commit given in the required `commit` input,
using **fast-forward-only** semantics: if the branches have diverged it
fails instead of creating a merge commit, so `docs-production` stays a
pure pointer into `main`'s history. A `docs-production` environment
required-reviewer gate pauses the job until a `qvac-internal-release`
member approves.

The target is an explicit input rather than "whatever `main` points at"
because the approval gate introduces an unbounded delay between dispatch
and push. Resolving `main` after the approval would promote commits that
landed while the run waited — commits nobody verified on staging. Naming
the commit pins the promotion to the state the operator actually
inspected, and makes the run self-documenting: the target appears in the
run title, so the approver sees what they are approving.

The validation runs in a separate ungated `preflight` job for the same
reason. An environment gate pauses a job before any of its steps run, so
a single-job workflow can only discover a bad input *after* someone has
been asked to approve it. Splitting the work means every rejectable
condition fails while the run is still unattended, and the reviewer is
only ever paged for a promotion that is known to be valid. Preflight also
writes the resolved SHA and the exact list of commits being promoted to
the run summary, which is what the reviewer reads before approving.

The person promoting is responsible for confirming staging is healthy and
that the docs PR Checks have passed on `main` before running the workflow.
Promotion is fully manual on purpose — the workflow never runs
automatically on a merge to `main`, and the timing (e.g. waiting for the
Head of QVAC to publish the SDK package) is a human decision.

> **Why fast-forward-only?** If `docs-production` ever received squash
> merges, cherry-picks, or direct commits, Git would create commits that
> don't exist on `main`, making the branch historically divergent even
> when the file contents match. Once that happens, future promotions can
> no longer fast-forward and require manual repair. Keeping promotion
> `--ff-only` guarantees `docs-production` is always a commit already
> reviewed and present on `main`.

---

## CI Workflows

Three GitHub Actions workflows touch the docs: one validates docs PRs, one manually promotes `main` to `docs-production`, and one probes the deployed production site on a daily schedule. SDK release docs are generated locally by a Cursor skill (no release workflow). None of these workflows build or deploy the site — the hosting provider does that on branch pushes.

### 1. Docs Website PR Checks

**File:** `.github/workflows/docs-website-pr-checks.yml`

**Triggers:** Pull requests to `main` that change `docs/website/**`, or manual dispatch.

**What it does:**
- Installs dependencies with Bun
- Runs `bun run build` to validate the site compiles
- Runs Vitest tests (sidebar consistency, link integrity, single-page rendering, changelog parser) excluding TSDoc completeness tests that require SDK source
- Optionally installs the SDK and runs the TSDoc completeness audit in warning mode

**Purpose:** Catches build errors and broken links in docs PRs before merge.

The API summary `index.mdx` lives at `content/docs/reference/api/` and is committed to the repo (refreshed locally by the `qv-sdk-changelog` skill Step 8 during SDK release prep), so PR checkouts always have it on disk — no placeholder step is needed.

### 2. Promote docs to production (manual)

**File:** `.github/workflows/promote-docs-production.yml`

**Triggers:** Manual `workflow_dispatch` only. It never runs automatically on a merge to `main`.

**Inputs:**

| Input | Required | Description |
|---|---|---|
| `commit` | Yes | The commit to promote. Any revision already merged to `main` (a full SHA is recommended; the resolved SHA is echoed in the log). |

**What it does:**
- Pauses for approval on the `docs-production` environment (`qvac-internal-release` required reviewers)
- Mints a short-lived **GitHub App token** (`actions/create-github-app-token`) and checks out `docs-production` (full history) with it — the App is the only bypass identity on the `docs-production` ruleset (the default `GITHUB_TOKEN` / GitHub Actions integration cannot be a ruleset bypass actor)
- Fetches `origin/main` and runs `git merge --ff-only origin/main`
- Pushes the fast-forwarded `docs-production`, which the hosting provider picks up to deploy production

Divergence must be repaired deliberately, not resolved by an automatic merge commit. The workflow never opens a PR and never creates a new commit on `docs-production`. Promoting the commit `docs-production` already points at is a no-op that exits cleanly.

**Purpose:** Give the docs owner a single, deliberate button to promote the reviewed `main` state to production once the SDK package is (about to be) published, without ever letting `docs-production` drift from `main`'s history.

> `docs-production` is branch-protected (Restrict updates, Restrict deletions, Block force pushes, no PR merges). The promotion workflow — running as the GitHub App after environment approval — is the only identity allowed to advance it.

### 3. SDK release docs (local, skill-driven)

**Where:** the `qv-sdk-changelog` Cursor skill, Step 8 (`.cursor/skills/qv-sdk-changelog/SKILL.md`). There is no GitHub Actions docs-release workflow — generation runs locally during release prep and ships in the SDK release PR alongside the changelog.

**When:** while preparing an `@qvac/sdk` release (after the changelog / `CHANGELOG_LLM.md` is generated). Skipped for non-`sdk` packages.

**What it does:**
1. Runs `release-version.ts <version> --force-extract` from `docs/website`, which dispatches:
   - **Minor (`X.Y.0`)** — full flow: generates the new API summary into `content/docs/reference/api/v<X.Y>.x.mdx` (TypeDoc + render — output is deterministic by construction), generates the new release notes into `content/docs/reference/release-notes/v<X.Y>.x.mdx` (per-package verbatim `CHANGELOG_LLM.md` under a single `## v<X.Y.0>` block), rewrites both `index.mdx` shims to `<include>` the new series file, rotates the managed alias block in `public/_redirects`, and refreshes `src/lib/versions.ts`. The outgoing series' MDX is never touched.
   - **Patch (`X.Y.Z`, `Z >= 1`)** — `release-version-patch.ts` inspects `src/lib/versions.ts` and picks `patch-latest` (incoming `X.Y` == latest `X.Y`: insert `## v<X.Y.Z>` directly after the existing `## v<X.Y>.0` block of `v<X.Y>.x.mdx`, then mirror the freshly-computed description onto the release-notes shim) or `patch-archived` (older minor: insert the same section into the existing archived `v<X.Y>.x.mdx`, no shim touch, no rename). The API summary page is never touched by patches.
2. Runs `npm run build` from `docs/website` to verify the site still compiles (fail-stop on error).
3. Only the generated surfaces are committed — `content/docs/reference/api/**`, `content/docs/reference/release-notes/**`, `src/lib/versions.ts`, and (on minor rotations) `public/_redirects`. The skill only generates files (it never runs `git add`); review `git status` and commit these, while all build/generation byproducts (`api-data.json`, `.next/`, `.source/`, `out/`, `dist/`) are gitignored so they never show up.

The dual-checkout race window the old CI workflow guarded against does not apply locally: the skill runs in the single release working tree after the changelog is generated, so the SDK source and CHANGELOGs are already the released state.

Once the SDK release PR (and its backmerge) lands on `main`, the hosting provider's `main` build picks it up and deploys to staging.

Patches never re-run TypeDoc — they touch only the frontmatter title of the API summary and append a section to the release notes — so `api-data.json` only changes on minor releases.

### 4. Production health check (scheduled)

**File:** `.github/workflows/docs-website-health-check.yml`

**Triggers:** Daily `schedule` (`30 2 * * *`, i.e. 02:30 UTC / 08:00 IST), manual `workflow_dispatch`, and `pull_request` (only when the workflow, script, or its test change — runs the unit tests, never the production probe).

**What it does:**
- **`probe-production`** runs `.github/scripts/docs-website-health-check.mjs` against `https://docs.qvac.tether.io`. The script assembles the set of URLs a reader or crawler should reach — every `<loc>` in the live `sitemap.xml`, each page's `.md` sibling, every literal `301` source in `public/_redirects` (pulled from the `docs-production` branch so it matches what the CDN serves), and `llms.txt` / `llms-full.txt` — then GETs each one (following redirects) with bounded concurrency. Any `404`, other `>= 400`, or network error fails the job.
- **`notify-on-failure`** runs only on the scheduled trigger and, on failure, opens (or comments on) a tracking issue labelled `docs-health`.

**What it deliberately does NOT do:** the list of broken URLs is written to the run's step summary and job log only — never to the issue body and never to Slack. A Slack webhook stored in this public repo is a credential-leak risk (a leaked webhook lets anyone post malicious links into the workspace), so the notification carries only a link back to the run. Consult the failed run to see which URLs broke.

**Purpose:** Catch broken pages on the deployed production site (e.g. a page removed or renamed without a matching redirect) shortly after they appear, rather than waiting for a user report.

> The collector/probe logic is pure and unit-tested (`.github/scripts/test/docs-website-health-check.test.mjs`); run `node --test .github/scripts/test/docs-website-health-check.test.mjs` locally. To probe manually, run `node .github/scripts/docs-website-health-check.mjs --redirects-file docs/website/public/_redirects` from the repo root.

---

## Script Reference

All scripts live in `docs/website/scripts/` and are designed to run with Bun.

| Script | npm alias | Description |
|---|---|---|
| `release-version.ts` | `docs:release-version` | Unified release dispatcher: parses the version and forwards to the minor or patch orchestrator. Called by the `qv-sdk-changelog` skill (Step 8) during release prep. |
| `release-version-minor.ts` | -- | Minor (X.Y.0) orchestrator: generate incoming `v<X.Y>.x.mdx` for API + release notes → rewrite both `index.mdx` shims → rotate the managed alias block in `public/_redirects` → refresh `versions.ts`. Importable from `release-version.ts`. |
| `release-version-patch.ts` | -- | Patch (X.Y.Z, Z>=1) orchestrator: insert `## v<X.Y.Z>` after the existing minor block on the appropriate series page. Also mirrors the versioned page's updated description onto the release-notes shim in `patch-latest` mode. Never touches the API summary. Importable from `release-version.ts`. |
| `generate-api-docs.ts` | `docs:generate-api` | Renders one minor series' API summary MDX at `v<X.Y>.x.mdx`. `--title-only` rewrites only the frontmatter title; `--target=<file>` overrides the output filename. Never writes to `index.mdx` (the shim is managed by `release-version-minor.ts`). |
| `api-docs/extract.ts` | -- | Phase 1: TypeDoc analysis, writes `api-data.json` |
| `api-docs/render.ts` | -- | Phase 2: Nunjucks rendering of `single-page.njk` from `api-data.json` |
| `api-docs/audit-tsdoc.ts` | `docs:audit-tsdoc` | TSDoc completeness audit (standalone or via extraction) |
| `generate-release-notes.ts` | `docs:generate-release-notes` | Generates / augments the release-notes series MDX at `v<X.Y>.x.mdx`. Default mode renders the page from scratch with a `## v<X.Y.0>` block; `--append-patch` inserts a `## v<X.Y.Z>` block directly after the minor; `--title-only` relabels the frontmatter title only. Never writes to `index.mdx`. |
| `update-versions-list.ts` | `docs:update-versions` | Rebuilds `src/lib/versions.ts` from `reference/api/v*.x.mdx` and `reference/release-notes/v*.x.mdx` siblings on disk. `--latest=X.Y.Z` records the precise patch in `latest` (the selector still labels series-only). |
| `run-docs-generate.ts` | `docs:generate` | Convenience: regenerates the current-latest series file + refreshes `versions.ts` using the monorepo SDK's `package.json` version (no version bump, no shim / redirects touch) |
| `lib/release-shared.ts` | -- | Shared helpers for the release orchestrators — version parsing, `versions.ts` reader, series-sibling resolver, series-name helpers, and the shim / redirects writers (`writeShim`, `writeLatestSeriesAliasRedirects`, `rewriteFrontmatterDescriptionLine`, `readFrontmatterField`). |
| `lib/changelog-parser.ts` | -- | Changelog parsing — `readChangelogLLMVerbatim` for the verbatim per-package render plus legacy `parseChangelog` / `parseChangelogFolder` / `mergeChangelogs` exports kept for unit-test fixtures and ad-hoc tooling |
| `lib/link-validator.ts` | -- | Internal link extraction + resolution (used by the link-integrity test) |

> AI-assisted authoring (drafting descriptions or examples) happens
> locally via Cursor skills — never inside this pipeline. Output of
> every script in this table is deterministic.
>
> For fully reproducible `api-data.json` set `SOURCE_DATE_EPOCH` to a
> fixed Unix timestamp (reproducible-builds convention). Without it,
> `ApiData.generatedAt` is the literal string `"unspecified"` so
> byte-identity checks still pass.

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

**Fix:** Run `docs:generate-api -- <version>` (writes `v<X.Y>.x.mdx`), then `docs:update-versions`. For a full release flow use `docs:release-version -- <version>` (auto-detects minor vs patch) instead.

### Build fails in CI (PR checks)

The committed `content/docs/reference/api/index.mdx` shim is what `next build` reads at the canonical URL — it `<include>`s the current series' `v<X.Y>.x.mdx`, both of which must exist. If the build still fails:

1. Check that `source.config.ts` and `next.config.mjs` are valid
2. Confirm the shim's `<include>` target file exists on disk
3. Run `bun run build` locally to reproduce
4. Look for broken MDX frontmatter or invalid imports in `content/`

### Recover a broken shim after a bad release

If a release ran but produced a broken `reference/api/index.mdx` or `reference/release-notes/index.mdx`, restore it by re-running the orchestrator against the previous version:

```bash
# Auto-detects minor (regen + shim rewrite + redirects rotate)
# vs patch (append section + shim description mirror).
bun run scripts/release-version.ts <previous-X.Y.Z> --force-extract
```

Then revert the bad commit / branch state via `git`. There is no automatic backup directory — versioning is the safety net (every previous series exists as a sibling `v<X.Y>.x.mdx`, untouched by the failed release).

### Generated MDX contains "undefined" or "[object Object]"

**Cause:** A function's JSDoc is missing or malformed.

**Fix:**
- The generator replaces literal `undefined` strings with `—` as a safety net
- Validation will throw if descriptions contain `undefined` or `[object Object]`
- Add proper JSDoc to the offending function in the SDK source and regenerate
