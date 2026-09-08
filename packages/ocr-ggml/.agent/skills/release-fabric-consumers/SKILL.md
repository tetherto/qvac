---
name: release-fabric-consumers
description: Release the qvac-fabric consumers to npm after the bundled version-bump PR merges — one release branch + on-merge dispatch per consumer, stopping at the npm approval gate. Supports --exclude to hold packages back. Phase C after rollout-phase-b.
argument-hint: "[base-branch] [--exclude <pkg>[,<pkg>...]]"
disable-model-invocation: true
---

# Release qvac-fabric consumers to npm

Publish the **qvac-fabric consumers** to npm in one coordinated pass. This is the
final phase of a fabric rollout — the step **after** `rollout-phase-b`'s bundled
version-bump PR (vcpkg `version>=` + `package.json` + `CHANGELOG.md` for the full roster)
has merged to `main`. It applies the single-package `release` workflow to every consumer
in the release set at once.

It reuses the same mechanics as `/release` (cut a `release-*` branch → dispatch
`on-merge-<package>.yml` → the on-merge workflow builds prebuilds, publishes to npm with
the `latest` tag, and creates a git tag), but for the whole release set, and it is aware
of the per-consumer quirks and the mandatory human approval gate.

**The release set** is the full consumer roster (see the table below) minus anything named
in `--exclude`. Every step below operates on the release set, not the roster.

## Usage

`/release-fabric-consumers [base-branch] [--exclude <pkg>[,<pkg>...]]`

```
/release-fabric-consumers
/release-fabric-consumers main --exclude model-fit
/release-fabric-consumers main --exclude model-fit,vla-ggml
```

- `[base-branch]` — optional; the branch the version bumps landed on. Defaults to `main`.
- `--exclude <pkg>[,<pkg>...]` — optional; comma-separated **`packages/` directory names**
  (the first column of the consumer table) to hold back from this pass. Everything else in
  the roster is released.

**Validate `--exclude` before touching anything.** A value that does not match a `packages/`
dir name in the table is a **hard error, not a silent no-op** — a typo like
`--exclude modelfit` would otherwise quietly release the very package the user meant to hold
back. Report the unmatched name and stop **before** creating any release branch. Excluding
every consumer is likewise an error, not an empty success.

## Prerequisites

- The consumer bump is **merged to `<base-branch>`** — either `rollout-phase-b`'s own bundled PR
  (e.g. qvac#3334) or, in `--on-top-of-pr` mode, the feature PR the bumps rode in on (e.g.
  qvac#3725). The target versions live on `origin/<base-branch>`.
- For each consumer **in the release set**, `origin/<base-branch>`'s `package.json` version is
  **higher** than the current npm `latest` (i.e. npm is one bump behind). If not, the version
  bump PR hasn't merged yet — stop.
- Each release-set consumer's `CHANGELOG.md` has a `## [<version>] - <date>` section (bracketed
  heading — the release-merge-guard requires this exact format).

These are checked only for the release set — a package held back by `--exclude` is never inspected,
which is the point of excluding it.

### Watch for a never-published consumer

The "npm is one bump behind" check can pass **for the wrong reason**. A package whose npm `latest`
reads `0.0.0` with no release tag has never actually been published — `0.0.0` is a name placeholder,
so any real version compares as "higher" and the precondition passes while the package is in a
first-publish state this skill otherwise assumes away.

```bash
npm view @qvac/<pkg> dist-tags.latest
git -C <repo> ls-remote --tags origin "<tag-prefix>-v*"
```

Both signals together (`0.0.0` **and** no tag) mean a first release. `0.0.0` here is a **sentinel**,
not a version that drifts — it is npm's placeholder for a name reserved but never published, so it
stays literal. Which package is in that state does drift, so run the two commands above across the
roster rather than trusting a name written here; `model-fit` was the instance when this was written
and has since published. When a package is in that state, its first release needs two things settled
before dispatch:

1. a dated `## [<version>] - <date>` entry — a `CHANGELOG.md` holding only an `## [Unreleased]`
   block is what the release extractor will not accept as a version section;
2. a decision on whether the version already on `origin/main` publishes as-is, or is superseded by
   the rollout bump. Do not bump past an unpublished version without asking — that silently burns a
   version number.

