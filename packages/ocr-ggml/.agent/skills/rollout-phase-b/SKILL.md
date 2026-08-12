---
name: rollout-phase-b
description: Phase B of a qvac-fabric rollout — tag the merged fabric commit, publish to registry, create 1 bundled consumer PR (vcpkg bumps + package versions + changelogs for all 7 consumers), post one Slack message. Pass --bump-only to resume a part-done rollout and do just the version + changelog work.
argument-hint: "<fabric-version> <merge-commit-sha> [--bump-only]"
---

# Rollout Phase B — Tag + Registry + Bundled Consumer PR

**Prerequisites:** Fabric PR merged. Phase A all green. `v<VERSION>` tag does NOT exist yet.

**The 7 consumers:** `embed-llamacpp`, `fabric`, `llm-llamacpp`, `model-fit`, `ocr-ggml`,
`translation-nmtcpp`, `vla-ggml`.

`classification-ggml` is **not** a fabric consumer — it dropped the `qvac-fabric` vcpkg dependency
and now consumes the published npm package `@qvac/fabric`. It needs neither overlay validation nor
a `version>=` bump during a rollout. Do not re-add it.

## THE GOLDEN RULE
Never bump `default-registry.baseline` in `vcpkg-configuration.json`. Anywhere. Ever.

---

## `--bump-only` (resume mode)

For the common resumed state: the fabric tag is pushed, the registry PR merged, and the
`vcpkg.json` floors already bumped — all that is left is the mechanical version + changelog work.

**Skips** B1 entirely, and skips Step 7 sub-steps 1–3.
**Performs** only Step 7 sub-step 4 (`package.json`) and sub-step 5 (`CHANGELOG.md`), for all 7
consumers. Everything the mode skips, it first verifies was actually done.

### Preflight — verify, then stop or proceed

Run **all** checks and report **every** failure in one list. Do not stop at the first — a part-done
rollout usually has more than one gap, and drip-feeding them wastes a round trip each.

| # | Check | How |
|---|---|---|
| 1 | Working repo is the real code repo on the right remote | `git -C <repo> remote -v` → `tetherto/qvac` |
| 2 | On a branch off `origin/main` — not `main`, not `release-*` | `git -C <repo> rev-parse --abbrev-ref HEAD` |
| 3 | Fabric tag `v<VERSION>` exists | `git -C <fabric-repo> ls-remote --tags <remote> "v<VERSION>"` |
| 4 | `qvac-fabric <VERSION>` is published to the registry | see command below — non-null result means published |
| 5 | All 7 `vcpkg.json` `"version>="` already equal `<VERSION>` | read each `packages/<consumer>/vcpkg.json` |
| 6 | Overlay fully removed | `vcpkg-overlays/ports/qvac-fabric/` absent **and** no `"overlay-ports"` key in any of the 7 `vcpkg-configuration.json` |
| 7 | No `default-registry.baseline` drift | `git -C <repo> diff origin/main -- "packages/*/vcpkg-configuration.json"` → empty |
| 8 | Per consumer: `origin/main` `package.json` version vs npm | `npm view @qvac/<pkg> dist-tags.latest` |

**Check 4** — request the raw blob so no base64 decoding is needed:
```bash
gh api repos/tetherto/qvac-registry-vcpkg/contents/versions/q-/qvac-fabric.json \
  -H "Accept: application/vnd.github.raw" --jq '[.versions[].version] | index("<VERSION>")'
```
A number means published; `null` means the registry PR has not merged — stop.

**Check 5** — parse the JSON; do **not** grep a fixed line offset from `"name": "qvac-fabric"`. The
dependency object's shape varies between consumers: `ocr-ggml` carries `"default-features": false`
and a `"features"` array, so a `grep -A1` reports the floor as missing when it is present and
correct. Read the `version>=` field out of the parsed object.

**Check 6 matters more than it looks.** A leftover overlay makes vcpkg resolve `qvac-fabric` from
the overlay instead of the registry — silently. Nothing errors; you would ship a bump that was
never validated against the published port.

**Check 8 has three outcomes**, not pass/fail:

