---
name: rollout-phase-a
description: Phase A of a qvac-fabric rollout — set up overlay port and validate all 7 consumers against the fabric branch before publishing to the registry. Pass --on-top-of-pr to apply the overlay onto an open PR's head branch instead of a dedicated validation branch.
argument-hint: "<fabric-version> <fabric-branch-or-commit> [--on-top-of-pr <pr-url>]"
---

# Rollout Phase A — Overlay Validation

**Prerequisites:** Fabric PR open in `tetherto/qvac-fabric-llm.cpp`. Tag does NOT exist yet.

**The 7 consumers:** `embed-llamacpp`, `fabric`, `llm-llamacpp`, `model-fit`, `ocr-ggml`,
`translation-nmtcpp`, `vla-ggml`.

`classification-ggml` is **not** a fabric consumer — it dropped the `qvac-fabric` vcpkg dependency
and now consumes the published npm package `@qvac/fabric`. It needs neither overlay validation nor
a `version>=` bump during a rollout. Do not re-add it.

Re-derive the roster if in doubt — it is one command, and it changes:
```bash
git -C <repo> grep -l "qvac-fabric" origin/main -- "packages/*/vcpkg.json"
```

## THE GOLDEN RULE
Never bump `default-registry.baseline` in `vcpkg-configuration.json`. Not now, not ever during a rollout.

Why nothing breaks without it: vcpkg resolves `version>=` against the registry's **published versions
(HEAD)**, not the baseline commit — the baseline is only a *floor* for ports with no explicit
constraint. Baselines are advanced only by separate, unrelated infra "Sync with fabric" maintenance
PRs; bumping the baseline in a rollout PR is the #1 review rejection.

## Two modes

| Invocation | Where the overlay lands |
|---|---|
| no `--on-top-of-pr` | **Default.** A dedicated validation branch, as below. |
| `--on-top-of-pr <pr-url>` | On top of that open PR's head branch, as one revertable commit. |

The default exists to validate fabric in isolation. `--on-top-of-pr` exists for the common case where
the fabric change was made *because of* an open feature PR: that PR already carries the consumer code
needing the new fabric, so validating on a separate branch leaves the PR's own CI building against
the published (old) fabric, and the two only meet after the whole rollout lands.

Every difference the mode makes is called out inline below under **`--on-top-of-pr`**; everything
else is shared. The overlay is scaffolding either way — `/rollout-phase-b` removes it, and in this
mode it does so by reverting the single commit Step 5 creates.

## Steps

### Step 0 — Preflight, then ask

**Do this before anything else.** Nothing below runs until the user approves.

| Case | Behaviour |
|---|---|
| `<fabric-version>` / `<fabric-branch-or-commit>` given on the invocation | Use them **verbatim**. |
| Not given | **Derive from context** (ladder below), recording the source of each value. |
| Neither | Name what is missing and stop. |

**What was supplied is what gets used.** Never substitute the registry's latest published version or
the newest fabric tag for a value the user gave you, and never "correct" a supplied value to one of
them. The version is passed **bare** — `10297.0.0`, not `v10297.0.0`; the `v` is added at tag time in
Phase B. A `v`-prefixed value is malformed: report the expected form and ask.

**Derivation ladder** — first hit wins, and remember which one it was:

1. **This session**, or the open fabric PR under validation — whose head ref is also
   `<fabric-branch-or-commit>`.
2. **The newest `temp-<N>` release branch with no corresponding `v<N>.*` tag.** Fabric releases are
   cut from branches named `temp-<upstream-llama.cpp-build>`, and the version is
   `<build>.<major>.<minor>` — `temp-10069` carries `v10069.0.0`, `temp-9341` carries `v9341.1.6`. An
   untagged `temp-<N>` is therefore the next rollout, and `<N>` gives the version's leading component.
   The trailing `.<major>.<minor>` is still a human decision — propose `<N>.0.0` and ask.

**Never derive the version from the registry's latest entry, the newest `v*` tag, or the consumers'
current `version>=` floors.** All three hold the *previous* version.

**Resolve against the remote** — read-only; the fabric repo is public, so no token:

