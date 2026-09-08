---
name: release-patch
description: Back-port fix(es) onto an existing release line and cut a patch release. Create the new release branch from the base with NO direct commits, land the fix(es) and the version+changelog bump via PRs into it, then publish via the `release` skill. Use for patching a shipped version (e.g. what an older SDK release pins) without pulling in later main-line changes.
argument-hint: "<package> <fix-PR-or-commit>... [base-release-branch]"
disable-model-invocation: true
---

# Release Patch — back-port a fix to an existing release line

Cut a patch release on an **existing release line** (a shipped `x.y.z` a consumer still depends on)
by back-porting one or more already-merged fixes, **without** dragging in later main-line changes.

Use this when, e.g., an older SDK release pins `@qvac/<pkg> ^0.36.3` and needs a fix that only landed
on `main`/a newer minor. The output is a new patch (e.g. `0.36.4`) published under the line's
maintenance dist-tag — `latest` is left pointing at the newest version.

`<package>` is the directory name under `packages/` (e.g. `llm-llamacpp`). `<fix-PR-or-commit>` is one
or more merged fix PRs (or their squash-merge SHAs). `[base-release-branch]` is the release line to
patch (e.g. `release-llm-0.36.3`); if omitted, discover it in Step 1.

## Golden rule

**Never commit or `git push` directly onto a `release-*` branch.** The `release-*` ruleset requires all
changes to arrive via a merged PR (a bare branch *creation* push is allowed; subsequent commits are
rejected — `GH013 … Changes must be made through a pull request`). So: create the release branch as an
exact copy of the base, push it once, then land **every** change (fix cherry-picks, version bump) via
PRs whose base is that release branch.

## Workflow

### Step 1 — Identify the target release line + next version

1. Determine the version the consumer needs — read its dependency spec, e.g. the SDK's
   `packages/sdk/package.json`: `"@qvac/<pkg>": "^0.36.3"` → the `0.36` line, and the patch must be
   `>= 0.36.3 < 0.37.0`.
2. Find the **actual** release-line ref. ⚠ **Naming is not uniform.** The `release` skill's default is
   `release-<package>-<version>` / tag `<package>-v<version>`, but real patch lines have used a short
   prefix: branch `release-llm-<version>` + tag `llamacpp-llm-v<version>`. Do not assume — verify:
   ```bash
   git ls-remote origin 'release-*' | grep -i <pkg>        # candidate branches
   git ls-remote --tags origin | grep -iE '<pkg>|llm'      # candidate tags
   ```
   Pick the branch/tag that actually holds the target version (confirm with
   `git show <ref>:packages/<pkg>/package.json | grep '"version"'`). That commit is the **base**.
3. **Next patch version** = base patch + 1 (must satisfy the consumer range and stay below the next
   minor). Record it as `<newver>` and the base branch as `<base>`.

### Step 2 — Resolve the source commits (use the SQUASH-merge SHAs on `main`)

For each fix PR, take the **squash-merge commit on `main`**, not the PR's individual branch commits:
```bash
gh pr view <N> --repo tetherto/qvac --json number,title,mergeCommit --jq '{n:.number,title,sha:.mergeCommit.oid}'
```
Do **not** cherry-pick a version/changelog-only PR (e.g. a prior `x.y.z` bump) — that bump is redone
for this line in Step 6.

### Step 3 — Assess cherry-pick cleanliness BEFORE touching anything

For each source commit, diff its touched files between the base and the commit's parent:
```bash
git diff --numstat <base> <squash-sha>~1 -- <touched-paths>
```
Empty output ⇒ that file is identical at the base ⇒ the hunk applies cleanly. Non-empty ⇒ that file
diverged ⇒ expect a conflict there (typically test files). If the **core source files** are identical,
the back-port is safe; a few diverged test files are resolved by grafting in Step 5. If everything is
heavily diverged, stop and reconsider (the fix may need manual porting, not a cherry-pick).

### Step 4 — Create the release branch from the base — NO changes — and push it

