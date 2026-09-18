---
name: release-fabric-consumers-b
description: Bump and release the qvac-fabric NPM-RUNTIME consumers (roster read per run from .github/fabric-consumers.json; currently six, incl. classification-ggml, vla-ggml, ocr-ggml, model-fit, translation-nmtcpp, embed-llamacpp) after a new @qvac/fabric is published — one PR bumping every caret, then a release branch + on-merge dispatch per addon, stopping at the npm approval gate. The follow-up to release-fabric-consumers-a.
argument-hint: "[base-branch] [--release-only] [--exclude <pkg>]"
disable-model-invocation: true
---

# Release the qvac-fabric npm-runtime consumers

The **npm-runtime addons** do not build the `qvac-fabric` vcpkg port. They depend on the
**published npm package `@qvac/fabric`**, so a fabric rollout does not reach them and
`/release-fabric-consumers-a` deliberately leaves them out.

They need their own pass, and it cannot run at the same time as `-a`. On a `0.x` version a
caret locks the minor: `^0.9.0` absorbs `0.9.x` but will **never** resolve `0.10.0`. So the
new `@qvac/fabric` has to be **on npm first**, then each addon's range is bumped by hand,
then each is released.

This skill does both halves: **Phase 2** opens one PR bumping every addon, and **Phase 3**
releases them after that PR merges.

## THE ROSTER IS READ PER RUN, NEVER RECALLED

`.github/fabric-consumers.json` on `origin/main` is the authority for who belongs here.
**Run this first, every time**, and use its output — not this file — everywhere below that says
"the addons", "each addon" or `<N>`:

```bash
git -C <repo> show origin/main:.github/fabric-consumers.json    # "npm_runtime": [...]
```

**Snapshot — 2026-09-18:** **six** addons — `classification-ggml`, `vla-ggml`,
`translation-nmtcpp`, `model-fit`, `ocr-ggml`, `embed-llamacpp`.

