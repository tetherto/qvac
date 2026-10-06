## Why

The SDK release runs a skill, and its docs step no longer works. `qv-sdk-changelog` Step 8 calls `scripts/release-version.ts`, which was retired when versioning became documentation lines: it prints a refusal and exits 1. The skill treats that as fail-stop, so a release now halts at the docs step. Everything Step 8 says about the run is wrong with it — the two output folders it names do not exist, the manifest it says the script writes is hand-edited, and the managed `_redirects` block it says a minor rotates was deleted. `docs-workflow.md`, cited as the full reference, documents the retired scheme and says so itself.

Worse than the hard failure is a quiet one. The two live generators resolve their target as "the current line, per the manifest" and never check that the version they were handed belongs to it. Run for `0.21.0` while the current line is still `v0.20`, the release-notes generator writes a page titled `v0.21.x` into the `(v0.20)` folder and deletes that line's own release notes. The build and the suite both pass afterwards. The permanent record of a shipped release is destroyed with no signal.

The new model puts a precondition in front of the release that nobody wrote down: the line is cut right after the previous release deploys, so the coming release's folder already exists when the SDK team runs the skill. Nothing states this, and nothing fails usefully when it has not happened.

## What Changes

- The generators refuse a version that is not the current line's, naming both, before writing anything. A version can only be written into the line that carries it.
- Cutting a line becomes one command. It performs the rename, the copy, the manifest edit, the preserved line's redirect pair, and the currency relabel, for any versioned collection. The hand path stays valid and the build stays the arbiter — the script is a way to make the edit, never a step the release depends on.
- The currency marker becomes part of the cut. Today the `(latest)` suffix on the two reference titles is set only by a generator flag, and the flag that used to clear it from a frozen line can no longer reach one, so a cut leaves the preserved line claiming to be current.
- `qv-sdk-changelog` Step 8 is rewritten to the commands that exist, the paths that exist, and the precondition that the line is already cut.
- `qv-sdk-backmerge` names the docs surfaces the release commit now carries, so its conflict triage and PR body account for them.
- `docs-workflow.md` is rewritten for the line model, and the README's cut procedure points at the script.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `docs-release-workflow`: gains what a release regenerates and by which commands, the refusal that keeps a version out of another line, the cut as one command, and the currency marker following the cut. The requirement holding that a cut is performed by hand is amended so the script can exist without becoming required.

## Impact

- `docs/website/scripts/cut-line.ts` — new.
- `docs/website/scripts/generate-api-docs.ts`, `scripts/generate-release-notes.ts` — the refusal; the stale header prose in the second.
- `docs/website/scripts/lib/release-shared.ts` — the current-line lookup grows the check the refusal needs.
- `docs/website/tests/` — the refusal and the cut, in both directions.
- `docs/website/docs-workflow.md`, `docs/website/README.md` — rewritten and amended.
- `.agents/skills/qv-sdk-changelog/SKILL.md`, `.agents/skills/qv-sdk-backmerge/SKILL.md` — outside `docs/website`, and the reason the whole change exists.
- No page moves, no URL changes, no redirect changes beyond what a future cut will add.
