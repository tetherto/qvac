---
name: vlm-benchmark
description: Benchmark an optimization (PR or branch) on a Device Farm device via the vlm-benchmark framework — baseline vs optimized, quality-regression-aware.
argument-hint: "<PR#|PR-url|branch> [--device s25|pixel9|s26|iphone17…] [--model qwen3.5-q8|gemma4-q4|<label>] [--preset full|base|smoke] [--runs 2] [--mmproj both|gpu]"
---

# VLM Benchmark — on-device optimization A/B

Benchmark an optimization change (a PR or branch, in the **addon** or the **qvac-fabric**) on a
specific **AWS Device Farm** device, using the `packages/llm-llamacpp/benchmarks/vlm-benchmark`
framework. It builds the change from source, runs a **baseline vs optimized** A/B on the device
(N runs each), pairs them by CPU fingerprint, and reports speed **and quality** — with
**quality regression as the primary gate**. This codifies the QVAC-21320 / QVAC-21297 methodology.

Scope: Qwen3.5-0.8B VLM, projector `mmproj` CPU-vs-GPU (`mmproj=both`) by default. The **model is
selectable** (`--model`) — the framework already ships multiple VLMs (Qwen3.5 f16/q8, Gemma-4-E2B)
and a new one can be added to `config.cjs`; Qwen3.5-q8 is just the default. Device Farm only (no local
ADB run yet). Thermal / cross-unit variance is handled by CPU-fingerprint matching over multiple runs,
not interleaving.

> **Source safety (read-only target).** This skill **never modifies the PR or branch under test.** It
> only *reads* the target — `gh pr view` / `gh pr diff` / `git diff` — to resolve its ref/commit and
> classify the change. **Every** change (harness/config edits and the optimization itself — the fabric
> overlay `REF` or cherry-picked addon commits) is made **only** on the skill's own `test/<slug>` /
> `test/<slug>-base` refs. It never commits to, pushes to, or otherwise alters the source PR's branch,
> the fabric repo, or `main`.

## Usage

```
/vlm-benchmark #2921
/vlm-benchmark https://github.com/tetherto/qvac/pull/2921
/vlm-benchmark https://github.com/tetherto/qvac-fabric-llm.cpp/pull/172 --model gemma4-q4 --device pixel9
/vlm-benchmark feat/QVAC-21297-opencl-vision-encoder --device s25 --preset full --runs 2
/vlm-benchmark feat/my-opt --mmproj both --preset base
```

## Arguments

| Arg | Required | Default | Meaning |
|-----|----------|---------|---------|
| target | yes | — | `#<n>` / PR URL → PR mode; otherwise a branch name |
| `--device` | no | `s25` | Device Farm phone as a `matrix_mobile` token: `s25` (S25 Ultra / Adreno), `pixel9` (Pixel 9 / Mali), `s26` (S26 Ultra), `iphone16` / `iphone17` / `iphone17pro`. Passed as `-f matrix_mobile=<token>` at dispatch (Step 8) — the workflow resolves it to a **single-device `device_model` filter**. A friendly name ('Pixel 9') maps to its token (`pixel9`). Append `-cpu`/`-gpu` to force the model backend; bare token = the harness picks per `--mmproj`. |
| `--model` | no | `qwen3.5-q8` | Which VLM to benchmark — a `config.cjs` catalog `label` (`qwen3.5-f16`, `qwen3.5-q8`, `gemma4-q4` = Gemma-4-E2B Q4) or a new one the skill adds (Step 6). A friendly value like `gemma4`/`gemma4-e2b` maps to the `gemma4-q4` catalog entry. Default = `MODEL_2` / current `mmprojModel` |
| `--preset` | no | `full` | `full` (5 tasks×5, sharpest — DEFAULT; but **overruns the mobile session for `mmproj=both`** → use only on desktop or `mmproj=gpu`, or raise `mobile_timeout_min` — see Step 8) · `base` (5 tasks×3 = the `cognitive` set with `matrix_samples=3`; **the mobile `mmproj=both` choice**) · `smoke` (textvqa×1, wiring check). Default to `base` on mobile `mmproj=both`. |
| `--runs` | no | `2` | runs per build (2 baseline + 2 optimized = a 4-run CPU-matched set) |
| `--mmproj` | no | `both` | `both` = projector CPU-vs-GPU per run · `gpu` = projector on GPU only |

