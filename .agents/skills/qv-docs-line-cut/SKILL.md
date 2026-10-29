---
name: qv-docs-line-cut
description: Cut the documentation line of the version being released in each collection the release moves — run scripts/cut-line.ts per collection, commit each cut on its own, verify it mechanically, and measure the evidence the PR body quotes. Use at a release cutoff (step 4 of qv-docs-cutoff), or when invoking /qv-docs-line-cut.
---

# Documentation Line Cut

A versioned collection publishes one folder per line it has cut: the
parenthesized one answers the version-less paths, every plain one carries its
version in the URL. The line still being written is not among them — it lives
at `content/_unpublished/<collection>/next/`, outside the site.

A cut publishes the line of the version being released:

- the outgoing group is renamed to its plain folder and keeps its content
- the development line is copied in as the new group, labelled with the
  version being released
- the development line stays where it is, now the next version's
- the manifest, the redirects and the currency marker follow

Nothing is deleted and the development line is never renamed, which is why a
feature PR that straddles the cutoff merges into the path it was written to.

The outgoing group is renamed, so a PR that edits it and merges after the cut
has two exact rename candidates for every page the sprint left alone, and git
picks one (QVAC-27286). `qv-docs-cutoff` lists those PRs before the cut, and the
`Documentation lines` job fails them until they are rebased — it is not a
required check, so it makes the window visible rather than withholding the
merge. Neither is this skill's to run; both are named here because they are
what keeps the rename from being silent.

`docs/website/scripts/cut-line.ts` performs the cut. This skill is the round
around it: which collections to cut, what to measure, and what the PR has to
prove. Every command runs from `docs/website` unless stated otherwise.

**Invoked from a flow, not by hand.** `qv-docs-cutoff` calls this skill as its
step 4, on a branch that already carries the regenerated API summary. It is
model-invocable for that reason. A human running `/qv-docs-line-cut` directly
is the exception — an out-of-band cut — and Step 1 is what refuses one made at
the wrong moment.

## The roster comes from the manifest, never from this file

`docs/website/src/lib/versions.ts` is the only list of cuttable collections.
Read it at the start of every run and derive, per entry with
`kind: 'collection'`:

- the **slug** the script takes, from `path` (`/sdk` → `sdk`)
- the **npm package** the line follows, from `package`
- the **line last cut**, the entry whose `folder` is parenthesized

Two collections are versioned today and more are coming, so never carry a
roster anywhere else. `cut-line.ts` reads the same manifest and refuses a slug
that is not a versioned collection, listing the ones that are.

## When to use

- Step 4 of `qv-docs-cutoff`, which is itself step 6 of
  [`docs/ci/RELEASE-TRAIN.md`](../../../docs/ci/RELEASE-TRAIN.md) or step 1 of
  the release flow in [`docs/gitflow.md`](../../../docs/gitflow.md).
- `/qv-docs-line-cut` invoked directly.

## What it does NOT do

- Does not release or publish. It reacts to a release that has started.
- Does not write content. The sprint's feature PRs wrote the line it publishes.
- Does not open the PR. It leaves the tree committed and the evidence measured.
- Does not promote to production. That waits for npm.

## Workflow

### Step 1: Check the moment, per collection

The moment is **declared, not detected**: the caller names the version being
released, and that invocation is the signal. A `release-train-*` branch can be
cut early and sit open for days, so its existence says nothing.

What this step does is check the declared version against the manifest, per
collection:

- `<x.y>` **above** the line last cut → the cut is due. The ordinary case.
- `<x.y>` **equal** to it → stop. This cut already ran.
- `<x.y>` **below** it → stop and ask. The collection is a release ahead.

No registry lookup is needed. Under this model a cut run late is not a
correctness problem — the sprint's prose was going into the development line
either way, never into a line already cut — so there is nothing to detect and
warn about. Run it when the release says to.

Report the roster, the version being released and the verdict per collection
before cutting anything.

### Step 2: Cut each collection, one commit each

Per collection, in manifest order:

```bash
bun run scripts/cut-line.ts <slug> v<x.y>
git -C ../.. add -A docs/website
git -C ../.. commit -m "docs: publish the <Collection> v<x.y> documentation line"
```

The version passed is the one being **released** — the line the cut opens, not
a successor to compute.

The commit between collections is not optional: `cut-line.ts` refuses a working
tree that already carries changes under `docs/website`, because a cut is
reviewed as its own diff. That refusal is what makes one commit per collection
the natural granularity, and it scales linearly — N collections, N runs, N
commits.

