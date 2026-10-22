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
  - [Builder configuration](#builder-configuration)
  - [Staging (automatic)](#staging-automatic)
  - [Production (manual promotion)](#production-manual-promotion)
- [CI Workflows](#ci-workflows)
  - [PR Checks](#1-docs-website-pr-checks)
  - [Promote docs to production (manual)](#2-promote-docs-to-production-manual)
  - [Documentation at the release cutoff (local, skill-driven)](#3-documentation-at-the-release-cutoff-local-skill-driven)
- [Script Reference](#script-reference)
- [Release-Notes Overrides (dormant)](#release-notes-overrides-dormant)
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

The SDK API summary is **generated from TypeScript source** via [TypeDoc](https://typedoc.org/) and Nunjucks. It is one MDX page inside the SDK's current documentation line, the folder `src/lib/versions.ts` declares as current. A line that has shipped is never regenerated, so there is one target and no way to name another. It is generated at the release cutoff; locally a maintainer can regenerate to preview.

**The site publishes no release-notes pages.** Each line's sidebar carries a `Release Notes` entry that links out to that minor's GitHub release, which is where the changelog already lives. The release notes a release authors (`qv-sdk-changelog`) therefore reach readers through GitHub, and a patch release touches `docs/website` not at all.

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

The API summary is the only generated page. Release notes are not rendered
into the site at all: `reference/meta.json` declares the sidebar entry as an
external link to `https://github.com/tetherto/qvac/releases/tag/sdk-v<X.Y>.0`,
so each line points at the GitHub release of its own minor. A cut rewrites that
tag for the line it opens.

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

`scripts/generate-release-notes.ts` is still on disk but has no caller: the
site publishes no release-notes pages. See
[Retired tooling](#retired-tooling).

### Where generated pages land

The generator writes into the SDK's **current documentation line** — the folder
`src/lib/versions.ts` declares as current — and takes no target. A line that has
shipped is what the site already serves and is never regenerated.

Because the destination is read rather than passed, it has to be checked. A
version that is not the current line's is refused, before the first write:

```
Refusing to write v0.21 pages into v0.20, the current line of /sdk.
  v0.21 has no line yet. Cut it before documenting the release:
    bun run scripts/cut-line.ts sdk v0.21
```

Without that refusal, documenting a release before its line is cut would
overwrite the API summary of the version before it, and the resulting tree
would still build and still pass the suite.

### Cutting a documentation line

A cut is what makes the next line current. It happens at the **release
cutoff** — step 6b of [`docs/ci/RELEASE-TRAIN.md`](../ci/RELEASE-TRAIN.md),
on the morning the sprint's versions are declared final and their release
branches are cut, stacked on step 6a — so the next version has a folder from the
first day of its development, and the version entering release is preserved as
it stood.

Cutting at a release's own deploy instead, which is what used to happen, leaves
a whole sprint writing feature documentation into the folder of a version that
already shipped. That is the defect QVAC-27286 fixed.

```bash
bun run scripts/cut-line.ts <collection> <version>

bun run scripts/cut-line.ts sdk v0.21
```

It renames the outgoing folder group to its plain form, copies it to the new
group, updates the manifest, adds the preserved line's rules to
`public/_redirects`, moves the currency marker from the preserved line's titles
to the opened one's, and points the opened line's `Release Notes` sidebar link
at its own minor's GitHub release tag. It refuses a collection that is not
versioned, a version that is not above the current line, a destination already
on disk, and a working tree that already carries changes.

The opened line keeps the API summary it copied, because the PR that
regenerates it is reviewed as a diff: a summary diffed against the previous
line shows only the surface that moved.

The tag the opened line links at does not exist yet — the release it names is
weeks away. That is fine: the link only has to resolve once the version ships,
which is also when readers reach that line.

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
│   │       └── api.mdx         ->            /sdk/reference/api          (generated)
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
  is why a cut is the only thing that changes it. The current line is the
  **version under development**; every plain folder is a version that shipped
  and documents that version alone.
- **Manifest**: `src/lib/versions.ts`, hand-edited, naming each line and the
  folder holding it. `tests/line-structure.test.ts` fails the build when the
  manifest and the folders disagree.
- **Permanence**: a published line is never removed. It is the only record of
  how that release behaved, and the readers who need it are the ones pinned to
  it.
- **Everything else is derived**: the switcher, the sidebars, the canonical
  URLs, the agent artifacts, `versions.json`, the sitemap, and the retrieval
  metadata are computed at build time from the manifest and the folders.

Documentation closes at the **release cutoff**, on `main`, by its own two PRs —
steps 6a and 6b of [`docs/ci/RELEASE-TRAIN.md`](../ci/RELEASE-TRAIN.md). A
release PR and its backmerge carry nothing under `docs/website`, and no CI
workflow generates documentation.

### Minor vs patch release behavior

| Trigger | API summary |
|---|---|
| Minor (`X.Y.0`) | Re-run TypeDoc and render `api.mdx` into the current line, at the cutoff (step 6a). |
| Patch (`X.Y.Z`, `Z >= 1`) | **Not touched.** The public API is frozen at the minor boundary, so a patch by definition adds nothing here. |

A patch release therefore touches `docs/website` not at all. What a patch
changes for readers is in its GitHub release, which the line's sidebar already
links.

A correction to an older line is an ordinary edit to that line's folder, not a
release flow: the generator only ever writes the current line.

### Retired tooling

The patch-series scheme — where a version was a `vX.Y.x.mdx` sibling of the API
summary rather than a folder — had orchestrators that froze the outgoing series
and regenerated the manifest from disk. They are kept on disk for reference and
**refuse to run**, because the manifest is now hand-edited and a cut is a
content change:

- `scripts/release-version.ts` and its `release-version-minor.ts` /
  `release-version-patch.ts` modules
- `scripts/update-versions-list.ts`

Nothing calls them. Running one prints what to do instead.

A second set is dormant rather than retired: the release-notes page generator
and everything feeding it. The site stopped publishing those pages — each
line's sidebar links its minor's GitHub release instead — so these have no
caller, but nothing about them is wrong and the page model may come back. Each
carries a note at the top saying so. Do not call them:

- `scripts/generate-release-notes.ts`
- `scripts/lib/changelog-parser.ts`
- `scripts/api-docs/templates/release-notes-page.njk` and
  `release-notes-patch-section.njk`
- `release-notes-overrides/`

The release path is `generate-api-docs.ts` at the cutoff; the cut is
`scripts/cut-line.ts` or the hand procedure in [`README.md`](README.md).

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

The two branches show different versions, and that is the point:

| Branch | Shows | Sits at |
|---|---|---|
| `main` (staging) | the version **under development** | the tip of `main` |
| `docs-production` (production) | the version **released** | the cutoff's step-6a commit |

So production is not promoted to `main`'s tip. It is promoted to the commit
that closed the released version's line — step 6a of
[`docs/ci/RELEASE-TRAIN.md`](../ci/RELEASE-TRAIN.md) — which publishes exactly
that tree and nothing merged after it. Everything merged since is the next
version, visible on staging until its own release day.

Either way production is a fast-forward of a reviewed, already-on-`main`
commit, so the two branches never diverge historically.

### Builder configuration

The build runs in two phases, and each sizes its own parallelism from the core count the builder reports — the host's, not the container's share. On a 16-core builder that means more than 12 GB, and a smaller builder is killed by the kernel partway through `Creating an optimized production build`. It prints no error, because the overrun is Turbopack's native memory rather than a V8 heap it could abort on.

Three build-time environment variables cap both phases and bring the whole build under 5 GB. Set them on every builder that runs `next build`; they must be real environment variables, since Next and Turbopack read them at startup, before any `.env` file:

- `TURBO_TASKS_AVAILABLE_PARALLELISM=1` — threads Turbopack compiles with. This is the one that governs the peak.
- `CIRCLE_NODE_TOTAL=2` — static generation workers, as `value - 1`.
- `NODE_OPTIONS=--max-old-space-size=2048` — V8 heap ceiling per Node process, for the generation phase only.

Measured on this tree, with the full `npm run build` chain and a cold cache: the default parallelism dies at 8 GB, `4` fits in 8 GB, `2` in 6 GB, `1` in 5 GB, and nothing fits in 4 GB. The cost of `1` is compile time, roughly three minutes instead of forty seconds.

Raising `NODE_OPTIONS` does not help and tends to hurt: it is a ceiling, not a reservation, so a larger value only lets each process grow further before collecting, and the kernel kills it.

`TURBO_TASKS_AVAILABLE_PARALLELISM=1` is the last notch of that dial. The requirement grows with the content — every retained documentation line is a full copy of a content tree — so once growth outgrows 5 GB the answer has to come from fewer retained lines or a larger builder. Re-measure after each cut.

### Staging (automatic)

```
During the sprint: feature PRs document the current line on main
    │
    ▼
At the cutoff: step 6a closes the line, step 6b opens the next one
    │
    ▼
Hosting provider detects each new commit on main and rebuilds staging
```

Staging always shows the version under development, so a feature's
documentation is reviewable the moment its PR merges. Every push to `main`
triggers the hosting provider's build the same way — there is no documentation
release workflow and release PRs carry no documentation at all.

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
`docs-production` to the commit you name using **fast-forward-only**
semantics: if the branches have diverged it fails instead of creating a
merge commit, so `docs-production` stays a pure pointer into `main`'s history.

**Which commit:** the merge commit of the cutoff's step 6a, recorded when that
PR landed. Not `main`'s tip — that is already the next version. The workflow
rejects a commit that is not contained in `main`, so only reviewed, merged work
can be promoted, and its preflight prints the content diff this promotion
publishes so you read the prose before approving it.

The person promoting is responsible for confirming staging is healthy and
that the docs PR Checks have passed on `main` before running the workflow.
Promotion is fully manual on purpose — the workflow never runs
automatically on a merge to `main`, and the timing (waiting for the npm
publish to go out) is a human decision.

> **Why fast-forward-only?** If `docs-production` ever received squash
> merges, cherry-picks, or direct commits, Git would create commits that
> don't exist on `main`, making the branch historically divergent even
> when the file contents match. Once that happens, future promotions can
> no longer fast-forward and require manual repair. Keeping promotion
> `--ff-only` guarantees `docs-production` is always a commit already
> reviewed and present on `main`.

---

## CI Workflows

Two GitHub Actions workflows touch the docs: one validates docs PRs, one manually promotes a reviewed `main` commit to `docs-production`. There is no documentation release workflow — the API summary is generated locally at the cutoff. Neither workflow builds or deploys the site; the hosting provider does that on branch pushes.

### 1. Docs Website PR Checks

**File:** `.github/workflows/docs-website-pr-checks.yml`

**Triggers:** Pull requests to `main` that change `docs/website/**`, or manual dispatch.

**What it does:**
- Installs dependencies with Bun
- Runs `bun run build` to validate the site compiles
- Runs Vitest tests (sidebar consistency, link integrity, single-page rendering, the cut) excluding TSDoc completeness tests that require SDK source
- Optionally installs the SDK and runs the TSDoc completeness audit in warning mode
- Runs `Docs lines up to date with main` in a second job, described below

**Purpose:** Catches build errors and broken links in docs PRs before merge.

The API summary page lives in the SDK's current line, at `content/docs/sdk/<current line>/reference/api.mdx`, and is committed to the repo (refreshed at the release cutoff), so PR checkouts always have it on disk — no placeholder step is needed.

**`Docs lines up to date with main`** is the second job, and it exists because
git cannot report the failure it catches. A cut renames the current line's
folder; git detects that rename by content similarity, so a branch created
before a cut has its documentation edits replayed into the folder the cut
*preserved* — a release that already shipped — with no conflict and a green
merge. That is how `cli/v0.16` came to document five features 0.16.0 never
shipped (QVAC-27286).

The job compares the set of line folders at `merge-base(main, head)` against
main's tip, and fails when they differ. The question it asks is "did main move
the line set under this branch?", not "what does this branch do to the line
set" — which is what lets the cut's own PR pass with no label and no exception.
The fix for a failure is `git merge origin/main`, then moving the edits to the
current line.

A PR that edits only preserved lines gets a warning rather than a failure: a
factual correction to a shipped release's documentation is legitimate, and only
a human can tell it apart from a misplaced edit.

Do not make this job a required check in branch protection while it is new. A
false positive would block every docs PR at once.

### 2. Promote docs to production (manual)

**File:** `.github/workflows/promote-docs-production.yml`

**Triggers:** Manual `workflow_dispatch` only. It never runs automatically on a merge to `main`.

**Input:** the commit to promote — the cutoff's step-6a merge commit, not `main`'s tip.

**What it does:**
- Validates the requested commit in an ungated job that cannot push: it must exist, be contained in `main`, and be strictly ahead of `docs-production`
- Prints a step summary with the commits being promoted and **the documentation content diff this promotion publishes**, so the prose going public is read before the approval
- Waits for the `docs-production` environment approval
- Fast-forwards and pushes `docs-production` using `PAT_TOKEN` (the default `GITHUB_TOKEN` cannot push to the protected branch), which the hosting provider picks up to deploy production

**Fails when:** the commit is unknown, is not on `main`, is behind `docs-production` (a silent rollback), or the branches have diverged. Each is intentional — divergence must be repaired deliberately, not resolved by an automatic merge commit. The workflow never opens a PR and never creates a new commit on `docs-production`.

**Purpose:** Give the docs owner a single, deliberate button to publish the version that shipped, reviewed content and all, without ever letting `docs-production` drift from `main`'s history.

> `docs-production` should stay branch-protected (no direct pushes, no PR merges); the promotion workflow's `PAT_TOKEN` account is the only identity allowed to push to it.

### 3. Documentation at the release cutoff (local, skill-driven)

**Where:** steps 6a and 6b of [`docs/ci/RELEASE-TRAIN.md`](../ci/RELEASE-TRAIN.md). There is no GitHub Actions documentation-release workflow, and a release PR carries no documentation.

**Who:** the train's **tech lead** runs `qv-docs-cutoff`, which opens both PRs in one sitting right after the train branch is cut. The **documentation engineer** reviews them and merges 6a then 6b. The order is not a preference — see "Why 6b stacks on 6a" below.

**When:** on the morning the sprint's versions are declared final and the release branches are cut. Not when the release publishes, days later.

**6a — close the line of the version being released.** From `docs/website`, on a branch off `main`, against the current line:

```bash
bun run scripts/generate-api-docs.ts <version> --force-extract
npm run build
```

One file per collection: `content/docs/sdk/<current line>/reference/api.mdx`. Never `src/lib/versions.ts` or `public/_redirects` — both belong to the cut.

**Record 6a's merge commit.** It is what the promotion workflow publishes on release day, and it is the last commit whose tree still has the released version as the current line.

A patch release has no 6a. The public API is frozen at the minor boundary, so there is nothing to regenerate.

**6b — open the line of the next version.** `qv-docs-line-cut`, on a branch off **6a's branch**.

**Why 6b stacks on 6a.** A cut renames the folder 6a writes into. If 6b branches off `main` instead, merging 6a and then 6b produces a tree where the *preserved* folder — the one production serves — silently keeps the **old** API summary, because that half of the merge has no conflict to report. The conflict surfaces only in the freshly opened folder, which no reader has reached yet. Stacked on 6a, both merge clean and the preserved folder keeps what 6a generated. The cost is that merging 6a retargets 6b's base and dismisses its approval; the same reviewer re-approves and merges.

Build and generation byproducts (`api-data.json`, `.next/`, `.source/`, `out/`, `dist/`) are gitignored, so `git status` shows only committable files.

#### Reviewing the two cutoff PRs

**This review is how the documentation side of a release is verified.** There is
no other gate: no CI job asserts that the API summary matches the version being
released, and once 6a's commit is promoted it is what the public reads. Review
both PRs before merging either.

On **6a — close the line being released**:

- The diff is one file per documented collection, `content/docs/<slug>/<current line>/reference/api.mdx`, and nothing else. `src/lib/versions.ts` and `public/_redirects` belong to the cut; their presence means 6a and 6b were not separated.
- The frontmatter title names the version being released and carries `(latest)`.
- **The body actually changed.** A summary byte-identical to the previous line's, title aside, means TypeDoc did not re-extract — the page would advertise the new version while describing the old one. `--force-extract` exists for this.
- The base is `main`.

After merging, **record the merge commit**. It is the promotion target, and nothing merged after it belongs to the released version.

On **6b — open the next version's line**:

- **The base is 6a's branch, not `main`.** Check this first. It is the only failure here that is silent: merged in order from `main`, git drops 6a from the preserved folder without a conflict and reports one only in the newly opened folder. The published line is the one that breaks, and nothing flags it.
- The preserved folder carries the summary 6a generated, not the one before it.
- `diff -r content/docs/<slug>/<preserved> 'content/docs/<slug>/(<opened>)'` reports only the title line and the release-notes link. Anything else means content moved that should not have.
- The opened line's `reference/meta.json` names the **opened** line's release tag; the preserved line keeps its own.
- The manifest and `public/_redirects` both moved, and `tests/line-structure.test.ts` passes — the build is what proves the manifest and the folders agree.

Merge 6a first, then 6b. Merging 6a retargets 6b to `main` and dismisses its approval, so re-approve and merge.

`Docs lines up to date with main` passes on both, by construction: 6a changes no folder names, and 6b's branch point has the same line set as `main`. A failure on either means the branch was cut from a stale base.

If something is wrong, hand it back to the tech lead rather than fixing it in the PR. Both PRs are script output, and a cut commit must never be rebased — resetting and re-running is cheaper than repairing.

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
| `generate-release-notes.ts` | `docs:generate-release-notes` | **Dormant**, kept on disk. Rendered the release-notes page of the SDK's current line; the site publishes no such page any more. Do not call it. |
| `cut-line.ts` | -- | Cuts a versioned collection's next documentation line: preserves the outgoing one, opens the new one as a copy, and updates the manifest, the redirects, the currency marker, and the opened line's release-notes link. A convenience for the hand procedure in `README.md`, never a dependency. |
| `update-versions-list.ts` | -- | **Retired**, kept for reference. Rebuilt `src/lib/versions.ts` from the series siblings on disk; that file is now hand-edited. |
| `run-docs-generate.ts` | `docs:generate` | Convenience: regenerates the current line's API summary using the monorepo SDK's `package.json` version (no version bump) |
| `create-version-bundle.ts` | -- | **Retired**, kept for reference. Copied the current `index.mdx` of each versioned section to `v<X.Y>.x.mdx`. |
| `lib/release-shared.ts` | -- | Shared helpers for the generators: version parsing, the manifest reader, and `referenceDirFor` / `apiPageFor` / `releaseNotesPageFor`, which resolve the current line's reference folder and refuse a version that is not its own |
| `lib/changelog-parser.ts` | -- | **Dormant**, kept on disk. Changelog parsing for the release-notes page generator, its only caller. |
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

## Release-Notes Overrides (dormant)

`release-notes-overrides/<version>.md` injected extra `## Heading` sections at
the top of a generated release-notes page. The site publishes no release-notes
pages any more, so nothing reads this directory. It is kept on disk with its
existing files, because the page model may come back.

A highlight, migration guide, or breaking-change callout now belongs in the
version's `CHANGELOG_LLM.md`, which is the body of its GitHub release.

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

**Cause:** the generator writes into the current line and only accepts a version that belongs to it.

**Fix:** if the version is ahead, its line has not been cut yet — which at the cutoff means step 6b has not run. If the version is behind, it has already shipped and its line is what the site serves; edit that line's page directly instead of regenerating it. Do not cut a line to make the refusal go away: cutting opens the line *after* the one you are naming, which is the mistake the refusal is there to catch.

### Build stops with no error and no log

**Symptom:** the builder's output ends partway through `Creating an optimized production build` and nothing follows — no stack trace, no `JavaScript heap out of memory`, no failing step. The exit status is 137 or 143.

**Cause:** the kernel's OOM killer, not a build error. Compilation exceeded the builder's RAM. Because Turbopack allocates outside V8's heap, the process is killed rather than aborting with a message, which is why there is nothing to read.

**Fix:** set `TURBO_TASKS_AVAILABLE_PARALLELISM=1` on the builder, which caps the phase that overran. See [Builder configuration](#builder-configuration). Raising `NODE_OPTIONS=--max-old-space-size` does not help here and makes matters worse by letting each Node process grow further.

To reproduce locally, run the build under the same ceiling:

```bash
systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=0 npx next build
```

### Build fails in CI (PR checks)

The committed `content/docs/sdk/<current line>/reference/api.mdx` is what `next build` reads. If the build still fails:

1. Check that `source.config.ts` and `next.config.mjs` are valid
2. Run `bun run build` locally to reproduce
3. Look for broken MDX frontmatter or invalid imports in `content/`

### Recover a broken API summary

If step 6a produced a broken `reference/api.mdx`, re-render it from the current line's own version:

```bash
bun run scripts/generate-api-docs.ts <current-line-X.Y.Z> --force-extract
```

Then revert the bad commit via `git`. There is no automatic backup directory — the retained lines are the safety net, each a full copy of the tree as that release stood.

### Fix production without waiting for the next release

Production is pinned at the released version's commit, so an urgent correction
to a published page cannot simply be merged to `main` — `main` is the next
version, and promoting it would publish unreleased documentation.

The procedure is deliberately manual, and it bypasses `docs-production`
entirely:

1. Fix what needs fixing on `main`, through a normal PR, and merge it.
2. Branch `docs-fix` from `main` at that commit.
3. On `docs-fix`, remove the current line's folder and make the manifest
   declare the previous line as current. The tree now shows the released
   version, plus the correction.
4. Push `docs-fix` to the repository.
5. In the hosting provider's dashboard, trigger a one-off manual deploy of the
   production site from `docs-fix`, leaving the automatic configuration pointed
   at `docs-production`.
6. Delete `docs-fix` once the next ordinary promotion has gone out.

Nothing is scripted here on purpose: it is rare, it touches production
directly, and every step wants a human looking at it. Step 3 is also the only
inverse of a cut — the cut itself has none.

### Generated MDX contains "undefined" or "[object Object]"

**Cause:** A function's JSDoc is missing or malformed.

**Fix:**
- The generator replaces literal `undefined` strings with `—` as a safety net
- Validation will throw if descriptions contain `undefined` or `[object Object]`
- Add proper JSDoc to the offending function in the SDK source and regenerate