Until both are settled, hold it back with **`--exclude <pkg>`** rather than dispatching it and
dealing with a failed `release-merge-guard`. That is the supported way to release the rest of the
roster on schedule while a first-publish package waits.

## The consumers

This table is the **full roster**. The release set is this list minus `--exclude`.

| Package dir (`packages/`) | npm name | on-merge workflow | git-tag created |
|---|---|---|---|
| `embed-llamacpp` | `@qvac/embed-llamacpp` | `on-merge-embed-llamacpp.yml` | `llamacpp-embed-v<ver>` |
| `fabric` | `@qvac/fabric` | `on-merge-fabric.yml` | `fabric-v<ver>` |
| `llm-llamacpp` | `@qvac/llm-llamacpp` | `on-merge-llm-llamacpp.yml` | `llamacpp-llm-v<ver>` |
| `model-fit` | `@qvac/model-fit` | `on-merge-model-fit.yml` | `model-fit-v<ver>` |
| `ocr-ggml` | `@qvac/ocr-ggml` | `on-merge-ocr-ggml.yml` | `ocr-ggml-v<ver>` |
| `translation-nmtcpp` | `@qvac/translation-nmtcpp` | `on-merge-translation-nmtcpp.yml` | `v<ver>` (bare) |
| `vla-ggml` | `@qvac/vla-ggml` | **`on-merge-vla.yml`** ⚠️ | `vla-v<ver>` |

The workflow-name and git-tag columns are **not** uniform — see Restrictions & nuances.

`classification-ggml` is **not** in this list. It dropped the `qvac-fabric` vcpkg
dependency and now consumes the published npm package `@qvac/fabric`, so it is not part
of a fabric rollout — see *Release `fabric` first* below for the one follow-up it needs.

## Working repo & the golden guardrail

- Run all `git`/`gh` operations in the **code working repo** (e.g. `~/repo/qvac`) — NOT a
  stale/read-only worktree. Verify the repo is on the right remote (`tetherto/qvac`).
- Base every release branch on **`origin/<base-branch>`**, never on local `HEAD` (local
  `main` is often behind).
- **GOLDEN RULE — a release branch modifies ZERO files.** It is an exact copy of
  `origin/<base-branch>`. Create it without a checkout, then assert an empty diff before
  pushing. **Never** edit anything under `.github/workflows/**`. If the diff is non-empty,
  STOP and report — do not push.

## Workflow

Do the whole release set in parallel unless told otherwise (version-only bumps were already
build-validated on the fabric sync PR; a canary-first order is a fine alternative).

### Release `fabric` first

`@qvac/fabric` is the shared runtime addon the others build against, and it is also a
**caret dependency of `@qvac/classification-ggml`**. Publish it ahead of the rest so
downstream installs resolve against the new build rather than the previous one.

Then check the caret. Read both values rather than assuming either — they move every
release, so any version written here would be wrong by the time you read it:

```bash
git -C <repo> grep -h "@qvac/fabric" origin/main -- packages/classification-ggml/package.json
git -C <repo> grep -h '"version"' origin/main -- packages/fabric/package.json
```

On a `0.x` version **a caret locks the minor**: `^0.<m>.<p>` absorbs later `0.<m>.x`
automatically but will **not** cross to `0.<m+1>.0`. So if this release moves
`@qvac/fabric`'s minor past the one classification-ggml's caret pins,
`classification-ggml` needs a manual dependency bump — track it as a **follow-up after the
release**, not as part of the rollout PR. This has happened before and is expected to
recur; `packages/classification-ggml/CHANGELOG.md` records each crossing.

If `fabric` is in `--exclude`, this ordering step does not apply to that pass and the
`classification-ggml` caret follow-up does not arise — release the rest of the set in
parallel and say in the report that the ordering constraint was moot.

### Step 1 — Sync and read target versions
```bash
git -C <repo> fetch origin <base-branch>
```
Resolve the release set first (roster minus `--exclude`, with `--exclude` validated per Usage),
then for each consumer **in the release set** read the version off `origin/<base-branch>`
(`git -C <repo> show origin/<base-branch>:packages/<pkg>/package.json`) and confirm
`npm view @qvac/<pkg> version` is lower. Also confirm no target `release-*` branch already
exists on the remote (`git -C <repo> ls-remote --heads origin "release-<pkg>-<ver>"`).

