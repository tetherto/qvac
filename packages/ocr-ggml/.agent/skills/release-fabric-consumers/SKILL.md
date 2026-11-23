---
name: release-fabric-consumers
description: Release the qvac-fabric consumers to npm after the bundled version-bump PR merges — follow the publish runs addon-auto-release.yml starts per consumer to the npm approval gate, and hand off the links. Supports --exclude to hold packages back. Phase C after rollout-phase-b.
argument-hint: "[base-branch] [--exclude <pkg>[,<pkg>...]]"
disable-model-invocation: true
---

# Release qvac-fabric consumers to npm

Publish the **qvac-fabric consumers** to npm in one coordinated pass. This is the
final phase of a fabric rollout — the step **after** `rollout-phase-b`'s bundled
version-bump PR (vcpkg `version>=` + `package.json` + `CHANGELOG.md` for the full roster)
has merged to `main`. It applies the single-package `release` workflow to every consumer
in the release set at once.

Merging the bump PR starts the releases: `addon-auto-release.yml` cuts `release-<pkg>-<ver>`
from the merge commit for every bumped consumer and starts `publish-npm.yml` on it, which
builds prebuilds, pauses for npm approval, publishes with the `latest` tag, and creates a git
tag. This skill does not cut branches or dispatch `publish-npm.yml`; it checks that every
consumer in the release set got its run, follows them to the approval gate, holds back
`--exclude` packages, and verifies the publish.

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
  (the first column of the consumer table) to hold back from this pass. Their publish runs are
  cancelled before anyone approves them (Step 2); everything else in the roster is released.

**Validate `--exclude` before touching anything.** A value that does not match a `packages/`
dir name in the table is a **hard error, not a silent no-op** — a typo like
`--exclude modelfit` would otherwise quietly release the very package the user meant to hold
back. Report the unmatched name and stop **before** cancelling or approving anything. Excluding
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

Until both are settled, hold it back with **`--exclude <pkg>`** rather than approving its run and
dealing with a failed `release-merge-guard`. That is the supported way to release the rest of the
roster on schedule while a first-publish package waits.

## The consumers

This table is the **full roster**. The release set is this list minus `--exclude`.

| Package dir (`packages/`) | npm name | release workflow | git-tag created |
|---|---|---|---|
| `embed-llamacpp` | `@qvac/embed-llamacpp` | `publish-npm.yml` | `llamacpp-embed-v<ver>` |
| `fabric` | `@qvac/fabric` | `publish-npm.yml` | `fabric-v<ver>` |
| `llm-llamacpp` | `@qvac/llm-llamacpp` | `publish-npm.yml` | `llamacpp-llm-v<ver>` |
| `model-fit` | `@qvac/model-fit` | `publish-npm.yml` | `model-fit-v<ver>` |
| `ocr-ggml` | `@qvac/ocr-ggml` | `publish-npm.yml` | `ocr-ggml-v<ver>` |
| `translation-nmtcpp` | `@qvac/translation-nmtcpp` | `publish-npm.yml` | `translation-nmtcpp-v<ver>` |
| `vla-ggml` | `@qvac/vla-ggml` | `publish-npm.yml` | `vla-v<ver>` |

The git-tag column is **not** uniform. Use the package's entry when checking a release.

`classification-ggml` is **not** in this list. It dropped the `qvac-fabric` vcpkg
dependency and now consumes the published npm package `@qvac/fabric`, so it is not part
of a fabric rollout — see *`fabric` publishes first* below for the one follow-up it needs.

## Working repo

- Run all `git`/`gh` operations in the **code working repo** (e.g. `~/repo/qvac`) — NOT a
  stale/read-only worktree. Verify the repo is on the right remote (`tetherto/qvac`).
- Read target versions from **`origin/<base-branch>`**, never local `HEAD` (local `main` is
  often behind).
- Never create, push or edit a `release-*` branch here; `addon-auto-release.yml` cuts each one
  as an exact copy of the merge commit.

## Workflow

### `fabric` publishes first

`@qvac/fabric` is the shared runtime addon the others build against, and it is also a
**caret dependency of `@qvac/classification-ggml`**. The consumers build against the
released `@qvac/fabric`, so `addon-auto-release.yml` orders this itself: a consumer whose
`@qvac/fabric` range has no version on npm gets its release branch at merge time but no
publish run, and the workflow starts it within an hour of the Fabric publish (it re-checks
hourly and after a successful `publish-npm.yml` run). Approve `fabric` first; to start the
consumer runs at once after it publishes, run `gh workflow run addon-auto-release.yml`.

This only holds when no published Fabric satisfies the consumer's range. If the range
still accepts the Fabric already on npm (for example `^0.33.0` while Fabric goes 0.33.0 →
0.33.1), the consumer starts at once and builds against the published 0.33.0. To build
against the new Fabric, move the consumer's range to it in the same bump PR.

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

If `fabric` is in `--exclude` and a consumer needs the new Fabric, that consumer stays
waiting until Fabric is released; say so in the report.

### Step 1 — Read target versions and find the auto-release run
```bash
git -C <repo> fetch origin <base-branch>
gh run list --repo tetherto/qvac --workflow addon-auto-release.yml --limit 10
```
Resolve the release set first (roster minus `--exclude`, with `--exclude` validated per Usage),
then for each consumer **in the release set** read the version off `origin/<base-branch>`
(`git -C <repo> show origin/<base-branch>:packages/<pkg>/package.json`) and confirm
`npm view @qvac/<pkg> version` is lower.

Open the `addon-auto-release.yml` run for the merge commit: its summary lists every bumped
addon and whether its publish started, is waiting for Fabric, or was skipped and why. State
the resolved release set, the excluded packages and that summary before proceeding.