| Outcome | Meaning | Do |
|---|---|---|
| npm **==** `origin/main` | normal — the bump is genuinely pending | proceed |
| npm **behind** `origin/main` | a bump already landed and is unreleased | **stop and ask** before adding another (`/bump-version` Step 1's rule) |
| npm **ahead** | wrong checkout or wrong branch | stop |

The middle case is live today: `@qvac/model-fit` reads `0.0.0` on npm (a name placeholder — it has
never been released, and no `model-fit-v*` tag exists) against `0.1.0` on `origin/main`. Do not
paper over it; ask whether `0.1.0` should publish as-is before bumping it to `0.2.0`.

**Step 7 sub-step 3 (Phase A C++ fixes) cannot be verified mechanically.** Do not claim a check you
did not perform. Instead print the non-manifest diff and have the user confirm:
```bash
git -C <repo> diff --stat origin/main -- "packages/*/addon" "packages/*/src"
```

### On success — apply the bumps

`/bump-version` is the single source of truth for bump level and changelog shape. Note that it is
`disable-model-invocation: true`, so it **cannot be invoked programmatically** — follow its written
Steps 3–5 procedure here. (Alternative, if you prefer the skill itself: run `/bump-version <pkg>`
per package by hand, using `/bump-version translation-nmtcpp major` for the one post-1.0 package.)

- **Bump level** comes from the table in Step 7 sub-step 4 below: `0.x` → minor, `>=1.0` → major.
  `/bump-version` never auto-selects major, so `translation-nmtcpp` must be given the level
  **explicitly**.
- **Changelog entries** use the fabric-only wording in Step 7 sub-step 5, with the bracketed
  `## [<version>] - <date>` heading.
- **`model-fit`'s CHANGELOG has a `## [Unreleased]` block** — insert the dated entry *below* it, per
  `/bump-version` Step 5. Inserting above makes the release extractor slice the body off.

### Stop point

Apply the 14 edits (7 × `package.json` + 7 × `CHANGELOG.md`), then **stop and confirm before
committing**. Print:

1. a summary table — `pkg · old → new · level`;
2. `git -C <repo> diff --stat origin/main`.

Assert the diff touches **only** `package.json` and `CHANGELOG.md` across the 7 packages — anything
else means something got swept in. Then ask the user to confirm before continuing into Step 9
(commit / push) and Step 10 (PR). Never commit unattended in this mode.

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
- `ports/qvac-fabric/portfile.cmake`: `REF v<VERSION>` + `SHA512 <sha512-of-tag-tarball>`
- `ports/qvac-fabric/vcpkg.json`: `"version": "<VERSION>"`
- Update versions DB:
  ```bash
  vcpkg --x-builtin-registry-versions-dir=versions x-add-version qvac-fabric
  ```

### Step 4: Verify portfile locally before opening registry PR

Note: commands below assume macOS + Apple Silicon. On Linux, swap `brew install` for your package manager; on Intel Mac or Linux, swap `--triplet arm64-osx` for the matching triplet (e.g. `x64-osx`, `x64-linux`).
```bash
brew install pkg-config
git clone https://github.com/microsoft/vcpkg /tmp/vcpkg --depth 1
/tmp/vcpkg/bootstrap-vcpkg.sh -disableMetrics
VCPKG_ROOT=/tmp/vcpkg GH_TOKEN=$(gh auth token) \
  /tmp/vcpkg/vcpkg install qvac-fabric \
  --overlay-ports=<path-to-qvac-registry-vcpkg-clone>/ports \
  --triplet arm64-osx
```
Success = SHA512 verified + build passes. Only then open the PR.

### Step 5: Open registry PR
Push branch to `tetherto/qvac-registry-vcpkg`, create PR.

---

## B2 — Bundled Consumer PR (ONE PR for all 7 consumers)

**Rule:** One PR carries everything: the 7 `vcpkg.json` bumps, any C++ changes from Phase A, the 7
`package.json` bumps, and the 7 `CHANGELOG.md` entries. Do not split per package.

### Step 6: Branch from `origin/main` — NOT from the Phase A branch
```bash
git fetch origin
git checkout -b TICKET/bump-fabric-<VERSION> origin/main
```

### Step 7: For each of the 7 consumers, on this one branch:

1. **Check the current `package.json` version on `origin/main`** — other PRs may have landed since
   Phase A; do NOT assume the version from Phase A.

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

   At time of writing only **`translation-nmtcpp` (`9.0.0`)** takes the major path; the other six
   are `0.x` (`embed-llamacpp` 0.31.0, `fabric` 0.3.1, `llm-llamacpp` 0.41.0, `model-fit` 0.1.0,
   `ocr-ggml` 0.14.0, `vla-ggml` 0.18.0). Treat that roster as illustration and the rule as the
   authority — these versions move every release. Precedent: `translation-nmtcpp` went `8.3.1` →
   `9.0.0` (#3567) for a dependency-floor alignment with no breaking API change.

   `model-fit` at `0.1.0` bumps to `0.2.0` — pre-1.0, so it takes the minor path even though it
   looks like a large jump.

5. **Add a `CHANGELOG.md` entry.** Heading MUST be `## [<version>] - <date>` (bracketed — release
   workflow requires this format).

   For `llm-llamacpp` (if API changes):
   ```markdown
   ## [<version>] - <date>

   ### Added
   - <describe new API>
   - `qvac-fabric` dependency bumped `<old>` → `<new>`.
   ```

   For the other 6 (fabric-only):
   ```markdown
   ## [<version>] - <date>

   ### Changed
   - `qvac-fabric` dependency bumped `<old>` → `<new>` (<feature>; no API change for this package).
   ```

### Step 8: Check overlay absent
`vcpkg-overlays/ports/qvac-fabric/` and the `"overlay-ports"` blocks must NOT exist on this branch.
If the Phase A branch was merged to main, remove them here: `git rm -r vcpkg-overlays/ports/qvac-fabric`
and drop the `"overlay-ports"` block from each consumer's `vcpkg-configuration.json`. Leave the rest
of `vcpkg-overlays/` (`triplets/`, `toolchains/`) alone — only the `ports/qvac-fabric` subtree is
rollout scaffolding. No other edits to `vcpkg-configuration.json` — no baseline bump.

### Step 9: Confirm all files, commit, push to origin
```bash
git push origin TICKET/bump-fabric-<VERSION>
```
`origin` = `tetherto/qvac` (cloned directly, not a fork).

### Step 10: Create PR
Title: `TICKET feat[api]: bump qvac-fabric to <VERSION> across consumers`
Body: link fabric PR + registry PR.
Squash-merge when green — the squash commit lands on qvac `main`, so make its message clear and
self-explanatory (what bumped, to which `<VERSION>`, across which addons).

**CI note:** the PR will fail until the registry PR merges (`version>=` can't resolve yet). Expected
— retrigger CI after the registry merges, before requesting review.

**Gotcha:** never rename a branch that has an open PR via the API — GitHub orphans/closes the PR
(head ref disappears, can't reopen). Create the PR with the final branch name.

---

## Post Slack message (once both PRs open)

```
Please review the <feature name>.
Registry PR: https://github.com/tetherto/qvac-registry-vcpkg/pull/<N>
Consumer bump (all 7 packages — vcpkg + package versions + changelogs, single PR):
• https://github.com/tetherto/qvac/pull/<N>
```
If you have no Slack access, print the message (with the links) to the console so the user can post it.
