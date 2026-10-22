---
name: qv-docs-line-cut
description: Cut the next documentation line of every versioned collection whose current line has entered release — run scripts/cut-line.ts per collection, commit each cut on its own, verify it mechanically, and measure the evidence the PR body quotes. Use at a release cutoff (step 6b of docs/ci/RELEASE-TRAIN.md), when the coming version needs a folder to land in, or when invoking /qv-docs-line-cut.
---

# Documentation Line Cut

A versioned collection publishes its current line from a parenthesized folder,
whose pages answer at the version-less paths, and every line cut before it from
a plain folder. The current line is the **version under development**; each
plain folder is a version that shipped and documents that version alone.

A cut closes the current line and opens the next one as a copy. It runs at the
release cutoff, so the coming sprint's features have a folder to land in from
their first day.

`docs/website/scripts/cut-line.ts` performs the cut. This skill is the round
around it: which collections are due, in what order, what to measure, and what
the PR has to prove. Every command runs from `docs/website` unless stated
otherwise.

**Invoked from a flow, not by hand.** `qv-docs-cutoff` calls this skill as its
step 6b, after opening the PR that closes the line being released. It is
model-invocable for that reason. A human running `/qv-docs-line-cut` directly is
the exception — an out-of-band cut — and Step 1 is what refuses one made at the
wrong moment.

## The roster comes from the manifest, never from this file

`docs/website/src/lib/versions.ts` is the only list of cuttable collections.
Read it at the start of every run and derive, per entry with
`kind: 'collection'`:

- the **slug** the script takes, from `path` (`/sdk` → `sdk`)
- the **npm package** the line follows, from `package`
- the **current line**, the entry whose `folder` is parenthesized

Two collections are versioned today and more are coming, so never carry a
roster anywhere else. `cut-line.ts` reads the same manifest and refuses a slug
that is not a versioned collection, listing the ones that are.

## When to use

- A release cutoff: the sprint's versions are final and their release branches
  are cut, so the next version needs a folder before the coming sprint's first
  feature PR. Step 6b of
  [`docs/ci/RELEASE-TRAIN.md`](../../../docs/ci/RELEASE-TRAIN.md), invoked by
  the train's tech lead.
- To cut every line that is due in one PR.
- `/qv-docs-line-cut` invoked directly.

## What it does NOT do

- Does not release or publish. It reacts to a release that has started.
- Does not write the opened line's content; the sprint's feature PRs do.
- Does not open the PR. It leaves the tree committed and the evidence measured.
- Does not build the preserved line's content from anything but the outgoing
  folder. A line cut late carries whatever was written into the current line
  meanwhile — see "Cut on time".

## Workflow

### Step 1: Decide which lines are due

A line is cut when the version it documents **enters release**, not when that
version ships. The current line is the version under development; once its
release branches are cut, development has moved to the next version and that
next version needs a folder. This is step 6b of
[`docs/ci/RELEASE-TRAIN.md`](../../../docs/ci/RELEASE-TRAIN.md), run by the
train's tech lead as part of the release procedure.

**The moment is declared, not detected.** The tech lead invokes this skill at
step 6b, naming the version being released. Do not try to infer from the
repository that a cutoff has arrived: a `release-train-*` branch can be cut
early and sit open for days, so its mere existence says nothing about whether
the sprint is over. The invocation is the signal.

What this step does is **verify the declared moment against the state**, per
collection, and refuse a cut that does not fit:

```bash
npm view <package> version
```

- **Published version one minor below the current line** → on time. The current
  line is the version entering release; npm still serves the one before it.
  Cut the next minor.
- **Published version equal to the current line** → **the cut is late.** That
  version is already out, and the sprint after it has been writing into its
  folder. Report it before cutting: the opened line will carry prose about
  features that release never shipped, and the preserved folder keeps a copy.
  See "Cut on time".
- **Published version above the current line** → stop and ask. A line was
  skipped, which this skill does not resolve.
- **Current line is not the version the tech lead named** → stop and ask. Either
  the cut already ran for this cutoff, or the collection is a release behind.

**Never read the version from `packages/<name>/package.json` on `main`.** The
release bumps it on the release branch, and `main` only catches up when the
backmerge lands. The registry is the signal.

Report the roster, the published version, the version being released, and the
verdict per collection before cutting anything.

**Branch off step 6a, not off `main`.** Step 6a regenerates the API summary of
the line being closed, in its own PR that has not merged yet when you run. A cut
renames the folder 6a writes into, so a cut branched from `main` silently
reverts 6a in the preserved line once both merge — measured: `main` keeps the
*old* summary in the published folder and conflicts only in the opened one,
which nobody is reading yet. Branch 6b from 6a's branch and both merge clean, in
order. If 6a's commit is not in your history, stop.

### Step 2: Cut each due collection, one commit each

Per collection, in manifest order:

```bash
bun run scripts/cut-line.ts <slug> v<major>.<minor+1>
git -C ../.. add -A docs/website
git -C ../.. commit -m "docs: cut the <Collection> v<major>.<minor+1> documentation line"
```

The commit between collections is not optional: `cut-line.ts` refuses a working
tree that already carries changes under `docs/website`, because a cut is
reviewed as its own diff. That refusal is what makes one commit per collection
the natural granularity, and it scales linearly — N collections, N runs, N
commits.

