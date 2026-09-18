---
name: rollout-phase-a
description: Phase A of a qvac-fabric rollout — set up overlay port and validate every vcpkg fabric consumer (roster derived per run) against the fabric branch before publishing to the registry. By default it opens a labelled DO NOT MERGE validation PR that drives the consumer CI. Pass --on-top-of-pr to apply the overlay onto an open PR's head branch instead of a dedicated validation branch.
argument-hint: "<fabric-version> <fabric-branch-or-commit> [--on-top-of-pr <pr-url>]"
---

# Rollout Phase A — Overlay Validation

**Prerequisites:** Fabric PR open in `tetherto/qvac-fabric-llm.cpp`. Tag does NOT exist yet.

## THE ROSTER IS DERIVED, NEVER RECALLED

**Run this first, every time. Do not skip it because you think you know the answer.**
```bash
git -C <repo> grep -l "qvac-fabric" origin/main -- "packages/*/vcpkg.json"
```
Print the resulting list and its count `<N>` in the Step 0 confirmation block, and use **that** list
everywhere below that says "the consumers", "each consumer" or `<N>`. Nothing in this file is a
substitute for the command's output.

**Snapshot — 2026-09-14, and shrinking fast:** just **two** packages, `fabric` and `llm-llamacpp`.

The roster has gone 7 → 6 → 2 in under a month as addons migrate off the vcpkg port to the published
npm package `@qvac/fabric`: `classification-ggml`, then `vla-ggml` (qvac#3998), then `model-fit`,
`ocr-ggml`, `translation-nmtcpp`, and `embed-llamacpp` (qvac#4362, `581b1d094`). An npm-runtime
consumer needs **neither** overlay validation **nor** a `version>=` bump. Do not re-add one.

**Overlaying a package that has migrated is not harmless.** It writes `overlay-ports` into a config
whose `vcpkg.json` has no `qvac-fabric` dependency, so the overlay is never consulted — and it masks
the CI trap below. Conversely, *not* overlaying it is what exposes that trap. Get the roster right
and neither happens.

### Two ways a consumer reaches the new fabric — the roster is not the coverage

The derived roster governs **where the overlay goes** and **which packages get a `version>=` bump in
Phase B**. It does **not** describe what gets validated. Every consumer is exercised against the new
fabric, by one of two routes:

| Route | Who | How |
|---|---|---|
| **vcpkg overlay** | the `<N>` on the roster | `overlay-ports` → their build compiles `qvac-fabric` from the pinned ref |
| **`fabric-prebuilds` artifact** | every npm-runtime addon | `detect-fabric-stack` → `resolve-fabric-prebuilds` waits for the `fabric-prebuilds` artifact produced by the **Fabric** consumer run, then overlays it into their installed `@qvac/fabric` |

So a red in an npm-runtime lane **can be a genuine fabric break** and must be triaged, not waved off.
Observed on qvac#4408: Embed's `resolve-fabric-prebuilds` blocked ~33 minutes, then logged
`Found fabric-prebuilds in run <fabric-run-id> — downloading`, taking the artifact from the Fabric
run that had resolved `qvac-fabric` out of `vcpkg-overlays/ports/qvac-fabric`.

**The precondition that makes this silent when it fails:** the artifact only exists if the
`prebuilds` stage is on. Each npm-runtime addon's workflow says so itself:
```
::warning::This PR changes packages/fabric, but no prebuilds label is set, so on-pr-fabric
publishes nothing. Native jobs here build against the released @qvac/fabric, not this PR's.
Add the 'prebuilds' label to exercise the stack.
```
Without a `prebuilds`-implying label those lanes go **green having tested the previously released
`@qvac/fabric`**, with nothing in the result to say so — the same class of silent pass as a vcpkg
binary-cache hit. The Step 5 label set (`run-desktop-addon-tests`, `run-coload-tests`) each imply
`prebuilds`, so a correctly labelled validation PR exercises the whole stack. **Confirm it rather
than assume it:** grep a npm-runtime lane's log for `Found fabric-prebuilds in run`. If you instead
see the warning above, the run proved nothing about this fabric.

### The `await-ts-checks` deadlock (bites when the roster is correct)

Every npm-runtime consumer's **heavy** workflow `on-pr-<addon>.yml` (`pull_request_target`) triggers
on `packages/fabric/vcpkg.json` and `packages/fabric/vcpkg-configuration.json`. A correct rollout PR
touches exactly those files — so all of them fire, even though none is on the roster.

Each then waits on its `on-pr-<addon>-ts.yml` (`pull_request`) via `await-ts-checks`. If that TS
workflow does **not** also list the two fabric paths, it never starts, and the heavy workflow blocks
for its full 25-minute window before failing with:
```
Timed out waiting for <addon>-pr-head-ts-checks / ts-checks
```
This is a red check that has nothing to do with fabric. Verified on qvac#4408 (Embed), fixed for
Embed by qvac#4461. Before a rollout, confirm the pairs still match:
```bash
git -C <repo> grep -n "packages/fabric" origin/main -- ".github/workflows/on-pr-*-ts.yml"
git -C <repo> grep -n "packages/fabric" origin/main -- ".github/workflows/on-pr-*.yml"
```
Any addon appearing in the second list but not the first will deadlock. Fix the workflow (add the
paths to the `-ts.yml`); do **not** "fix" it by overlaying the addon or dropping the triggers from
the heavy workflow — those triggers exist so npm-runtime consumers rebuild against PR-modified
fabric.

## THE GOLDEN RULE
Never bump `default-registry.baseline` in `vcpkg-configuration.json`. Not now, not ever during a rollout.

Why nothing breaks without it: vcpkg resolves `version>=` against the registry's **published versions
(HEAD)**, not the baseline commit — the baseline is only a *floor* for ports with no explicit
constraint. Baselines are advanced only by separate, unrelated infra "Sync with fabric" maintenance
PRs; bumping the baseline in a rollout PR is the #1 review rejection.

## Two modes

| Invocation | Where the overlay lands | Whose PR runs the CI |
|---|---|---|
| no `--on-top-of-pr` | **Default.** A dedicated validation branch, plus a labelled `DO NOT MERGE` validation PR opened in Step 5. | the validation PR |
| `--on-top-of-pr <pr-url>` | On top of that open PR's head branch, as one revertable commit. | the target PR |

The default exists to validate fabric in isolation. `--on-top-of-pr` exists for the common case where
the fabric change was made *because of* an open feature PR: that PR already carries the consumer code
needing the new fabric, so validating on a separate branch leaves the PR's own CI building against
the published (old) fabric, and the two only meet after the whole rollout lands.

**Both modes are PR-driven.** That is the single most important thing to carry into Steps 6, 8 and 9:
the consumer workflows fire from `pull_request_target`, not from `workflow_dispatch`, in *either* mode.
Precedent for the default mode's PR: qvac#3954 and qvac#3814, both opened and later **closed, never
merged**.

The validation PR is an artifact, not a change to land. It exists so the validation has a reviewable
home and a link for Step 9's handoff; `/rollout-phase-b` closes it after the registry PR merges. If you
ever find yourself merging it, stop — the consumer bumps ride Phase B's own bundled PR.

Every difference the mode makes is called out inline below under **`--on-top-of-pr`**; everything
else is shared. The overlay is scaffolding either way — `/rollout-phase-b` removes it, and in
`--on-top-of-pr` mode it does so by reverting the single commit Step 5 creates.

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
  roster (N=2)    fabric, llm-llamacpp        (derived just now from origin/main)
  target          validation branch + new DO NOT MERGE validation PR  (default mode)
  PR labels       run-cpp-addon-tests, run-desktop-addon-tests, run-coload-tests
                  -> prebuilds ON (implied twice), mobile/Device-Farm co-load OFF
```

The roster row is the derived list, never one recalled from this file. If it differs from the snapshot
at the top, say so explicitly — that is not an error, it is the reason the command is run.

The label row is part of the approval because it is what decides whether the PR compiles anything —
see Step 6. State it before creating, not after.

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
is otherwise identical, all <N> consumers included.

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

### Step 3: Add overlay-ports to all <N> consumers
In each `packages/<consumer>/vcpkg-configuration.json`, add:
```json
"overlay-ports": ["../../vcpkg-overlays/ports"]
```
The path is relative to the `vcpkg-configuration.json` that declares it — hence two levels up out
of `packages/<consumer>/` and back down into `vcpkg-overlays/ports`. Same string for all <N>.

If this path is wrong, **nothing errors**: vcpkg finds no overlay, silently resolves `qvac-fabric`
from the registry, and you validate the OLD version while believing you tested the new one. Confirm
the overlay is live by checking the install log for the overlay's `<VERSION>`.

Do NOT change `default-registry.baseline`.

**Do NOT bump consumer `vcpkg.json` `"version>="` in Phase A** — that happens in Phase B. The overlay bypasses version resolution entirely; only the overlay port's own `vcpkg.json` version needs to match.

### Step 4: Confirm changes with user before committing

`git diff --stat` must show **exactly `<N>` + 2 files** — one
`packages/<consumer>/vcpkg-configuration.json` per consumer on the derived roster, plus
`vcpkg-overlays/ports/qvac-fabric/{portfile.cmake,vcpkg.json}`. With today's roster of 2 that is
4 files; when the roster was 7 it was 9. Anything else means something got swept in; in
`--on-top-of-pr` mode that something is the PR author's own work.

### Step 5: Commit, push to upstream branch (NOT fork), open the validation PR
```bash
git push origin <branch>
```
`origin` = `tetherto/qvac` (cloned directly, not a fork). Push straight to origin.

#### Default mode — the commit, then the validation PR

The commit message carries `DO NOT MERGE` (here the whole branch *is* throwaway) and the functional
trailer Phase B greps for:

```
<TICKET> chore[notask]: overlay-validate the <N> fabric consumers against <fabric-ref>

DO NOT MERGE. Rollout Phase A validation branch for qvac-fabric <VERSION>.

Adds the shared qvac-fabric overlay port pinned at <fabric-ref> and points all <N>
consumers at it, so they build against the fabric commit before the v<VERSION> tag
exists and before anything is published to the registry.

Consumer version>= pins are untouched — the overlay bypasses version resolution
entirely, so only the overlay port's own version matters here; bumping the pins is
Phase B. default-registry.baseline is untouched in all <N>.

Rollout-Overlay: qvac-fabric <VERSION> ref=<fabric-branch-or-commit> sha=<fabric-sha>
```

Then open the PR. **It must be labelled and it must not be a draft** — see Step 6 for why an unlabelled
or draft PR validates nothing:

```bash
gh pr create --repo tetherto/qvac --base main --head <validation-branch> \
  --title "<TICKET> chore: DO NOT MERGE, overlay-validate the <N> fabric consumers against qvac-fabric <VERSION>" \
  --body-file <path-to-body.md> \
  --label run-cpp-addon-tests --label run-desktop-addon-tests --label run-coload-tests
```

`--body-file`, not a heredoc — repo `CLAUDE.md` forbids heredocs, `cat >` and `echo >`; write the body
with the Write tool.

The body should carry, modelled on qvac#3954:

- `## DO NOT MERGE` first, saying the overlay is validation scaffolding removed in Phase B.
- What is being validated: the fabric ref, its subject, and — if it is a PR head — how far ahead of the
  release branch it is and which files it changes that consumers compile against.
- The `<N>` consumers by name, the command they were derived from, and which addons are
  deliberately excluded as npm-runtime consumers of `@qvac/fabric`.
- That consumer `version>=` pins and `default-registry.baseline` are untouched in all <N>.
- **Tested:** the 9-file diff assertion from Step 4, and how the SHA512 was computed.
- **Notes for reviewers:** any known-environmental failure to expect, so a red is not misread.

Then **print the PR URL** — it is the input to Steps 8 and 9, and to Phase B's close step.

#### `--on-top-of-pr` — one commit, and only the overlay in it

Phase B removes the overlay by **reverting this commit**, so its contents decide whether that revert
is safe. Two halves, both required:

- **The commit holds those `<N>` + 2 files and nothing else.** Consumer C++ fixes from Step 7 are real work
  that stays on the PR after the rollout — they go in *separate* commits. Fold a fix into the overlay
  commit and Phase B's revert silently removes the fix along with the overlay.
- **The message has to be findable and self-explanatory**, because the next person to read it is
  whoever is triaging the PR:

  ```
  <TICKET> chore[notask]: overlay-validate the <N> fabric consumers against <fabric-ref>

  Rollout Phase A for the <feature> fabric change. Adds the shared qvac-fabric overlay
  port and points all <N> consumers at it, so they build against the fabric branch head
  before the tag exists and before anything is published to the registry.

  Consumer version>= pins are untouched — the overlay bypasses version resolution, so
  only the overlay port's own version matters here; bumping the pins is Phase B.
  default-registry.baseline is untouched in all <N>.

  TEMPORARY. This commit is reverted by /rollout-phase-b --on-top-of-pr before the
  fabric dependency bump. The PR itself is meant to merge; this commit is not.

  Rollout-Overlay: qvac-fabric <VERSION> ref=<fabric-branch-or-commit> sha=<fabric-sha>
  ```

  The trailing `Rollout-Overlay:` line is functional metadata — it is what Phase B greps for. Keep it
  last and keep the prefix exact.

**Do not copy `DO NOT MERGE` from the default mode's commit or PR.** There it is correct — the branch
and its validation PR are both throwaway. Here the PR *is* meant to merge; it is the overlay **commit**
that must go first, and the wording above says so precisely. Getting this backwards either strands a
contributor's feature PR as unmergeable or invites someone to merge an overlay into `main`.

Push to the PR's head branch, then **print the resulting commit SHA** — it is Phase B's input.

### Step 6: Monitor the consumer CI — the PR triggers it, do NOT dispatch

**Opening the PR already triggered all <N>.** The overlay commit edits every
`packages/<consumer>/vcpkg-configuration.json`, which each `on-pr-<consumer>.yml` path-matches via
`packages/<consumer>/**`. Dispatching as well duplicates every run on the same ref. This holds in both
modes; the only difference is whose PR it is.

`workflow_dispatch` keeps exactly one use: re-running a **single** consumer while iterating on a Step 7
C++ fix, where you do not want the rest of the `<N>` rebuilt. **Take the workflow filename from the
repo, not from memory** — the `on-pr-<consumer>.yml` names are not uniformly derived from the package
dir. `on-pr-fabric.yml` and `on-pr-llm-llamacpp.yml` follow the standard naming; historical exceptions
existed (`vla-ggml` shipped as `on-pr-vla.yml` while it was still a vcpkg consumer), so confirm with
`gh workflow list` or `ls .github/workflows/` before dispatching.

```bash
gh workflow run on-pr-<consumer>.yml --repo tetherto/qvac --ref <branch>   # one consumer only
```

**Triage `fabric` first.** It is the shared runtime the others build on, so a break there usually
explains failures in the rest; fixing it first avoids chasing one root cause across every other run.

It is also the **producer of the `fabric-prebuilds` artifact** every npm-runtime addon blocks on (see
"Two ways a consumer reaches the new fabric"). So a Fabric failure does not merely correlate with the
others — it starves them. Expect npm-runtime lanes to sit in `resolve-fabric-prebuilds` for 30+
minutes while Fabric is still building; that wait is normal, not a hang.

#### The labels are what make the PR a validation

`pull_request_target` is **not** a trusted event. `ci-router` enables every stage for
`workflow_dispatch` / `workflow_call` / `push` / `schedule`, but for a PR event it enables only
`run_verified_checks` plus what the granular labels select. `run_verified_checks` gates just
`sanity-checks` and `cpp-lint` — **not** `prebuild`, which is what actually compiles the addon against
fabric.

So an unlabelled validation PR goes green having built nothing against the new fabric. The label set:

| Label | Adds | Implies `prebuilds`? |
|---|---|---|
| `run-cpp-addon-tests` | C++ unit tests | no |
| `run-desktop-addon-tests` | desktop integration tests | **yes** |
| `run-coload-tests` | desktop multi-addon co-load smoke | **yes** |

Those three are what Phase A sets. **Do not add `prebuilds` explicitly** — desktop and co-load each
turn it on, so the label is redundant (qvac#3954 carried it unnecessarily). Read the implications off
`.github/actions/ci-router/action.yml` rather than trusting prose:

```bash
[ "$HAS_DESKTOP" = "true" ]  && { DESKTOP=true; PREBUILDS=true; }
[ "$HAS_MOBILE" = "true" ]   && { MOBILE=true; PREBUILDS=true; }
[ "$HAS_COLOAD" = "true" ]   && { COLOAD=true; PREBUILDS=true; }
```

`run-mobile-addon-tests` is deliberately **omitted**: per the router's own ANNOUNCEMENT the standalone
per-addon mobile suites are dispatch-only and the label no longer launches them, so all it still does is
gate the on-device Device Farm co-load — a known-flaky lane orthogonal to a fabric change. Desktop
co-load runs on `run-coload-tests` alone. `verified` selects nothing at all; `ci-router` never reads it.

**A draft PR routes nothing.** `ci-router` sets `IS_AUTHORIZED=false` when `draft` is true, so *zero*
stages run however many labels are on it. Mark it ready.

#### Every push re-runs all <N> — `paths:` matches the whole PR, not the push

On a `pull_request_target` event GitHub evaluates `paths:` against the PR's **cumulative** changed-file
set (`base...head`), not the delta of the push that triggered it. Step 5's overlay commit already put
all <N> `packages/<consumer>/vcpkg-configuration.json` into that set, so each `on-pr-<consumer>.yml` keeps
matching for the rest of the PR's life. A commit touching only
`vcpkg-overlays/ports/qvac-fabric/portfile.cmake` still fires every consumer. Verified on qvac#3725:
commit `40a157675` changed two lines of the portfile and fired all seven. The same rule is why adding a
label re-runs all <N> — a `labeled` event carries no file delta, yet the cumulative match still holds.

Do **not** touch the `<N>` configs to force a rebuild, and do not dispatch the remaining consumers on
top.

**A re-pin needs all `<N>`, and you get that for free.** Moving the overlay's `REF`/`SHA512` changes the
fabric every consumer builds against, so any consumer not re-run is showing a **stale green from the
previous fabric ref** with nothing to say so. Since the push re-fires all <N> by itself, the failure mode
here is the opposite of the old one: don't assume an earlier green still counts. Say plainly, in the PR
and in the handoff, that greens against a superseded ref are void.

#### Expected noise while monitoring

- **Label churn on PR creation.** `gh pr create --label a --label b --label c` fires the `opened` event
  plus one `labeled` event per label, and concurrency groups cancel each superseded generation —
  qvac#4100 produced about ten `cancelled` runs this way. Only the last generation per consumer is live.
  Before triaging, confirm **exactly one live run per consumer**, and never read a superseded
  `cancelled` run as a failure. Listing with `--limit 12` can hide a live run behind the cancelled ones;
  filter per workflow if a consumer looks absent.
- **`Merge Guard` / `validate-pr` now run for real.** They no longer auto-fail for want of a PR. But
  they are a **rollup**: `validate-pr` fails when `build-status: false`, so a consumer red makes them
  red too. Fix the consumer; the rollup follows. It is not an independent signal.
- **Every npm-runtime addon fires too, not just the `<N>` on the roster** — and **their results are
  real signal**, not noise. See "Two ways a consumer reaches the new fabric" above. Read them as you
  would a roster consumer: a red there can mean the new fabric broke an npm-runtime addon. Leave
  them running rather than cancelling someone's lane.
- Known-flaky macOS and mobile device-farm jobs are typically non-blocking and orthogonal to a fabric
  change — confirm they're pre-existing / baseline-reproducible, retry the failed job (not the whole
  run), and don't chase them as rollout blockers.

#### Two traps that make a green mean less than it looks

- **A green consumer may never have compiled fabric.** vcpkg restores `qvac-fabric` from the binary
  cache whenever the ABI hash matches, and then `portfile.cmake` **never executes**. Grep the install
  log for `Building qvac-fabric` to know the ref was actually built; `Restored N package(s)` followed by
  `Installing …` with no build line means it was not. A real build is 30+ minutes. This is the same
  class of silent failure as the overlay-not-live warning in Step 3.

  Consequence worth knowing: a cache hit also skips the portfile's own preconditions. Observed on
  qvac#4100 — VLA had been green on the previous pin because the package was restored, and the re-pin's
  cache miss ran `portfile.cmake` for the first time, surfacing a pre-existing ROCm/`hip-backend`
  precondition failure at `portfile.cmake:118` that had never executed before. That is a latent defect
  exposed, not one the rollout caused; say so when reporting it.

- **`gh run watch --exit-status` exiting 1 does not always mean the run failed.** It also exits 1 on a
  connection error. Check the output tail for `error connecting to api.github.com` before reporting a
  consumer red, and re-query the run's `conclusion` to confirm. Two watchers dying within seconds of
  each other is a network symptom, not two failures.

#### `--on-top-of-pr` — everything above applies; what differs is that it is someone else's PR

The triggering, the label routing, the cumulative-`paths:` rule and the two green-means-less traps are
all identical here — the Step 5 push fires all <N> the same way. Three things change:

- **Ask before adding labels.** Labels change the CI cost of a PR you do not own. Present Step 0's
  stage-eligibility report, ask, and add only what was approved. Without at least one label implying
  `prebuilds`, the PR goes green having compiled nothing against fabric — which is the whole reason
  Step 0 prints that report.
- **Do not remove or replace labels the PR already carries.** Add to them if approved; the author put
  them there for their own reasons.
- **Do not rebase, and keep the noise down.** Rewriting a contributor's history is not this skill's
  business, and the overlay works from wherever the PR's head sits.

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
per consumer, all <N> listed:
```
- <consumer name>: <CI run link>
```
These are PR runs in both modes: the validation PR's in default mode, the target PR's under
`--on-top-of-pr`. Name **which qvac PR** they came from and **which fabric ref** they validated, so a
later reader can tell what the green belongs to — a run link alone does not say which pin it built.

If any consumer is red for a reason that is not the fabric change — an environmental failure, or a
pre-existing defect the re-pin merely exposed — say which, and why it is not attributable. A bare list
of greens with one red invites the reader to assume the fabric broke it.

### Step 9: Post Slack message when all consumers green
```
Hi Team, Please review the PR for <feature name>
Fabric PR: https://github.com/tetherto/qvac-fabric-llm.cpp/pull/<N>
Validation PR: https://github.com/tetherto/qvac/pull/<N> (DO NOT MERGE — temporary qvac-fabric
overlay; /rollout-phase-b closes it after the registry PR merges. Consumer CI runs are listed in
the fabric PR description.)
```
The validation PR link is unconditional now — default mode always opens one in Step 5.

In `--on-top-of-pr` mode, the line names the target PR instead, and must not call it DO NOT MERGE —
that PR *is* meant to merge; only the overlay commit is temporary:
```
Validated on: https://github.com/tetherto/qvac/pull/<N> (carries a TEMPORARY qvac-fabric
overlay commit — /rollout-phase-b reverts it before the dependency bump)
```

If you have no Slack access, print the message (with the links) to the console so the user can post it.
Wait for lead to merge fabric PR before proceeding to `/rollout-phase-b`.
