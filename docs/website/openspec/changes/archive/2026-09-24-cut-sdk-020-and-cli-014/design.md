## Context

The site publishes two versioned collections. Each holds its documentation as *lines*: one folder per major-minor version, the current one written as a Fumadocs folder group — `(v0.19)` — so it is excluded from the slug and serves at the collection's version-less paths. Every other line serves under its version segment. `src/lib/versions.ts` declares the set by hand, `src/lib/version-structure.ts` checks the declaration against the folders on disk, and every derived surface — the switcher, the sidebars, the canonical URLs, the per-line corpora, the line indexes, `versions.json`, the sitemap — is computed from the declaration at build time.

`@qvac/sdk` `0.20.0` and `@qvac/cli` `0.14.0` are released. `tether/main` carries both numbers in `packages/sdk/package.json` and `packages/cli/package.json`; the monorepo leaves a package at its released version between releases rather than bumping ahead, so the version the folder group should name is readable straight from those files. The site is at `0.19` and `0.13`.

The obstacle is a deliberate one. When the versioning model was designed, two lines was the chosen size — the minimum that exercises switching, fallback, canonical resolution, and corpus isolation — and the question of what becomes of a line pushed out by a third cut was left open rather than answered badly. The refusal was written into the specs and enforced in `checkCollection`, which fails the build and names the oldest line. Both collections sit at two, so the cut this change needs is exactly the one the build rejects.

## Goals / Non-Goals

**Goals:**

- Answer the open question: decide what becomes of a line a third cut would push out.
- Serve `@qvac/sdk` `0.20` and `@qvac/cli` `0.14` at the version-less paths.
- Keep every URL the site publishes today resolving, including the older lines' and the inventory's.
- Keep the cut a hand-performed content change that the build validates, with no new tooling.

**Non-Goals:**

- Describing what changed in `0.20` and `0.14`. The new lines start as copies, which is the model's defined behaviour; the editorial work is a separate change.
- Refreshing `@qvac/ai-sdk-provider` to `v0.8` in the inventory.
- Automating the cut. The workflow's position is that no tool is required to make a cut correct and the build is what rejects an incorrect one, and nothing here changes that.

## Decisions

### Retire nothing: every cut line stays published

The open question had three answers. Retire the oldest line to `content/_unpublished/` and redirect its URLs, which is the precedent the sixteen patch-series archives set. Raise the cap to three, which moves the wall one release further out and guarantees the same discussion at `0.21`. Or remove the cap, so a line that has been published stays published.

The cap is removed. The two arguments that decided it:

- A documentation line is the only record of how a released version behaved. Readers pinned to an older SDK are the people most in need of it, and they are the least able to reconstruct it from a newer line. Retiring lines on a schedule deletes exactly the material that is hardest to replace.
- The number two was never a limit the system needed; it was a floor chosen to prove the model works. Nothing in the code is sized by it. `getPublishedVersions`, `getCurrentLine`, `destinationsFor`, the corpus writers, and the line-index route all iterate the declared set. The grep for arity assumptions across `src`, `scripts`, and `tests` returns exactly one hit: a doc comment in `versions.ts` describing a collection as "one current line and one older line". The cap exists in two spec requirements, one guard clause, and one test — nowhere else.

The cost is real and is accepted rather than waved away. Each SDK cut adds 39 pages and each CLI cut adds 4, and each of those pages also lands in the search index, in its line's isolated corpus, and in the per-line Markdown twin. The site goes from 111 pages to 157 with this cut — 43 from the two lines and 3 from the inventory — and grows by about the same amount every release. The point at which that stops being affordable is a real future decision; this change does not pretend it has been solved, it decides that losing released-version documentation is the worse trade.

### The folder group becomes the latest released version, not a speculative next one

The baseline says the current line "is the version shipping next" and that between releases `main` carries a line for a version that has not shipped. Read literally against a repo where `0.20.0` is already live, that would make the group `(v0.21)` and leave a `v0.20` line containing `0.19`'s content — documentation labelled with a version it does not describe.