| Fact | Command |
|---|---|
| ref → commit sha | `git ls-remote https://github.com/tetherto/qvac-fabric-llm.cpp <ref>` |
| `v<VERSION>` must NOT exist yet | `git ls-remote --tags https://github.com/tetherto/qvac-fabric-llm.cpp "v<VERSION>"` |
| commit subject + date | `gh api repos/tetherto/qvac-fabric-llm.cpp/commits/<sha> --jq '{sha:.sha,msg:.commit.message,date:.commit.committer.date}'` |

Do **not** compare the ref against `master` — it tracks upstream, not the release line, and reports
`diverged` for every legitimate rollout.

#### `--on-top-of-pr` — resolve and vet the target PR

Only in this mode, and before anything else in Step 0 is presented:

```bash
gh pr view <n> --repo tetherto/qvac \
  --json number,title,state,isDraft,headRefName,headRefOid,headRepositoryOwner,baseRefName,labels,files
```

**Hard stops.** Report the reason, not a bare failure — each of these means the run cannot do what it
claims to:

| Condition | Why it stops the run |
|---|---|
| the URL is not a `tetherto/qvac` PR | a **fabric-repo** PR URL is the likely slip — that is the change being validated, not the target |
| PR is not `OPEN` | nothing to validate |
| head repo ≠ `tetherto/qvac` (a fork) | the overlay commit cannot be pushed to a fork's head branch |
| `baseRefName` ∉ `main` / `release-*` / `feature-*` / `tmp-*` | every `on-pr-<consumer>.yml` carries that `branches:` filter, so **no** consumer workflow fires at all |
| PR already carries `overlay-ports` or `vcpkg-overlays/ports/qvac-fabric/` | already overlaid — re-applying doubles it |
| local worktree dirty, or local branch ≠ `headRefOid` | the commit would sweep in unrelated work |

**Then the stage-eligibility report — this is the check that makes the mode honest.** CI stages are
routed by event, and `pull_request_target` is *not* a trusted event:
`.github/actions/ci-router/action.yml` enables every stage for `workflow_dispatch` / `workflow_call` /
`push` / `schedule`, but for a PR event it enables only `run_verified_checks` plus whatever the
granular labels select — and a **draft PR routes nothing at all**.

That matters because `run_verified_checks` gates only `sanity-checks` and `cpp-lint`. The `prebuild`
job — the one that actually compiles the addon against fabric — is gated on `run_prebuilds`.

Compute the report from the PR's own labels and draft state; never assume it:

```
  target PR       #3352  "QVAC-21981 feat[api]: ABot-World …"
                  head QVAC-21981/abot-world @ a2d3265d  ->  base main
                  labels: (none)   draft: no

  sanity-checks   eligible
  cpp-lint        eligible
  prebuild        NOT eligible   <- needs `prebuilds`
  cpp tests       NOT eligible   <- needs `run-cpp-addon-tests`
  desktop tests   NOT eligible   <- needs `run-desktop-addon-tests`
  mobile tests    NOT eligible   <- needs `run-mobile-addon-tests`

  ⚠ Without at least `prebuilds`, the overlay is never compiled — the PR
    goes green having built nothing against the new fabric.
```

A draft PR is its own `⚠`: it routes nothing, so the overlay sits inert until the PR is marked ready.
This is the same failure the misplaced-overlay warning in Step 3 describes — a green result that
validated the old version — reached by a different route, so treat it with the same seriousness.

**Present, then ask.** Label every value `(as given)` or `(derived: <source>)` — that label is what
lets the user catch a bad derivation, so never omit it. Render an anomaly (unknown ref, `v<VERSION>`
already present) as a `⚠` row naming its consequence:

```
Phase A — confirm before proceeding:

  fabric version   10297.0.0    (derived: temp-10297 is untagged)
  validating ref   temp-10297   (derived: newest untagged release branch)
  resolves to      6a32c29a7    "<subject>"   <date>
  tag v10297.0.0   does not exist yet ✓  (Phase B creates it)
  target          validation branch  (default mode)
```

In `--on-top-of-pr` mode the last row names the PR instead, and the stage-eligibility report above is
printed immediately below the block:

```
  target          PR #3352 on tetherto/qvac   (as given)
                  head QVAC-21981/abot-world @ a2d3265d  ->  base main
```

Then `AskUserQuestion` with exactly:

**Proceed** · **Correct a value** (say which) · **Abort**

