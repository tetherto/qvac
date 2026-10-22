---
name: qv-docs-cutoff
description: Open the documentation PR of a release cutoff — one PR that publishes the line of the version being released and leaves the next sprint's line open. Use at step 6 of docs/ci/RELEASE-TRAIN.md, at step 1 of a single-package release in docs/gitflow.md, when invoked from qv-release-train or qv-sdk-changelog, or when invoking /qv-docs-cutoff.
---

# Documentation cutoff

The documentation site publishes one **line** per minor of each versioned
collection. Every line under `content/docs/<collection>/` has been cut: the
parenthesized one is the newest and answers the version-less paths, and every
plain one carries its version in the URL. The line still being written lives
outside the site, at `content/_unpublished/<collection>/next/`, where nothing
builds it and no URL reaches it.

A cutoff publishes the line of the version being released, in **one** PR into
`main`, per collection cut:

- the outgoing group becomes plain and gains its versioned URLs
- a copy of the development line becomes the new group
- the development line stays where it is — it is already the next version's
- the manifest and the redirects follow

The development line is addressed by a fixed name rather than by its number,
and that is what makes the cutoff cheap: no line folder is deleted, so git has
no deletion to pair a pre-cutoff edit against, and a feature PR that straddles
the cutoff merges clean into the line it was written for.

## When to use

- Step 6 of [`docs/ci/RELEASE-TRAIN.md`](../../../docs/ci/RELEASE-TRAIN.md),
  invoked from `qv-release-train` right after the train branch is cut. Every
  collection the train moves is cut, in one PR.
- Step 1 of the release flow in [`docs/gitflow.md`](../../../docs/gitflow.md),
  invoked from `qv-sdk-changelog` when a single package is released on its own.
  One collection is cut, in one PR.
- `/qv-docs-cutoff` invoked directly, to redo a cutoff's documentation PR.

## What it does NOT do

- Does not merge or approve the PR. The documentation engineer reviews it —
  that review is the only gate on the documentation side of a release.
- Does not write prose. Feature documentation reaches the development line
  through the sprint's own PRs (`qv-docs-update`), and is already on `main`.
- Does not promote anything to production. Promotion happens **after** the
  version is on npm — step 9 of `RELEASE-TRAIN.md`, or after step 3 of the
  release flow in `gitflow.md`. Promoting before that would publish a line
  whose packages nobody can install.

## Prerequisites

- `bun` on PATH, and `docs/website` dependencies installed
  (`cd docs/website && bun install`).
- `SDK_PATH` needs no value inside the monorepo: the generator falls back to
  `packages/sdk`.
- A machine with less than 8 GB of RAM needs the build caps from
  `docs/website/.env.example` exported as real environment variables.

Resolve the org remote from `git remote -v` — its URL contains `tetherto/qvac`,
and it is often named `upstream`, sometimes `origin`. `ORG_REMOTE` below is that
name.

## Workflow

### Step 1: Resolve the collections and check the moment

Read the version being released, `<x.y.z>`, from the invocation.

Derive the collections to cut:

- Invoked from `qv-release-train`: every versioned collection whose package the
  train moves. `docs/website/src/lib/versions.ts` maps package to collection —
  `@qvac/sdk` → `/sdk`, `@qvac/cli` → `/cli`. A train package with no
  collection (`@qvac/inference`, `@qvac/ai-sdk-provider`, the plugins) cuts
  nothing.
- Invoked from `qv-sdk-changelog` or by hand: the one collection of the package
  being released. If it has none, there is nothing to do — report that and
  stop.

Per collection, read the line last cut from the manifest — the parenthesized
entry — and check the moment:

- If `<x.y>` is **above** it, the cutoff is due. This is the ordinary case.
- If `<x.y>` **equals** it and the collection has no
  `content/_unpublished/<collection>/next/`, this is the collection's **first
  cut** under this model: the group still holds the version under development,
  so the cut only opens the development line. Expect no manifest or redirect
  change.
- If `<x.y>` equals it and the development line exists, stop and report: this
  cutoff already ran.
- If `<x.y>` is below it, stop and ask. The collection is a release ahead.

Confirm the tree is clean (`git status --porcelain` empty) and fetch:

```bash
git fetch ORG_REMOTE main
```

The PR comes off `main` so it carries documentation alone. The release's own
version bump, changelog and NOTICE live on the release head branch and stay
there. A dirty tree means release work is still uncommitted: stop, and let the
release flow reach its own cut first.

### Step 2: Regenerate the API summary of the version being released

Only the SDK has a generated reference; skip this for any other collection.

```bash
git switch -c docs/cutoff-<x.y.z> ORG_REMOTE/main
cd docs/website && bun run scripts/generate-api-docs.ts <x.y.z> --force-extract
```

This writes one file, into the line that is about to be published:
`content/_unpublished/sdk/next/reference/api.mdx` — or, on the collection's
first cut, `content/docs/sdk/(v<x.y>)/reference/api.mdx`. The destination is
resolved, never passed; a version whose line has already been cut is refused.

**Confirm the body changed, not just the title.** `--force-extract` re-runs
TypeDoc; a diff of one line means it did not, and the page would then advertise
the new version while describing the previous one:

```bash
git diff --stat -- content
```

### Step 3: Cut each collection

Invoke `qv-docs-line-cut`, passing the version and the collections resolved in
Step 1. It runs `scripts/cut-line.ts` once per collection, commits each cut on
its own, and verifies the result.

The API summary from Step 2 goes in with the first commit. The cut copies the
development line after it, so the published line carries the summary just
generated and the development line keeps it as its starting point.

### Step 4: Open one PR

```bash
git push -u ORG_REMOTE docs/cutoff-<x.y.z>
```

Open it into `main`. The body states the version, the collections cut, that the
summary was re-extracted, and the evidence `qv-docs-line-cut` measured.

One PR, not two: nothing here renames a folder another commit writes into, so
there is no ordering to protect and no stacked base to retarget.

### Step 5: Hand it over

Report:

- the PR URL
- the collections it cuts and the version each publishes
- that promotion to production happens **after** the version is on npm, not on
  merge — step 9 of `RELEASE-TRAIN.md`, or after step 3 of the release flow in
  `gitflow.md`
- the review procedure: `docs/website/docs-workflow.md`, "Reviewing the cutoff
  PR"

If the documentation engineer reports a problem, reset the branch and re-run
rather than patching it. The PR is script output, and a cut commit must never be
rebased — replaying a cut onto a base that moved applies cleanly and produces an
incoherent tree.

## Quality Checklist

- [ ] Collections derived from the packages being released, via the manifest
- [ ] Per collection, `<x.y>` checked against the line last cut
- [ ] Branch cut from `ORG_REMOTE/main`, tree clean at the start
- [ ] The API summary regenerated into the line being published, body changed
- [ ] One `cut-line.ts` invocation and one commit per collection
- [ ] `npm run build` clean and `vitest` green before the PR is opened
- [ ] One PR URL reported, neither approved nor merged
- [ ] Promotion stated as a later step, gated on npm

## References

- Release procedures: `docs/ci/RELEASE-TRAIN.md` step 6,
  `docs/gitflow.md` "Release flow"
- The cut: `.agents/skills/qv-docs-line-cut/SKILL.md`
- Line model, review procedure and the production promotion:
  `docs/website/docs-workflow.md`
- Generator: `docs/website/scripts/generate-api-docs.ts`
