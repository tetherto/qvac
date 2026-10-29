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
  - [Previewing the development line](#previewing-the-development-line)
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
| The line being written, per versioned collection | `content/_unpublished/<collection>/next/` | Yes, but not built and not served |
| SDK API summary (generated) | `content/_unpublished/sdk/next/reference/api.mdx`, published with its line | Yes (committed once per minor release) |

The SDK API summary is **generated from TypeScript source** via [TypeDoc](https://typedoc.org/) and Nunjucks. It is one MDX page inside the SDK's development line — the version being written, which the release cutoff publishes. A line already published is never regenerated, so there is one target and no way to name another. It is generated at the release cutoff; locally a maintainer can regenerate to preview.

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
Phase 2: Nunjucks rendering  ──►  content/_unpublished/sdk/next/reference/api.mdx
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
   `content/_unpublished/sdk/next/reference/api.mdx`, the line being written
3. Run a smoke test that checks for `## Functions` and `## Errors` headings

`--title-only` short-circuits this: it skips TypeDoc + render and only
rewrites the `title:` line of the existing page, then runs the
same smoke test.

**Flags:**

| Flag | Description |
|---|---|
| `--title-only` | Rewrite the frontmatter title in-place (skips TypeDoc + render). |
| `--force-extract` | Bypass the mtime cache and re-run TypeDoc extraction. |

There is no flag naming the target. The destination is the SDK's development
line, and a version that has already shipped is refused before anything is
written — see [Where generated pages land](#where-generated-pages-land).

`scripts/generate-release-notes.ts` is still on disk but has no caller: the
site publishes no release-notes pages. See
[Retired tooling](#retired-tooling).

### Where generated pages land

The generator writes into the SDK's **development line** —
`content/_unpublished/sdk/next/reference/` — and takes no target. A line that
has been published is what the site already serves and is never regenerated.

Because the destination is read rather than passed, it has to be checked. A
version that has already shipped is refused, before the first write:

```
Refusing to write v0.20 pages into the development line of /sdk.
  v0.22 is the line last cut, so v0.20 has shipped. A cut line is what the
  site serves and is never regenerated. Edit
  content/docs/sdk/(v0.22)/ directly to correct it.
```

### Previewing the development line

Nothing under `content/_unpublished/` is built, so the line being written does
not appear in `npm run dev`. To read it in the browser, link it into the
collection under a name that is not a version:

```bash
ln -s ../../_unpublished/sdk/next content/docs/sdk/preview
npm run dev          # the line is at /sdk/preview/…
rm content/docs/sdk/preview
```

`content/docs/*/preview` is gitignored, so the link cannot be committed by
accident, and `tests/line-structure.test.ts` rejects a symlinked entry under a
collection outright — which means the suite fails while the link is in place.
Remove it before running the tests. Both guards exist because Fumadocs follows
a link while the bijection between the folders and the manifest reads
`isDirectory()`, which a link answers `false`: a committed link would publish a
line that no check can see.

### Cutting a documentation line

A cut is what publishes a line. It happens at the **release cutoff** — step 6
of [`docs/ci/RELEASE-TRAIN.md`](../ci/RELEASE-TRAIN.md) for a train, step 1 of
the release flow in [`docs/gitflow.md`](../gitflow.md) for a single package —
on the day the version's release branch is cut.

```bash
bun run scripts/cut-line.ts <collection> <version being released>

bun run scripts/cut-line.ts sdk v0.21
```

It renames the outgoing group to its plain form, copies the development line
in as the new group, updates the manifest, adds the preserved line's rules to
`public/_redirects`, moves the currency marker from the preserved line's titles
to the opened one's, and points the opened line's `Release Notes` sidebar link
at its own minor's GitHub release tag. **The development line stays where it
is**, and is now the next version's.

Nothing is deleted, and the development line is never renamed. That is what
makes the cutoff safe for the sprint's own work: a feature PR opened before it
and merged after it writes to the same path either way, so its prose lands in
the version whose sprint it belongs to — with no rename for git to replay it
through. That replay is the defect QVAC-27286 fixed by hand.

The outgoing group **is** renamed, and the group the cut opens is byte-identical
to it wherever the sprint changed nothing. A PR that edits the group and merges
after the cut therefore gives git two exact rename candidates for every page it
touches, and git picks one — QVAC-27286 again, reachable at every cut. The
`Documentation lines` job fails such a PR until it is rebased, and the cutoff
lists the open PRs before cutting so the window is read rather than
discovered. Both are described under "Docs website PR checks" below.

It refuses a collection that is not versioned, a version that is not above the
line last cut, a missing development line, a destination already on disk, and a
working tree that already carries changes.

The opened line keeps the API summary it copied, because the PR that
regenerates it is reviewed as a diff: a summary diffed against the previous
line shows only the surface that moved.

The tag the opened line links at exists by the time readers reach that line:
the release follows within days of the cutoff, and production is not promoted
until it has.

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

Every line under `content/docs/<collection>/` has been published. The newest
one's folder is written in parentheses: Fumadocs reads that as a group and
excludes it from the slug, so it answers the version-less paths. Every other
line's folder is plain, so its pages carry the version.

The line still being written is not under `content/docs/` at all. It lives at
`content/_unpublished/<collection>/next/`, which nothing builds and no URL
reaches, until the release cutoff copies it in:

```
content/
├── _unpublished/
│   ├── sdk/next/               -> being written, no URL
│   └── cli/next/               -> being written, no URL
└── docs/
    ├── ecosystem/              -> not versioned
    ├── resources/              -> not versioned
    ├── sdk/
    │   ├── (v0.20)/            -> last published, serves /sdk/…
    │   │   ├── quickstart.mdx  ->               /sdk/quickstart
    │   │   └── reference/
    │   │       └── api.mdx     ->               /sdk/reference/api     (generated)
    │   ├── v0.19/              -> published, serves /sdk/v0.19/…
    │   └── v0.18/
    └── cli/
        ├── (v0.14)/
        ├── v0.13/
        └── v0.12/
```

- **Line name**: `vX.Y`. A line represents every patch in its range, so a line
  is never named for a patch. The development line is named `next` instead:
  the name is fixed so the path a feature PR writes to does not move at a
  cutoff.
- **Currency**: stated once, by the parentheses. Nothing else records it, which
  is why a cut is the only thing that changes it. The parenthesized line is the
  **version last released**; every plain folder is an older release and
  documents that release alone.
- **Manifest**: `src/lib/versions.ts`, hand-edited, naming each published line
  and the folder holding it. The development line is not in it — it is not
  published. `tests/line-structure.test.ts` fails the build when the manifest
  and the folders disagree.
- **Permanence**: a published line is never removed. It is the only record of
  how that release behaved, and the readers who need it are the ones pinned to
  it.
- **Everything else is derived**: the switcher, the sidebars, the canonical
  URLs, the agent artifacts, `versions.json`, the sitemap, and the retrieval
  metadata are computed at build time from the manifest and the folders.

A version is published at the **release cutoff**, on `main`, by one PR — step
6 of [`docs/ci/RELEASE-TRAIN.md`](../ci/RELEASE-TRAIN.md) for a train, step 1
of the release flow in [`docs/gitflow.md`](../gitflow.md) for a single
package. A release PR and its backmerge carry nothing under `docs/website`,
and no CI workflow generates documentation.

Collections are cut independently. A release that moves only the CLI cuts only
`/cli`, and the SDK's lines are untouched — nothing in the model ties the two
together.

### Minor vs patch release behavior

| Trigger | API summary |
|---|---|
| Minor (`X.Y.0`) | Re-run TypeDoc and render `api.mdx` into the development line, at the cutoff, just before that line is published. |
| Patch (`X.Y.Z`, `Z >= 1`) | **Not touched.** The public API is frozen at the minor boundary, so a patch by definition adds nothing here. |

A patch release therefore touches `docs/website` not at all. What a patch
changes for readers is in its GitHub release, which the line's sidebar already
links.

A correction to a published line is an ordinary edit to that line's folder,
merged to `main` and promoted like anything else: the generator only ever
writes the development line.

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
| `main` (staging) | every line published so far | the tip of `main` |
| `docs-production` (production) | the same, as of the last promotion | a commit already on `main` |

Between two cutoffs the two branches show the same **set of lines**. The
sprint's feature documentation goes into the development line, which is not
built, so merging it changes nothing a reader can see.

That is a statement about which versions are published, and about nothing else.
**Production is always promoted to one named commit, never to whatever `main`
points at.** The commit is the tree the operator verified on staging, and
anything merged after it is unverified: a dependency bump, a component change,
a bad MDX edit anywhere in the site can break the build or the pages without
touching a line folder at all. Promoting the tip would publish that, and the
fast-forward semantics would not notice — they protect the branch's history,
not the content.

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
During the sprint: feature PRs document the development line on main
    │                 (not built — read it with the preview link, locally)
    ▼
At the cutoff: one PR publishes that line and preserves the previous one
    │
    ▼
Hosting provider detects each new commit on main and rebuilds staging
```

Staging shows every line published so far, which between cutoffs is the same
set production shows. The version under development is deliberately not among
them: its prose is reviewed in the PR that writes it, and previewed locally
with the link described under [Previewing the development
line](#previewing-the-development-line). Every push to `main` triggers the
hosting provider's build the same way — there is no documentation release
workflow and release PRs carry no documentation at all.

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

**Which commit:** one you verified on staging, named explicitly. At a release
that is the merge commit of the cutoff PR, promoted once the version it
publishes is on npm. For a correction between cutoffs it is that correction's
own merge commit. Never `main`'s tip as a shorthand for either: the input
exists so the promoted tree is the one inspected, not the one that happens to
be on `main` when the environment approval lands, which may be several merges
later.

The commit also must not be at or after the next cutoff while that version has
not shipped — that would publish a line for packages nobody can install. The
workflow rejects a commit that is not contained in `main`, so only reviewed,
merged work can be promoted, and its preflight prints the content diff this
promotion publishes so you read the prose before approving it.

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
- Runs `Documentation lines` in a second job, described below

**Purpose:** Catches build errors and broken links in docs PRs before merge.

The API summary page is committed to the repo, so PR checkouts always have it on disk — no placeholder step is needed. It is refreshed at the release cutoff, into the line being published.

**Neither the build nor the tests cover the development line.** Nothing under `content/_unpublished/` is built, so a broken link or malformed MDX written during the sprint surfaces at the cutoff, on the PR that publishes it, rather than in the PR that wrote it. That is the price of keeping the line out of the site, and the cutoff is where it gets paid.

**`Documentation lines`** is the second job, and it runs two checks on where a
PR writes.

The first only warns. It names every file the PR changes under
`content/docs/<collection>/` — every folder there is a release that already
shipped — and points at `content/_unpublished/<collection>/next/` as where a
feature's documentation belongs. It cannot be a failure, because a factual
correction to a shipped release's documentation is legitimate and only a human
can tell it apart from a misplaced edit.

The second fails the run, and covers the window a cutoff opens for the
published lines. A feature PR crosses a cutoff safely: it writes to the
development line, which the cut copies and leaves in place, so its path means
the same thing before and after. **A correction to the published line does
not.** The cut renames the outgoing group — `(vX.Y)` becomes `vX.Y` — beside a
new `(vX.Y+1)` whose pages are byte-identical wherever the sprint changed
nothing, so every page the PR edits has two exact rename candidates and git
replays the edit into one of them: no conflict, green merge, and a shipped
release documenting a feature it never had. That is QVAC-27286, reachable at
every cut and invisible to whoever merges.

The check reads the parenthesized folder — the line last cut, whose name only a
cutoff changes — at the parent of the PR's oldest commit and at the base
branch's head, and fails when they differ while the PR edits a line under
`content/docs/`. It anchors on the branch point rather than the merge-base
because *Update branch* moves the merge-base past the cutoff and carries the
misplacement in with it, turning a merge-base check green at the moment the
damage is done. A rebase is what clears it.

**It deliberately leaves the development line alone.** Reading
`_unpublished/<collection>/next/` too would catch the other shape a cutoff
strands — documentation meant to ship with the release, merging after the cut
into the line after it — but would fail every open feature PR carrying docs at
every cutoff and dismiss their approvals. The open-PR inventory in
`qv-docs-cutoff` reads that shape before the cut instead.

**The job is not a required check**, so neither step withholds the merge. What
the second one buys is that the window stops being silent: the run goes red and
names the folder group as it stood at the branch point and as it stands now, so
merging anyway is a decision someone takes rather than a step nobody saw. Making
it required would hold the merge, at the cost of the job running only on docs
paths — every PR that touches none would need the check reported some other way.

The structural fix is to stop renaming: a fixed group folder name would make a
cut a copy plus an overwrite, leaving git no deletion to pair an edit against.
That moves the manifest, the redirects, the breadcrumbs and their tests, so for
now the check is what makes the window visible.

### 2. Promote docs to production (manual)

**File:** `.github/workflows/promote-docs-production.yml`

**Triggers:** Manual `workflow_dispatch` only. It never runs automatically on a merge to `main`.

**Input:** the commit to promote, named explicitly and required — the cutoff PR's merge commit once the version is on npm, or a correction's own merge commit between cutoffs. It is the tree you verified on staging, which is the whole reason the input exists.

**What it does:**
- Validates the requested commit in an ungated job that cannot push: it must exist, be contained in `main`, and be strictly ahead of `docs-production`
- Prints a step summary with the commits being promoted and **the documentation content diff this promotion publishes**, so the prose going public is read before the approval
- Waits for the `docs-production` environment approval
- Fast-forwards and pushes `docs-production` using `PAT_TOKEN` (the default `GITHUB_TOKEN` cannot push to the protected branch), which the hosting provider picks up to deploy production

**Fails when:** the commit is unknown, is not on `main`, is behind `docs-production` (a silent rollback), or the branches have diverged. Each is intentional — divergence must be repaired deliberately, not resolved by an automatic merge commit. The workflow never opens a PR and never creates a new commit on `docs-production`.

**Purpose:** Give the docs owner a single, deliberate button to publish the version that shipped, reviewed content and all, without ever letting `docs-production` drift from `main`'s history.

> `docs-production` should stay branch-protected (no direct pushes, no PR merges); the promotion workflow's `PAT_TOKEN` account is the only identity allowed to push to it.

### 3. Documentation at the release cutoff (local, skill-driven)

**Where:** step 6 of [`docs/ci/RELEASE-TRAIN.md`](../ci/RELEASE-TRAIN.md) for a train, step 1 of the release flow in [`docs/gitflow.md`](../gitflow.md) for a single package. There is no GitHub Actions documentation-release workflow, and a release PR carries no documentation.

**Who:** the release's **tech lead** runs `qv-docs-cutoff`, which opens one PR right after the release branch is cut. The **documentation engineer** reviews and merges it, then promotes it once the version is on npm.

**When:** on the day the version's release branch is cut. Not when the release publishes, days later — though a cut run late is no longer a correctness problem, only a late one: the sprint's prose was going into the development line either way.

**Off which commit:** the release base — `git merge-base <remote>/<release-branch> <remote>/main` — and not `main`'s tip. The tip carries whatever merged after the release branch came off, which ships in the version after this one. The PR still targets `main`; only its base commit is pinned.

**What it checks before cutting:** the open PRs writing either line of the
collection, listed with `gh pr list` and reported one by one. A PR writing the
development line with documentation for **this** release has to merge before
the cut, or the release ships without it; one writing the outgoing group has to
be rebased after the cutoff merges, since until then its edits have two
identical rename candidates. Cutting with PRs outstanding is a decision, not an
error — the point is that it is made rather than discovered. The `Documentation
lines` job then fails the ones writing the outgoing group, so that rebase is
asked for on the PR itself rather than remembered; for the development line,
this list is the only reading there is.

**What the PR carries**, per collection the release moves:

1. The regenerated API summary of the version being released, written into the development line just before it is published:

   ```bash
   bun run scripts/generate-api-docs.ts <version> --force-extract
   ```

2. The cut itself, one commit per collection:

   ```bash
   bun run scripts/cut-line.ts <collection> v<X.Y>
   npm run build
   ```

A patch release has neither. The public API is frozen at the minor boundary and no line is cut, so a patch touches `docs/website` not at all.

Build and generation byproducts (`api-data.json`, `.next/`, `.source/`, `out/`, `dist/`) are gitignored, so `git status` shows only committable files.

#### Reviewing the cutoff PR

**This review is how the documentation side of a release is verified.** There is
no other gate: no CI job asserts that the API summary matches the version being
released, and once the commit is promoted it is what the public reads. It is
also the first time the sprint's prose is built at all, since the development
line is excluded from the build.

Per collection:

- **The published line is the sprint's work.** `diff -r content/_unpublished/<slug>/next 'content/docs/<slug>/(v<X.Y>)'` reports only the title line and the release-notes link. Anything else means content moved that should not have.
- **The API summary's body actually changed.** A summary byte-identical to the previous line's, title aside, means TypeDoc did not re-extract — the page would advertise the new version while describing the old one. `--force-extract` exists for this.
- The frontmatter title of the opened line names the version being released and carries `(latest)`; the preserved line's no longer does.
- The opened line's `reference/meta.json` names the **opened** line's release tag; the preserved line keeps its own.
- The preserved folder is recorded as a rename of the outgoing group at 100% similarity, relabelled pages aside. The opened folder is recorded as additions — it is a copy, and the development line it came from is still on disk.
- **The development line is still there**, unchanged. A cut that moved it instead of copying it would take the next sprint's folder away.
- The manifest and `public/_redirects` both moved, and `tests/line-structure.test.ts` passes — the build is what proves the manifest and the folders agree.
- The base is `main`.

After merging, **do not promote yet.** Production goes to this commit once the version is on npm — step 9 of [`docs/ci/RELEASE-TRAIN.md`](../ci/RELEASE-TRAIN.md), or after step 3 of the release flow in [`docs/gitflow.md`](../gitflow.md).

If something is wrong, hand it back to the tech lead rather than fixing it in the PR. The PR is script output, and a cut commit must never be rebased — resetting and re-running is cheaper than repairing.

---

## Script Reference

All scripts live in `docs/website/scripts/` and are designed to run with Bun.

| Script | npm alias | Description |
|---|---|---|
| `release-version.ts` | -- | **Retired**, kept for reference. Was the release dispatcher forwarding to the minor or patch orchestrator. |
| `release-version-minor.ts` | -- | **Retired**, kept for reference. Was the minor (X.Y.0) orchestrator: freeze outgoing series → generate new latest → refresh `versions.ts`. |
| `release-version-patch.ts` | -- | **Retired**, kept for reference. Was the patch (X.Y.Z, Z>=1) orchestrator, inserting `## v<X.Y.Z>` after the existing minor block. |
| `generate-api-docs.ts` | `docs:generate-api` | Renders the API summary page of the SDK's development line. `--title-only` rewrites only the frontmatter title. |
| `api-docs/extract.ts` | -- | Phase 1: TypeDoc analysis, writes `api-data.json` |
| `api-docs/render.ts` | -- | Phase 2: Nunjucks rendering of `single-page.njk` from `api-data.json` |
| `api-docs/audit-tsdoc.ts` | `docs:audit-tsdoc` | TSDoc completeness audit (standalone or via extraction) |
| `generate-release-notes.ts` | `docs:generate-release-notes` | **Dormant**, kept on disk. Rendered a release-notes page of the SDK's newest line; the site publishes no such page any more. Do not call it. |
| `cut-line.ts` | -- | Publishes the line of the version being released: preserves the outgoing one, copies the development line in as the new one, and updates the manifest, the redirects, the currency marker, and the opened line's release-notes link. The development line stays in place. A convenience for the hand procedure in `README.md`, never a dependency. |
| `update-versions-list.ts` | -- | **Retired**, kept for reference. Rebuilt `src/lib/versions.ts` from the series siblings on disk; that file is now hand-edited. |
| `run-docs-generate.ts` | `docs:generate` | Convenience: regenerates the development line's API summary using the monorepo SDK's `package.json` version (no version bump) |
| `create-version-bundle.ts` | -- | **Retired**, kept for reference. Copied the current `index.mdx` of each versioned section to `v<X.Y>.x.mdx`. |
| `lib/release-shared.ts` | -- | Shared helpers for the generators: version parsing, the manifest reader, `developmentLineDir`, and `referenceDirFor` / `apiPageFor` / `releaseNotesPageFor`, which resolve the development line's reference folder and refuse a version that has already shipped |
| `lib/changelog-parser.ts` | -- | **Dormant**, kept on disk. Changelog parsing for the release-notes page generator, its only caller. |
| `lib/link-validator.ts` | -- | Internal link extraction + resolution, for the docs tree and for the development line the build never renders (used by the link-integrity test) |

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

### Refusing to write pages into the development line

```
Refusing to write v0.20 pages into the development line of /sdk.
```

**Cause:** the generator writes into the development line, which holds the
version under development, and the version named has already shipped.

**Fix:** edit that version's published folder directly to correct it. A line
the site serves is never regenerated — a full render would replace the record
of a release, and the tree that results still builds and still tests clean,
which is why the refusal exists. Do not cut a line to make it go away.

### Build stops with no error and no log

**Symptom:** the builder's output ends partway through `Creating an optimized production build` and nothing follows — no stack trace, no `JavaScript heap out of memory`, no failing step. The exit status is 137 or 143.

**Cause:** the kernel's OOM killer, not a build error. Compilation exceeded the builder's RAM. Because Turbopack allocates outside V8's heap, the process is killed rather than aborting with a message, which is why there is nothing to read.

**Fix:** set `TURBO_TASKS_AVAILABLE_PARALLELISM=1` on the builder, which caps the phase that overran. See [Builder configuration](#builder-configuration). Raising `NODE_OPTIONS=--max-old-space-size` does not help here and makes matters worse by letting each Node process grow further.

To reproduce locally, run the build under the same ceiling:

```bash
systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=0 npx next build
```

### Build fails in CI (PR checks)

The committed API summary of each published line is what `next build` reads. If the build still fails:

1. Check that `source.config.ts` and `next.config.mjs` are valid
2. Run `bun run build` locally to reproduce
3. Look for broken MDX frontmatter or invalid imports in `content/`

### Recover a broken API summary

If the cutoff produced a broken `reference/api.mdx`, re-render it before the cut, from the version being released:

```bash
bun run scripts/generate-api-docs.ts <X.Y.Z> --force-extract
```

If the cut has already been committed, reset the branch and re-run both steps rather than patching the published folder. There is no automatic backup directory — the retained lines are the safety net, each a full copy of the tree as that release stood.

### Correct a published page without waiting for the next release

Merge the correction to `main` through a normal PR, verify it on staging, then
run the promotion workflow on **that merge commit**. Between two cutoffs `main`
publishes the same lines production already shows, so the promotion carries the
correction and whatever else merged up to that commit — which is why the commit
is named rather than taken from the tip.

The one window where this does not hold is between a cutoff and that version
reaching npm: promoting then would publish a line for packages nobody can
install. Wait for npm, or promote the correction with the release.

### Generated MDX contains "undefined" or "[object Object]"

**Cause:** A function's JSDoc is missing or malformed.

**Fix:**
- The generator replaces literal `undefined` strings with `—` as a safety net
- Validation will throw if descriptions contain `undefined` or `[object Object]`
- Add proper JSDoc to the offending function in the SDK source and regenerate
