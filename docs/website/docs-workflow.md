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
  - [Where generated pages land](#where-generated-pages-land)
  - [Cutting a documentation line](#cutting-a-documentation-line)
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
| Manual content (guides, tutorials, addons) | one collection folder per top level: `content/docs/ecosystem/`, `content/docs/sdk/`, `content/docs/cli/`, `content/docs/resources/` | Yes |
| SDK API summary (generated) | `content/docs/sdk/<current line>/reference/api.mdx` | Yes (committed once per minor release) |
| SDK release notes (generated) | `content/docs/sdk/<current line>/reference/release-notes.mdx` | Yes (committed on every minor and patch release) |

The SDK API summary and release notes are **generated from TypeScript source / package CHANGELOGs** via [TypeDoc](https://typedoc.org/) and Nunjucks. Each is one MDX page inside the SDK's current documentation line, the folder `src/lib/versions.ts` declares as current. A line that has shipped is never regenerated, so there is one target and no way to name another. Generation is triggered by the release pipeline; locally a maintainer can regenerate to preview.

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
Phase 2: Nunjucks rendering  ──►  content/docs/sdk/<current line>/reference/api.mdx
```

Release notes are one page in the current line too — it accumulates patch
sections as `## vX.Y.Z`
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

```bash
bun run scripts/generate-api-docs.ts <version> [flags]
```

This will:

1. Run TypeDoc against the SDK entry point (`SDK_PATH/index.ts`) and write `api-data.json`
2. Render a single MDX via the Nunjucks `single-page.njk` template into
   `content/docs/sdk/<current line>/reference/api.mdx`, the line
   `src/lib/versions.ts` declares as current
3. Run a smoke test that checks for `## Functions` and `## Errors` headings

`--title-only` short-circuits this: it skips TypeDoc + render and only
rewrites the `title:` line of the existing page, then runs the
same smoke test.

**Flags:**

| Flag | Description |
|---|---|
| `--title-only` | Rewrite the frontmatter title in-place (skips TypeDoc + render). |
| `--force-extract` | Bypass the mtime cache and re-run TypeDoc extraction. |

There is no flag naming the target. The destination is the SDK's current line,
read from the manifest, and a version that is not that line's is refused before
anything is written — see [Where generated pages land](#where-generated-pages-land).

Release notes work the same way:

```bash
bun run scripts/generate-release-notes.ts <version> [--append-patch]
```

`--append-patch` inserts a `## vX.Y.Z` section into the line's existing page
instead of rendering it from scratch. Re-running the same patch is idempotent.

### Where generated pages land

Both generators write into the SDK's **current documentation line** — the
folder `src/lib/versions.ts` declares as current — and neither takes a target.
A line that has shipped is what the site already serves and is never
regenerated.

Because the destination is read rather than passed, it has to be checked. A
version that is not the current line's is refused, before the first write:

```
Refusing to write v0.21 pages into v0.20, the current line of /sdk.
  v0.21 has no line yet. Cut it before documenting the release:
    bun run scripts/cut-line.ts sdk v0.21
```

Without that refusal, documenting a release before its line is cut would
overwrite the previous line's own release notes, and the resulting tree would
still build and still pass the suite.

### Cutting a documentation line

A cut is what makes the next line current. It happens immediately after a
release deploys — not when the next one is being prepared — so new material has
a folder to land in and the release that just shipped is preserved as it stood.

```bash
bun run scripts/cut-line.ts <collection> <version>

bun run scripts/cut-line.ts sdk v0.21
```

It renames the outgoing folder group to its plain form, copies it to the new
group, updates the manifest, adds the preserved line's index pair to
`public/_redirects`, and moves the currency marker from the preserved line's
titles to the opened one's. It refuses a collection that is not versioned, a
version that is not above the current line, a destination already on disk, and
a working tree that already carries changes.

It is a convenience, never a dependency. The same cut made by hand is the same
cut — the procedure is in [`README.md`](README.md) — and the build is what
accepts either. The command does not build; run `npm run build` and `npm test`
yourself and review the diff.

`src/lib/versions.ts` is hand-edited. It declares every documented software,
the package it is, where it is documented, and the versions published for it.
Publishing a version is two edits in one diff — the folder under
`content/docs/`, and the entry in that file — and
`tests/line-structure.test.ts` fails the build when the two disagree, naming
the version at fault. `scripts/update-versions-list.ts`, which used to
regenerate the file from disk, is retired and refuses to run.

### Full Generation (Orchestrated)

When running inside the monorepo, use the orchestrator script that reads the SDK version from `packages/sdk/package.json` automatically:

```bash
bun run docs:generate
```

This runs `generate-api-docs.ts` — useful for previewing a regen against the current SDK. It no longer refreshes the version list, which is hand-edited.

---

## Versioning

Versioning is a property of a collection. A **versioned collection** — the SDK,
the CLI — publishes one **documentation line** per minor release: one folder
directly under the collection, holding a complete page tree for that release.
The unversioned collections, Ecosystem and Resources, publish one copy of
everything.

The current line's folder is written in parentheses. Fumadocs reads that as a
group and excludes it from the slug, so the current line answers the
version-less paths; every other line's folder is plain, so its pages carry the
version:

```
content/docs/
├── ecosystem/                  -> not versioned
├── resources/                  -> not versioned
├── sdk/
│   ├── (v0.20)/                -> current line, serves /sdk/…
│   │   ├── quickstart.mdx      ->            /sdk/quickstart
│   │   └── reference/
│   │       ├── api.mdx         ->            /sdk/reference/api          (generated)
│   │       └── release-notes.mdx ->          /sdk/reference/release-notes (generated)
│   ├── v0.19/                  -> preserved, serves /sdk/v0.19/…
│   └── v0.18/
└── cli/
    ├── (v0.14)/
    ├── v0.13/
    └── v0.12/
```

- **Line name**: `vX.Y`. A line represents every patch in its range, so a line
  is never named for a patch.
- **Currency**: stated once, by the parentheses. Nothing else records it, which
  is why a cut is the only thing that changes it.
- **Manifest**: `src/lib/versions.ts`, hand-edited, naming each line and the
  folder holding it. `tests/line-structure.test.ts` fails the build when the
  manifest and the folders disagree.
- **Permanence**: a published line is never removed. It is the only record of
  how that release behaved, and the readers who need it are the ones pinned to
  it.
- **Everything else is derived**: the switcher, the sidebars, the canonical
  URLs, the agent artifacts, `versions.json`, the sitemap, and the retrieval
  metadata are computed at build time from the manifest and the folders.

SDK release docs are generated **locally** as part of the release prep, not by
a CI workflow. The `qv-sdk-changelog` skill (Step 8) runs the two generators in
the same working tree as the changelog, so both land in a single release PR.
The line being released was already cut, so the generators have somewhere to
write; a release that reaches them before the cut is refused.

### Minor vs patch release behavior

| Trigger | API summary | Release notes |
|---|---|---|
| `release-sdk-X.Y.0` (minor) | Re-run TypeDoc and render `api.mdx` into the current line. | Full render of the `## vX.Y.0` block (per-package verbatim `CHANGELOG_LLM.md` under `### @qvac/<pkg>`) into the current line's `release-notes.mdx`. |
| `release-sdk-X.Y.Z`, `Z >= 1` (patch) | **Not touched.** The public API is frozen at the minor boundary, so a patch by definition adds nothing here. | Insert the `## vX.Y.Z` section directly after the existing `## vX.Y.0` block. Description range bumps to include the new patch. |

A patch of an older line is an ordinary edit to that line's page, not a release
flow: the generators only write the current line.

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

### Retired tooling

The patch-series scheme — where a version was a `vX.Y.x.mdx` sibling of the API
summary rather than a folder — had orchestrators that froze the outgoing series
and regenerated the manifest from disk. They are kept on disk for reference and
**refuse to run**, because the manifest is now hand-edited and a cut is a
content change:

- `scripts/release-version.ts` and its `release-version-minor.ts` /
  `release-version-patch.ts` modules
- `scripts/update-versions-list.ts`

Nothing calls them. Running one prints what to do instead. The release path is
the two generators; the cut is `scripts/cut-line.ts` or the hand procedure in
[`README.md`](README.md).

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
Staging is verified and ready
    │
    ▼
Manually run the "Promote docs to production" workflow (workflow_dispatch)
    │
    ▼
Workflow fast-forwards docs-production to origin/main (--ff-only)
    │  (fails if docs-production has diverged from main)
    ▼
Push to docs-production
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
`docs-production` to the current `main` commit using **fast-forward-only**
semantics: if the branches have diverged it fails instead of creating a
merge commit, so `docs-production` stays a pure pointer into `main`'s
history.

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

Two GitHub Actions workflows touch the docs: one validates docs PRs, one manually promotes `main` to `docs-production`. SDK release docs are generated locally by a Cursor skill (no release workflow). Neither workflow builds or deploys the site — the hosting provider does that on branch pushes.

### 1. Docs Website PR Checks

**File:** `.github/workflows/docs-website-pr-checks.yml`

**Triggers:** Pull requests to `main` that change `docs/website/**`, or manual dispatch.

**What it does:**
- Installs dependencies with Bun
- Runs `bun run build` to validate the site compiles
- Runs Vitest tests (sidebar consistency, link integrity, single-page rendering, changelog parser) excluding TSDoc completeness tests that require SDK source
- Optionally installs the SDK and runs the TSDoc completeness audit in warning mode

**Purpose:** Catches build errors and broken links in docs PRs before merge.

The API summary page lives in the SDK's current line, at `content/docs/sdk/<current line>/reference/api.mdx`, and is committed to the repo (refreshed locally by the `qv-sdk-changelog` skill Step 8 during SDK release prep), so PR checkouts always have it on disk — no placeholder step is needed.

### 2. Promote docs to production (manual)

**File:** `.github/workflows/promote-docs-production.yml`

**Triggers:** Manual `workflow_dispatch` only. It never runs automatically on a merge to `main`.

**What it does:**
- Checks out `docs-production` (full history) using `PAT_TOKEN` (the default `GITHUB_TOKEN` cannot push to the protected `docs-production` branch)
- Fetches `origin/main` and runs `git merge --ff-only origin/main`
- Pushes the fast-forwarded `docs-production`, which the hosting provider picks up to deploy production

**Fails when:** `docs-production` has diverged from `main` (the `--ff-only` merge is rejected). This is intentional — divergence must be repaired deliberately, not resolved by an automatic merge commit. The workflow never opens a PR and never creates a new commit on `docs-production`.

**Purpose:** Give the docs owner a single, deliberate button to promote the reviewed `main` state to production once the SDK package is (about to be) published, without ever letting `docs-production` drift from `main`'s history.

> `docs-production` should stay branch-protected (no direct pushes, no PR merges); the promotion workflow's `PAT_TOKEN` account is the only identity allowed to push to it.

### 3. SDK release docs (local, skill-driven)

**Where:** the `qv-sdk-changelog` Cursor skill, Step 8 (`.cursor/skills/qv-sdk-changelog/SKILL.md`). There is no GitHub Actions docs-release workflow — generation runs locally during release prep and ships in the SDK release PR alongside the changelog.

**When:** while preparing an `@qvac/sdk` release (after the changelog / `CHANGELOG_LLM.md` is generated). Skipped for non-`sdk` packages.

**Precondition:** the line for the version being released is already cut. The
cut happens right after the *previous* release deploys, so by release prep the
folder exists. Reaching the generators before that is refused, naming the cut
that is missing.

**What it does:**
1. Runs the generators from `docs/website`, against the current line:
   - **Minor (`X.Y.0`)** — `generate-api-docs.ts <version> --force-extract`
     (TypeDoc + render, deterministic by construction) and
     `generate-release-notes.ts <version>` (per-package verbatim
     `CHANGELOG_LLM.md` under a single `## v<X.Y.0>` block).
   - **Patch (`X.Y.Z`, `Z >= 1`)** — `generate-release-notes.ts <version> --append-patch`,
     inserting `## v<X.Y.Z>` directly after the existing `## v<X.Y>.0` block.
     The API summary is never touched by a patch.
2. Runs `npm run build` from `docs/website` to verify the site still compiles (fail-stop on error).
3. Only the generated surfaces are committed — `content/docs/sdk/<current line>/reference/api.mdx` and `content/docs/sdk/<current line>/reference/release-notes.mdx`. Never `src/lib/versions.ts` or `public/_redirects`: both belong to the cut. The skill only generates files (it never runs `git add`); review `git status` and commit these, while all build/generation byproducts (`api-data.json`, `.next/`, `.source/`, `out/`, `dist/`) are gitignored so they never show up.

The dual-checkout race window the old CI workflow guarded against does not apply locally: the skill runs in the single release working tree after the changelog is generated, so the SDK source and CHANGELOGs are already the released state.

Once the SDK release PR (and its backmerge) lands on `main`, the hosting provider's `main` build picks it up and deploys to staging.

Patches never re-run TypeDoc — they touch only the frontmatter title of the API summary and append a section to the release notes — so `api-data.json` only changes on minor releases.

---

## Script Reference

All scripts live in `docs/website/scripts/` and are designed to run with Bun.

| Script | npm alias | Description |
|---|---|---|
| `release-version.ts` | -- | **Retired**, kept for reference. Was the release dispatcher forwarding to the minor or patch orchestrator. |
| `release-version-minor.ts` | -- | **Retired**, kept for reference. Was the minor (X.Y.0) orchestrator: freeze outgoing series → generate new latest → refresh `versions.ts`. |
| `release-version-patch.ts` | -- | **Retired**, kept for reference. Was the patch (X.Y.Z, Z>=1) orchestrator, inserting `## v<X.Y.Z>` after the existing minor block. |
| `generate-api-docs.ts` | `docs:generate-api` | Renders the API summary page of the SDK's current line. `--title-only` rewrites only the frontmatter title. |
| `api-docs/extract.ts` | -- | Phase 1: TypeDoc analysis, writes `api-data.json` |
| `api-docs/render.ts` | -- | Phase 2: Nunjucks rendering of `single-page.njk` from `api-data.json` |
| `api-docs/audit-tsdoc.ts` | `docs:audit-tsdoc` | TSDoc completeness audit (standalone or via extraction) |
| `generate-release-notes.ts` | `docs:generate-release-notes` | Generates / augments the release-notes page of the SDK's current line. Default mode renders the page from scratch with a `## v<X.Y.0>` block; `--append-patch` inserts a `## v<X.Y.Z>` block directly after the minor; `--title-only` relabels the frontmatter title only. |
| `cut-line.ts` | -- | Cuts a versioned collection's next documentation line: preserves the outgoing one, opens the new one as a copy, and updates the manifest, the redirects, and the currency marker. A convenience for the hand procedure in `README.md`, never a dependency. |
| `update-versions-list.ts` | -- | **Retired**, kept for reference. Rebuilt `src/lib/versions.ts` from the series siblings on disk; that file is now hand-edited. |
| `run-docs-generate.ts` | `docs:generate` | Convenience: regenerates the current line's API summary using the monorepo SDK's `package.json` version (no version bump) |
| `create-version-bundle.ts` | -- | **Retired**, kept for reference. Copied the current `index.mdx` of each versioned section to `v<X.Y>.x.mdx`. |
| `lib/release-shared.ts` | -- | Shared helpers for the generators: version parsing, the manifest reader, and `referenceDirFor` / `apiPageFor` / `releaseNotesPageFor`, which resolve the current line's reference folder and refuse a version that is not its own |
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

**Cause:** a version is recorded but its MDX file doesn't exist on disk. Only reachable through the retired release tooling; the equivalent failure today is `tests/line-structure.test.ts` reporting a declared version whose folder is missing.

**Fix:** For a version declared in `src/lib/versions.ts`, create the folder the entry names, or drop the entry. The two must agree.

### Refusing to write vX.Y pages into vA.B

```
Refusing to write v0.21 pages into v0.20, the current line of /sdk.
```

**Cause:** the generators write into the current line and only accept a version that belongs to it.

**Fix:** if the version is ahead, its line has not been cut — `bun run scripts/cut-line.ts sdk v<X.Y>`, or the hand procedure in [`README.md`](README.md). If the version is behind, it has already shipped and its line is what the site serves; edit that line's page directly instead of regenerating it.

### Build fails in CI (PR checks)

The committed `content/docs/sdk/<current line>/reference/api.mdx` is what `next build` reads. If the build still fails:

1. Check that `source.config.ts` and `next.config.mjs` are valid
2. Run `bun run build` locally to reproduce
3. Look for broken MDX frontmatter or invalid imports in `content/`

### Recover a broken reference page after a bad release

If a release ran but produced a broken `reference/api.mdx` or `reference/release-notes.mdx`, re-render the page from the current line's own version:

```bash
bun run scripts/generate-api-docs.ts <current-line-X.Y.Z> --force-extract
bun run scripts/generate-release-notes.ts <current-line-X.Y.Z>
```

Then revert the bad commit / branch state via `git`. There is no automatic backup directory — versioning is the safety net (every previous version exists as a sibling `vX.Y.Z.mdx`).

### Generated MDX contains "undefined" or "[object Object]"

**Cause:** A function's JSDoc is missing or malformed.

**Fix:**
- The generator replaces literal `undefined` strings with `—` as a safety net
- Validation will throw if descriptions contain `undefined` or `[object Object]`
- Add proper JSDoc to the offending function in the SDK source and regenerate
