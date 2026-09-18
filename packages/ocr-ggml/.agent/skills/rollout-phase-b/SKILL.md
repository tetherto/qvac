---
name: rollout-phase-b
description: Phase B of a qvac-fabric rollout — tag the merged fabric commit, publish to registry, land the consumer side (vcpkg bumps + package versions + changelogs for every vcpkg fabric consumer, roster derived per run) as one PR, close Phase A's validation PR unmerged, post one Slack message. Pass --bump-only to resume a part-done rollout and do just the version + changelog work. Pass --on-top-of-pr to put the whole consumer side onto an open PR — revert the overlay commit Phase A placed there AND land the bumps on that same PR, instead of opening a separate bundled PR.
argument-hint: "<fabric-version> <merge-commit-sha> [--bump-only] [--on-top-of-pr <pr-url>]"
---

# Rollout Phase B — Tag + Registry + Bundled Consumer PR

**Prerequisites:** Fabric PR merged. Phase A all green. `v<VERSION>` tag does NOT exist yet.

## THE ROSTER IS DERIVED, NEVER RECALLED

**Run this first, every time**, and use its output — not this file — everywhere below that says
"the consumers", "each consumer" or `<N>`:
```bash
git -C <repo> grep -l "qvac-fabric" origin/main -- "packages/*/vcpkg.json"
```
Print the list and its count `<N>` in the Step 0 confirmation block.

