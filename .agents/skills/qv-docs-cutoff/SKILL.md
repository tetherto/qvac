---
name: qv-docs-cutoff
description: Open the two documentation PRs of a release cutoff — one closing the line of the version being released, one opening the next version's line. Use at step 6 of docs/ci/RELEASE-TRAIN.md, when invoked from qv-release-train, or when invoking /qv-docs-cutoff.
---

# Documentation cutoff

The documentation site publishes one **line** per minor of each versioned
collection. The line in a parenthesized folder is the version **under
development**; every plain folder is a version that shipped and documents that
version alone.

A cutoff advances that pointer by two PRs into `main`:

- **6a — close the line being released.** Regenerate its API summary, so the
  line states the surface the release actually ships.
- **6b — open the next version's line.** The line just closed becomes a plain
  folder; a new parenthesized one takes over and receives the coming sprint's
  feature documentation from its first day.

This skill opens both and hands them to the documentation engineer. It runs at
the same moment the release branches are cut, because that is when `main` is
the release's source and when the next version starts.

## When to use

- Step 6 of [`docs/ci/RELEASE-TRAIN.md`](../../../docs/ci/RELEASE-TRAIN.md),
  invoked from `qv-release-train` right after the train branch is cut.
- `/qv-docs-cutoff` invoked directly, to redo a cutoff's documentation PRs.

## What it does NOT do

- Does not merge or approve either PR. The documentation engineer reviews both —
  that review is the only gate on the documentation side of a release — then
  merges 6a, records its merge commit, and merges 6b.
- Does not write prose. Feature documentation reaches the line through the
  sprint's own PRs (`qv-docs-update`), and is already on `main` by now.
- Does not promote anything to production. That is a separate manual workflow,
  run on release day against 6a's merge commit.

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

### Step 1: Check the moment and the tree

Read the version being released, `<x.y.z>`, from the invocation.

Confirm `<x.y>` is the current line of `/sdk` in
`docs/website/src/lib/versions.ts`. If it is not, stop and report: either this
cutoff's documentation PRs already exist, or the collection is a release behind.

Confirm the tree is clean (`git status --porcelain` empty) and fetch:

```bash
git fetch ORG_REMOTE main
```

Both PRs come off `main` so they carry documentation alone. The release's own
version bump, changelog and NOTICE live on the release head branch, which is a
different branch and stays there. A dirty tree means release work is still
uncommitted: stop, and let the release flow finish step 6 first.

### Step 2: PR 1 — close the line being released

Branch, regenerate, build:

```bash
git switch -c docs/cutoff-<x.y.z>-close-line ORG_REMOTE/main
cd docs/website && bun run scripts/generate-api-docs.ts <x.y.z> --force-extract
npm run build
cd ../..
```

This writes one file:
`docs/website/content/docs/sdk/(v<x.y>)/reference/api.mdx`. The SDK is the only
collection with a generated reference, so this is the whole of 6a.

**Confirm the body changed, not just the title.** `--force-extract` re-runs
TypeDoc; a diff of one line means it did not, and the page would then advertise
the new version while describing the previous one:

```bash
git diff --stat -- docs/website/content/docs/sdk
```

Commit and open the PR:

```bash
git add -A docs/website
git commit -m "docs: close the SDK v<x.y> line for <x.y.z>"
git push -u ORG_REMOTE docs/cutoff-<x.y.z>-close-line
```

Open it into `main`. The body states the version, that the summary was
re-extracted, and the diffstat just measured.

### Step 3: PR 2 — open the next version's line

Branch off **PR 1's branch**, then invoke `qv-docs-line-cut`:

```bash
git switch -c docs/cutoff-<x.y.z>-open-lines   # from the branch above, still checked out
```

`qv-docs-line-cut` reads the roster from the manifest and cuts every collection
whose current line has entered release, one invocation and one commit each. It
covers the CLI as well as the SDK, and it measures the evidence its PR body
quotes.

Open the PR with **base `docs/cutoff-<x.y.z>-close-line`**, so its diff shows
the cut alone. When PR 1 merges, GitHub retargets this PR to `main`.

Stacking on PR 1 is what makes the pair correct. Branched off `main` instead,
the two merge in order and git drops PR 1's regenerated summary from the
*preserved* folder — the one production serves — reporting a conflict only in
the freshly opened folder, which no reader has reached yet.

### Step 4: Hand both over

Report:

- both PR URLs, labelled 6a and 6b
- that they merge in that order, 6a first
- that merging 6a retargets 6b and dismisses its approval, so 6b needs
  re-approving
- that 6a's merge commit is the production promotion target, and the
  documentation engineer records it
- the review procedure: `docs/website/docs-workflow.md`, "Reviewing the two
  cutoff PRs"

If the documentation engineer reports a problem, reset the branch and re-run
rather than patching it. Both PRs are script output, and a cut commit must never
be rebased — replaying a cut onto a base that moved applies cleanly and produces
an incoherent tree.

## Quality Checklist

- [ ] `<x.y>` confirmed as the current line of `/sdk` in the manifest
- [ ] Both branches cut from `ORG_REMOTE/main`, tree clean at the start
- [ ] PR 1 carries one file, `content/docs/sdk/(v<x.y>)/reference/api.mdx`
- [ ] PR 1's diff is more than the title line, proving TypeDoc re-extracted
- [ ] `npm run build` clean before PR 1 is opened
- [ ] PR 2 branched off PR 1's branch, and its PR base is that branch
- [ ] PR 2 carries one commit per collection, from `qv-docs-line-cut`
- [ ] Both PR URLs reported with their merge order, neither approved nor merged

## References

- Release procedure: `docs/ci/RELEASE-TRAIN.md` step 6
- The cut: `.agents/skills/qv-docs-line-cut/SKILL.md`
- Line model, review procedure and the production promotion:
  `docs/website/docs-workflow.md`
- Generator: `docs/website/scripts/generate-api-docs.ts`