The script prints every path it touched. Expect the two folders, the manifest,
the redirects, and the pages it relabelled. It refuses, before writing
anything, a slug that is not a versioned collection, a version carrying a patch
component, a version not above the current line, a destination already on
disk, and a dirty tree.

### Step 3: Verify each cut mechanically

Per collection, against the commit that made the cut:

```bash
diff -r content/docs/<slug>/<preserved> 'content/docs/<slug>/(<opened>)'
```

Two differences are reported, and only these two:

- the **title line of each page whose title names the series**, where the
  opened line gains the `(latest)` marker the preserved line loses
- the **release-notes link in `reference/meta.json`**, where each line points
  at its own minor's GitHub release rather than the one it was copied from

A collection with neither reports nothing and exits 0 — a line with no marker
and no release link is a valid line, not a failure.

Second proof, free from git: the commit records the opened folder as a rename
of the outgoing one, at 100% similarity for every page except the ones
relabelled. Quote it alongside the diff.

### Step 4: Check for a hardcoded current line

```bash
rg "\(v[0-9]+\.[0-9]+\)" src tests scripts
```

Every hit must be a fixture with a synthetic version or a comment. A test
asserting against the real current line breaks on the cut and must derive it
from the manifest through `getCurrentLine()` instead. This is the one step
`cut-line.ts` does not cover.

### Step 5: Run the checks that reject a bad cut

```bash
npm run build
bun run vitest run --exclude '**/tsdoc-completeness*'
```

That is exactly what `.github/workflows/docs-website-pr-checks.yml` gates on.
Between them they reject a manifest disagreeing with the folders, a collection
left with no group or two, a patch-shaped folder name, a line numbered above
the group, a URL that stopped resolving, and an artifact reaching into another
line. `tsdoc-completeness` is excluded here because CI runs it separately with
`continue-on-error`; it reads `packages/sdk` and never touches `content/docs`.

### Step 6: Hand over the evidence

The PR is mechanical, so its body carries the commands a reviewer replays
rather than asking anyone to read 10k lines of copied content. Per collection:
the `diff -r` of Step 3 with **its measured output**, and the rename similarity
of Step 2.

**Never write a number into the body that was not just measured.** A body
promising a diff size that the tip no longer produces is worse than no body —
it sends the reviewer looking for a discrepancy that is the body's fault.

## Cut on time

Cut at the cutoff — the morning the sprint's versions are declared final and
their release branches are cut — not when the release goes live days later, and
not when the next one is being prepared. The current line is always the version
under development, and the cut is what moves that pointer forward.

A late cut is not merely late. While the next version has no folder, the
sprint's feature PRs document their features inside the line that is still
current, which by then is a version in release or already published. The cut
then preserves that contaminated folder and copies it forward, so the published
line describes features its release never shipped. That is QVAC-27286: `cli/v0.16`
documented five features 0.16.0 never had.

Two things catch it before readers do. `Docs lines up to date with main` in
`docs-website-pr-checks.yml` fails a branch whose line set is older than main's,
which is how a pre-cut branch's edits reach a preserved folder. And the
promotion preflight prints the content diff this release publishes, for review
before the approval.

Recovering from a late cut costs an extra commit that resets the preserved
folders to the tree of the release's backmerge commit, and the PR stops being
pure script output.

## If the base moved under the branch

**Never rebase a cut commit.** A cut is "rename the current folder and copy
it", not a patch. Replaying it onto a base that moved applies cleanly and
produces an incoherent tree: the opened line keeps the content from the old
base while the preserved line gets the new one.

Reset onto the base and re-run the script instead. That is cheap precisely
because the commits are script output.

Stack the cut on step 6a's branch and nothing else. That one stack is required
(see Step 1); any other is not. Note the cost and warn the reviewer: when 6a
merges, GitHub retargets this PR to `main`, and a base change dismisses every
approval on it — GitHub treats it as its own reason, apart from
`dismiss_stale_reviews_on_push`. Since the two PRs are merged back to back by
the same reviewer, re-approving is the whole cost.

## Quality Checklist

- [ ] Roster read from `src/lib/versions.ts`, not assumed
- [ ] Each collection's verdict based on the train branch, with `npm view` read as the timing check — never on `main`'s manifest
- [ ] Step 6a's API-summary commit already on `main` before cutting
- [ ] One `cut-line.ts` invocation and one commit per collection
- [ ] `diff -r` run per collection, output recorded
- [ ] Opened line's `reference/meta.json` links its own minor's GitHub release
- [ ] No hardcoded current line left in `src`, `tests`, or `scripts`
- [ ] `npm run build` clean and `vitest` green minus `tsdoc-completeness`
- [ ] Every number in the PR body measured against the branch tip

## References

- Cut: `docs/website/scripts/cut-line.ts`
- Hand procedure and the rest of the site's versioning:
  `docs/website/README.md`, "Cutting a documentation line"
- Manifest: `docs/website/src/lib/versions.ts`
- Checks: `docs/website/tests/line-structure.test.ts`,
  `docs/website/tests/cut-line.test.ts`,
  `.github/workflows/docs-website-pr-checks.yml`
