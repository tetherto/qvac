## Context

What a release does to the docs site today, verified against the tree:

- Four scripts refuse to run: `release-version.ts`, `release-version-minor.ts`, `release-version-patch.ts`, `update-versions-list.ts`. `refuseRetiredScript` prints and exits 1.
- Two generators are live and correct. `generate-api-docs.ts` and `generate-release-notes.ts` both resolve their target through `CONTENT_REFERENCE` in `scripts/lib/release-shared.ts`, which is `content/docs/sdk/<current line folder>/reference`, read from the manifest. Running them wrote to the right place.
- `src/lib/versions.ts` is a hand-edited manifest. `DOCUMENTED_SOFTWARE` holds six entries; a collection's first version is its current line and is the only one whose folder is parenthesised.
- `public/_redirects` has no managed block. Preserved lines are literal pairs, two rules each, one per line, because a segment with a dot misses the CDN's slash normalisation.
- No CI workflow references any retired script. The damage is confined to the two skills and `docs-workflow.md`.

The precondition nobody wrote down: `docs-release-workflow` requires the cut immediately after a release deploys. So when the SDK team runs the release skill for `0.21.0`, `(v0.21)` already exists and is current. When it does not, the generator writes into `(v0.20)`.

## Goals / Non-Goals

**Goals:**

- A release that runs the skill either produces the right pages or stops with a message naming what is wrong.
- A cut is one command, reviewable as a diff, for any versioned collection.
- The written instructions — the skill, `docs-workflow.md`, the README — describe the commands that exist.

**Non-Goals:**

- Changing when a cut happens, or what the version-less paths serve during a cycle. Both were decided and stand.
- Moving the cut into the release skill. It stays with the documentation engineer, as one small PR, the same shape for the SDK and the CLI.
- Reviving the retired scripts, or deleting them. They are kept on disk for reference and refuse to run; that is already the decision.
- Reworking the currency marker itself. Whether a title should still say `(latest)` now that the switcher and the release label both state it is a separate question; this change only stops the marker from lying.

## Decisions

### The generators refuse, rather than a checker catching it afterwards

The failure mode is destructive: the full render overwrites the previous line's release notes, so by the time a build ran, the content is gone and only git holds it. A check on the built tree would report the damage, not prevent it. The refusal goes where the damage would be done — before the first write, in the target resolution both generators already share.

So `release-shared.ts` grows a function that takes the version being generated and returns the reference folder only when the current line's major and minor match it. Mismatch throws, naming the version asked for and the line that is current, and saying that the line is cut before the release is documented. Both generators call it; neither can opt out, because the constant they import is what the function replaces.

This deliberately also refuses a legitimate-looking case: regenerating an older line's pages. That is already forbidden — "a released line is never regenerated" is in both generators' headers — so the refusal enforces something the code only asserted in prose.

### The cut script does the whole cut, and is never required

`docs-release-workflow` says a cut needs no tooling and the build is what rejects an incorrect one. That is worth keeping: a release that depends on a script is what just broke. The script is therefore a convenience that produces exactly the edit a person would make by hand, and the hand path in the README stays.

One command, one collection, one version:

```
bun run scripts/cut-line.ts <collection> <new-version>
```

It renames the outgoing group, copies it forward, rewrites the manifest entry and inserts the new one, appends the preserved line's redirect pair beside the existing ones, and clears the currency marker from the preserved line's titles. It refuses when the collection is not versioned, when the new version is not above the current line, when a folder is in the way, or when the tree is dirty — a cut is a reviewable diff, and a dirty tree makes it unreadable.

It does not run the build. The operator does, and the existing checks are what accept the result.

### The currency marker is the cut's business, not a generator flag's

Today `--latest` adds `(latest)` to a title and `--title-only` was how the minor orchestrator cleared it from the frozen series. That orchestrator is retired, and `--title-only` now resolves to the current line, so nothing can reach a frozen one. The marker survives only because the migration set it by hand.

Currency is a property of which folder is parenthesised, and the cut is the only event that changes it. So the cut relabels: the preserved line loses `(latest)`, the new line's copy gets the new series and keeps it. `--latest` stays on the generators, because a regeneration of the current line must not silently drop the marker the cut set.

### The skill keeps a docs step, shrunk to what is real

Step 8 stays where it is and keeps its shape — prerequisites, generate, verify with a build, leave staging to the operator. What changes is its content: the precondition that the line is cut, the two commands instead of the dispatcher, the real paths, and the removal of `_redirects` and the manifest from the list of files the step writes. Neither is touched by a release any more; both are touched by a cut.

The minor and patch split survives, because it is real: a minor renders both pages, a patch appends a section to the release notes and leaves the API summary alone, since the public API is frozen at the minor boundary.

## Risks / Trade-offs

**The refusal blocks a release when the cut was forgotten** → That is the point, and the message says which edit is missing. The alternative is the silent overwrite that exists today.

**A script for an operation the spec says needs none** → Kept honest by the requirement: the hand path stays documented in the README and the build stays the arbiter. If the script ever disagrees with the hand path, the build is what says so.

**The skills live outside `docs/website`** → This OpenSpec instance governs the site, and the skill is the site's consumer. Editing it from here is the reason the change exists, but it means the skill can drift again without this instance noticing. Nothing here prevents that; the refusal is what makes the drift loud instead of quiet.

**Relabelling titles inside a copied tree** → The cut rewrites two frontmatter lines in the preserved line and two in the new one, by the same line-oriented rewrite the generators already use. A collection whose reference pages are named differently — the CLI has no `api.mdx` — must not fail the cut, so the relabel is best-effort per file and reports what it touched.