State the resolved release set and the excluded packages before proceeding, so the user can
catch a wrong set before any branch is pushed.

### Step 2 — Create + assert + push each release branch
```bash
git -C <repo> branch release-<pkg>-<ver> origin/<base-branch>    # no checkout
git -C <repo> diff --stat origin/<base-branch>..release-<pkg>-<ver>   # MUST be empty
git -C <repo> push origin release-<pkg>-<ver>                    # non-force, non-main
```

### Step 3 — Dispatch the on-merge workflow (uses the workflow-name map)
```bash
gh workflow run "<on-merge-wf>" --repo tetherto/qvac --ref release-<pkg>-<ver>
```
The workflow file for `vla-ggml` is `on-merge-vla.yml`. Pushing a fresh `release-*` branch
usually does **not** auto-trigger (path filter sees no new commits), so the explicit
dispatch is the trigger — but check `gh run list --branch release-<pkg>-<ver>` and, if a
push-triggered run already exists, do NOT double-dispatch.

### Step 4 — Monitor to the approval gate (do NOT approve)
Poll until each run pauses at `publish-npm`. Read the run URL straight from `gh` rather than
hand-assembling it from a run id:
```bash
gh run list --branch release-<pkg>-<ver> --repo tetherto/qvac --limit 1 --json databaseId,url,status,conclusion
gh api repos/tetherto/qvac/actions/runs/<run-id>/pending_deployments
```
Job order per run: `label-gate` (auto) → `publish-logic` + `release-merge-guard` (env
`release`, branch-policy only) → `build` (prebuilds, ~9 platforms) → **`publish-npm` (env
`npm`, required reviewers) ← PAUSES HERE** → `create-tag`.

**When a run reaches the `npm` pending-deployment gate, STOP** and hand off to the user.

**Required output format.** Emit the CI run links as **one line per addon**, in the order of the
consumer table, and nothing else on those lines:

```
<addon>: <CI run link>
```

- `<addon>` is the **`packages/` directory name** (`fabric`, `embed-llamacpp`, `vla-ggml`,
  `translation-nmtcpp`, …) — not the npm name, not the workflow name.
- `<CI run link>` is the run's `url` from the `gh run list --json` call above, i.e.
  `https://github.com/tetherto/qvac/actions/runs/<run-id>`.
- **Only the release set appears.** Packages held back by `--exclude` get no line.
- **Every addon in the set gets a line**, even if its run has not yet reached the gate — append a
  short state marker (`— awaiting gate`, `— build running`, `— failed`) so the list is never
  partial and a missing package is always a real problem rather than a timing artifact.

Worked example (`--exclude model-fit`):

```
fabric: https://github.com/tetherto/qvac/actions/runs/31390432306
embed-llamacpp: https://github.com/tetherto/qvac/actions/runs/31390431726
llm-llamacpp: https://github.com/tetherto/qvac/actions/runs/31390432200
ocr-ggml: https://github.com/tetherto/qvac/actions/runs/31390430929
translation-nmtcpp: https://github.com/tetherto/qvac/actions/runs/31390430912
vla-ggml: https://github.com/tetherto/qvac/actions/runs/31390432221 — build running
```

After the list, note the gate detail once — gated job `publish-npm`, environment `npm`, and which
runs are already pending approval. That is context; the list is the hand-off artifact.

**Never approve the deployment yourself** (the automation token has `can_approve=false` anyway;
only a `qvac-internal-release` member can).