If a consumer in the release set is missing from the summary, or its row failed, start the
workflow for the merge commit (dry run first) rather than cutting the branch by hand:
```bash
gh workflow run addon-auto-release.yml --repo tetherto/qvac -f sha=<merge-commit> -f dry_run=true
gh workflow run addon-auto-release.yml --repo tetherto/qvac -f sha=<merge-commit>
```

### Step 2 — Hold back `--exclude` packages
For each excluded package with a run on `release-<pkg>-<ver>`, cancel it before anyone
approves it:
```bash
gh run list --repo tetherto/qvac --workflow publish-npm.yml --branch release-<pkg>-<ver> --limit 1 --json databaseId
gh run cancel <run-id> --repo tetherto/qvac
```
The automation never restarts a cancelled run. To release the package later, re-run that run
from its page. An excluded package still waiting for Fabric has no run yet; the auto-release
scan starts it after Fabric publishes, so check again then and cancel it.

### Step 3 — Monitor to the approval gate (do NOT approve)
Poll until each run pauses at `publish`. Read the run URL straight from `gh` rather than
hand-assembling it from a run id:
```bash
gh run list --branch release-<pkg>-<ver> --repo tetherto/qvac --limit 1 --json databaseId,url,status,conclusion
gh api repos/tetherto/qvac/actions/runs/<run-id>/pending_deployments
```
Job order per run: `select` → `logic` + `release-merge-guard` + `verify` → `providers`
(fabric's prebuilds, when the package links fabric or is fabric) → `build` (prebuilds, ~9
platforms) → **`publish` (env `npm`, required reviewers) ← PAUSES HERE** → `create-tag`.

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

### Step 4 — After the user approves, verify
Once `publish-npm` + `create-tag` complete for a consumer:
```bash
npm view @qvac/<pkg> dist-tags.latest                 # == <ver>
git -C <repo> ls-remote --tags origin "<git-tag>"     # tag exists (see per-package table)
```
Public-access check (token-less): install each `@qvac/<pkg>@<ver>` into a clean dir with a
bare registry `.npmrc` and an **isolated `HOME`** (so the user's token is never read),
`--ignore-scripts --no-package-lock`; confirm the installed `package.json` version matches.
Put this loop in a script file and run `bash <file>` (see Bash discipline).

### Step 5 — Report
Consolidated table: package, npm `latest`, git tag, public-install ✓, CI run link. Release
branches are never merged back to `main`; offer to delete the leftover local branches.

State explicitly which packages were **excluded and why** (e.g. `model-fit — first publish, awaiting
dated CHANGELOG entry and version decision`). A pass that silently covers six of seven is
indistinguishable later from one that dropped a package by accident.

## Restrictions & nuances (hard-won)

- Fabric and its consumers publish from `publish-npm.yml` (`packages` input). The input and
  the release branch use the package directory name, including `release-vla-ggml-<ver>`.
- **The release branch name is load-bearing.** A push selects exactly the package
  `release-<pkg>-<x.y.z>` names, and `release-check-branch` refuses to publish unless that
  package is the one the run publishes, at the branch's version. A misnamed branch fails the run rather than publishing
  the wrong thing.
- **git-tag naming varies per package** — do NOT assume `<pkg>-v<ver>`. Use the table:
  `llamacpp-embed-v<ver>`, `fabric-v<ver>`, `llamacpp-llm-v<ver>`, `model-fit-v<ver>`,
  `ocr-ggml-v<ver>`, `translation-nmtcpp-v<ver>`, and `vla-v<ver>`.
  The tag comes from `create-release-tag.yml`, which builds `<repo_name>-v<published_version>`
  from each package's `project.json`: `metadata.publish.tagPrefix` on the `publish` target.
  Read that rather than guessing from the directory name if a new consumer appears.
- **A release dispatch needs no labels.** `publish-npm.yml` runs on the push or dispatch
  alone. Labels steer pull request runs only (`prebuilds` and the `run-*` stage labels);
  `verified` selects nothing anywhere.
- **The npm approval gate is mandatory and human-only.** `publish` runs in the `npm`
  environment, protected by `required_reviewers` (team `qvac-internal-release`). Every run
  pauses there. Detect via `.../pending_deployments`. **Never approve** — hand off to the
  user. (Earlier jobs use env `release`, which has only a `branch_policy` allowing
  `release-*`, so they never gate.)
- **No GitHub *Release* objects are created.** This pipeline produces npm publishes + git
  tags only. `gh release view <tag>` returns "release not found" — that is EXPECTED, not a
  failure. (The `create-github-release.yml` workflow is unrelated/defunct on another
  branch.) Do not treat a missing GitHub Release as an error.
- **Release branches never merge back to `main`.** `addon-auto-release.yml` creates them on
  the remote only. Do not cut or push them by hand: a hand-cut branch at another commit makes
  the automation skip that package, and a second dispatch queues a duplicate publish run.
- **Bash discipline (repo `CLAUDE.md`).** In direct commands: no heredocs, no `$()`
  command substitution, no `&&`/`||`/`;` chaining, no pipes or redirects. Put polling
  loops / the public-install check in a script file and run `bash <file>`. Use `git -C
  <path>` and `gh --repo <repo>` instead of `cd`.
- **Sequencing.** Consumers whose range needs the new Fabric start together once it is on npm. For a canary-first
  pass, approve one consumer's run, verify it, then approve the rest.

## Error handling

- `release-merge-guard` fails → version not bumped or `CHANGELOG.md` missing the
  `## [<version>] - <date>` section. Fix on `main` with a new bump PR; its merge starts a new
  release.
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