## Prerequisites & paths

The commands below use placeholders — **resolve each once, up front, then substitute** (don't assume
hard-coded paths):

- **`gh` CLI** authenticated to `tetherto/qvac` (Actions dispatch + read); **`node`** on PATH (for `match-devices.js`).
- **`<qvac>`** — the local qvac **main clone** (`origin` = `tetherto/qvac`). Discover it, don't guess:
  run `git worktree list` from any qvac checkout → the **first** line's path is the main worktree. The
  session's current directory may be a **read-only** worktree — never build or push from it.
- **`<feature-branch>`** — the resolved target branch from Step 1 (the PR head branch, or the branch
  argument). The optimized ref is `test/<slug>`; the baseline ref is `test/<slug>-base`.
- **`<pr-repo>`** — the GitHub repo the PR lives in (resolved in Step 1): `tetherto/qvac-fabric-llm.cpp`
  for a fabric PR, `tetherto/qvac` for an addon PR. Used only to read the PR; Actions dispatch always
  targets `tetherto/qvac`.
- **`<slug>`** — the feature-branch basename (branch `feat/QVAC-21297-opencl-vision-encoder` → slug
  `QVAC-21297-opencl-vision-encoder`).
- **`<worktree>`** — the isolated worktree this run creates in Step 5: `<qvac>/../wt-<slug>` (a sibling
  of the clone — the repo's `wt-<name>` convention). All edits, build, and push happen here.
- **`<base>`** — the branch the worktree is cut from; chosen in Step 4 (`origin/main`, or the qvac
  feature branch related to the target).

## Workflow

### Step 1 — Resolve the target

- PR (`#<n>` or URL): resolve the **repo from the target** — a `qvac-fabric-llm.cpp` PR URL →
  `tetherto/qvac-fabric-llm.cpp` (a **fabric** PR); a `qvac` PR URL or a bare `#<n>` → `tetherto/qvac`
  (an **addon** PR). Then `gh pr view <n> --repo <pr-repo> --json headRefName,commits,files,title,body`
  → the head branch is the optimization. (`<pr-repo>` is only for reading the PR; all Actions dispatch
  in Steps 7–8 targets `tetherto/qvac`, where the workflow lives.)
- Branch: use it directly.
- Parse the flags off the tail (`--device` / `--model` / `--mmproj` / `--preset` / `--runs`); unset
  ones take their defaults, but `--device`/`--model`/`--mmproj` are reconciled against the PR in Step 3
  before anything is built.

### Step 2 — Detect the change scope (from the diff)

Run `gh pr diff <n> --repo <pr-repo>` (PR; `<pr-repo>` from Step 1) or `git diff main...<branch>`
(branch). Classify:

- **Addon change** — touches `packages/*/addon/**` or addon JS/config. The **optimization** is the
  addon commit(s); **baseline** is the pre-optimization state (Steps 5–6 build it as `<base>` +
  harness edits, addon change omitted; the optimized ref adds the addon commits on top).
- **Fabric change** — the optimization is a `qvac-fabric` (`tetherto/qvac-fabric-llm.cpp`) commit (a
  fabric PR/commit, or a branch that bumps the fabric). The A/B uses a **self-contained vcpkg
  overlay-port** whose `REF` is the only delta: **optimized** overlay `REF` = the fabric PR/branch head
  commit; **baseline** overlay `REF` = the pre-change fabric commit (the PR's merge-base with its base,
  or the published registry version's commit). Both refs use the overlay — Step 6 covers creating the
  port and computing its `SHA512` directly (no CI round-trip).
- **Mixed / dependency** — a PR that needs both (addon + a fabric overlay): apply both on the
  optimized build; the baseline strips **only** the optimization under test. Keep the optimization the
  **sole delta** between the two builds (isolation).

### Step 3 — Reconcile the passed options against the PR

Before building, cross-check `--device` / `--model` / `--mmproj` against what the change actually
targets, from the PR title/body/linked ticket + the diff-touched code:
- **Device / backend** — `ggml-opencl` / "OpenCL" / "Adreno" → an Adreno device (token `s25`);
  `ggml-vulkan` / "Vulkan" / "Mali" → a Mali device (token `pixel9`); "Metal" → iOS/desktop. Plus any
  explicit device/SoC mention in the PR (`S25`, `Pixel 9`, `Adreno 830`, `Snapdragon`) → its token.
- **Model** — a Qwen / Gemma / other model or projector mention.
- **mmproj axis** — whether it's a projector (`mmproj`) change vs an LLM change.

Then, per axis:
- **(a)** user did **not** pass it and the PR implies a value → **adopt the PR's value and notify**.
- **(b)** user **passed** it and it **conflicts** with the PR (e.g. `--device pixel9` (Mali/Vulkan)
  on an Adreno/OpenCL-only fix — the change wouldn't even be exercised) → **AskUserQuestion**: proceed
  as passed / switch to the PR's value / cancel.
- **(c)** no PR signal → keep the passed value or the default.

Branch-mode targets with no PR: best-effort from the branch name / diff, else proceed with passed/defaults.

### Step 4 — Choose `<base>`

- `git -C <qvac> fetch origin`
- **Default: `<base>` = `origin/main`.** The optimization is layered as the sole delta (fabric overlay
  `REF` / cherry-picked addon commits per Step 2), so the baseline stays clean regardless of base — this
  is the case for fabric PRs (target in `tetherto/qvac-fabric-llm.cpp`) and standard addon PRs alike.
- **Exception — an existing qvac feature branch the target builds on:** a branch-mode target that names a
  qvac branch, or an optimization explicitly stacked on another unmerged qvac feature branch → set
  `<base>` = that branch so the A/B builds on the same foundation.

The `mmproj=both` benchmark harness may not live on `<base>` yet — until it merges to `main` it lives on
**`test/QVAC-21257-mmproj-gpu-benchmark-changes`** (the harness + addon instrumentation grafted cleanly
onto `main`). Step 5 brings it in once the worktree exists. (Do **not** use the older
`feat/QVAC-21257-mmproj-gpu-config` — it is ~100 commits behind `main` and does not merge cleanly.)

### Step 5 — Create the isolated worktree + bring in the harness

Create the worktree **from `<qvac>`** (never the read-only session checkout or other in-use worktrees):
```
git -C <qvac> worktree add <worktree> -b test/<slug> <base>
```
(drop `-b` if `test/<slug>` already exists.) All later edits, build, and push happen inside `<worktree>`.

**Bring in the `mmproj=both` harness.** Check whether it is already present:
`git -C <worktree> show HEAD:packages/llm-llamacpp/benchmarks/vlm-benchmark/config.cjs` contains
`mmprojGpu`/`mmprojModel` **and** `benchmarks/vlm-benchmark/match-devices.js` exists.
- **Present** (`<base>` already carries it — e.g. once the harness has merged to `main`) → nothing to do.
- **Absent** → merge the grafted harness branch in — it sits directly on `main`, so this is a clean
  merge (no conflicts):
  `git -C <worktree> merge --no-edit origin/test/QVAC-21257-mmproj-gpu-benchmark-changes`
  It brings the `mmproj=both` axis (`mmprojGpu`/`mmprojModel`, `legsFor`, per-row `vision_ms`), the
  **addon `mmproj-use-gpu` key + `VisionEncodeMs` instrumentation** (which `vision_ms` depends on),
  `match-devices.js`, and the `matrix_mmproj_gpu` input + conditional targeted-android prebuild in
  `benchmark-vlm-model-comparison.yml`. (Never merge the old `feat/QVAC-21257-mmproj-gpu-config`: it
  trails `main` by ~100 commits, its addon C++ conflicts with `main`'s `ContextSlideOutcome` refactor,
  and its `matrix-s25`/`android_flagship_models` wiring predates `main`'s `matrix_mobile`/`device_model`.)

**Two refs, one delta.** The A/B is two refs that share **identical** harness config and differ
**only** by the optimization. Build them in this order (Step 6 gives the exact edits):
1. **baseline** = `test/<slug>-base` = `<base>` (+ harness) + the harness/config edits, **no optimization**.
2. **optimized** = `test/<slug>` = the baseline **plus the optimization only** — fabric: point the
   self-contained `packages/llm-llamacpp/vcpkg/ports/qvac-fabric` overlay-port `REF` at the fabric commit with a computed
   `SHA512` (Step 6); addon: cherry-pick / merge the PR/branch's addon commits on top.

(The QVAC-21297 run named these `…-s25-stock` / `…-s25`.)

### Step 6 — Adjust the harness (notify the user, no approval)

Inside the worktree, make the edits and **notify the user of each** (file + what changed) — **no
approval needed**, since it's an isolated branch/worktree:
- **Optimization** — apply the optimization per Step 2 (the sole delta between baseline and optimized):
  - **Fabric** — use a **self-contained overlay-port** at `packages/llm-llamacpp/vcpkg/ports/qvac-fabric/`.
    Copy `portfile.cmake` + `vcpkg.json` **+ `android-vulkan-version.cmake`** from the registry port
    `tetherto/qvac-registry-vcpkg:ports/qvac-fabric/` into that dir — for a **Mali / Android-Vulkan**
    target the port MUST carry `android-vulkan-version.cmake` + its Vulkan-C++-header provisioning (the
    port *owns* the Android `vulkan.hpp`, so the build works even on a fabric commit that predates a
    fabric-side Android Vulkan build fix — this is why the baseline builds cleanly). Add
    `"overlay-ports": ["vcpkg/ports"]` to `packages/llm-llamacpp/vcpkg-configuration.json` — `main` has
    **no** `overlay-ports` key, so add it as the first field (the path is relative to that file's dir →
    `packages/llm-llamacpp/vcpkg/ports`). In the portfile, change the registry's `REF v${VERSION}` to the
    fabric commit and set `SHA512` to the hash **computed directly** (no CI round-trip; see
    `SKILL-fabric-release.md` Phase A). The fabric repo is **private**, so the archive fetch needs a
    token. Use `curl` on the `/archive/<ref>.tar.gz` URL — **not** `gh api …/tarball/<ref>`: the
    `/tarball/` endpoint returns a differently-named top-level dir (`owner-repo-shortsha` vs
    `repo-fullsha`) → a **different `SHA512`** that won't match what vcpkg fetches (and `gh api` can't
    write to a file without a redirect anyway). Commit-SHA `/archive/` tarballs are byte-stable, so the
    computed hash equals vcpkg's fetch (validate once against a `SHA512` already pinned in a known port):
    ```
    curl -fsSL -H "Authorization: Bearer $GH_TOKEN" https://github.com/tetherto/qvac-fabric-llm.cpp/archive/<ref>.tar.gz -o /tmp/f.tgz
    openssl dgst -sha512 /tmp/f.tgz     # or: vcpkg hash /tmp/f.tgz
    ```
    ```cmake
    vcpkg_from_github(REPO tetherto/qvac-fabric-llm.cpp REF <fabric-commit> SHA512 <computed-sha512>)
    ```
    The baseline ref pins the pre-change fabric commit; the optimized ref pins the PR/branch commit —
    the overlay `REF`+`SHA512` is the only difference between them. (Fallback: if the computed hash is
    ever wrong, vcpkg prints the expected hash on the first failed fetch.)
  - **Addon** — cherry-pick / merge the PR/branch's addon commits onto the optimized ref only.
- **Model** (`--model`, as reconciled in Step 3) — where it's set depends on the mmproj axis:
  - `--mmproj both` (mmproj-compare) → the run uses `config.mmprojModel`, read directly by the compare
    path (it does **not** honor `matrix_models`). Set `mmprojModel` in `config.cjs` on the `test/` ref
    (e.g. `mmprojModel: GEMMA4_Q4` for `gemma4-q4` / Gemma-4-E2B). If the model isn't defined yet, add a
    `{label, name, ctx_size, llm: hf(...), mmproj: hf(...)}` literal (match the blob `repo`/`sha`/`file`
    to the registry/HF source) and point `mmprojModel` at it.
  - `--mmproj gpu` (two-models) → pass the model(s) via `-f matrix_models=…` at dispatch (forwarded to
    the phone as `QVAC_VLM_MODELS`); no branch edit.
- **Device / preset / samples / mode are DISPATCH INPUTS — not harness edits.** Main's benchmark forwards
  them to the phone via the `matrix-mobile` job's `device_env` channel (`QVAC_VLM_PRESET` ← `matrix_preset`,
  `QVAC_VLM_SAMPLES` ← `matrix_samples`, `QVAC_VLM_MODE` ← `matrix_mode`, and `device_model`/
  `device_manufacturer` from the `matrix_mobile` token). Pass them as `-f` flags in Step 8 — **do not edit
  the branch for these.** The `--device` token fixes the GPU backend (`s25`→Adreno/OpenCL,
  `pixel9`→Mali/Vulkan) → which drives the Step 9 routing-proof grep and which opts are even relevant.
- **mmproj** (`--mmproj`) — the **one** run knob that IS a test-branch config edit for mobile: set
  `mmprojGpu: 'both'|'gpu'` in `config.cjs` (mobile reads `config.mmprojGpu`; `QVAC_VLM_MMPROJ_GPU` is
  desktop-only and not in `device_env`). `both` also reads `config.mmprojModel` (see the Model bullet).

Commit these harness edits on `test/<slug>` — this commit is the **baseline** state. Branch the baseline
ref at it: `git -C <worktree> branch test/<slug>-base`. Then apply the **optimization** on `test/<slug>`
(fabric: set the overlay-port `REF`+computed `SHA512` to the optimized fabric commit; addon: cherry-pick
/ merge the PR's addon commits) and commit. The two refs now differ by **exactly** the optimization —
nothing else.

### Step 7 — Push the two refs (the one approval gate)

Notify the user of the exact pushes and **ask for approval** — noting they target **separate
`test/<slug>` refs** (never `main`), so it's safe. Push **both** the optimized and baseline
refs from Step 5:
```
git -C <worktree> push -u origin test/<slug>
git -C <worktree> push -u origin test/<slug>-base
```
Push only on approval.

### Step 8 — Run baseline + optimized on Device Farm (`--runs` each)

Dispatch **each ref `--runs` times** — the optimized ref and the baseline ref from Step 5. `<device>`
is the `--device` token (default `s25`); `matrix_desktop=none` forces **zero** desktop cells → the run
is mobile-only, which triggers the targeted android-only prebuild (`prebuild-candidate-mobile`, built
**with the Vulkan SDK** for Mali) and skips the heavy full-desktop prebuild + desktop legs. ⚠️ Use the
literal `none` (any non-empty unknown token works), **not** an empty string — the workflow defaults an
empty/unset `matrix_desktop` to `linux-cpu` (`${MATRIX_DESKTOP:-linux-cpu}`), which would run the full
desktop prebuild and **skip** the targeted mobile build. `matrix_sources=addon@candidate` builds the
addon **from the dispatched ref** so the ref's fabric overlay / addon commits actually take effect:
```
# optimized — dispatch --runs times
gh workflow run benchmark-vlm-model-comparison.yml --repo tetherto/qvac \
  --ref test/<slug> \
  -f matrix_sources=addon@candidate -f matrix_desktop=none \
  -f matrix_mobile=<device> -f matrix_preset=<preset> -f matrix_mode=two-models
# baseline — dispatch --runs times (identical inputs; only --ref differs)
gh workflow run benchmark-vlm-model-comparison.yml --repo tetherto/qvac \
  --ref test/<slug>-base \
  -f matrix_sources=addon@candidate -f matrix_desktop=none \
  -f matrix_mobile=<device> -f matrix_preset=<preset> -f matrix_mode=two-models
```
**`--preset` → dispatch inputs.** `matrix_preset` names a `config.cjs` preset (`smoke`, `cognitive`,
`full`); there is **no `base` preset**, so map the arg:
- `full` → `-f matrix_preset=full`
- `base` → `-f matrix_preset=cognitive -f matrix_samples=3` (the 5 VQA tasks × 3 = 15/cell, no OCR)
- `smoke` → `-f matrix_preset=smoke`

⚠️ **Mobile session budget (critical for `mmproj=both`).** On mobile, `mmproj=both` runs **two** cells
(CPU + GPU) in one Device-Farm session → ~2× the inferences. **`full` × `mmproj=both` overruns the
~30-min per-test ceiling**: the CPU cell finishes but the GPU cell is **cut off mid-run** (`matrix-mobile`
shows `failure` while `matrix-combine` still succeeds on partial data — the GPU cell's quality then covers
only the first 1–2 tasks and is **not comparable**). So for a mobile `mmproj=both` verdict **default to
`base`**, and/or raise the ceiling with **`-f mobile_timeout_min=<min>`** (e.g. `60`; capped by the 120-min
DF/GH job ceiling). `full` on mobile is safe only for `mmproj=gpu` (one cell) or with a raised timeout.

Default `--runs 2` → **4 dispatches total** (`--runs` = dispatches per ref, for CPU-fingerprint
matching across units — not samples/task, which the preset governs). Device / preset / mode reach the
phone via the `matrix-mobile` job's `device_env` (Step 6) — pass them as `-f` inputs, identical for both
refs; only `mmprojGpu` (+ `mmprojModel` for `--mmproj both`) is baked into each ref's `config.cjs`.
Monitor each run to completion (poll `gh run view <id> --repo tetherto/qvac --json status,conclusion,jobs`):
the candidate prebuild (`prebuild-candidate-mobile` on a mobile-only run) is the early build signal;
`matrix-mobile` is the on-device leg (skips if the prebuild fails). **Record which run ID is baseline vs
optimized** — needed in Step 10.

### Step 9 — Retrieve metrics

**The raw `[VLMROW]`/`[VLMSEG]` markers a mobile run needs are in the `console-logs-*-Android`
artifact — NOT in `gh run view --log`** (they print to the on-device Android logcat, which Device Farm
captures as an artifact). For each run, download it and keep the logcat as that run's marker file for
Step 10:
```
gh run download <run-id> --repo tetherto/qvac --name console-logs-<pkg>-<device>-Android --dir <run-dir>
# → <run-dir>/Android/Android_logcat_full.txt holds the [VLMROW]/[VLMSEG] markers
```
Use a distinct `<run-dir>` per build+index (e.g. `opt1/`, `base1/`) so Step 10 can pair them, matching
the run IDs recorded in Step 8. (On **desktop** legs the markers are on native stderr, so there the
`gh run view --log` run log carries them; mobile does not.)

For the ready-made summary, read the **`vlm-matrix-consolidated-<run#>`** artifact (~2 KB markdown — full
quality + speed + samples tables) or the identical `matrix-combine` job-log render:
- **Quality:** per-task `textvqa / vizwiz / gqa / docvqa / ai2d` + **Overall %** (equal-weight mean).
- **Speed:** `mmproj-encode` (from the addon `vision_ms` RuntimeStat), TTFT, wall; small/large
  resolution buckets; samples run / passed / failed.
- Confirm the projector routed to the intended backend from logcat — Adreno OpenCL:
  `Adreno GPU version 830 found keeping OpenCL backend` → `using device GPUOpenCL`; Mali Vulkan:
  `found device description: Mali-G715` → `removing OpenCL backend … rely on Vulkan/cpu only` →
  `using device Vulkan0 (Mali-G715)`.

### Step 10 — Pair + detect quality regression (primary gate)

- Pair baseline↔optimized runs with `benchmarks/vlm-benchmark/match-devices.js` (build-invariant CPU
  `mmproj-encode` fingerprint → same-unit-equivalent), passing the per-run logs saved in Step 9
  (`--shipping` = the baseline runs, `--optimized` = the optimized runs):
  `node benchmarks/vlm-benchmark/match-devices.js --shipping base1/Android/Android_logcat_full.txt [base2/…] --optimized opt1/Android/Android_logcat_full.txt [opt2/…]` (the per-run logcat files downloaded in Step 9).
- **Quality Δ = (optimized − baseline) Overall %**, plus **per-task Δ**. **Flag ANY negative Δ**
  (overall or any task) as a regression — this is the gate.
- With `--mmproj both`, also report the **within-run GPU-vs-CPU** quality Δ per build (the
  projector-backend regression — the QVAC-21297 case: stock GPU −4.1 pp → fixed GPU Δ0).
- `full` (5 tasks×5) gives the sharpest quality signal on **desktop / `mmproj=gpu`**. `base` (3 samples)
  is coarser and can noise-mask small regressions (QVAC-21320 saw the same Adreno bug read as base −4 pp
  vs full −18.8 pp) — **but on mobile `mmproj=both` it is the verdict preset**: `full` overruns the
  Device-Farm per-test window and truncates the GPU cell (Step 8), so a completed `base` beats a
  truncated `full`. Raise `mobile_timeout_min` if you must run `full` on mobile. `smoke` (1 sample) is a
  **wiring check only** — it cannot produce a quality verdict, so on smoke, skip the regression gate +
  the full Step 11 report and just confirm routing / `GPU==CPU` / 0 device-loss.

### Step 11 — Report → write `QVAC-<ticket>-benchmark-results.md`

Write to `QVAC-<ticket>-benchmark-results.md` in the working dir where the prior docs live (repo root,
alongside `QVAC-21320-benchmark-results.md` / `QVAC-21297-benchmark-results.md`). Derive `<ticket>` as
the `QVAC-\d+` match from the PR title (`gh pr view <n> --repo <pr-repo> --json title`) or the branch
name; if there is no ticket, fall back to `<slug>-benchmark-results.md` and say so in the doc.

**Never discard prior results** — layer the newest on top (the shape `QVAC-21320-benchmark-results.md`
already has: newest first, older sections below):
- **Doc absent** → create it in full with the **Write tool**, section-for-section per the template below.
- **Doc present** → **do not overwrite.** Read it, then insert THIS run at the top of the results (below
  the doc's title + goal/context paragraph, above the prior run) in order:
  1. **Summary of the latest result** — the `> **Result:** …` blockquote + the `# Latest results …`
     section (method one-liner, quality gate, CPU-matched table, recommendation) for this run.
  2. **Latest result details** — the `# Detailed results` block for this run.
  3. **Results before that** — the previously-latest content, demoted beneath: rename the prior
     `# Latest results …` heading to a dated/labelled `# Previous results — <date/axis>` and keep it and
     all older sections **intact** below (preserve verbatim; only demote headings / reorder).

Either way the skill does **not** commit/push the doc (see Notes).

Match the two reference docs **section-for-section, in this order** (copy their exact column/wording):

1. `# QVAC-<ticket>: <one-line descriptor> (<device> / <SoC + backend>)`
2. Goal / context paragraph (_italic_) — what the optimization is, the ticket goal, related-ticket links.
3. `> **Result:** …` blockquote — one-paragraph headline verdict (what the A/B proved, **quality first**).
4. `---`
5. **Headline section** `# Latest results — <compared axis> (<device>)`:
   - Method in one line (_italic_): N runs, Device Farm pool, baseline-vs-optimized definitions, model,
     `mmproj` mode, preset (tasks×samples, `n=`/cell), matched-by CPU fingerprint, link to [CI runs](#ci-runs).
   - **Quality** paragraph (the primary gate) — Overall Δ + notable per-task shifts.
   - **Speed** paragraph + the **CPU-matched comparison table**:
     `| Metric | Baseline-CPU | Baseline-GPU | Optimized-CPU | Optimized-GPU | <opt vs base> | <opt vs shipping-CPU> |`
     rows `mmproj-encode (ms)` · `TTFT (ms)` · `wall (ms)` · `quality (Overall %)`; then a short
     column-meaning gloss.
   - **Primary robust metric** paragraph — the within-run CPU/GPU encode ratio (device variance cancels).
   - `## Recommendation` — numbered, actionable verdict.
6. `---`
7. `# Detailed results`:
   - `## Quality — lmms-eval overall %` — per-task table
     `| Build | Config | textvqa | vizwiz | gqa | docvqa | ai2d | Overall % |` + a Δ-callout line
     (**flag ANY negative per-task or overall Δ**; note base-preset granularity if the preset is coarse).
   - `## Per-run summary` — `| Run | Build | CPU enc | GPU enc | GPU TTFT | within-run CPU/GPU | quality GPU vs CPU |`,
     one row per run, run-ID linked.
   - `## Resolution dependence` — small vs large `mmproj-encode` bucket table.
   - `## Caveats` — decode-TPS artifact, peak-RSS not captured, CPU-fingerprint match %.
   - `## Setup & isolation` — model/blobs, device + logcat backend-routing proof, baseline/optimized
     build definitions (overlay `REF` / addon commit), the isolation statement (optimization = sole delta).
   - `## CI runs` — build-validation, smoke, and the N-run matched set, all run-ID linked.
   - `## Investigation` (optional) — headroom / profiler / accuracy-guard notes when relevant.
   - `## Verdict` — closing paragraph.

`QVAC-21320-benchmark-results.md` and `QVAC-21297-benchmark-results.md` are the worked templates —
copy their exact column headers and phrasing.

## Notes

- **Device Farm only** — no local ADB run yet. Thermal / cross-unit variance is handled by
  CPU-fingerprint matching + N runs, not interleaving.
- **Isolation** — the optimization under test must be the ONLY delta between baseline and optimized
  builds. Don't drag in unrelated fabric/addon changes (e.g. keep OpenCL work free of Vulkan opts).
- **Worktree** — created from `<qvac>` (the main clone) at `<worktree>` = `<qvac>/../wt-<slug>` (the
  repo's `wt-<name>` convention; see Prerequisites). Never edit in the read-only session checkout or
  other in-use worktrees.
- **Model support** — `config.cjs` already ships multiple VLMs (Qwen3.5 f16/q8, Gemma-4-E2B); select
  via `--model` → `mmprojModel` (mmproj-compare) / `models` (two-models), and add a new one via `hf()`
  blob literals. No framework code change is needed to benchmark a different model.
- **Approval policy** — harness edits happen in the isolated worktree and are **notify-only**; the
  **only** approval gate is the **push** to `origin` (Step 7), and even that is a separate
  `test/<slug>`, never `main`.
- **Harness source** — until the mmproj benchmark tooling merges to `main`, it lives on
  `test/QVAC-21257-mmproj-gpu-benchmark-changes` (grafted cleanly onto `main`), merged in by Step 5.
  The older `feat/QVAC-21257-mmproj-gpu-config` is NOT usable — it trails `main` by ~100 commits and its
  addon C++ conflicts with `main`'s `ContextSlideOutcome` refactor (the removed `FullWipe`). **End state:**
  once the grafted branch lands on `main`, drop the Step 5 merge and base directly on `origin/main`.
- **Device targeting** — a `-f matrix_mobile=<token>` dispatch input (`s25`/`pixel9`/`s26`/`iphone*`),
  **not** a branch edit. The `context` job resolves each token to `device_model`+`device_manufacturer`
  and the `matrix-mobile` job runs it as a single-device Device Farm filter (one phone per token).
- **What reaches the phone** — the `matrix-mobile` job forwards dispatch inputs to the device via its
  `device_env` (`QVAC_VLM_PRESET` ← `matrix_preset`, `QVAC_VLM_MODE` ← `matrix_mode`, `QVAC_VLM_SAMPLES`
  ← `matrix_samples`, `QVAC_VLM_MODELS` ← `matrix_models`, plus `device_model`). So preset/mode/samples/
  model are `-f` inputs, **not** `config.cjs` edits. The exception is `mmprojGpu` (`QVAC_VLM_MMPROJ_GPU`
  is desktop-only, absent from `device_env`) → set it in `config.cjs` on the `test/` ref.
- **Per-op OpenCL profiling** (`GGML_OPENCL_PROFILING` / `CLPROF`) is out of scope: its per-kernel
  logcat routing is blocked under `GGML_BACKEND_DL` (the backend module's stderr is not captured).
- **Assets it drives:** `benchmarks/vlm-benchmark/{config.cjs,harness.cjs,stage.cjs,aggregate.js,match-devices.js}`,
  `.github/workflows/{benchmark-vlm-model-comparison,reusable-prebuild-targeted,integration-mobile-test-llm-llamacpp}.yml`.
  Worked examples of the output format: `QVAC-21320-benchmark-results.md`, `QVAC-21297-benchmark-results.md`.
- **Writes** the results doc `QVAC-<ticket>-benchmark-results.md` to disk (Step 11) — **creating it if
  absent, otherwise prepending the new run as *Latest* and demoting the prior run to history (never
  discarding prior results)** — but does NOT commit/push it or open a PR; the caller handles version control.