This set has grown as the mirror image of `-a`'s: every package that migrated off the vcpkg port
landed here. `classification-ggml` first, then `vla-ggml`
([#3998](https://github.com/tetherto/qvac/pull/3998), 2026-09-01), then `model-fit`, `ocr-ggml`,
`translation-nmtcpp` and `embed-llamacpp` (qvac#4362, `581b1d094`). Expect it to keep growing while
`-a`'s shrinks; the two rosters are disjoint and together cover every fabric consumer. If a package
appears in both, stop — that is a migration left half-done, not something to release twice.

## Usage

`/release-fabric-consumers-b [base-branch] [--release-only] [--exclude <pkg>]`

```
/release-fabric-consumers-b                      # Phase 1 + 2: check fabric, open the bump PR
/release-fabric-consumers-b --release-only       # Phase 3: after that PR merged, release them all
/release-fabric-consumers-b --exclude vla-ggml   # hold one addon back
```

- `[base-branch]` — optional; defaults to `main`.
- `--release-only` — skip the bump PR and go straight to Phase 3. Use when the bump PR has
  already merged. **Verify it actually merged** (the target version is on
  `origin/<base-branch>`) rather than trusting the flag.
- `--exclude <pkg>[,<pkg>...]` — hold addons back. Each must match a `packages/` dir name in the
  roster; an unmatched name is a **hard error, not a silent no-op**. Excluding the whole roster is
  an error.

## Per-addon release facts

Look each addon up here once the roster is read. Verified 2026-09-18 against `origin/main`.

| Package dir | npm name | on-merge workflow | gated job | git tag |
|---|---|---|---|---|
| `classification-ggml` | `@qvac/classification-ggml` | `on-merge-classification-ggml.yml` | **`publish-release-npm`** | `classification-ggml-v<ver>` |
| `vla-ggml` | `@qvac/vla-ggml` | **`on-merge-vla.yml`** | `publish-npm` | `vla-v<ver>` |
| `translation-nmtcpp` | `@qvac/translation-nmtcpp` | `on-merge-translation-nmtcpp.yml` | `publish-npm` | `translation-nmtcpp-v<ver>` |
| `model-fit` | `@qvac/model-fit` | `on-merge-model-fit.yml` | `publish-npm` | `model-fit-v<ver>` |
| `ocr-ggml` | `@qvac/ocr-ggml` | `on-merge-ocr-ggml.yml` | `publish-npm` | `ocr-ggml-v<ver>` |
| `embed-llamacpp` | `@qvac/embed-llamacpp` | `on-merge-embed-llamacpp.yml` | `publish-npm` | **`llamacpp-embed-v<ver>`** |

**Nothing in this table is uniform — read it, do not pattern-match:**

- **Two workflow/tag names do not follow the directory.** `vla-ggml` builds from
  `on-merge-vla.yml` and tags `vla-v<ver>` (short name, no `-ggml`); `embed-llamacpp` tags
  `llamacpp-embed-v<ver>` (the halves are reversed). Both come from the `repo_name` input that each
  `on-merge-*.yml` passes to `create-release-tag.yml` — read that input if a seventh addon appears:
  ```bash
  git -C <repo> show origin/main:.github/workflows/on-merge-<pkg>.yml   # grep repo_name
  ```
- **The gated job names differ**: `publish-release-npm` for `classification-ggml`, `publish-npm`
  for the other five. `-a` assumes `publish-npm` everywhere and that assumption is wrong here.
  **Detect the gate with `pending_deployments`, which is name-agnostic**, never by job
  name (see Phase 3).
- `translation-nmtcpp` also carries older `nmtcpp-v<ver>` tags from before a rename. The current
  form is `translation-nmtcpp-v<ver>`; do not read the old ones as the pattern.

Every addon gates on environment `npm`; earlier jobs use environment `release`, which has only a
branch policy and never gates.

## Working repo & the golden guardrail

- Run all `git`/`gh` operations in the **code working repo** (e.g. `~/repo/qvac`), never a
  stale worktree. Verify the remote is `tetherto/qvac`.
- Base everything on **`origin/<base-branch>`**, never local `HEAD` (local `main` is often
  behind).
- **GOLDEN RULE — a release branch modifies ZERO files.** Create it without a checkout,
  assert an empty diff, then push. **Never** edit `.github/workflows/**`. Non-empty diff →
  STOP and report.

---

## Phase 1 — Preconditions (hard stop on any failure)

### 1. `@qvac/fabric@<target>` must already be published

This is the precondition the whole skill exists for. Read the target from
`origin/<base-branch>`, then require that exact version on npm:

```bash
git -C <repo> show origin/<base-branch>:packages/fabric/package.json    # -> the target version
npm view @qvac/fabric versions --json                                   # must contain it
```

If it is absent, **stop**. Do not open the PR, do not create a branch. Say which version is
missing and the likely cause: **`fabric`'s own release is probably still parked at its npm
approval gate** (`/release-fabric-consumers-a` leaves it there for a human), so the version
exists as a git tag and a built artifact but not yet on the registry.

Opening the bump PR early is not a harmless head start — the PR's own CI installs
`@qvac/fabric@^<new>` and cannot resolve it, so the PR goes red for a reason that has
nothing to do with the change, and the red is easily misread as a real failure.

Check `npm view @qvac/fabric dist-tags.latest` too: `latest` should be the target. If a
version exists but `latest` points elsewhere, ask before proceeding rather than guessing.

### 2. Neither addon has an unreleased version pending

For each addon in the release set, `origin/<base-branch>`'s `package.json` version should
equal npm `latest`. If `origin/main` is already **ahead**, a previous bump PR merged and was
never released — go straight to Phase 3 for that addon (`--release-only`) instead of
bumping it a second time.

### 3. No stale release branch

```bash
git -C <repo> ls-remote --heads origin "release-<pkg>-<ver>"      # must be empty
```

State the resolved set, the fabric target, and each addon's current → new version before
changing anything.

---

## Phase 2 — One PR bumping every addon

Branch off `origin/<base-branch>`:

```bash
git -C <repo> checkout -b <ticket>/bump-fabric-npm-<fabric-ver> origin/<base-branch>
```

For **each** addon in the set:

**`package.json`** — two edits:

- `"@qvac/fabric": "^<major>.<minor>.0"` — the caret for the newly published fabric.
- the addon's own `"version"` — **minor** bump. Both are `0.x`, and `/bump-version`'s rule is
  `0.x` → minor, `>=1.0` → major. Do **not** pass `major`. Read the current version off
  `origin/<base-branch>` rather than assuming; these move every release.

**`CHANGELOG.md`** — a `## [<version>] - <date>` heading. **Bracketed**: the
release-merge-guard requires that exact shape, and Phase 3 fails without it. Insert below any
`## [Unreleased]` block, never above it, or the release extractor slices the body off.

### Use the established changelog wording

`packages/classification-ggml/CHANGELOG.md` already carries this entry twice (`0.21.0`,
`0.22.0`). Follow it rather than inventing phrasing — it spells out the caret mechanic, which
is the part a reader will not infer:

```markdown
### Changed

- `@qvac/fabric` dependency bumped `^<old>` -> `^<new>`, which carries `qvac-fabric`
  `<old-vcpkg>` -> `<new-vcpkg>` (<what that fabric version brought>). This package consumes
  the shared runtime via npm rather than building the vcpkg port, so the range bump is what
  picks up the new fabric. A caret on a `0.x` version locks the minor, so `^<old>` would not
  have resolved `<new>` on its own. No API change for this package.
```

Then add a sentence on what the new fabric means **for that addon specifically** — e.g.
classification runs MobileNetV3-Small on CPU and gains nothing from GPU or vector-index work,
so the honest note is that the bump keeps it on the current shared runtime rather than a
superseded one. A changelog that only restates the version numbers tells a reader nothing.

### Check for unreleased work before writing the entry

**A caret bump is often not the only thing the release ships.** An addon can carry commits
that landed with no version bump and no changelog entry, which this release would publish
silently.

```bash
git -C <repo> log --oneline <last-release-tag>..origin/<base-branch> -- packages/<pkg>
```

If that returns anything beyond the bump itself, document it in the same entry. Real
instance: `vla-ggml`'s migration to the shared npm runtime
([#3998](https://github.com/tetherto/qvac/pull/3998), 2026-09-01) merged with **no** bump and
**no** changelog entry, sitting on an already-published `0.23.0` — so the next release
publishes the migration too.

Note also that `vla-ggml`'s older entries still use the pre-migration wording
(`qvac-fabric <vcpkg-version> -> ...`, describing a vcpkg dependency it no longer has). Its
first npm-runtime entry should adopt the classification idiom above; leave the historical
entries alone.

### Open one PR

**One PR covering the whole release set**, not one per addon — they move together and a reviewer
should see the set. Body per the repo convention: 🎯 Problem / 📝 How / 🧪 Tested / ⚠️ Breaking, and
say plainly that squash-merging publishes every package listed.

**Then stop.** Hand off the PR link. Phase 3 cannot run until it merges.

---

## Phase 3 — Release, after the bump PR merges

Re-invoked with `--release-only`. First confirm the bump is actually on
`origin/<base-branch>` — re-fetch and re-read both versions. A flag is not evidence.

### Step 1 — Branch, assert, push (per addon)

```bash
git -C <repo> fetch origin <base-branch>
git -C <repo> branch release-<pkg>-<ver> origin/<base-branch>          # no checkout
git -C <repo> diff --stat origin/<base-branch>..release-<pkg>-<ver>    # MUST be empty
git -C <repo> push origin release-<pkg>-<ver>
```

### Step 2 — Dispatch (workflow name from the roster table)

```bash
gh run list --branch release-<pkg>-<ver> --repo tetherto/qvac --limit 5 --json databaseId
gh workflow run "<on-merge-wf>" --repo tetherto/qvac --ref release-<pkg>-<ver>
```

Pushing a fresh `release-*` branch usually does **not** auto-trigger (the path filter sees no
new commits), so the dispatch is the trigger — but check first and do **not** double-dispatch
if a push-triggered run already exists.

### Step 3 — Monitor to the gate, and stop

```bash
gh api repos/tetherto/qvac/actions/runs/<run-id>/pending_deployments --jq 'length'
```

A non-empty result means the run is waiting for npm approval. **Use this, not the job name** —
the addons do not all name that job the same way (`classification-ggml` uses
`publish-release-npm`) and a name check would silently miss one.

Job order: `publish-logic` + `release-merge-guard` → `prebuild` (classification) / `build`
(the rest) → `verify-generated` → `publish-gpr` (env `release`) → **the npm-gated job ← PAUSES** →
`create-tag`. Not every addon has `verify-generated` — `model-fit` and `embed-llamacpp` go
straight from `build` to `publish-gpr`.

**Never approve the deployment yourself.** Only a `qvac-internal-release` member can, and the
automation token has `can_approve=false`. Hand off with one line per addon:

```
<addon>: <CI run link>
```

Use the `packages/` directory name, take the URL from `gh run list --json url`, and give
**every** addon in the set a line — append `— build running` / `— awaiting gate` / `— failed`
so the list is never partial. A missing line should always mean a real problem, never a
timing artifact.

### Step 4 — Verify after approval

```bash
npm view @qvac/<pkg> dist-tags.latest              # == <ver>
git -C <repo> ls-remote --tags origin "<git-tag>"  # per-package name from the roster
```

Confirm the published package actually resolves the new fabric:

```bash
npm view @qvac/<pkg>@<ver> dependencies.@qvac/fabric    # == ^<new>
```

That last check is the point of the whole skill — if it still reads the old caret, the bump
did not make it into the published artifact.

### Step 5 — Report

Table: package, npm `latest`, git tag, resolved `@qvac/fabric` range, CI run link. Say which
addons were excluded and why. Release branches never merge back to `main`; offer to delete
the leftover local branches.

---

## Restrictions & nuances

- **This skill is second, always.** It cannot start until `@qvac/fabric` is published, which
  means `/release-fabric-consumers-a` must have completed *and* had its npm gate approved.
  Running them concurrently cannot work.
- **The caret is the whole mechanism.** These addons consume fabric as an npm dependency;
  nothing in a vcpkg rollout touches them. If the caret is not bumped, they keep resolving the
  old fabric indefinitely and nothing fails loudly.
- **The addons drift apart.** As of 2026-09-01 `classification-ggml` pinned `^0.8.0` and
  `vla-ggml` `^0.9.0` against a published `fabric 0.9.0` — one was already a minor behind.
  Read every package's caret separately; never infer one from another, and never assume they
  start from the same base. (As of 2026-09-18 all six happen to sit on `^0.16.0` — a coincidence
  of the last rollout, not an invariant.)
- **No GitHub *Release* objects are created.** npm publishes + git tags only. `gh release
  view <tag>` returning "release not found" is EXPECTED, not a failure.
- **`label-gate` auto-authorises release dispatches.** `push` and `workflow_dispatch` are
  trusted events, so a `release-*` dispatch needs no labels.
- **Bash discipline (repo `CLAUDE.md`).** No heredocs, no `$()`, no `&&`/`||`/`;` chaining, no
  pipes or redirects in direct commands. Put loops and multi-step checks in a script file and
  run `bash <file>`. Use `git -C <path>` and `gh --repo <repo>` rather than `cd`.

## Error handling

- `release-merge-guard` fails → the version was not bumped, or `CHANGELOG.md` lacks the
  `## [<version>] - <date>` heading. Fix on `main` in a new PR and re-dispatch.
- npm publish fails → the version may already exist, or `NPM_TOKEN` is invalid; check
  `npm view @qvac/<pkg> versions`.
- The published package still shows the old `@qvac/fabric` caret → the bump PR did not
  actually land before the release branch was cut. Re-check what merged; do not re-publish
  over it.
- Never delete, skip or weaken tests to get a release through.