### Step 5 — After the user approves, verify
Once `publish-npm` + `create-tag` complete for a consumer:
```bash
npm view @qvac/<pkg> dist-tags.latest                 # == <ver>
git -C <repo> ls-remote --tags origin "<git-tag>"     # tag exists (see per-package table)
```
Public-access check (token-less): install each `@qvac/<pkg>@<ver>` into a clean dir with a
bare registry `.npmrc` and an **isolated `HOME`** (so the user's token is never read),
`--ignore-scripts --no-package-lock`; confirm the installed `package.json` version matches.
Put this loop in a script file and run `bash <file>` (see Bash discipline).

### Step 6 — Report
Consolidated table: package, npm `latest`, git tag, public-install ✓, CI run link. Release
branches are never merged back to `main`; offer to delete the leftover local branches.

State explicitly which packages were **excluded and why** (e.g. `model-fit — first publish, awaiting
dated CHANGELOG entry and version decision`). A pass that silently covers six of seven is
indistinguishable later from one that dropped a package by accident.

## Restrictions & nuances (hard-won)

- **Workflow-name map is not uniform.** 6 consumers use `on-merge-<pkg>.yml`, but
  **`vla-ggml` uses `on-merge-vla.yml`** (short name, no `-ggml`). This is the release
  (on-merge) workflow — distinct from the PR-validation workflow `on-pr-vla.yml`.
- **git-tag naming varies per package** — do NOT assume `<pkg>-v<ver>`. Use the table:
  `llamacpp-embed-v<ver>`, `fabric-v<ver>`, `llamacpp-llm-v<ver>`, `model-fit-v<ver>`,
  `ocr-ggml-v<ver>`, bare `v<ver>` for `translation-nmtcpp`, and `vla-v<ver>`.
  The tag comes from `create-release-tag.yml`, which builds `<repo_name>-v<published_version>`
  from the `repo_name` each `on-merge-*.yml` passes it — read that input if a new consumer
  appears rather than guessing from the directory name.
- **label-gate auto-authorises release dispatches.** The `label-gate`/Authorise job treats
  `push` and `workflow_dispatch` as *trusted events* (`authorised=true`) — so a
  `release-*` branch dispatch needs **no labels at all**. PR events are the contrasting
  case, and they do **not** want `verified` either: they need the granular stage labels
  (`prebuilds` plus the four `run-*`), which are the only names `ci-router` reads.
  `verified` selects nothing anywhere — the label gate was retired repo-wide.
- **The npm approval gate is mandatory and human-only.** `publish-npm` runs in the `npm`
  environment, protected by `required_reviewers` (team `qvac-internal-release`). Every run
  pauses there. Detect via `.../pending_deployments`. **Never approve** — hand off to the
  user. (Earlier jobs use env `release`, which has only a `branch_policy` allowing
  `release-*`, so they never gate.)
- **No GitHub *Release* objects are created.** This pipeline produces npm publishes + git
  tags only. `gh release view <tag>` returns "release not found" — that is EXPECTED, not a
  failure. (The `create-github-release.yml` workflow is unrelated/defunct on another
  branch.) Do not treat a missing GitHub Release as an error.
- **Release branches never merge back to `main`;** local copies remain after the run —
  offer to clean them up. If a target `release-*` branch already exists on the remote, ask
  the user before reusing or aborting.
- **Bash discipline (repo `CLAUDE.md`).** In direct commands: no heredocs, no `$()`
  command substitution, no `&&`/`||`/`;` chaining, no pipes or redirects. Put polling
  loops / the public-install check in a script file and run `bash <file>`. Use `git -C
  <path>` and `gh --repo <repo>` instead of `cd`.
- **Sequencing.** All-6-in-parallel is safe for version-only fabric bumps (already
  build-validated on the fabric sync PR). Canary-first (release one, verify, then fan out)
  is a valid slower alternative if the fabric change was risky.

## Error handling

- `release-merge-guard` fails → version not bumped or `CHANGELOG.md` missing the
  `## [<version>] - <date>` section. Fix on `main` (new PR) and re-dispatch.
- A prebuild platform fails → `gh run view <run-id> --repo tetherto/qvac --log-failed`.
- npm publish fails → the version may already exist (someone released it) or `NPM_TOKEN`
  is invalid; check `npm view @qvac/<pkg> versions`.
- Never delete/skip tests or weaken CI to get a release through.

## Reference — the PR #3334 run (worked example)

qvac#3334 (`qvac-fabric 9840.0.0`) released all 6 consumers **of that time** via this exact
flow. Runs: classification-ggml 29736362703, embed-llamacpp 29736364449,
llm-llamacpp 29736366470, ocr-ggml 29736373159, translation-nmtcpp 29736374927,
vla-ggml 29736376662. All paused at `publish-npm`; after a `qvac-internal-release` member
approved, all 6 published to npm `latest` and created their (differently-named) git tags.

This is a **historical record, not the current roster** — `classification-ggml` was still a
fabric consumer then, and `fabric` / `model-fit` had not been added. The flow it demonstrates
is unchanged; use the table above for who to release.
