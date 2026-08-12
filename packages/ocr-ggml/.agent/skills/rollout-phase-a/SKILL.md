---
name: rollout-phase-a
description: Phase A of a qvac-fabric rollout — set up overlay port and validate all 7 consumers against the fabric branch before publishing to the registry.
argument-hint: "<fabric-version> <fabric-branch-or-commit>"
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

## Steps

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
  HEAD_REF main
)
```
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

### Step 5: Commit and push to upstream branch (NOT fork)
```bash
git push origin <branch>
```
`origin` = `tetherto/qvac` (cloned directly, not a fork). Push straight to origin.

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
- Do NOT add the `verified` label to any validation PR — it makes every push re-run ALL consumers.
  `workflow_dispatch` is trusted by `label-gate` (no label needed) and lets you re-run only the
  consumer(s) you actually changed.
- First pass: all seven. Later iterations: re-dispatch just the one(s) you touched.

**Expected failures / flakes while monitoring:**
- `merge-guard` / `validate-pr` always fail on a no-PR dispatch branch — expected, ignore.
- Known-flaky macOS and mobile device-farm jobs are typically non-blocking and orthogonal to a fabric
  change — confirm they're pre-existing / baseline-reproducible, retry the failed job (not the whole
  run), and don't chase them as rollout blockers.

### Step 7: Fix consumer breaks
Apply C++ fixes (API drift, new failure modes) using the Edit tool — specific lines only. Never `git checkout <branch> -- file.cpp` (takes the whole file, causes regressions).

Watch for:
- **API drift** — a fabric bump pulls a newer upstream llama.cpp/ggml whose API may have moved
  (renamed/relocated struct fields, changed signatures). Fix in the consumer addon.
- **Runtime behaviour shifts** (perf, threading, init paths) — if an integration test now hits a
  timeout, calibrate the timeout with a comment explaining why; NEVER skip/disable the test. Guard
  new failure modes (e.g. an init call returning null) with a catchable error, not a segfault.

### Step 8: Update the fabric PR description with the validation runs
Once all consumers are green, add the validation CI runs to the fabric PR description — one bullet
per consumer, all 7 listed, noting the head commit they validated:
```
- <consumer name>: <CI run link>
```

### Step 9: Post Slack message when all consumers green
```
Hi Team, Please review the PR for <feature name>
Fabric PR: https://github.com/tetherto/qvac-fabric-llm.cpp/pull/<N>
Validation branch: <validation-branch> (consumer CI runs listed in the fabric PR description)
```
If a qvac validation PR was opened, add its link (`Add on PR: https://github.com/tetherto/qvac/pull/<N>`).
If you have no Slack access, print the message (with the links) to the console so the user can post it.
Wait for lead to merge fabric PR before proceeding to `/rollout-phase-b`.
