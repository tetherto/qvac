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
  - [Previewing the development line](#previewing-the-development-line)
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
  - [Documentation at a release](#3-documentation-at-a-release)
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
| API reference | Rendered from the SDK contract and generated surface data (`scripts/api-reference/`) |
| Build output | `docs/website/dist/` (static HTML/CSS/JS) |
| Hosting | Static site CDN (hosting provider runs the build and serves the output) |

Content falls into two categories:

| Category | Path | Committed? |
|---|---|---|
| Manual content (guides, tutorials, addons) | one collection folder per top level: `content/docs/ecosystem/`, `content/docs/sdk/`, `content/docs/cli/`, `content/docs/resources/` | Yes |
| The line being written, per versioned collection | the software's `packages/<pkg>/docs/users/` | Yes, but not served in production |
| SDK API data (generated) | `packages/sdk/docs/users/_generated/` and the reference stubs in `packages/sdk/docs/users/reference/api/` | Yes, kept fresh by `npm run docs:sdk-api -- --check` |

The SDK API reference is **rendered from data**, never written by hand. Field facts — types, nesting, constraints, descriptions — come from the SDK's exported contract (`packages/sdk/contract/`, generated from its Zod schemas). The client functions come from `packages/sdk/docs/users/_generated/`: `js-api.json`, extracted by TypeDoc, and `python-api.json`, read from the Python client's source. Each line renders the data of its own commit.

**The site publishes no release-notes pages.** Each line's sidebar carries a `Release Notes` entry that links out to that minor's GitHub release, which is where the changelog already lives. The release notes a release authors (`qv-sdk-changelog`) therefore reach readers through GitHub, and a patch release touches `docs/website` not at all.

### How the Pipeline Works

Generation and rendering are separate. Generation needs the packages'
sources, so it runs in the repository and its output is committed; the site
build only reads committed data. Output is deterministic. (AI-assisted
authoring happens locally via agent skills, never inside this pipeline.)

```
packages/sdk (TypeDoc) + packages/sdk-python (source)
  │  npm run docs:sdk-api
  ▼
packages/sdk/docs/users/_generated/{js-api,python-api}.json
packages/sdk/docs/users/reference/api/<function>.mdx   (one stub per function)
  │  build: materialize the line, then render
  ▼
reference pages   ── <FunctionReference>, <SchemaTable>, <ModelsTable>
Markdown twins    ── the same components rendered as cards
<function>.schema.json   ── scripts/write-schema-slices.ts, after next build
```

- `<SchemaTable fn>` renders a function's request fields as nested tables,
  with a JavaScript/Python switch for field names.
- `<ModelsTable engines>` lists the registry models of the given engines.
- `<FunctionReference fn>` renders a function's whole reference page.

In a page's Markdown twin, each component renders as a card: a TypeScript
type for fields, a list for models. `npm run docs:sdk-parity` checks that every
contract method is reachable from JavaScript and Python, and
`npm run docs:sdk-descriptions` lists the public request fields the contract
leaves undescribed.

Release notes are not rendered
into the site at all: `reference/meta.json` declares the sidebar entry as an
external link to `https://github.com/tetherto/qvac/releases/tag/sdk-v<X.Y>.0`,
so each line points at the GitHub release of its own minor. The tag is written
in the package's `reference/meta.json`, so it must name the coming minor before
that minor's release branch is cut.

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

### Generating the SDK API data

```bash
npm run docs:sdk-api            # regenerate after changing the SDK's public API
npm run docs:sdk-api -- --check # fail when the committed data is stale
```

It writes `packages/sdk/docs/users/_generated/` and the reference stubs in
`packages/sdk/docs/users/reference/api/`. Commit both with the SDK change.

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

### Previewing the development line

The line being written lives in each software's package —
`packages/sdk/docs/users/`, `packages/cli/docs/users/` — and is not published.
`npm run dev` materializes it with `--include-dev`, at `/<collection>/preview/`.
The folder is written by the materializer and ignores itself in git; a
symbolic link at that path is refused.

## Versioning

Versioning is a property of a collection. A **versioned collection** — one per
product, today the SDK and the CLI — publishes one **documentation line** per
minor release. The unversioned collections, Ecosystem and Resources, publish one
copy of everything.

Each product declares its lines in `versions/<software>.json` (see the README,
"Documentation lines and versions files"). The first line is current and
answers the version-less paths; every other line carries its version in the
URL. A **pinned** line is materialized from the release commit it names into
`content/docs/<collection>/<folder>/` before the build; an **in-place** line is
one published before the migration, still served from that folder until it is
retired.

- **Line name**: `vX.Y`. A line represents every patch in its range, so a line
  is never named for a patch.
- **Currency**: the order of `lines`. Promoting a line is putting it first.
- **Retirement**: a line stays published until the team stops supporting its
  version; retiring it is moving it to `retired`, and its addresses redirect to
  the current line.
- **Everything else is derived**: the switcher, the sidebars, the canonical
  URLs, the agent artifacts, `versions.json`, the sitemap, the retrieval
  metadata, and the line redirect rules.

A release publishes its line by pinning the release commit — a minor adds a
line, a patch moves its minor's pin. A correction to a released line is a
documentation-only pull request into that line's release branch, then moving
the pin to the merged commit.

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

The SDK and the CLI publish a line by pinning its release commit in their
versions file; the SDK's API data is already committed with the release.

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
- Runs Vitest tests (sidebar consistency, link integrity, materialization, API reference)
- Runs `Documentation lines` in a second job, described below

**Purpose:** Catches build errors and broken links in docs PRs before merge.

The SDK's generated API data and reference stubs are committed in its package, so PR checkouts always have them on disk.

**The tests cover the development line; the production build does not.** `tests/link-integrity.test.ts` resolves the links of each product's `packages/<pkg>/docs/users/`, and `npm run dev` renders it as `preview`. Building it in a PR check, with `--include-dev`, is part of the CI changes still to come.

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

### 3. Documentation at a release

A release publishes its documentation by pinning it, in one pull request on
`main`: the product's versions file gains the line (a minor) or moves its pin
(a patch), with the release branch as `ref` and the release commit as `sha`.
The documentation itself, and the SDK's generated API data, were already
committed with the code that the release carries.

Review it by building it: `npm run build` materializes the line from its
commit, and the checks reject a pin without documentation or a malformed
versions file. While earlier lines are still in place, the pull request that
makes the first pinned line current also renames the in-place current folder
from `(vX.Y)` to `vX.Y`.

---

## Script Reference

All scripts live in `docs/website/scripts/` and are designed to run with Bun.

| Script | npm alias | Description |
|---|---|---|
| `release-version.ts` | -- | **Retired**, kept for reference. Was the release dispatcher forwarding to the minor or patch orchestrator. |
| `release-version-minor.ts` | -- | **Retired**, kept for reference. Was the minor (X.Y.0) orchestrator: freeze outgoing series → generate new latest → refresh `versions.ts`. |
| `release-version-patch.ts` | -- | **Retired**, kept for reference. Was the patch (X.Y.Z, Z>=1) orchestrator, inserting `## v<X.Y.Z>` after the existing minor block. |
| `api-reference/generate-sdk-data.ts` | `docs:sdk-api` | Writes the SDK's generated surface data (`js-api.json`, `python-api.json`) and its reference stubs. `--check` fails when they are stale. |
| `api-reference/python-surface.py` | -- | Reads the Python client's public functions from source, standard library only |
| `api-reference/check-sdk-parity.ts` | `docs:sdk-parity` | Fails naming each contract method a published language does not reach |
| `api-reference/report-sdk-descriptions.ts` | `docs:sdk-descriptions` | Lists public request fields without a description; never fails |
| `api-docs/extract.ts` | -- | TypeDoc analysis of the SDK's client functions, used by `generate-sdk-data.ts` |
| `api-reference/generate-cli-data.ts` | `docs:cli-api` | Writes a Commander CLI's command tree (`cli.json`) and, with `--openapi`, its OpenAPI document (`openapi.json`) into its `_generated/`. Needs the CLI's dependencies installed. `--check` fails when stale. |
| `api-reference/commander-walker.ts` | -- | Replays a Commander entry's `register*` calls without running it, run from the CLI package |
| `write-schema-slices.ts` | -- | After `next build`: publishes each function's `<fn>.schema.json` beside its reference page |
| `write-line-redirects.ts` | -- | After `next build`: expands the documentation-line markers of `out/_redirects` |
| `materialize-lines.ts` | `docs:materialize` | Materializes every pinned line from its commit; `--override`, `--include-dev` |
| `generate-release-notes.ts` | `docs:generate-release-notes` | **Dormant**, kept on disk. Rendered a release-notes page of the SDK's newest line; the site publishes no such page any more. Do not call it. |
| `update-versions-list.ts` | -- | **Retired**, kept for reference. Rebuilt `src/lib/versions.ts` from the series siblings on disk; that file is now hand-edited. |
| `create-version-bundle.ts` | -- | **Retired**, kept for reference. Copied the current `index.mdx` of each versioned section to `v<X.Y>.x.mdx`. |
| `lib/release-shared.ts` | -- | Shared helpers for the generators: version parsing, the manifest reader, `developmentLineDir`, and `referenceDirFor` / `apiPageFor` / `releaseNotesPageFor`, which resolve the development line's reference folder and refuse a version that has already shipped |
| `lib/changelog-parser.ts` | -- | **Dormant**, kept on disk. Changelog parsing for the release-notes page generator, its only caller. |
| `lib/link-validator.ts` | -- | Internal link extraction + resolution, for the docs tree and for the development line the build never renders (used by the link-integrity test) |

> AI-assisted authoring (drafting descriptions or examples) happens
> locally via agent skills — never inside this pipeline. Output of
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

**Fix:** For an in-place version declared in `versions/<software>.json`, create the folder the entry names, or drop the entry. The two must agree.

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

### Recover stale SDK API data

If a reference page shows a function or field that no longer matches the SDK,
the committed data is stale. Regenerate and commit it:

```bash
npm run docs:sdk-api
```

### Correct a published page without waiting for the next release

For a pinned line, merge the correction into the line's release branch as a
documentation-only pull request, then move the line's `sha` in its versions
file to the merged commit. For an in-place line, correct its folder under
`content/docs/<collection>/` on `main`. Either way, the change reaches
production with the next promotion of `docs-production`.

### Generated MDX contains "undefined" or "[object Object]"

**Cause:** A function's JSDoc is missing or malformed.

**Fix:**
- The generator replaces literal `undefined` strings with `—` as a safety net
- Validation will throw if descriptions contain `undefined` or `[object Object]`
- Add proper JSDoc to the offending function in the SDK source and regenerate
