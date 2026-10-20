---
name: qv-docs-line-cut
description: Cut the next documentation line of every versioned collection whose release has already shipped — run scripts/cut-line.ts per collection, commit each cut on its own, verify it mechanically, and measure the evidence the PR body quotes. Use when a release goes live, at the start of a sprint when the coming version needs a folder to land in, or when invoking /qv-docs-line-cut.
disable-model-invocation: true
---

# Documentation Line Cut

A versioned collection publishes its current line from a parenthesized folder,
whose pages answer at the version-less paths, and every line cut before it from
a plain folder. A cut preserves the outgoing line and opens the next one as a
copy, so the sprint's features have a folder to land in while the version-less
paths keep serving what was just released.

`docs/website/scripts/cut-line.ts` performs the cut. This skill is the round
around it: which collections are due, in what order, what to measure, and what
the PR has to prove. Every command runs from `docs/website` unless stated
otherwise.

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

- A release of a documented collection has gone live and its line must be cut
  before the sprint's first feature PR needs a folder.
- At the start of a sprint, to cut every line that is due in one PR.
- `/qv-docs-line-cut` invoked directly.

## What it does NOT do

- Does not release or publish. It reacts to releases that already shipped.
- Does not write the opened line's content; the sprint's feature PRs do.
- Does not open the PR. It leaves the tree committed and the evidence measured.
- Does not build the preserved line's content from anything but the outgoing
  folder. A line cut late carries whatever was written into the current line
  meanwhile — see "Cut on time".

## Workflow

### Step 1: Decide which lines are due

For each collection in the manifest, ask the registry for the published
version of the package it follows:

```bash
npm view <package> version
```

Compare its major.minor against the collection's current line:

- **Equal** → due. The current line has shipped, and the line to open is the
  next minor.
- **Below** → not due. The current line is still unreleased; leave it open and
  skip the collection.
- **Above** → stop and ask. A line was skipped, which this skill does not
  resolve.

**Never read the version from `packages/<name>/package.json` on `main`.** The
release bumps it on the release branch, and `main` only catches up when the
backmerge lands, so a shipped release still reads as the previous version
there. The registry is the signal.

Report the roster, the published version, and the verdict per collection before
cutting anything.

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
diff -r -x release-notes.mdx content/docs/<slug>/<preserved> 'content/docs/<slug>/(<opened>)'
```

The only difference reported is the **title line of each page whose title names
the series**, where the opened line gains the `(latest)` marker the preserved
line loses. A collection publishing no such page reports nothing and exits 0 —
a line with no marker anywhere is a valid line, not a failure.

`release-notes.mdx` is excluded because the cut empties it by design: the
opened line's notes share nothing with the line before them, so carrying them
over would publish the previous release's notes under the new line's title and
turn the release PR's diff into a wholesale replacement. The page itself stays,
because `reference/meta.json` lists it.

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

Cut as soon as the release goes live, not when the next one is being prepared.
A line cut late is not just late: while the folder is missing, the sprint's
feature PRs document their features inside the line that is still current, so
the preserved line ends up describing features its release never shipped.
Recovering costs an extra commit that resets the preserved folders to the tree
of the release's backmerge commit, and the PR stops being pure script output.

## If the base moved under the branch

**Never rebase a cut commit.** A cut is "rename the current folder and copy
it", not a patch. Replaying it onto a base that moved applies cleanly and
produces an incoherent tree: the opened line keeps the content from the old
base while the preserved line gets the new one.

Reset onto the base and re-run the script instead. That is cheap precisely
because the commits are script output.

Avoid stacking the cut on another branch. Changing an open PR's base dismisses
every approval on it — GitHub treats the base change as its own reason, apart
from `dismiss_stale_reviews_on_push`.

## Quality Checklist

- [ ] Roster read from `src/lib/versions.ts`, not assumed
- [ ] Each collection's verdict based on `npm view`, not on `main`'s manifest
- [ ] One `cut-line.ts` invocation and one commit per collection
- [ ] `diff -r -x release-notes.mdx` run per collection, output recorded
- [ ] Opened line's `release-notes.mdx` holds the placeholder, frontmatter kept
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
