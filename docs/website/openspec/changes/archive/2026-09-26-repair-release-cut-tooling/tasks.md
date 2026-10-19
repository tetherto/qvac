## 1. Refuse a version that is not the current line's

- [x] 1.1 Replace the current-line lookup in `scripts/lib/release-shared.ts` with one that takes the version being generated and returns the reference folder only when the current line's major and minor match it.
- [x] 1.2 Throw on mismatch, naming the version asked for, the line that is current, and the cut that is missing.
- [x] 1.3 Call it from `generate-api-docs.ts` and `generate-release-notes.ts`, so neither can resolve a target without passing it.
- [x] 1.4 Cover both directions in a test: the matching version resolves, a version ahead refuses, an older line refuses.
- [x] 1.5 Prove it against the tree by reproducing the original failure — generate `0.21.0` while the current line is `v0.20` — and confirm the refusal writes nothing.

## 2. Cut a line with one command

- [x] 2.1 Write `scripts/cut-line.ts` taking a collection and the version to open.
- [x] 2.2 Refuse an unversioned collection, a version not above the current line, an occupied destination, or a dirty working tree, before touching anything.
- [x] 2.3 Rename the outgoing folder group to its plain form and copy it to the new group.
- [x] 2.4 Rewrite the manifest: the outgoing entry's folder becomes plain, and the new entry is inserted above it.
- [x] 2.5 Append the preserved line's index pair to `public/_redirects`, beside the pairs already there.
- [x] 2.6 Clear the currency marker from the preserved line's reference titles and set it, with the new number, on the opened line's; touch only the files that carry it.
- [x] 2.7 Report what was changed and leave verification to the build.
- [x] 2.8 Test it end to end against a copy of the tree, and confirm the result is what the hand procedure produces.

## 3. Fix the written instructions

- [x] 3.1 Rewrite Step 8 of `.agents/skills/qv-sdk-changelog/SKILL.md`: the precondition that the line is cut, the two generator commands, the minor and patch split, and the real output paths.
- [x] 3.2 Remove the manifest and `_redirects` from what that step writes, in the step, the Output section, and the Quality Checklist.
- [x] 3.3 Name the docs surfaces the release commit carries in `.agents/skills/qv-sdk-backmerge/SKILL.md`, in the conflict triage and the PR body template.
- [x] 3.4 Rewrite `docs-workflow.md` for the line model, dropping the superseded section and the retired orchestrators.
- [x] 3.5 Point the README's cut procedure at the command, keeping the hand procedure as what it does.
- [x] 3.6 Correct the stale target prose in the header of `generate-release-notes.ts`.

## 4. Verify

- [x] 4.1 Run both generators for the current version and confirm they write where they did before.
- [x] 4.2 Run `npm run build` and confirm every check passes.
- [x] 4.3 Run `npm test` and confirm the suite passes.
- [x] 4.4 Confirm no reference to a retired script survives outside the retired scripts themselves.

## 5. Land it

- [x] 5.1 Validate with `openspec validate repair-release-cut-tooling --strict` and archive.
- [x] 5.2 Check the published `docs-release-workflow` spec after archiving.
- [x] 5.3 Commit the whole change as one commit.
