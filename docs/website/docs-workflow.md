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
  - [SDK release docs (local, skill-driven)](#2-sdk-release-docs-local-skill-driven)
- [Script Reference](#script-reference)
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
bun run scripts/generate-api-docs.ts 0.11.0 --latest

# Render an older minor series into content/docs/reference/api/v0.10.x.mdx (no --latest)
bun run scripts/generate-api-docs.ts 0.10.0

# Bump only the frontmatter title (called by the minor freeze flow):
# no TypeDoc, no render
bun run scripts/generate-api-docs.ts 0.10.0 --target=v0.10.x.mdx --title-only
```

This will:
1. Run TypeDoc against the SDK entry point (`SDK_PATH/index.ts`) and write `api-data.json`
2. Render a single MDX via the Nunjucks `single-page.njk` template:
   - `--latest` → `content/docs/reference/api/index.mdx`
   - `--target=<file>` → `content/docs/reference/api/<file>` (explicit override)
   - otherwise → `content/docs/reference/api/v<X.Y>.x.mdx` (series-named)
3. Run a smoke test that checks for `## Functions` and `## Errors` headings

`--title-only` short-circuits this: it skips TypeDoc + render and only
rewrites the `title:` line of the existing target MDX, then runs the
same smoke test.

**Flags:**

| Flag | Description |
|---|---|
| `--latest` | Write to `index.mdx` instead of `v<X.Y>.x.mdx`. |
| `--target=<file>` | Override the output filename inside `api/` (mutually exclusive with `--latest`). |
| `--title-only` | Rewrite the frontmatter title in-place (skips TypeDoc + render). Used by the minor-release freeze step to relabel the outgoing snapshot. |
| `--force-extract` | Bypass the mtime cache and re-run TypeDoc extraction. |

**2. Release a new version end-to-end (freeze outgoing, generate incoming, refresh dropdown):**

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

SDK release docs are generated **locally** as part of the release prep, not by a CI workflow. The `qv-sdk-changelog` skill (Step 8) runs the `release-version.ts` dispatcher in the same working tree as the changelog, so both land in a single release PR. The dispatcher reads the version, picks minor (freeze outgoing → regenerate) for `X.Y.0` and patch (insert `## vX.Y.Z` section under the minor block — API summary untouched) for `X.Y.Z` with `Z >= 1`, and forwards to the focused orchestrator.

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

A thin dispatcher (`release-version.ts`) auto-detects minor vs patch from the version's patch number and forwards to one of two focused modules:

**`release-version-minor.ts`** — for `X.Y.0` releases.

1. Reads the current `latest` from `src/lib/versions.ts` (the outgoing version).
2. Calls `scripts/create-version-bundle.ts <outgoing>` — copies `reference/api/index.mdx` to the series sibling `v<outgoingMajor>.<outgoingMinor>.x.mdx` and the same for release notes.
3. Title-only relabel: rewrites the frozen snapshots' titles to drop the `(latest)` marker.
4. Calls `scripts/generate-api-docs.ts <new> --latest` — overwrites `reference/api/index.mdx` with the new minor's content.
5. Calls `scripts/generate-release-notes.ts <new> --latest` — same for release notes, reading per-package CHANGELOG_LLM.md verbatim.
6. Calls `scripts/update-versions-list.ts --latest=<new>` — refreshes `versions.ts` so the dropdown picks up the new latest series plus the frozen older sibling.

**`release-version-patch.ts`** — for `X.Y.Z` releases with `Z >= 1`. Inspects `src/lib/versions.ts` to choose between `patch-latest` (write to `index.mdx`) and `patch-archived` (write to the existing `vX.Y.x.mdx`). The script never invokes the API summary generator.

All three modules are pure file mutations — they never `git commit` or `gh pr create`. The wrapping GitHub workflow opens the PR.

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

With `main` + `docs-production`, every production deploy has a reviewable PR showing exactly what changed.

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

### Production (manual PR)

```
Staging is verified and ready
    │
    ▼
Open PR: main -> docs-production
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

The reviewer is responsible for confirming staging is healthy and that
the docs PR Checks have passed on `main` before merging into
`docs-production`. There is no automated CI gate on the production PR
— promotion is fully manual on purpose.

---

## CI Workflows

One GitHub Actions workflow validates docs PRs; SDK release docs are generated locally by a Cursor skill (no release workflow).

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

### 2. SDK release docs (local, skill-driven)

**Where:** the `qv-sdk-changelog` Cursor skill, Step 8 (`.cursor/skills/qv-sdk-changelog/SKILL.md`). There is no GitHub Actions docs-release workflow — generation runs locally during release prep and ships in the SDK release PR alongside the changelog.

**When:** while preparing an `@qvac/sdk` release (after the changelog / `CHANGELOG_LLM.md` is generated). Skipped for non-`sdk` packages.

**What it does:**
1. Runs `release-version.ts <version> --force-extract` from `docs/website`, which dispatches:
   - **Minor (`X.Y.0`)** — full flow: freezes the outgoing `index.mdx` into a series sibling `v<outgoingMajor>.<outgoingMinor>.x.mdx`, generates the new API summary into `index.mdx` (TypeDoc + render — output is deterministic by construction), generates the new release notes into `index.mdx` (per-package verbatim `CHANGELOG_LLM.md` under a single `## v<X.Y.0>` block), refreshes `src/lib/versions.ts`.
   - **Patch (`X.Y.Z`, `Z >= 1`)** — `release-version-patch.ts` inspects `src/lib/versions.ts` and picks `patch-latest` (incoming `X.Y` == latest `X.Y`: insert `## v<X.Y.Z>` directly after the existing `## v<X.Y>.0` block of `index.mdx`) or `patch-archived` (older minor: insert the same section into the existing `v<X.Y>.x.mdx`, no rename). The API summary page is never touched by patches.
2. Runs `npm run build` from `docs/website` to verify the site still compiles (fail-stop on error).
3. Only the generated surfaces are committed — `content/docs/reference/api/**`, `content/docs/reference/release-notes/**`, and `src/lib/versions.ts`. The skill only generates files (it never runs `git add`); review `git status` and commit these, while all build/generation byproducts (`api-data.json`, `.next/`, `.source/`, `out/`, `dist/`) are gitignored so they never show up.

The dual-checkout race window the old CI workflow guarded against does not apply locally: the skill runs in the single release working tree after the changelog is generated, so the SDK source and CHANGELOGs are already the released state.

Once the SDK release PR (and its backmerge) lands on `main`, the hosting provider's `main` build picks it up and deploys to staging.

Patches never re-run TypeDoc — they touch only the frontmatter title of the API summary and append a section to the release notes — so `api-data.json` only changes on minor releases.

---

## Script Reference

All scripts live in `docs/website/scripts/` and are designed to run with Bun.

| Script | npm alias | Description |
|---|---|---|
| `release-version.ts` | `docs:release-version` | Unified release dispatcher: parses the version and forwards to the minor or patch orchestrator. Called by the `qv-sdk-changelog` skill (Step 8) during release prep. |
| `release-version-minor.ts` | -- | Minor (X.Y.0) orchestrator: freeze outgoing series → generate new latest from per-package `CHANGELOG_LLM.md` → refresh `versions.ts`. Importable from `release-version.ts`. |
| `release-version-patch.ts` | -- | Patch (X.Y.Z, Z>=1) orchestrator: insert `## v<X.Y.Z>` after the existing minor block on the appropriate series page. Never touches the API summary. Importable from `release-version.ts`. |
| `generate-api-docs.ts` | `docs:generate-api` | Renders one minor series' API summary MDX. `--title-only` rewrites only the frontmatter title (called from the minor freeze flow); `--target=<file>` overrides the output filename. |
| `api-docs/extract.ts` | -- | Phase 1: TypeDoc analysis, writes `api-data.json` |
| `api-docs/render.ts` | -- | Phase 2: Nunjucks rendering of `single-page.njk` from `api-data.json` |
| `api-docs/audit-tsdoc.ts` | `docs:audit-tsdoc` | TSDoc completeness audit (standalone or via extraction) |
| `generate-release-notes.ts` | `docs:generate-release-notes` | Generates / augments the release-notes series MDX. Default mode renders the page from scratch with a `## v<X.Y.0>` block; `--append-patch` inserts a `## v<X.Y.Z>` block directly after the minor; `--title-only` relabels the frontmatter title only. |
| `update-versions-list.ts` | `docs:update-versions` | Rebuilds `src/lib/versions.ts` from `reference/api/v*.x.mdx` and `reference/release-notes/v*.x.mdx` siblings on disk. `--latest=X.Y.Z` records the precise patch in `latest` (the selector still labels series-only). |
| `run-docs-generate.ts` | `docs:generate` | Convenience: regenerates the latest summary + refreshes `versions.ts` using the monorepo SDK's `package.json` version (no version bump) |
| `create-version-bundle.ts` | `docs:create-version` | Copies the current `index.mdx` of each versioned section to `v<X.Y>.x.mdx` (called from `release-version-minor.ts`) |
| `lib/release-shared.ts` | -- | Shared helpers for the release orchestrators (version parsing, `versions.ts` reader, series-sibling resolver, series-name helpers) |
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

**Fix:** Run `docs:generate-api -- <version> --latest` (writes `index.mdx`) or `docs:generate-api -- <version>` (writes `vX.Y.Z.mdx`) first, then `docs:update-versions`. For a full release flow use `docs:release-version -- <version>` (auto-detects minor vs patch) instead.

### Build fails in CI (PR checks)

The committed `content/docs/reference/api/index.mdx` is what `next build` reads. If the build still fails:

1. Check that `source.config.ts` and `next.config.mjs` are valid
2. Run `bun run build` locally to reproduce
3. Look for broken MDX frontmatter or invalid imports in `content/`

### Recover a broken `index.mdx` after a bad release

If a release ran but produced a broken `reference/api/index.mdx` or `reference/release-notes/index.mdx`, restore it by re-running the orchestrator against the previous version:

```bash
# Auto-detects minor (full freeze + regen) vs patch (title-only + append).
bun run scripts/release-version.ts <previous-X.Y.Z> --force-extract
```

Then revert the bad commit / branch state via `git`. There is no automatic backup directory — versioning is the safety net (every previous version exists as a sibling `vX.Y.Z.mdx`).

### Generated MDX contains "undefined" or "[object Object]"

**Cause:** A function's JSDoc is missing or malformed.

**Fix:**
- The generator replaces literal `undefined` strings with `—` as a safety net
- Validation will throw if descriptions contain `undefined` or `[object Object]`
- Add proper JSDoc to the offending function in the SDK source and regenerate
