---
name: qv-sdk-backmerge
description: Open the follow-up "backmerge" PR that lands a release's version bump + changelog onto main. Use after (or alongside) creating a release PR for an SDK pod package.
---

# SDK Pod Backmerge PR Creation

Create the backmerge PR that keeps `main` aligned with what shipped on a `release-<pkg>-<x.y.z>` branch, per `docs/gitflow.md` "Keep main aligned" sections.

## When to use this skill

**Applies to SDK pod packages** as defined in `.cursor/rules/sdk/sdk-pod-packages.mdc`.

**Use when:**

- A release PR has been (or is being) created for `release-<pkg>-<x.y.z>`
- User invokes `/qv-sdk-backmerge`
- `sdk-pr-create` chains into this flow automatically when the target is a release branch (see that skill's "Release Target Dual-PR Flow")

The backmerge PR carries the version bump + changelog metadata from the release branch onto `main` so future development sees it. It is tagged `[skiplog]` to keep it out of subsequent changelogs.

## Inputs (resolve in priority order)

1. **Active release-PR context** (when chained from `sdk-pr-create`): release PR number/URL, release branch, source head branch, ticket
2. **Explicit args** when invoked standalone:
   - Release PR URL/number, OR
   - `--package=<pkg> --version=<x.y.z>` and one of `--source=<head-branch>` or `--commit=<sha>`
3. **Inferred from current branch** when no args given: if currently on a head branch that targets `release-<pkg>-<x.y.z>`, derive package, version, and source from it
4. ASK only if still ambiguous after the steps above

## Branch / remote preference

Same policy as `qv-sdk-pr-create`: prefer pushing the backmerge head to the **org** remote (`tetherto/qvac`) and opening a same-repo PR. Personal-fork heads are a fallback and count as external for CI (`fork-ci` environment approval required per run on the current head SHA).

In command examples below, `ORG_REMOTE` / `FORK_REMOTE` are placeholders — substitute the resolved remote names from Step 1. Do not run those tokens literally.

## Workflow

### Step 1: Pre-flight

- `gh` is installed and authenticated (`gh auth status`)
- Working tree is clean (`git status` empty); if not, ASK whether to stash
- Identify **org remote**: scan `git remote -v` for the canonical org repo (`tetherto/qvac.git`); fall back to a remote literally named `upstream`. ASK if neither found.
- Identify **fork remote** if present (often `origin` when org is `upstream`) — used only when org push is unavailable or the user explicitly chooses the fork path
- Prefer org-branch push for the backmerge head

### Step 2: Resolve the cherry-pick source

| Scenario                              | Source range                                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Chained from `sdk-pr-create`          | `ORG_REMOTE/release-<pkg>-<x.y.z>..ORG_REMOTE/<source-head-branch>` (fetch the head first). If the org remote tip is missing, use the release PR head SHA from `gh pr view <num> --json headRefOid` instead of an unqualified local branch name. |
| Standalone with merged release PR     | The PR's merge/squash commit on `ORG_REMOTE/release-<pkg>-<x.y.z>` (`gh pr view <num> --json mergeCommit,headRefName`) |
| Standalone with `--commit=<sha>`      | That single commit                                                                                               |

**Sanity check:** the source range must reflect release metadata only (version bump, changelog files, NOTICE, optional model registry/history). If `git diff <range> --stat` shows broad unrelated changes (suggesting the branch was based off `main`, not the release branch), STOP and ASK how to proceed — do not silently cherry-pick unrelated work onto `main`.

### Step 3: Detect no-op (main already aligned)

Before creating the backmerge branch, check whether `main` already contains the release content.

```bash
git fetch ORG_REMOTE main
git fetch ORG_REMOTE release-<pkg>-<x.y.z>
git merge-tree --write-tree --merge-base=<src>^ ORG_REMOTE/main <src>
git rev-parse ORG_REMOTE/main^{tree}
```

The first command prints the tree SHA produced by simulating the cherry-pick. The second prints `main`'s current tree SHA. If they are identical, every change in the source range is already on `main`:

1. STOP. Do not create a branch, do not push, do not open a PR.
2. Find the commit that landed the release content directly on `main` so you can cite it:
   ```bash
   git log ORG_REMOTE/main --oneline -1 -- <pkg-dir>/changelog/<x.y.z>/
   ```
   Resolve `<pkg-dir>` via `node -p "require('./scripts/sdk/package-paths.cjs').getPackageDir('<pkg>')"` (plugins use `plugins/…`, not `packages/…`).
3. Report to the user, e.g.:
   ```
   No backmerge PR needed — main is already aligned with release-<pkg>-<x.y.z>.
   The release content landed on main via <commit-sha> (<commit-subject>).
   ```

This avoids pushing an empty branch and a `gh pr create` failure.

### Step 4: Sync and create the backmerge branch

```bash
git fetch ORG_REMOTE main
git fetch ORG_REMOTE release-<pkg>-<x.y.z>
git checkout -b backmerge/release-<pkg>-<x.y.z> ORG_REMOTE/main
```

If a local branch with that name already exists, ASK before overwriting.

### Step 5: Cherry-pick

```bash
git cherry-pick -x <commit_or_range>
```

For a true merge commit (not squashed), add `-m 1`.

### Step 6: Conflict triage

Resolve `<pkg-dir>` with `scripts/sdk/package-paths.cjs` (`getPackageDir('<pkg>')`).

**Auto-resolvable** (resolve, `git add`, then `git cherry-pick --continue`):

- `<pkg-dir>/package.json` — version field conflict: take release-side.
  ```bash
  git checkout --theirs <pkg-dir>/package.json
  git add <pkg-dir>/package.json
  ```
- `<pkg-dir>/CHANGELOG.md` (top-level aggregated): regenerate from the version folders just cherry-picked in.
  ```bash
  node scripts/sdk/generate-changelog-sdk-pod.cjs --package=<pkg>
  git add <pkg-dir>/CHANGELOG.md
  ```

**Anything else → STOP. Hand control back to the user.** Do not force-resolve, skip, or abort the cherry-pick on the user's behalf.

When stopping, print:

- `git status -sb`
- The list of unresolved files
- Resume instructions:
  ```
  # After resolving manually:
  git add <files>
  git cherry-pick --continue
  # Then re-run: /qv-sdk-backmerge --resume
  ```

### Step 7: Push the backmerge head

Re-verify that the cherry-pick produced commits that actually change `ORG_REMOTE/main`. Defensive only — Step 3 catches the common no-op case; this guards against rarer paths (e.g. a `--commit=<sha>` arg that turned out to already be on `main`, or a `-m 1` cherry-pick of a merge commit that resolved to nothing):

```bash
git diff --stat ORG_REMOTE/main..HEAD
```

If the output is empty, treat it as a late no-op and STOP (same handling as Step 3 — report and exit). Otherwise push to the **org remote** when write access allows:

```bash
# Preferred — org-branch head (substitute real remote name for ORG_REMOTE):
git push -u ORG_REMOTE backmerge/release-<pkg>-<x.y.z>

# Fallback — personal fork (external CI path):
git push -u FORK_REMOTE backmerge/release-<pkg>-<x.y.z>
```

### Step 8: Build PR title and body

**Title** (default — release PRs typically have a `QVAC-####` ticket):

```
TICKET chore[skiplog]: backmerge release-<pkg>-<x.y.z> — <summary>
```

**Title (tickless fallback)** — only when there is genuinely no ticket; combine the two tags inside a single bracket pair separated by `|` per `.cursor/rules/sdk/commit-and-pr-format.mdc`:

```
chore[skiplog|notask]: backmerge release-<pkg>-<x.y.z> — <summary>
```

- Reuse the ticket from the companion release PR whenever possible.
- `<summary>` lists what is being landed (e.g. `version bump, changelog, NOTICE`).

**Body** (concise, copy-ready):

~~~markdown
## What this PR does

Lands the release metadata for `<pkg>@<x.y.z>` on `main`, per [gitflow.md](../docs/gitflow.md) "Keep main aligned". No functional changes — tagged `[skiplog]` so it does not appear in future changelogs.

## Companion release PR

- <release PR URL>

## Files

- `<pkg-dir>/package.json` — version `<prev>` → `<x.y.z>`
- `<pkg-dir>/changelog/<x.y.z>/` — generated changelog files
- `<pkg-dir>/CHANGELOG.md` — aggregated changelog
- `<pkg-dir>/NOTICE` — updated dependency attributions (if present)
- (any other release-metadata files included in the cherry-pick)
~~~

### Step 9: Open the PR

```bash
# Preferred — org-branch (same-repo) PR:
gh pr create \
  --repo tetherto/qvac \
  --base main \
  --head backmerge/release-<pkg>-<x.y.z> \
  --title "<title>" \
  --body "<body>"

# Fallback — personal fork -> org PR:
gh pr create \
  --repo tetherto/qvac \
  --base main \
  --head <FORK_OWNER>:backmerge/release-<pkg>-<x.y.z> \
  --title "<title>" \
  --body "<body>"
```

Print the new PR URL as a clickable hyperlink. When chained from `sdk-pr-create`, the parent prints both URLs side by side. If the fork fallback was used, note that merge/release must approve the `fork-ci` environment for privileged CI on that head.

## Quality Checklist

Before completing:

- [ ] Branch name is exactly `backmerge/release-<pkg>-<x.y.z>`
- [ ] Title contains `[skiplog]` tag (combined as `[skiplog|notask]` if tickless)
- [ ] Body links the companion release PR
- [ ] Cherry-pick used `-x` (so the original SHA is recorded in commit messages)
- [ ] No conflicts remain; any non-trivial conflicts were resolved by the user, not the skill
- [ ] Head was pushed to the org remote when write access allows; fork path only as fallback
- [ ] `gh pr view` confirms target is `tetherto/qvac:main` and head is the expected org branch (or `<fork>:backmerge/...` if fallback)

## References

- `.cursor/skills/qv-sdk-pr-create/SKILL.md` — companion skill, auto-chains into this one for release targets
- `.cursor/skills/qv-sdk-changelog/SKILL.md` — changelog regeneration used during conflict resolution
- `.cursor/rules/sdk/commit-and-pr-format.mdc` — title format and `[skiplog]` semantics
- `.cursor/rules/sdk/sdk-pod-packages.mdc` — packages this skill applies to
- `docs/gitflow.md` — release flow and "Keep main aligned" rules (still documents fork-first contribution; prefer org-branch heads per this skill until DevOps updates gitflow)
- Fork CI trust model: `docs/ci/LABELS.md` (fork-ci environment + `fork-approval`)