The run does not start until Proceed is chosen — silence is not consent, and approval is required
even when every value resolves cleanly. When a `⚠` is present, Proceed's description must name what
is being accepted — an unlabelled PR means accepting that nothing will be compiled. If nothing yields
a version, say which value is missing and stop; never guess one.

**`--on-top-of-pr`:** the working branch for Steps 1–4 is the PR's head branch — `gh pr checkout <n>
--repo tetherto/qvac`. **Do not rebase it.** Rewriting a contributor's history is not this skill's
business, and the overlay works from wherever the PR's head happens to sit. Everything in Steps 1–3
is otherwise identical, all 7 consumers included.

### Step 1: Compute SHA512 of the fabric tarball
The fabric repo is public — no token needed. Use the `/archive/` URL (what vcpkg fetches). Do NOT use
`gh api …/tarball/` — its differently-named top-level directory yields a different hash.
```bash
curl -fsSL https://github.com/tetherto/qvac-fabric-llm.cpp/archive/<fabric-branch-or-commit>.tar.gz -o /tmp/fabric.tgz
vcpkg hash /tmp/fabric.tgz
```
Or let vcpkg print the expected hash on first failed fetch (intentionally wrong hash triggers it).

### Step 2: Add shared overlay port
Copy ALL files from the registry port (`tetherto/qvac-registry-vcpkg/ports/qvac-fabric/`) into `vcpkg-overlays/ports/qvac-fabric/` (repo root — `vcpkg-overlays/` already exists, holding `triplets/` and `toolchains/`). Then update `portfile.cmake` to point at the fabric branch/commit (NOT a tag — it doesn't exist yet):
```cmake
vcpkg_from_github(
  OUT_SOURCE_PATH SOURCE_PATH
  REPO tetherto/qvac-fabric-llm.cpp
  REF <fabric-branch-or-commit>
  SHA512 <sha512>
)
```
Keep the call to those four arguments. The registry port carries **no `HEAD_REF`**, and fabric's
default branch is `master` — so a copied-in `HEAD_REF main` is both an addition to the port you were
told to copy verbatim and a wrong value.

The registry port's `REF` is parameterized as `REF v${VERSION}`; the overlay replaces it with the
literal branch/commit precisely because no tag exists yet. Phase B restores the parameterized form
by leaving the registry portfile's `REF` untouched.

Update `vcpkg-overlays/ports/qvac-fabric/vcpkg.json` with `"version": "<VERSION>"`. (Overlays bypass
version resolution entirely, so this version only needs to satisfy the consumers' existing
`version>=` pin — the new `<VERSION>` is fine.)
Copy any other files from the registry port too (e.g. `android-vulkan-version.cmake` if present).

### Step 3: Add overlay-ports to all 7 consumers
In each `packages/<consumer>/vcpkg-configuration.json`, add:
```json
"overlay-ports": ["../../vcpkg-overlays/ports"]
```
The path is relative to the `vcpkg-configuration.json` that declares it — hence two levels up out
of `packages/<consumer>/` and back down into `vcpkg-overlays/ports`. Same string for all 7.

If this path is wrong, **nothing errors**: vcpkg finds no overlay, silently resolves `qvac-fabric`
from the registry, and you validate the OLD version while believing you tested the new one. Confirm
the overlay is live by checking the install log for the overlay's `<VERSION>`.

Do NOT change `default-registry.baseline`.

**Do NOT bump consumer `vcpkg.json` `"version>="` in Phase A** — that happens in Phase B. The overlay bypasses version resolution entirely; only the overlay port's own `vcpkg.json` version needs to match.

### Step 4: Confirm changes with user before committing

`git diff --stat` must show **exactly 9 files** — the 7 `packages/<consumer>/vcpkg-configuration.json`
plus `vcpkg-overlays/ports/qvac-fabric/{portfile.cmake,vcpkg.json}`. Anything else means something
got swept in; in `--on-top-of-pr` mode that something is the PR author's own work.

### Step 5: Commit and push to upstream branch (NOT fork)
```bash
git push origin <branch>
```
`origin` = `tetherto/qvac` (cloned directly, not a fork). Push straight to origin.

#### `--on-top-of-pr` — one commit, and only the overlay in it

Phase B removes the overlay by **reverting this commit**, so its contents decide whether that revert
is safe. Two halves, both required:

- **The commit holds those 9 files and nothing else.** Consumer C++ fixes from Step 7 are real work
  that stays on the PR after the rollout — they go in *separate* commits. Fold a fix into the overlay
  commit and Phase B's revert silently removes the fix along with the overlay.
- **The message has to be findable and self-explanatory**, because the next person to read it is
  whoever is triaging the PR:

  ```
  <TICKET> chore[notask]: overlay-validate the 7 fabric consumers against <fabric-ref>

  Rollout Phase A for the <feature> fabric change. Adds the shared qvac-fabric overlay
  port and points all 7 consumers at it, so they build against the fabric branch head
  before the tag exists and before anything is published to the registry.

  Consumer version>= pins are untouched — the overlay bypasses version resolution, so
  only the overlay port's own version matters here; bumping the pins is Phase B.
  default-registry.baseline is untouched in all 7.

  TEMPORARY. This commit is reverted by /rollout-phase-b --on-top-of-pr before the
  fabric dependency bump. The PR itself is meant to merge; this commit is not.

  Rollout-Overlay: qvac-fabric <VERSION> ref=<fabric-branch-or-commit> sha=<fabric-sha>
  ```

  The trailing `Rollout-Overlay:` line is functional metadata — it is what Phase B greps for. Keep it
  last and keep the prefix exact.

**Do not copy `DO NOT MERGE` from a validation-branch commit.** On a dedicated branch that marked the
whole branch as throwaway. Here the PR *is* meant to merge; it is the overlay **commit** that must go
first, and the wording above says so precisely.

Push to the PR's head branch, then **print the resulting commit SHA** — it is Phase B's input.

### Step 6: Trigger validation CI per consumer (`workflow_dispatch`)
```bash
for w in embed-llamacpp fabric llm-llamacpp model-fit ocr-ggml translation-nmtcpp vla; do
  gh workflow run on-pr-$w.yml --repo tetherto/qvac --ref <validation-branch>