```bash
git -C <repo> fetch origin <base>
git -C <repo> worktree add <wt> origin/<base>
git -C <wt> checkout -b release-<pkg>-<newver>     # exact copy of the base, no edits
git -C <wt> config user.email "<you>"; git -C <wt> config user.name "<you>"
git -C <wt> push origin release-<pkg>-<newver>     # branch-creation push (allowed)
```
Commit identity = the releaser; **never add an AI signature / `Co-Authored-By`**. Confirm HEAD == base
commit. Do not bump the version here — leave it at the base value (publish-safe).

### Step 5 — PR #1: the fix(es), into the new release branch

Work on a **normal-named** branch (not `release-*`, so it isn't push-protected):
```bash
git -C <wt> checkout -b <TICKET>/backport-<pkg>-<newver>
git -C <wt> cherry-pick <squash-sha>...
```
Resolve only the expected diverged-file conflicts by **grafting** the commit's added block into the
base file (keep the base file's structure; do not reformat unrelated lines). All identical-at-base
files apply automatically.

**Validate completeness** (that the cherry-pick captured the source, nothing missed):
- Cleanly-applied files — resulting blob byte-identical to the source commit's post-image:
  `git rev-parse <squash-sha>:<file>` == `git rev-parse HEAD:<file>` for each.
- Manually-resolved files — the added lines equal the commit's added lines
  (`git show <squash-sha> -- <file>` `+`-lines vs `git diff <base> HEAD -- <file>` `+`-lines).

Push the helper branch; open PR #1 with **base = `release-<pkg>-<newver>`** (four-emoji body; link the
source PR(s)).

**CI:** add the matrix labels — `prebuilds`, `run-cpp-addon-tests`, `run-desktop-addon-tests`,
`run-mobile-addon-tests`, `run-coload-tests` — to run the fix-validating jobs. **Do not add
`verified`**: `ci-router` reads only those five names, so `verified` selects no stage and fails
silently, costing a CI round. (The label still exists and its siblings' descriptions still read
"requires verified" — that text is stale; the label gate was retired, and
`ci-trust-policy.test.mjs` asserts it stays retired.) Auto-approve the `release`
environment deployment when it appears. **Always read failures from full logs via**
`gh api repos/tetherto/qvac/actions/jobs/{id}/logs` — `gh run view --job --log` silently truncates
(~1.1 MB of ~9 MB) and can fake a "hang". Triage flaky-vs-real; pre-existing environment failures
(e.g. `test-darwin-x64` macOS-x64-VM timeouts) are non-gating and not blockers — confirm the fix's own
tests pass. Merge PR #1 into the release branch.

### Step 6 — PR #2: version + CHANGELOG bump, into the release branch

On another helper branch off the (now fix-carrying) release branch:
- `packages/<pkg>/package.json`: base version → `<newver>`.
- `packages/<pkg>/CHANGELOG.md`: add `## [<newver>] - <YYYY-MM-DD>` (bracketed heading — the release
  workflow requires this format) above the base entry; reuse the original fix's changelog wording,
  crediting the fix PR(s). `package.json` version MUST equal the new heading.
- Keep the version at the base value until this PR so nothing publishes early.
- Lint gate varies by line era — run `npm run lint` in `packages/<pkg>` (older release lines use
  `standard`, newer use `prettier`); match whatever that branch enforces.

Open PR #2 (base = `release-<pkg>-<newver>`).

### Step 7 — Release (merging PR #2 auto-triggers publish; use the `release` skill to verify)

Merging the bump PR into the `release-*` branch is a **trusted push** → `on-merge-<pkg>.yml` runs and
publishes automatically. No labels are needed on a merge/push: `push` is a trusted event in
`ci-router`, which short-circuits label parsing and enables every stage on its own. Publication is
gated by version>npm + `release-merge-guard`. Follow the **`release` skill** for the monitor/verify mechanics (its Steps 4–6),
with these **nuances**:

- **`release`-skill latest-guard caveat.** The `release` skill's Step 1 compares the local version to
  npm **`latest`** and stops if not higher. A back-port (e.g. `0.36.4` < `latest` `0.38.0`) fails that
  check — so the publish path for a maintenance patch is the **on-merge auto-trigger from the PR merge**,
  and you verify against the line's **maintenance dist-tag**, not `latest`. Use the `release` skill for
  its monitor/verify steps; don't let the latest-guard block a legitimate back-port.
- **dist-tag.** The `npm-dist-tag-determination` action publishes an older-than-`latest` patch under a
  **maintenance tag** (e.g. `release-<major.minor>`) and must NOT move `latest`. This is correct —
  consumer semver ranges (`^0.36.3`) resolve by version, so they still pick up the new patch.
- **`create-tag` job fails (HTTP 403/422).** It uses `secrets.GITHUB_TOKEN`, which is not authorized to
  create the protected release tag (no repo tag-ruleset; a user/PAT can). So the git tag is NOT created
  automatically — **create it manually** with a user/PAT credential:
  ```bash
  git tag <pkg-tag-prefix>-v<newver> <release-branch-sha>   # e.g. llamacpp-llm-v0.36.4
  git push origin <pkg-tag-prefix>-v<newver>
  ```
  (Longer-term fix: change `create-release-tag.yml` to use `secrets.PAT_TOKEN`, like `label-gate` does.)

### Step 8 — Verify

- `npm view @qvac/<pkg>@<newver> version` → the new patch exists.
- `npm view @qvac/<pkg> dist-tags` → `latest` **unchanged**; the new patch under its maintenance tag.
- The release git tag exists.
- The consumer's range now resolves to the new patch (`npm view @qvac/<pkg>@'<range>' version`).

## Nuances & gotchas (all hit for real; do not relearn them)

- **PR-only changes to `release-*`** — the ruleset blocks direct commits after branch creation. Land
  everything via PRs whose base is the release branch (helper branches are normal-named).
- **Cherry-pick the squash-merge SHA**, not PR-branch commits.
- **`gh run view --log` truncates** — use `gh api …/actions/jobs/{id}/logs`; sanity-check job duration
  vs timeout before believing a "hang". (See `reference_gh_job_log_truncation`.)
- **Merging into `release-*` auto-publishes** (on-merge, trusted push) — the version bump is the
  point-of-no-return; keep version at base until then.
- **Back-port dist-tag** goes to a maintenance tag, never clobbering `latest`.
- **`create-tag` 403/422** → create the tag manually (GITHUB_TOKEN can't; PAT/user can).
- **`release`-skill Step 1 latest-guard** doesn't fit back-ports — verify against the maintenance tag.
- **No AI signatures / `Co-Authored-By`** in commits or PRs.
- **Lint gate era** — `standard` on older release lines, `prettier` on newer; run `npm run lint`.

## Worked example — `@qvac/llm-llamacpp` 0.36.4 (QVAC-22472)

SDK 0.15 pinned `^0.36.3`; the `n_predict`-inside-reasoning fix was only on `main`/0.37+.
- Base: branch `release-llm-0.36.3` = tag `llamacpp-llm-v0.36.3` (`84be415c`, v0.36.3).
- Source: PR #3318 squash `0d782b12c` (the fix). PR #3327 (0.37.1 bump) NOT cherry-picked.
- Cleanliness: all C++/unit files identical at base; only `qwen3-5.test.js` diverged → grafted the one
  new test block; blob-identity confirmed for the rest.
- Branch `release-llm-0.36.4` created from base (no changes) → PR #3337 (fix) → PR #3342 (0.36.4 bump).
- Merge auto-published: run 29749326488; npm `0.36.4` under dist-tag `release-0.36`; `latest` stayed
  `0.38.0`. `create-tag` failed 403/422 → tag `llamacpp-llm-v0.36.4` created manually via SSH.

## Error handling

- Heavy cherry-pick conflicts across core source (not just tests) → the fix predates too much
  divergence; stop and port it manually or reconsider the base.
- `release-merge-guard` fails on merge → version not bumped or CHANGELOG heading missing/mis-formatted.
- Publish didn't run after merge → confirm the merge was a push to `release-*` and `packages/<pkg>/**`
  changed; check `on-merge-<pkg>.yml` runs.
- Publish ran but `latest` moved to the patch → the dist-tag logic mis-fired; restore with
  `npm dist-tag add @qvac/<pkg>@<real-latest> latest`.