The script prints every path it touched. Expect the preserved folder, the
opened folder, the manifest, the redirects and the pages it relabelled. It
refuses, before writing anything, a slug that is not a versioned collection, a
version carrying a patch component, a version not above the line last cut, a
missing development line, a destination already on disk, and a dirty tree.

### Step 3: Verify each cut mechanically

Per collection, against the commit that made the cut. The opened line is a copy
of the development line:

```bash
diff -r content/_unpublished/<slug>/next 'content/docs/<slug>/(v<x.y>)'
```

Two differences are reported, and only these two:

- the **title line of each page whose title names the series**, where the
  opened line gains the `(latest)` marker the development line never carries
- the **release-notes link in `reference/meta.json`**, where the opened line
  points at its own minor's GitHub release

The preserved line is the outgoing group, unchanged but for the marker it lost:

```bash
git show --stat HEAD -- 'docs/website/content/docs/<slug>'
```

Expect the outgoing folder recorded as a rename at 100% similarity for every
page except the ones relabelled, and the opened folder recorded as additions —
a copy, not a rename, since the development line it came from is still there.

A collection with neither marker nor release link reports nothing from the
`diff -r` and exits 0. A line with no marker is a valid line, not a failure.

### Step 4: Check for a hardcoded line

```bash
rg "\(v[0-9]+\.[0-9]+\)" src tests scripts
```

Every hit must be a fixture with a synthetic version or a comment. A test
asserting against the real group breaks on the cut and must derive it from the
manifest through `getCurrentLine()` instead. This is the one step `cut-line.ts`
does not cover.

### Step 5: Run the checks that reject a bad cut

```bash
npm run build
bun run vitest run --exclude '**/tsdoc-completeness*'
```

That is exactly what `.github/workflows/docs-website-pr-checks.yml` gates on.
Between them they reject a manifest disagreeing with the folders, a collection
left with no group or two, a patch-shaped folder name, a line numbered above
the group, a symlinked line folder, a URL that stopped resolving, and an
artifact reaching into another line. `tsdoc-completeness` is excluded here
because CI runs it separately with `continue-on-error`; it reads `packages/sdk`
and never touches `content/`.

The development line is not built. Nothing under `content/_unpublished/` is,
and that is the point — but `tests/link-integrity.test.ts` reads it anyway, so
a broken link or a page with no title is rejected on the PR that wrote it. What
still surfaces only here is malformed MDX, which needs a render to find.

### Step 6: Hand over the evidence

The PR is mechanical, so its body carries the commands a reviewer replays
rather than asking anyone to read 10k lines of copied content. Per collection:
the `diff -r` of Step 3 with **its measured output**, and the rename and
addition counts of Step 2.

**Never write a number into the body that was not just measured.** A body
promising a diff size that the tip no longer produces is worse than no body —
it sends the reviewer looking for a discrepancy that is the body's fault.

## If the base moved under the branch

**Never rebase a cut commit.** A cut is "rename one folder and copy another",
not a patch. Replaying it onto a base that moved applies cleanly and produces
an incoherent tree: the opened line keeps the content from the old base while
the development line gets the new one.

Reset onto the base and re-run the script instead. That is cheap precisely
because the commits are script output.

## Quality Checklist

- [ ] Roster read from `src/lib/versions.ts`, not assumed
- [ ] Per collection, the version being released checked against the line last cut
- [ ] One `cut-line.ts` invocation and one commit per collection
- [ ] `diff -r` run per collection against the development line, output recorded
- [ ] Opened line's `reference/meta.json` links its own minor's GitHub release
- [ ] Development line still in place after every cut
- [ ] No hardcoded group left in `src`, `tests`, or `scripts`
- [ ] `npm run build` clean and `vitest` green minus `tsdoc-completeness`
- [ ] Every number in the PR body measured against the branch tip

## References

- Cut: `docs/website/scripts/cut-line.ts`
- The round that invokes this one: `.agents/skills/qv-docs-cutoff/SKILL.md`
- Line model and hand procedure: `docs/website/docs-workflow.md`
- Manifest: `docs/website/src/lib/versions.ts`
- Checks: `docs/website/tests/line-structure.test.ts`,
  `docs/website/tests/cut-line.test.ts`,
  `.github/workflows/docs-website-pr-checks.yml`