The requirement's own scenario resolves it in the other direction: "**WHEN** `@qvac/sdk` `0.18` is live on the site **THEN** `main` renames `(v0.18)` to `v0.18` and copies it to `(v0.19)`". Applied here, `0.19` is live on the site, so `(v0.19)` becomes `v0.19` and the copy becomes `(v0.20)` — and `0.20` is the released version, so the version-less paths serve a version that exists. That also matches how the site has actually been built: the group has tracked the major-minor in the package's `package.json`, which the monorepo holds at the last released number. The scenario and the practice agree, so this change follows them and leaves the requirement alone.

### The inventory window is a floor, not an exact set

Adding `v0.20` to the inventory while the requirement reads "each MUST carry its two most recent released versions" invites the reading that `v0.18` must now go. Dropping it would break `/ecosystem/inventory/sdk/v0.18/` and `/ecosystem/inventory/sdk-python/v0.18/` for no gain, and would contradict the decision just made for the collections.

The requirement is restated as a floor — at least the two most recent, and never fewer than what the entry already publishes — so growth is the only direction an entry moves. This is a clarification of intent rather than a reversal: the original text describes a package *gaining* its second version at its next minor release and never describes shedding one.

### The only redirect a cut owes is the preserved line's index

A cut needs a rule for a page the new line does not carry, and both new lines are exact copies, so no page rule is added. It does owe one thing regardless: the line it preserves becomes reachable at `/sdk/v0.19` and `/cli/v0.13`, whose last segment carries a dot, so the CDN reads it as a file request and never applies its slash normalization. Each preserved line therefore needs the `200` rewrite and the `301` below it, exactly as `v0.18` and `v0.12` already have.

No build gate catches a missing pair: the broken-link check is told to ignore line indexes, and the redirect replay exercises the built output rather than the CDN's matcher. It is caught by reading the rule set, which is why the tasks name it.

## Risks / Trade-offs

- **A line that is a copy is labelled with a version it does not describe.** `(v0.20)` will document `0.19`'s surface — including the Parakeet language codes and the KV-cache behaviour that `0.20` changed — until the editorial follow-up lands. → This is the model's defined behaviour, not a defect introduced here, and the SDK's two generated pages are regenerated so the API summary and release notes are accurate from the start. The mitigation that matters is scheduling the follow-up rather than leaving it implicit: the proposal names the specific surfaces it must cover.
- **Unbounded growth has no stated stopping point.** → Nothing in the build is sized by the line count, so the failure mode is gradual cost rather than a cliff: build time, index size, and corpus size grow linearly and visibly. Revisiting is a spec change, made when the cost is measurable rather than guessed at now.
- **Removing a build gate removes a check that has been catching something.** → Only the count clause goes. `checkCollection` keeps rejecting a collection with anything but exactly one folder group, a patch-shaped line name, a line numbered above the group, a stray non-line directory, and folders that disagree with the manifest. The test asserting the count rejection is rewritten to assert three lines are accepted, so the loosening is itself covered rather than silently untested.
- **The `ai-sdk-provider` entry ships knowingly stale.** The inventory requirement is unmet for that package the day this lands. → It is named in the proposal rather than hidden, and the restated requirement makes the fix purely additive: one version folder and one index line, with nothing to remove.

## Migration Plan

The cut is four hand edits per collection and one rebuild, in the order the build can verify:

1. Rename `content/docs/sdk/(v0.19)` to `v0.19` and copy it to `(v0.20)`; the same for the CLI, `(v0.13)` to `v0.13` and a copy to `(v0.14)`.
2. Relax `checkCollection` and its test, so the build accepts the declaration that follows.
3. Update `src/lib/versions.ts`: rename the two folders on the existing collection entries, add the two new group entries, add the three inventory versions.
4. Regenerate the SDK's API summary and release notes, which resolve the current line from the manifest and therefore write into `(v0.20)` once step 3 lands.
5. Add the three inventory version pages as the READMEs released in `sdk-v0.20.0` and `cli-v0.14.0`, and list them on their package indexes.
6. Build. The structure check, the broken-link check, the redirect replay, and the artifact check are the verification; there is no separate rollback step, because nothing is deleted and the change is a single reviewable diff.

Rollback is reverting the diff. No URL is retired and no redirect is added, so there is no state left behind outside the repository.

## Open Questions

- When does the growth stop being affordable? Deliberately unanswered. The decision above trades a bounded, measurable cost for the certainty of not losing released-version documentation, and the threshold should be set from measurements rather than fixed now.