done
```
- The workflow file for the `vla-ggml` consumer is `on-pr-vla.yml` (NOT `on-pr-vla-ggml.yml`).
  `on-pr-fabric.yml` and `on-pr-model-fit.yml` follow the standard naming — `vla` is the only
  exception.
- **Triage `fabric` first.** It is the shared runtime addon the other consumers link against, so a
  break there usually explains failures in the rest; fixing it first avoids chasing the same root
  cause across six other runs.
- Do NOT add stage labels to a validation PR — with `prebuilds` or any `run-*` label on it, every
  push re-runs ALL consumers (`pull_request_target` fires on each synchronize). `workflow_dispatch`
  is a trusted event in `ci-router` (no label needed, every stage enabled) and lets you re-run only
  the consumer(s) you actually changed. `verified` is **not** one of the labels to avoid adding or
  to add — `ci-router` reads only `prebuilds`, `run-cpp-addon-tests`, `run-desktop-addon-tests`,
  `run-mobile-addon-tests` and `run-coload-tests`; `verified` selects nothing.
- **A draft validation PR routes nothing at all.** `ci-router` sets `IS_AUTHORIZED=false` when
  `draft` is true, so *zero* stages run however many labels are on it — labels on a draft buy no
  coverage. Mark it ready, or drive it by dispatch.
- First pass: all seven. Later iterations: re-dispatch just the one(s) you touched.
- **A re-pin counts as touching all seven.** Moving the overlay's `REF`/`SHA512` changes the fabric
  every consumer builds against, so re-dispatching only `fabric` after one leaves the other six
  showing a **stale green from the previous fabric ref**, with nothing to say so. Nothing re-runs on
  this branch unless you dispatch it — there is no PR here, so no path filter is doing it for you.

**Expected failures / flakes while monitoring:**
- `merge-guard` / `validate-pr` always fail on a no-PR dispatch branch — expected, ignore. (Not so in
  `--on-top-of-pr` mode: a real PR has a real title, so these pass and a failure is genuine.)
- Known-flaky macOS and mobile device-farm jobs are typically non-blocking and orthogonal to a fabric
  change — confirm they're pre-existing / baseline-reproducible, retry the failed job (not the whole
  run), and don't chase them as rollout blockers.

#### `--on-top-of-pr` — do NOT dispatch; the push already triggered CI

The Step 5 push auto-triggers all 7 consumer workflows: the overlay commit edits every
`packages/<consumer>/vcpkg-configuration.json`, which each `on-pr-<consumer>.yml` path-matches via
`packages/<consumer>/**`. Monitor those runs. Dispatching as well would duplicate every run on the
same ref.

**Ask before adding labels.** Step 0's eligibility report says which stages the PR is actually
eligible for, and without `prebuilds` none of them compile anything. Adding labels changes the CI
cost of someone else's PR, so present the report, ask, and add only what was approved. `prebuilds`
alone gets the addon built against fabric; `run-cpp-addon-tests` / `run-desktop-addon-tests` /
`run-mobile-addon-tests` add the test tiers (each of the latter two implies `prebuilds`).

**Re-pinning the overlay re-triggers all 7 — `paths:` matches the whole PR, not the push.** When you
iterate by moving the overlay's `REF`/`SHA512`, a commit touching only
`vcpkg-overlays/ports/qvac-fabric/portfile.cmake` still fires every consumer workflow. On a
`pull_request_target` event GitHub evaluates `paths:` against the PR's **cumulative** changed-file set
(`base...head`), not the delta of the push that triggered it — and Step 5's overlay commit already put
all 7 `packages/<consumer>/vcpkg-configuration.json` into that set, so each `on-pr-<consumer>.yml`
keeps matching on `packages/<consumer>/**` for the rest of the PR's life. Do **not** touch the 7
configs to force a rebuild, and do not dispatch the six: both add noise to someone else's PR for an
effect you already have.

The same rule is why adding a label re-runs all 7 — a `labeled` event carries no file delta at all,
yet the cumulative path match still holds. Verified on qvac#3725: commit `40a157675` changed two lines
of the portfile and fired Fabric, Embed, LLM, Model Fit, NMTCPP, OCR-GGML and VLA.

This is the one place where the two modes genuinely diverge, so do not carry the default flow's
instinct across: on a dispatch-driven validation branch there is no PR and no cumulative diff, so
nothing re-runs unless you dispatch it — see the re-pin warning in Step 6 above.

### Step 7: Fix consumer breaks
Apply C++ fixes (API drift, new failure modes) using the Edit tool — specific lines only. Never `git checkout <branch> -- file.cpp` (takes the whole file, causes regressions).

Watch for:
- **API drift** — a fabric bump pulls a newer upstream llama.cpp/ggml whose API may have moved
  (renamed/relocated struct fields, changed signatures). Fix in the consumer addon.
- **Runtime behaviour shifts** (perf, threading, init paths) — if an integration test now hits a
  timeout, calibrate the timeout with a comment explaining why; NEVER skip/disable the test. Guard
  new failure modes (e.g. an init call returning null) with a catchable error, not a segfault.

**`--on-top-of-pr`:** these fixes are real work that stays on the PR — commit them **separately** from
the Step 5 overlay commit, never as an amend to it. That commit has to stay a pure overlay so Phase B
can revert it without taking a fix with it.

### Step 8: Update the fabric PR description with the validation runs
Once all consumers are green, add the validation CI runs to the fabric PR description — one bullet
per consumer, all 7 listed, noting the head commit they validated:
```
- <consumer name>: <CI run link>
```
In `--on-top-of-pr` mode these are the target PR's own runs; name the PR and the head commit they
validated, so a later reader can tell which fabric ref the green belongs to.

### Step 9: Post Slack message when all consumers green
```
Hi Team, Please review the PR for <feature name>
Fabric PR: https://github.com/tetherto/qvac-fabric-llm.cpp/pull/<N>
Validation branch: <validation-branch> (consumer CI runs listed in the fabric PR description)
```
If a qvac validation PR was opened, add its link (`Add on PR: https://github.com/tetherto/qvac/pull/<N>`).

In `--on-top-of-pr` mode, replace the validation-branch line with the target PR and say the overlay is
temporary, so nobody merges it by mistake:
```
Validated on: https://github.com/tetherto/qvac/pull/<N> (carries a TEMPORARY qvac-fabric
overlay commit — /rollout-phase-b reverts it before the dependency bump)
```

If you have no Slack access, print the message (with the links) to the console so the user can post it.
Wait for lead to merge fabric PR before proceeding to `/rollout-phase-b`.