**Snapshot — re-confirmed 2026-09-15 on the 10549.1.0 rollout:** just **two** packages, `fabric` and
`llm-llamacpp`.
The roster went 7 → 6 → 2 in under a month as addons migrated off the vcpkg port to the published npm
package `@qvac/fabric` (`classification-ggml`; `vla-ggml` in qvac#3998; then `model-fit`, `ocr-ggml`,
`translation-nmtcpp`, `embed-llamacpp` in qvac#4362 / `581b1d094`).

An npm-runtime consumer needs **no `version>=` bump** — it has no `qvac-fabric` entry to bump — and
**no changelog entry** for the fabric version. Bumping one is a review rejection; worse, adding a
`version>=` to a package that does not depend on the port can wedge resolution. Do not re-add one.

**But "not on the roster" does not mean "not validated."** In Phase A every npm-runtime addon is
exercised against the new fabric too, via the `fabric-prebuilds` artifact that the Fabric run
publishes and their `resolve-fabric-prebuilds` job overlays into their installed `@qvac/fabric`. The
roster decides who gets an overlay and a bump; it does not decide coverage. So when Phase A reports
greens, expect roughly `<N>` + 6 consumer lanes to have run, and treat a red in any of them as real.

The roster also governs Phase A's overlay removal: only packages on it ever received `overlay-ports`,
so only they need it stripped. If you find `overlay-ports` on a package that is *not* on the roster,
it was overlaid in error — remove it, and say so, but do not give it a `version>=` bump.

## THE GOLDEN RULE
Never bump `default-registry.baseline` in `vcpkg-configuration.json`. Anywhere. Ever.

---

## Step 0 — Preflight, then ask

**Do this before anything else, in every mode.** Nothing in B1 or B2 runs until the user approves.

### Where the fabric details come from

| Case | Behaviour |
|---|---|
| Given on the invocation | Use them **verbatim**, for the whole run. |
| Not given | **Derive from context** (ladder below), recording the source of each value. |
| Neither | Name what is missing and stop. |

**What was supplied is what gets used.** Do not substitute the registry's latest published version,
the consumers' `version>=` floors, or the newest fabric tag for a value the user gave you, and do not
"correct" a supplied value to one of them. Remote resolution below *annotates* the values; it never
replaces them.

The version is passed **bare** — `10069.0.0`, not `v10069.0.0`. `git tag v<VERSION>` and the registry
portfile's `REF v${VERSION}` both add the `v`. A `v`-prefixed value is malformed: report the expected
form and ask, rather than silently stripping it.

### Derivation ladder — only for values that were NOT given

Take the first that yields a value, and remember which one it was:

1. **This session** — a `/rollout-phase-a` run, or a version stated explicitly.
2. **The overlay port's own version** — `vcpkg-overlays/ports/qvac-fabric/vcpkg.json` `"version"`,
   on the Phase A validation branch or (in `--on-top-of-pr` mode) on the target PR's head branch.
   Phase A Step 2 sets this to the exact target. Best source when either branch is to hand.
3. **`--bump-only` only:** the <N> consumers' `vcpkg.json` `"version>="`, which must all agree. In this
   mode the floors *are* the target — that is the mode's precondition.
4. **`<merge-commit-sha>`:** the HEAD of the release branch `temp-<N>` (see below), or the fabric PR's
   merge commit.

**Never derive a NEW version from the registry's latest entry, the newest `v*` tag, or the current
`version>=` floors.** All three hold the *previous* version, so a value taken from them re-tags an
already-tagged commit and republishes a live one. `--bump-only` is the single exception, because
there the previous version *is* the target.

### The release line is `temp-<N>`, not `master`

Fabric releases are cut from branches named `temp-<upstream-llama.cpp-build>`, and the version is
`<build>.<major>.<minor>`. **`master` tracks upstream and is not the release line** — comparing a
release commit against it reports `diverged` and tells you nothing.

| Version | Release branch | Tag sits at |
|---|---|---|
| `10069.0.0` | `temp-10069` | branch HEAD (`63bfbdea0`) |
| `9341.1.6` | `temp-9341` | branch HEAD (`55325c0c8`) |

So `<merge-commit-sha>` should be on `temp-<N>` for the `<N>` leading the version you are publishing.
A commit that is not is the strongest available signal that the version and the commit disagree.

### Resolve against the remote — read-only

`tetherto/qvac-fabric-llm.cpp` is public; no token needed.

| Fact | Command |
|---|---|
| does `v<VERSION>` already exist | `git ls-remote --tags https://github.com/tetherto/qvac-fabric-llm.cpp "v<VERSION>"` |
| release-branch HEAD | `git ls-remote https://github.com/tetherto/qvac-fabric-llm.cpp "refs/heads/temp-<N>"` |
| commit subject + date | `gh api repos/tetherto/qvac-fabric-llm.cpp/commits/<sha> --jq '{sha:.sha,msg:.commit.message,date:.commit.committer.date}'` |
| is the commit on `temp-<N>` | `gh api repos/tetherto/qvac-fabric-llm.cpp/compare/temp-<N>...<sha> --jq .status` → `identical` or `behind` means yes |

Expected tag state — **flag it, never resolve it yourself**:

- full run → `v<VERSION>` must NOT exist; if it does, proceeding re-tags a published version
- `--bump-only` → `v<VERSION>` must exist; if it does not, the registry PR probably has not merged

### Where the overlay is, and the safety net

`--on-top-of-pr <pr-url>` says Phase A put its overlay commit on an open PR rather than a dedicated
validation branch. Step 5b reverts it — **and B2's bumps land on that same PR**, not on a new one.
See the mode table at the head of B2; the flag governs the whole consumer side, not just the revert.

Without the flag, Phase A's overlay lives on its own validation branch behind a `DO NOT MERGE`
validation PR. Nothing needs reverting — that branch is throwaway — but the PR still has to be
disposed of: **Step 11 closes it unmerged** once the registry PR has landed.

**If the flag is absent, still look.** Run the completeness sweep in Step 5b against the working repo
before proceeding. If it finds overlay artefacts, **stop** — name exactly what was found and which
branch or PR carries it, and say `--on-top-of-pr` is required:

```
/rollout-phase-b: refusing to bump over a live overlay.

  ! vcpkg-overlays/ports/qvac-fabric/       present on <branch>
  ! "overlay-ports" key in <N> packages/*/vcpkg-configuration.json

An overlay makes vcpkg resolve qvac-fabric from the local portfile instead of the
registry, silently. Bumping the floors now ships a version that was never validated
against the published port.

Re-run with --on-top-of-pr <pr-url>, or remove the overlay first.
```

This is the same invariant `--bump-only` preflight check 6 enforces; the flag is what tells the skill
where to go and fix it rather than only complain.

### Present, then ask

Print every value with its provenance, then ask. The label is what lets the user catch a bad
derivation — it is the reason deriving is safe at all, so never omit it:

```
Phase B — confirm before proceeding:

  fabric version   10069.0.0    (as given)
  tag to create    v10069.0.0   ⚠ already exists — proceeding re-tags a published version
  release branch   temp-10069
  merge commit     63bfbdea0    (derived: temp-10069 HEAD)
                   "Merge pull request #204 …"   2026-08-06
  mode             full (B1 + B2) — bumps land on a new branch off origin/main
```

The `mode` row must name **where the bumps will land**, so a wrong target is caught before anything is
pushed. In `--on-top-of-pr` mode it reads:

```
  mode             full (B1 + B2) — bumps land on PR #3725, no separate PR
```

`--bump-only` shows the version, that `v<VERSION>` exists, and that the registry has published it —
no commit row.

`--on-top-of-pr` adds two rows naming what Step 5b will revert, resolved before the prompt so the
user can catch a wrong PR or a missing overlay commit while it is still cheap:

```
  overlay on       PR #3352  head QVAC-21981/abot-world @ a2d3265d
  reverting        5a950ade2  "… overlay-validate the <N> fabric consumers against …"
```

Then `AskUserQuestion` with exactly:

**Proceed** · **Correct a value** (say which) · **Abort**

When a `⚠` is present, Proceed's description must name what is being accepted. The run does not start
until Proceed is chosen — silence is not consent, and approval is required even when every value
resolves cleanly.

### If nothing yields a version

Name the missing value and stop. Never guess a version, never default it, never fall back to the
newest tag:

```
/rollout-phase-b: no fabric version supplied, and none could be derived.
usage: /rollout-phase-b <fabric-version> <merge-commit-sha> [--bump-only]
   eg: /rollout-phase-b 10069.0.0 63bfbdea0
Nothing was changed. Re-run with the version you intend to publish.
```

---

## `--bump-only` (resume mode)

For the common resumed state: the fabric tag is pushed, the registry PR merged, and the
`vcpkg.json` floors already bumped — all that is left is the mechanical version + changelog work.

**Skips** B1 entirely, and skips Step 7 sub-steps 1–3.
**Performs** only Step 7 sub-step 4 (`package.json`) and sub-step 5 (`CHANGELOG.md`), for all <N>
consumers. Everything the mode skips, it first verifies was actually done.

Combining it with `--on-top-of-pr` is legitimate — the overlay outlives a part-done rollout as easily
as a whole one. In that combination Step 5b still runs, before the bumps, and preflight check 6 is
what it satisfies. The bumps land on the **target PR** here too, and checks 2 and 7 below need the
merge-base treatment (Step 5b's `$BASE`) rather than `origin/main`, since the target branch is not cut
fresh from main.

### Preflight — verify, then stop or proceed

**Step 0 runs first.** These checks compare against the version the user confirmed there; if Step 0
never reached approval, none of this runs. `--bump-only` does not make the version optional — the
mode skips B1's *work*, not its input, though it does widen how the version may be derived (Step 0's
ladder item 3).

Run **all** checks and report **every** failure in one list. Do not stop at the first — a part-done
rollout usually has more than one gap, and drip-feeding them wastes a round trip each.

| # | Check | How |
|---|---|---|
| 1 | Working repo is the real code repo on the right remote | `git -C <repo> remote -v` → `tetherto/qvac` |
| 2 | On a branch off `origin/main` — not `main`, not `release-*` (in `--on-top-of-pr` mode: on the target PR's head branch) | `git -C <repo> rev-parse --abbrev-ref HEAD` |
| 3 | Fabric tag `v<VERSION>` exists | `git -C <fabric-repo> ls-remote --tags <remote> "v<VERSION>"` |
| 4 | `qvac-fabric <VERSION>` is published to the registry | see command below — non-null result means published |
| 5 | All <N> `vcpkg.json` `"version>="` already equal `<VERSION>` | read each `packages/<consumer>/vcpkg.json` |
| 6 | Overlay fully removed | the completeness sweep in Step 5b, repo-wide — not just the <N> |
| 7 | No `default-registry.baseline` drift | `git -C <repo> diff $BASE -- "packages/*/vcpkg-configuration.json"` → empty (`$BASE` = `origin/main`, or the merge base in `--on-top-of-pr` mode) |
| 8 | Per consumer: `origin/main` `package.json` version vs npm | `npm view @qvac/<pkg> dist-tags.latest` |

**Check 4** — request the raw blob so no base64 decoding is needed:
```bash
gh api repos/tetherto/qvac-registry-vcpkg/contents/versions/q-/qvac-fabric.json \
  -H "Accept: application/vnd.github.raw" --jq '[.versions[].version] | index("<VERSION>")'
```
A number means published; `null` means the registry PR has not merged — stop.

**Check 5** — parse the JSON; do **not** grep a fixed line offset from `"name": "qvac-fabric"`. The
dependency object's shape varies between consumers, so a `grep -A1` reports the floor as missing when
it is present and correct. On the current roster `fabric` carries `features: [hip-backend,
vector-index]` after its `version>=` while `llm-llamacpp` carries nothing; packages that have since
left the roster used `default-features` and `features` too. Read the `version>=` field out of the
parsed object and the shape stops mattering.

A floor may also carry a port-version suffix — `"version>=": "10549.0.0#1"` — when the last rollout
published a rebuild. That still compares equal to `<VERSION>` only if `<VERSION>` includes the same
suffix, so compare the whole string, and expect to *drop* the suffix when moving to a new version.

**Check 6 matters more than it looks.** A leftover overlay makes vcpkg resolve `qvac-fabric` from
the overlay instead of the registry — silently. Nothing errors; you would ship a bump that was
never validated against the published port.

Run Step 5b's sweep for it rather than checking only the <N> consumers — an overlay added by hand
outside the roster resolves just as silently. On failure, name the branch or PR still carrying it and
point at `--on-top-of-pr`; a bare "check 6 failed" leaves the user to find it themselves.

**Check 8 has four outcomes**, not pass/fail:

| Outcome | Meaning | Do |
|---|---|---|
| npm **==** `origin/main` | normal — the bump is genuinely pending | proceed |
| npm **behind** `origin/main` | a bump already landed and is unreleased | **stop and ask** before adding another (`/bump-version` Step 1's rule) |
| npm **ahead**, major differs | the package's line was **renumbered** — see below | proceed on the `origin/main` number |
| npm **ahead**, same line | wrong checkout or wrong branch | stop |

Two cases that look like failures and are not:

- A package reading `0.0.0` on npm with **no release tag** has never been published — `0.0.0` is
  npm's name placeholder, not a real release, so it presents as the *behind* case. Do not paper over
  it; ask whether the version already on `origin/main` should publish as-is before bumping past it.
  (`model-fit` was the standing instance and has since published — re-derive rather than assume;
  `npm view @qvac/<pkg> dist-tags.latest` plus `git ls-remote --tags origin "<prefix>-v*"`.)
- `@qvac/translation-nmtcpp` reads `10.0.0` on npm against `0.8.0` on `origin/main`: the *renumbered*
  case, not a bad checkout. Its `main` line was restarted at `0.x` (there is a live `release-0.7`
  dist-tag at `0.7.0`), so npm's `latest` will stay numerically ahead indefinitely. **`origin/main`
  is the authority for the bump.** Confirm the branch is right, then proceed from `0.8.0`.

**Step 7 sub-step 3 (Phase A C++ fixes) cannot be verified mechanically.** Do not claim a check you
did not perform. Instead print the non-manifest diff and have the user confirm:
```bash
git -C <repo> diff --stat $BASE -- "packages/*/addon" "packages/*/src"
```
(`$BASE` = `origin/main`, or the merge base in `--on-top-of-pr` mode — on a target PR branch
`origin/main` folds in the author's own C++ and makes this unreadable.)

### On success — apply the bumps

`/bump-version` is the single source of truth for bump level and changelog shape. Note that it is
`disable-model-invocation: true`, so it **cannot be invoked programmatically** — follow its written
Steps 3–5 procedure here. (Alternative, if you prefer the skill itself: run `/bump-version <pkg>`
per package by hand, passing `major` explicitly for any package that is already `>=1.0`.)

- **Bump level** comes from the table in Step 7 sub-step 4 below: `0.x` → minor, `>=1.0` → major.
  `/bump-version` never auto-selects major, so any package on `>=1.0` must be given the level
  **explicitly**. As of 2026-09-15 **no consumer is** — every package on the roster is `0.x`. Read the
  version and apply the table; see Step 7 sub-step 4.
- **Changelog entries** use the fabric-only wording in Step 7 sub-step 5, with the bracketed
  `## [<version>] - <date>` heading.
- **A `## [Unreleased]` block is a decision, not a placeholder** — see Step 7 sub-step 5. Never insert
  the dated entry below populated unreleased content.

### Stop point

Apply the `<N>` × 2 edits (`package.json` + `CHANGELOG.md` per consumer), then **stop and confirm
before committing**. Print:

1. a summary table — `pkg · old → new · level`;
2. `git -C <repo> diff --stat $BASE` — or, in `--on-top-of-pr` mode, `git diff --cached --stat`,
   since the target branch carries the author's work and can never reduce to those files.

Assert the diff touches **only** `package.json` and `CHANGELOG.md` across the <N> packages — anything
else means something got swept in. Then ask the user to confirm before continuing into Step 9
(commit / push) and Step 10 (PR — or, in `--on-top-of-pr` mode, updating the target PR instead of
creating one). Never commit unattended in this mode.

---

## B1 — Tag + Registry

### Step 1: Tag the merged fabric commit
```bash
git -C <fabric-repo-path> tag v<VERSION> <merge-commit-sha>
git -C <fabric-repo-path> push upstream v<VERSION>
```
(`upstream` = whichever remote points at `tetherto/qvac-fabric-llm.cpp` — it may be named `origin` in a direct clone; check `git remote -v`.)
Verify: `git -C <fabric-repo-path> show v<VERSION> --stat`

### Step 2: Compute SHA512 of the tag tarball
```bash
curl -fsSL https://github.com/tetherto/qvac-fabric-llm.cpp/archive/v<VERSION>.tar.gz -o /tmp/fabric-tag.tgz
vcpkg hash /tmp/fabric-tag.tgz
```

### Step 3: Update registry portfile (`tetherto/qvac-registry-vcpkg`)
- `ports/qvac-fabric/portfile.cmake`: update `SHA512` to the tag tarball's hash. **That is the only
  edit.** `REF` is already `REF v${VERSION}`, parameterized off the port's `vcpkg.json` — do not
  replace it with a literal `REF v<VERSION>`; de-parameterizing the portfile is a review rejection.
- `ports/qvac-fabric/vcpkg.json`: `"version": "<VERSION>"` — bumping this is what moves the ref.
- Update versions DB:
  ```bash
  vcpkg --x-builtin-registry-versions-dir=versions x-add-version qvac-fabric
  ```

#### Then check `x-add-version`'s output — but keep the `port-version` it writes

**Keep `"port-version": 0` on the new entry.** `x-add-version` emits it, and that is now the intended
shape: registry PR **#366 deliberately normalized** `versions/q-/qvac-fabric.json` so every entry
carries the key explicitly, matching the other 28 version files in that registry, which had always
carried it. Stripping it makes the new entry the sole outlier in a normalized file.

**Earlier revisions of this skill said the opposite** — "omit `port-version` when it is 0", with an
idempotency re-run offered as proof. Do not follow that. `x-add-version` does not append to a versions
file; it reparses and rewrites the whole thing through vcpkg's canonical serializer, which always
emits `port-version`. So every publish PR that stripped the keys had them re-added by the next run —
#362 stripped, #366 stopped stripping precisely to end that churn. The idempotency re-run proves
nothing here either way: vcpkg accepts the entry with **or** without the key, so a clean
"No files were updated" is not evidence that removing it was correct.

An omitted `port-version` still *resolves* identically to `0`, so this is a convention question, not a
correctness one. The convention is now "always explicit". If you find yourself reasoning about which
form is technically required, you are answering the wrong question — read the most recent merged
publish PR and match it.

The re-run is still worth doing as a sanity check that the entry is complete:
```bash
vcpkg --x-builtin-registry-versions-dir=versions x-add-version qvac-fabric --verbose
# expect: "version <VERSION> is already in …versions/q-/qvac-fabric.json"
#         "No files were updated for qvac-fabric"
```
If it instead rewrites the file or demands `--overwrite-version`, the entry really is wrong — fix it
rather than forcing it.

`vcpkg x-add-version --verify` **does not exist** (`error: unexpected switch: --verify`). The
idempotency re-run above is the check; do not go looking for a `--verify` flag.

**Assert this diff shape before pushing.** Anything beyond it is noise:
```
ports/qvac-fabric/portfile.cmake | 2 +-      (SHA512 only)
ports/qvac-fabric/vcpkg.json     | 2 +-      (version, and see below)
versions/baseline.json           | 4 ++--    (baseline string + its port-version)
versions/q-/qvac-fabric.json     | 5 +++++   (pure insertion)
```
`qvac-fabric.json` must be a **pure insertion**. A hunk with deletions means an existing entry was
modified — revert that part; published entries are live and not yours to touch.

Two `port-version` movements in that diff are expected, and are not the same thing as the entry rule
above:

- **`ports/qvac-fabric/vcpkg.json`** loses the key when the previous release was a rebuild. Publishing
  `10549.1.0` after `10549.0.0#1` drops `"port-version": 1` from the port manifest, because a new
  version starts at 0. That is why the manifest hunk can be `3 +--` rather than `2 +-`.
- **`versions/baseline.json`** moves its `port-version` to match the new baseline — `1` → `0` in the
  same example. Let `x-add-version` write it; a baseline left at `1` would claim a `<VERSION>#1` that
  does not exist.

After **any** amend, re-assert the recorded git-tree — it must equal the `git-tree` in the new entry:
```bash
git rev-parse HEAD:ports/qvac-fabric
```

### Step 4: Verify the portfile locally — mandatory, isolated, and reported

This step is not optional and not satisfiable by a green exit code. Read the trap first.

#### The false pass — a clean exit here usually means nothing was built

vcpkg's install plan is satisfied by **any** installed version of the port. A shared install root
holding an older `qvac-fabric` short-circuits the whole thing:

```
The following packages are already installed:
    qvac-fabric[core,llama]:x64-linux@9840.0.1
Total install time: 156 us
All requested installations completed successfully in: 156 us
```

That is **exit 0 having verified nothing** — no download, no hash check, no compile, and the new
version never mentioned. A fast, clean, cheerful exit is the *failure* signature here, not success.
(The same reason `--overwrite-version` does not re-install locally: only a clean root rebuilds.)

#### Always isolate the roots

An existing local vcpkg checkout is fine — it is the **install root** that must be fresh, not the
tool. Isolation is the part that matters; pick the host triplet for whatever machine you are on.

```bash
GH_TOKEN=$(gh auth token) vcpkg install qvac-fabric \
  --overlay-ports=<path-to-qvac-registry-vcpkg-clone>/ports \
  --triplet <host-triplet> \
  --x-install-root=<tmp>/vcpkg-installed \
  --x-buildtrees-root=<tmp>/vcpkg-bt \
  --x-packages-root=<tmp>/vcpkg-pkg
```

#### Positive assertions — all three must appear, each naming `<VERSION>`

| Must appear in the log | Proves |
|---|---|
| `Downloading …/archive/v<VERSION>.tar.gz` + `Successfully downloaded` | the new tag was actually fetched |
| `Building qvac-fabric[…]@<VERSION>` | the plan resolved the *new* version, not a cached one |
| `All requested installations completed successfully` | the port builds |

A SHA512 mismatch is a hard failure *before* the build, so reaching "Building" is itself the hash
gate passing. Sanity-check the elapsed time too: a real build is minutes. Microseconds or seconds
means you hit the false pass above.

#### Re-verification after an amend

If `git rev-parse HEAD:ports/qvac-fabric` is **unchanged**, the build result still holds — a
`versions/`-only amend (e.g. removing `port-version`) needs no re-run. If the `ports/` tree changed,
re-run this step.

### Step 5: Open registry PR
Push branch to `tetherto/qvac-registry-vcpkg`, create PR.

**Report the verification when you present the PR.** State that it was built locally and how: version
built, triplet, features, that the install root was isolated, and that the three Step 4 assertions
held. A registry PR handed over without that line is incomplete — the reviewer cannot tell a real
verification from the false pass above.

If Step 4 was skipped or could not run, **say so explicitly**. Silence reads as "verified".

### Step 5b: Strip the overlay from the target PR — `--on-top-of-pr` only

Skip this step entirely in the default mode; Step 8 covers the validation-branch case.

**Why here.** The revert lands after B1 has published `<VERSION>`, and it is immediately followed by
B2's bump **on the same branch, in the same push** (5b.5 below). The overlay comes off and the floors
go up as one transition, so the PR never sits in a state where it resolves neither the overlay nor the
new version.

**Before the target PR is closed or merged.** If it has been closed or already merged by the time you
get here, `--on-top-of-pr` has nothing to attach to: fall back to the default separate-PR path
(Steps 6–10 as written), and **say plainly in the report that the fallback was used and why**. The tag
is already pushed at this point — do not stall the rollout waiting on a decision.

1. **Check out the target PR at its current head.** `gh pr checkout <n> --repo tetherto/qvac`, then
   pull. Commits may well have landed since Phase A — do not assume the head you saw then.

2. **Survey the overlay history before touching anything.** Not "find the commit" — count them:
   ```bash
   git log --format="%h %ad %an %s" --date=short origin/main..HEAD \
     -- vcpkg-overlays "packages/*/vcpkg-configuration.json"
   ```
   Narrower probes for the canonical commit, first hit wins, then the SHA the user supplied:
   ```bash
   git log --grep="^Rollout-Overlay:" --format=%H origin/main..HEAD
   git log --diff-filter=A --format=%H -- vcpkg-overlays/ports/qvac-fabric
   ```
   The first is the trailer Phase A Step 5 writes; the second catches overlays predating it.

   **A long-lived target PR usually has a messy overlay history, and that is the normal case, not an
   anomaly.** Real instance (qvac#4408, 10549.1.0): *ten* commits by two authors — the overlay added,
   re-pinned three times, **fully removed** once when the previous version got tagged, then re-added.
   A self-cancelling chain like that cannot be reverted commit-by-commit; the removal commit's revert
   re-adds what a later commit already deleted.

3. **Choose the removal method from what step 2 found.**

   **One overlay commit, nothing else touching those paths** → revert it:
   ```bash
   git revert --no-commit <overlay-sha>
   ```

   **Anything else — several commits, a removal among them, or a revert that conflicts** → remove
   explicitly, and say in the commit message and the report that you did and why:
   ```bash
   git rm -r vcpkg-overlays/ports/qvac-fabric
   git checkout $BASE -- packages/<each-consumer>/vcpkg-configuration.json
   ```
   `git checkout $BASE --` on those config files is safe here **only because** the sweep in 5b.4 then
   proves the result is byte-identical to `$BASE` across exactly these paths. Confirm first that the
   overlay block is the sole difference:
   ```bash
   git diff --stat $BASE -- "packages/*/vcpkg-configuration.json"   # expect only the +3 overlay hunks
   ```
   If a config carries any other change, Edit the `overlay-ports` key out by hand instead — a
   whole-file checkout would silently discard the author's work.

   Do **not** treat explicit removal as a lesser outcome. It reaches the same tree as a clean revert
   and the sweep proves it; the revert is preferred only for the trivial single-commit case, where it
   documents intent slightly better.

4. **The completeness sweep.** Every check runs; report all failures together. It is deliberately
   repo-wide rather than scoped to the <N> consumers:

   **Diff against the merge base, not `origin/main`'s tip** — set it once and reuse:
   ```bash
   BASE=$(git merge-base origin/main HEAD)
   ```

   | Check | Passes when |
   |---|---|
   | **the overlay paths are back to their pre-overlay state** | `git diff $BASE -- vcpkg-overlays "packages/*/vcpkg-configuration.json"` → empty |
   | port subtree gone | `git diff $BASE -- vcpkg-overlays` → empty |
   | no key left anywhere | `git grep -l "overlay-ports" -- "**/vcpkg-configuration.json"` → no output |
   | no baseline drift | `git diff $BASE -- "packages/*/vcpkg-configuration.json"` → empty |
   | nothing left behind | `git status --porcelain` → clean |

   The first check is the strongest — byte-identical to the merge base across exactly the paths Phase
   A touched — and it is **method-independent**, so it holds whether you reverted or removed
   explicitly. Older revisions of this skill asserted `git diff <overlay-sha>^ HEAD` instead; that
   form only means anything when a single commit introduced the overlay and nothing else touched
   those paths, which is the rarer case. Use `$BASE`. The third check is what catches an overlay
   someone added by hand outside the <N>.

   `vcpkg-overlays/` itself **stays**: `triplets/` and `toolchains/` are permanent repo infrastructure
   and only the `ports/qvac-fabric` subtree is rollout scaffolding. The second check passing is what
   proves you removed the one and not the other.

   **Why the merge base and not `origin/main`.** A long-lived target PR forked a while ago, so
   `git diff origin/main` reports everything main has landed *since* — which reads as drift the
   rollout caused. Real instance: `packages/diffusion-cpp/vcpkg-configuration.json` appeared to have
   lost a `"reference": "main"` key, which was actually PR #3551 landing on main post-fork.

   Reading a hit: a package **outside the <N> consumers**, or a key other than `baseline`, is almost
   always a staleness artifact. Re-measure against `$BASE` before reporting it as drift — and never
   "fix" it, since it is not yours.

5. **Do NOT push the revert on its own.** Go straight into B2 (Step 7) on this same branch and commit
   the bumps as a **separate commit**, then push **once** — two commits, one push, one CI trigger.

   Pushing the revert alone leaves the PR resolving the *previously published* fabric until a later
   push, which is both a wasted CI run and a green that means nothing about `<VERSION>`.

   The push itself needs confirmation: this is someone else's PR. Show the revert diffstat, the bump
   diffstat, and the sweep results, get confirmation, then push to the PR's head branch.

6. **Say what the PR builds against now.** With the overlay gone and the floors at `<VERSION>`, the
   target PR resolves `<VERSION>` from the registry as soon as the registry PR merges. Until it does,
   the PR's CI is **red on an unresolvable `version>=`** — expected, and the same condition Step 10's
   CI note describes. Retrigger after the registry PR merges.

   Say this out loud rather than letting someone read the red as a real failure, or the eventual green
   as evidence gathered before the registry landed.

---

## B2 — The consumer bumps (ONE PR for all <N> consumers)

**Rule:** One PR carries everything: the <N> `vcpkg.json` bumps, any C++ changes from Phase A, the <N>
`package.json` bumps, and the <N> `CHANGELOG.md` entries. Do not split per package.

**Which PR that is depends on the mode:**

| Mode | Where the consumer bumps land |
|---|---|
| default | a new branch off `origin/main` → a new bundled PR (Steps 6, 9, 10 as written) |
| `--on-top-of-pr` | the **target PR's head branch**, as a second commit alongside the Step 5b revert. **No new branch, no new PR.** |

`--on-top-of-pr` exists precisely so the consumer code needing the new fabric and the fabric bump meet
*on the same PR*. Opening a separate bump PR recreates the problem the flag was added to solve — the
target PR's CI keeps building against the old published fabric, and the two only meet after the whole
rollout lands (see `/rollout-phase-a`'s "Two modes"). If you find yourself running `git checkout -b`
in this mode, stop.

### Step 6: Branch from `origin/main` — NOT from the Phase A branch
```bash
git fetch origin
git checkout -b TICKET/bump-fabric-<VERSION> origin/main
```

**`--on-top-of-pr`: skip this step.** You are already on the target PR's head branch from Step 5b.
Do not branch from `origin/main` and do not create `TICKET/bump-fabric-<VERSION>`.

### Step 7: For each of the <N> consumers, on this one branch:

1. **Check the current `package.json` version on `origin/main`** — other PRs may have landed since
   Phase A; do NOT assume the version from Phase A.

   **`--on-top-of-pr`: `origin/main` is the wrong base to read, and the failure is silent until
   merge time.** Read the version off the **target branch**, and compare every one of the <N> against
   `origin/main` before bumping anything:

   ```bash
   for p in $(git grep -l "qvac-fabric" origin/main -- "packages/*/vcpkg.json" | cut -d/ -f2); do
     printf "%-20s branch=%-8s main=%s\n" "$p" \
       "$(git show HEAD:packages/$p/package.json | jq -r .version)" \
       "$(git show origin/main:packages/$p/package.json | jq -r .version)"
   done
   ```

   | Outcome | Meaning | Do |
   |---|---|---|
   | equal | branch is current for that package | bump normally |
   | branch **behind** main | the branch predates a release | **update the branch with `origin/main` first**, then re-read |
   | branch **ahead** of main | the PR already bumped that package | do **not** double-bump — fold the fabric changelog line into the entry the PR already added |

   Bumping across a stale base ships a wrong number and a conflict. Real instance: a target branch
   read `llm-llamacpp` 0.42.0 while `origin/main` was 0.43.0, so a naive bump produced
   `0.42.0 → 0.44.0` with **no 0.43.0 CHANGELOG entry**, and a modify/modify conflict against main's
   own `0.42.0 → 0.43.0` the moment the PR merged.

   Updating someone else's branch changes their PR's history — confirm the method (merge vs rebase)
   with the user before doing it.

2. **Bump `vcpkg.json` `"version>="`** to `<VERSION>`.

3. **Apply C++ changes from Phase A** (`llm-llamacpp` only if applicable):
   Use the Edit tool for specific lines. Do NOT run:
   ```bash
   git checkout <phase-a-branch> -- file.cpp  # WRONG — takes whole file, causes regressions
   ```

4. **Bump `package.json`** — a new fabric version means a new package version, API change or not.
   Which component moves depends on where the package already is:

   | Current version | Bump | Example |
   |---|---|---|
   | `0.x.y` (pre-1.0) | **minor** | `0.31.0` → `0.32.0` |
   | `x.y.z` where `x >= 1` | **major** | `9.0.0` → `10.0.0` |

   Read the current version off `origin/main` (sub-step 1 above) before deciding — do not assume.

   **Every consumer on the roster has been `0.x` at every rollout so far, so in practice every one
   takes the minor path.** As of 2026-09-15: `fabric` 0.13.1 → 0.14.0, `llm-llamacpp` 0.52.1 →
   0.53.0. Treat those numbers as illustration and the table as the authority — they move every
   release, and a package that looks like it takes a large jump (`0.1.0` → `0.2.0`) is just pre-1.0.

   **Do not special-case `translation-nmtcpp`.** Older revisions of this skill said it takes the major
   path, on the strength of it sitting at `9.0.0` (`8.3.1` → `9.0.0` in #3567 for a dependency-floor
   alignment, then `9.0.0` → `10.0.0`). Its `main` line was since **restarted at `0.x`** — npm still
   carries `latest` = `10.0.0` and a `release-0.7` line at `0.7.0` while `origin/main` reads `0.x`, so
   npm stays numerically ahead indefinitely. Applying the old advice bumps to `1.0.0`, an unintended
   major release. It has also since left the roster entirely; if it returns, read the version off
   `origin/main` and apply the table like any other package.

5. **Add a `CHANGELOG.md` entry.** Heading MUST be `## [<version>] - <date>` (bracketed — release
   workflow requires this format).

   Baseline shape, fabric-only:
   ```markdown
   ## [<version>] - <date>

   ### Changed
   - `qvac-fabric` dependency bumped `<old>` → `<new>` (<feature>; no API change for this package).
   ```

   #### Say what the fabric version actually carries

   A bare "bumped `<old>` → `<new>`" names the version and nothing else, leaving a reader to diff the
   fabric repo to find out whether the bump matters. List the upstream changes as a nested list:
   ```bash
   gh api repos/tetherto/qvac-fabric-llm.cpp/compare/v<OLD>...v<VERSION> \
     --jq '.commits[] | "\(.sha[0:9]) \(.commit.message | split("\n")[0])"'
   ```
   One concise line per change, **crash and correctness fixes first** — those are the argument for
   taking the bump, and they are usually not the feature that motivated the rollout. Read a commit's
   body before summarizing it; subjects understate (`"set tensor 2d hash"` was RPC upload caching).
   Omit changes irrelevant to the consumer rather than padding the list. Where a consumer's own new
   option is driven by an upstream change, say so in that consumer's copy and keep the others generic.

   #### A populated `## [Unreleased]` block must be folded into the release

   If the file has `## [Unreleased]` with content under it, that content **ships in this release** —
   the bump publishes the package. Promote the heading:

   ```
   ## [Unreleased]        ->     ## [<version>] - <date>
   ```

   …and place the `qvac-fabric` bullet into a `### Changed` section within it, in Keep-a-Changelog
   order (`Added`, `Changed`, `Fixed`). Do not alter existing entry text. Leave no empty
   `[Unreleased]` placeholder behind; the next feature PR re-adds one.

   Precedent: `83a394f2a` (llm-llamacpp 0.49.1) promoted the heading exactly this way. Real instance
   of getting it wrong — on the 10549.1.0 rollout the dated entry was first inserted *below* a
   populated `[Unreleased]`, which would have published the tool-grammar work (qvac#4120) and the
   prefill-throttle fix (qvac#4401) inside `0.53.0` while the file still called them unreleased.

   Older revisions of this skill said to insert *below* the block, citing `/bump-version` Step 5. That
   advice is only right for an **empty** placeholder. The underlying constraint is the release
   extractor, which slices from the first dated heading — so the dated heading must be the top one,
   and everything shipping must sit under it.

   #### Document the host PR's own API change, in `--on-top-of-pr` mode

   The target PR's feature is shipping in the release you are cutting, so a changelog covering only
   the fabric bump publishes that API undocumented. Check whether the PR touched the changelog:
   ```bash
   gh pr view <n> --repo tetherto/qvac --json files --jq '.files[].path'
   ```
   If it did not, write the entry from the PR's diff — the new option, its accepted values, what it
   rejects — and split out any **default that changed** under `### Changed` rather than folding it
   into the `### Added` bullet. A new option is a feature; a flipped default is a behaviour change
   existing callers hit on upgrade, and it is the part most likely to surprise someone.

   Then say in the report that you wrote it and ask the author to check the wording — they know the
   intended migration story, and it is still their feature.

### Step 8: Check overlay absent
Run **Step 5b's completeness sweep** on this branch too — it is the same invariant, and keeping one
definition stops the two drifting apart. In the default mode this branch is cut fresh from
`origin/main`, so the sweep should pass untouched and `$BASE` is just `origin/main`.

In `--on-top-of-pr` mode Step 5b already cleaned the target PR — re-run the sweep after the bump
commit to confirm it stayed clean, keeping the `$BASE` merge-base form.

`vcpkg-overlays/ports/qvac-fabric/` and the `"overlay-ports"` blocks must NOT exist on this branch.
If the Phase A branch was merged to main, remove them here: `git rm -r vcpkg-overlays/ports/qvac-fabric`
and drop the `"overlay-ports"` block from each consumer's `vcpkg-configuration.json`. Leave the rest
of `vcpkg-overlays/` (`triplets/`, `toolchains/`) alone — only the `ports/qvac-fabric` subtree is
rollout scaffolding. No other edits to `vcpkg-configuration.json` — no baseline bump.

That removal path is a **safety net, not an expected step**: Phase A's validation PR is titled and
bodied `DO NOT MERGE` and Step 11 closes it unmerged, so the overlay should never have reached `main`.
If this sweep does find it there, treat it as a live problem worth naming, not a routine cleanup.

### Step 9: Confirm all files, commit, push to origin
```bash
git push origin TICKET/bump-fabric-<VERSION>
```
`origin` = `tetherto/qvac` (cloned directly, not a fork).

Assert the change is exactly `<N>` × 3 files (`vcpkg.json` + `package.json` + `CHANGELOG.md` per
consumer), plus any Phase A C++ from Step 7 sub-step 3.

**`--on-top-of-pr`: assert on the commit, not on `origin/main`.** The branch carries the PR author's
own work, so `git diff --stat origin/main` can never reduce to those files and the assertion is
meaningless there. Use the bump commit itself:
```bash
git show --stat HEAD          # after committing
git diff --cached --stat      # before committing
```
Then push to the **target PR's head branch** — one push carrying the 5b revert and this commit
together, after the confirmation in 5b.5.

### Step 10: Create PR
Title: `TICKET feat[api]: bump qvac-fabric to <VERSION> across consumers`
Body: link fabric PR + registry PR.
Squash-merge when green — the squash commit lands on qvac `main`, so make its message clear and
self-explanatory (what bumped, to which `<VERSION>`, across which addons).

**CI note:** the PR will fail until the registry PR merges (`version>=` can't resolve yet). Expected
— retrigger CI after the registry merges, before requesting review.

**Gotcha:** never rename a branch that has an open PR via the API — GitHub orphans/closes the PR
(head ref disappears, can't reopen). Create the PR with the final branch name.

#### `--on-top-of-pr` — do NOT create a PR

The target PR *is* the consumer PR. Creating another one is the mistake this mode exists to prevent.
Instead:

- The push already happened in 5b.5. Nothing to open.
- **Draft the rollout summary and get approval before posting it.** It carries the fabric PR and tag,
  the registry PR link, the `<N>` version bumps, and the CI-red-until-the-registry-merges note.
  **Never post it unprompted** — a comment on someone else's PR notifies the author and every
  watcher, so show the full text and wait, and if the user trims it to one line, post exactly that.
  Prefer a comment over rewriting the author's PR body.
- **Tell the user the blast radius changed**, because it is easy to miss: the target PR now also
  carries `<N>` package releases, so squash-merging it publishes them. Its title/tags may need to
  reflect an API-affecting change, and if the PR belongs to someone else, the author needs to know
  their feature PR is now also a release PR.
- **Push commits append-only.** Do not amend or force-push to rewrite a contributor's branch, even to
  tidy your own just-pushed commits. Offer the squash; let them decide.
- Escape hatch, as in 5b: if the target PR turned out closed or already merged, fall back to the
  default path above and say the fallback was used.

### Step 11: Close the Phase A validation PR — default mode only

Phase A's default mode opens a labelled `DO NOT MERGE` validation PR carrying the overlay (see
`/rollout-phase-a` Step 5). Nothing else disposes of it, and both precedents — qvac#3954 and qvac#3814 —
were **closed, never merged**. `--on-top-of-pr` has no equivalent: there Step 5b already reverted the
overlay off a PR that is meant to merge.

**Close it, never merge it.** Merging would land the overlay port and the <N> `"overlay-ports"` blocks on
`main`, which is exactly what Step 8's sweep exists to undo.

Do this **after the registry PR has merged**, so the validation stays reviewable while it is still the
only evidence that `<VERSION>` builds:

```bash
gh pr close <N> --repo tetherto/qvac --delete-branch \
  --comment "Phase A validation complete for qvac-fabric <VERSION>. Overlay was scaffolding only; the consumer bumps land in <bundled-PR-url>. Closing unmerged by design."
```

- **Confirm with the user before closing** if anyone other than you commented on it, or if any consumer
  never went green — a red consumer may be the only record of a real defect, and closing buries it.
- `--delete-branch` is safe here because the branch exists only to host the overlay. Do **not** pass it
  in `--on-top-of-pr` mode; that branch is someone's feature work.
- If the validation PR is already closed, say so and move on. If it was somehow **merged**, do not close
  anything — run Step 8's sweep against `origin/main` and report that the overlay reached `main`, since
  that is a live problem rather than a cleanup task.

---

## Post Slack message (once both PRs open)

```
Please review the <feature name>.
Registry PR: https://github.com/tetherto/qvac-registry-vcpkg/pull/<N>
Consumer bump (all <N> packages — vcpkg + package versions + changelogs, single PR):
• https://github.com/tetherto/qvac/pull/<N>
```

In `--on-top-of-pr` mode there is no separate bump PR — the consumer line points at the target PR, and
should say the bump rides it so nobody goes looking for a second one:

```
Please review the <feature name>.
Registry PR: https://github.com/tetherto/qvac-registry-vcpkg/pull/<N>
Consumer bump rides the feature PR (all <N> packages — vcpkg + package versions + changelogs):
• https://github.com/tetherto/qvac/pull/<N>  ← also publishes the <N> packages when squash-merged
```

If you have no Slack access, print the message (with the links) to the console so the user can post it.
