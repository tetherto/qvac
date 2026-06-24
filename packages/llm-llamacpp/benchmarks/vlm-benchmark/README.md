# VLM Benchmark

A **universal quality + speed benchmark** for vision-language inference with
`@qvac/llm-llamacpp`. It runs one frozen image fixture through a
chosen configuration and renders a single consolidated report, so the same numbers
are produced — and directly comparable — across platforms and backends.

It is built to be **flexible first, with sensible defaults**: out of the box it
compares Qwen3.5-0.8B with its vision projector at F16 vs Q8 across a desktop and a
mobile platform, but every axis (model, engine, platform, backend, tasks, samples) is
configurable.

---

## How it works

The harness loads a model configuration, runs every fixture sample, and prints
machine-readable markers to the log; a host-side script collects those logs and turns
them into one report. The **same harness runs on every target**, which is what makes
results comparable.

Pipeline:

1. **Harness** — `vlm-matrix.test.js` (entry) → `harness.cjs` loads the model(s), runs
   each `(task, sample, repeat)`, and emits `[VLMROW]` / `[VLMSEG]` / `[VLMMETA]`
   markers to stdout.
2. **Collect** — CI gathers the per-target logs as artifacts.
3. **Aggregate** — `aggregate.js` parses the markers, scores quality, and writes a
   Markdown report to the workflow **step summary**, a **PR comment**, and an artifact.

Everything ships from **this one directory**
(`packages/llm-llamacpp/benchmarks/vlm-benchmark/`). Desktop runs the files in place;
the mobile build first runs `stage.cjs`, which copies the entry + harness + config +
fixture data into `test/integration/` and the `fixture/` images into
`test/mobile/testAssets/` (both git-ignored) so the mobile test generator and app
bundler pick them up. The
`../../`-relative requires resolve identically from either location.

---

## Platforms & backends

A run targets one or more **(platform × backend)** pairs. The benchmark is
platform-agnostic — adding an OS or a device is a runner/workflow change, not a config
change.

Every leg is a dispatch token — pick any combination per run, e.g.
*"linux-cpu, linux-gpu, iphone17-cpu, s25-cpu, s25-gpu"*.

**Desktop** — `matrix_desktop`, tokens `<os>-<backend>`:

| token | runner | GPU backend |
|---|---|---|
| `linux-cpu` / `linux-gpu` | `qvac-ubuntu2204-x64` / `qvac-ubuntu2404-x64-gpu` | Vulkan |
| `macos-cpu` / `macos-gpu` | `macos-15-xlarge` (GitHub-hosted Apple Silicon VM) | Metal |
| `macmini-cpu` / `macmini-gpu` | `mac-mini-m4-gpu` (self-hosted bare-metal M4) | Metal |
| `windows-cpu` / `windows-gpu` | `qvac-win25-x64` / `qvac-win25-x64-gpu` | Vulkan |

**Mobile (AWS Device Farm)** — `matrix_mobile`, tokens `<device>[-<backend>]`;
a bare device token runs CPU **and** GPU in one on-device session, a `-cpu`/`-gpu`
suffix pins one backend:

| device token | Device Farm filter |
|---|---|
| `s26` | Samsung · "S26 Ultra" (Android) |
| `s25` | Samsung · "S25 Ultra" (Android) |
| `pixel9` | Google · "Pixel 9" (Android) |
| `iphone16` | Apple · "iPhone 16" (iOS) |
| `iphone17` | Apple · "iPhone 17" (iOS; CONTAINS — may pick a 17-family variant) |
| `iphone17pro` | Apple · "iPhone 17 Pro" (iOS) |

- Each mobile leg schedules **exactly one phone** (model filter, maxDevices 1)
  through the `integration-mobile-test-llm-llamacpp.yml` workflow; the backend
  selection and the dispatched mode/preset are forwarded to the device via the
  `qvacPerfConfig.txt` push channel (`device_env`).
- **Adding a platform is one map entry**: a desktop OS = one case in the workflow
  `context` job's `dmatrix` step; a phone (e.g. a future S26) = one case in the
  `mmatrix` step — provided the device exists in the Device Farm fleet.
- The config never names a platform — it only selects backends via `devices`
  (`cpu` / `gpu` / both).

---

## Modes

The benchmark runs in exactly one **comparison mode** per run. Each mode fixes one axis
and varies another.

| | **two-models** | **several-sources** |
|---|---|---|
| Varies | the **model** | the **source** (build and/or engine) |
| Holds fixed | the engine (default `addon`) | the model |
| Compares | `MODEL_1` vs `MODEL_2` | any of: `addon@candidate` vs `addon@baseline` (build comparison) · `addon` vs `fabric-cli` vs `upstream-cli` (engine comparison) |
| Default example | Qwen3.5 mmproj-F16 vs mmproj-Q8 | candidate addon (your branch) vs the published baseline — same model |
| Targets | desktop + mobile, CPU + GPU | desktop (Linux/macOS/Windows) for all sources; mobile for the **addon** builds only (`addon@candidate`/`@baseline` run as separate Device Farm sessions) — the native `fabric`/`upstream` CLIs are desktop-only |
| Headline metric | per-model quality + vision-encode time | per-source quality (VQA + OCR) + encode/TTFT |

**two-models** compares the two complete VLMs configured as `MODEL_1` and `MODEL_2`.
Each is a main LLM blob + an mmproj blob. They can be **two blobs/variants of the same
model** (the default — Qwen3.5 with the projector at F16 vs Q8: same `llm`, different
`mmproj`) or **two different models** (point the two `llm` blobs at different models).

**several-sources** holds the model fixed and varies the **source** — what's running it.
Two flavours, freely combined via `matrix_sources`:
- **Build comparison (A2):** `addon@candidate` vs `addon@baseline`. The **candidate** is the
  addon built from the dispatched `ref` (your branch / PR head / commit — see "Running it");
  the **baseline** is the pinned published npm version (`config.defaultBaseline.npm`). This is
  how you check, *before merge*, whether a change actually moved speed/quality. Desktop swaps
  the freshly-built prebuild per source per run; mobile runs each build as its own Device Farm
  session. Two sources → a clean 2-column report.
- **Engine comparison:** `addon` vs `fabric-cli` vs `upstream-cli` — the same model across the
  published addon and the two native llama.cpp CLIs (desktop-only, built from source per-OS).

The report's **Details → "Sources — resolved versions"** table shows exactly what each column
resolved to (e.g. `addon@candidate → git:<sha>`, `addon@baseline → npm:0.24.0`).
The report labels the two columns from each model's `label`.

---

## Configuration

All behavior lives in **`config.cjs`** — the single source of truth, staged to the
device so it configures every target. Two independent axes:

- **mode** (what's compared) — `mode` field / `matrix_mode` input.
- **preset** (how much is run) — `defaultPreset` field / `matrix_preset` input.

**The models** are explicit at the top of the config:

| constant | used by | meaning |
|---|---|---|
| `MODEL_1`, `MODEL_2` | two-models | the two complete VLMs to compare |
| `SOURCES_MODEL` | several-sources | the one VLM run through every engine |

Each is a full spec — `label`, `name`, `ctx_size`, an `llm` blob and an `mmproj` blob
(each blob has a `source` descriptor + optional `registry` annotation). Edit those
constants to change what runs; nothing else needs to change.

**Presets** are run-size + task-group bundles (independent of mode):

| preset | what runs | use |
|---|---|---|
| `smoke` | 1 task × 1 sample | a single inference per config — wiring check |
| `cognitive` | 5 VQA tasks × 5 | reasoning/quality evaluation |
| `ocr1page` | 1 light `ocr-page` doc | quick document-OCR check (fits the mobile session) |
| `ocr5pages` | all 5 high-MP `ocr-page` docs | heavy document OCR — desktop-oriented |
| `full` | cognitive + `ocr-small` ×5 + 1 light `ocr-page` | **default** — the complete fixture (`ocr-page` capped to 1) |

**Run knobs** (preset fields). Each is overridable by env on every target — desktop
gets env directly from the workflow; mobile gets it via the `qvacPerfConfig.txt`
file the workflow pushes to the device (`device_env`):

| field | env override | meaning |
|---|---|---|
| `samplesPerTask` | `QVAC_VLM_SAMPLES` | images per task |
| `repeats` | `QVAC_VLM_REPEATS` | runs per sample, mean reported (default 3 desktop / 1 mobile) |
| `devices` | `QVAC_VLM_DEVICES`, `NO_GPU` | backends; `null` = CPU + GPU where applicable |
| `tasks` | `QVAC_VLM_TASKS` | task subset; `null` = all fixture tasks |

**Which preset runs where.** Every leg uses `QVAC_VLM_PRESET` (set from the
workflow's `matrix_preset` input — forwarded to phones as device env), falling
back to the committed `defaultPreset` when run outside the workflow.

**Model sources.** Each model blob carries a `source` descriptor — `hf` (pinned
HuggingFace commit), `url` (direct link), `s3` (presigned URL) — plus an optional
`registry` annotation (a published QVAC-registry entry; reported as Source = "Registry",
bytes fetched from its canonical pinned URL). See `resolveBlob()` in `harness.cjs`.

---

## Running it

The benchmark is driven by the **Benchmark VLM (model comparison)** workflow
(`.github/workflows/benchmark-vlm-model-comparison.yml`). *Run workflow* (or `gh workflow run`)
→ set `run_matrix = true`, then pick the axes via the dispatch inputs below.

### Launch configuration checklist

There are **two ways to configure a launch**, and each item below shows both:

- **Config (committed):** edit `config.cjs` and push. Required for the model choice
  (models are config-only); also the fallback for mode/preset when run outside the
  workflow.
- **Dispatch (`-f`):** pass to `gh workflow run` (or the *Run workflow* UI). Overrides
  the config on **every leg** — desktop via env, phones via the pushed device env —
  no commit needed.

Walk it top-to-bottom. Steps 1–2 (model + source versions) decide *what* is measured;
3–9 decide *how* it runs.

**1. Set the model(s).** *(dispatch or config — see `CONTRACT.md` §3)*
   - **Dispatch — ANY model, zero code changes:** `-f matrix_models=…`, comma-separated:
     catalog names (`qwen3.5-f16,qwen3.5-q8`) and/or ad-hoc pairs
     `[label=]<llm-gguf-url>|<mmproj-gguf-url>[@ctx=N]` (two https URLs are all a model
     needs; HF resolve-URLs are reported with repo+ref provenance), or `json:[…]` for
     exotic cases (registry sources — desktop-only). Empty = config `defaultModels`.
   - **Config:** edit the `catalog` / `MODEL_1`/`MODEL_2` specs in `config.cjs` (two
     blobs of one model → same `llm`, different `mmproj`; distinct `label` each).
   - several-sources mode always runs the committed `SOURCES_MODEL`.

**2. Update the source versions.**
   - **Sources under comparison** (`several-sources` mode): `-f matrix_sources=…`, comma-sep:
     - `addon` — the published npm prebuild.
     - `addon@candidate` — the addon **built from the dispatched `ref`** (your branch / PR head /
       commit). Triggers the `prebuild-candidate` build job; desktop swaps the built prebuild in,
       mobile bundles it into its own session.
     - `addon@baseline` — the pinned published version (`config.defaultBaseline.npm`), packed from npm.
     - `fabric@<ref>` / `upstream@<ref>` — native llama.cpp CLIs built from source (desktop-only).
     - **Candidate-vs-baseline** = `-f matrix_sources=addon@candidate,addon@baseline` (a clean
       2-source build comparison; see the example below). The native-CLI steps run only when a
       `fabric`/`upstream` token is present, so this stays addon-only.
   - **Candidate ref** = the **`ref`** input (`-f ref=<branch|tag|commit-sha>`, default = the branch
     the workflow runs on). This is what gets built as `addon@candidate`.
   - **Model version:** bump the pinned commit in `config.cjs` (`SHA.*` / the blob's
     `source.sha`) — or just dispatch the new URL via `matrix_models`.
   - **Fixture images:** stored in a fixture object store (URI configured in the
     benchmark workflow), not git; you may download them separately for local tests.
     Regenerate with `build-fixture.cjs`, then upload `./fixture/` to that store; CI pulls
     them per run (needs the `release` environment for the OIDC role).

**3. Mode** — what's compared.
   - Config: `mode: 'two-models' | 'several-sources'`.
   - Dispatch: `-f matrix_mode=…` (every leg; forwarded to phones as device env).

**4. Preset** — task group: `smoke` (1 task, wiring check) · `cognitive` (5 VQA tasks × 5) ·
   `ocr1page` (1 light `ocr-page` doc — quick document-OCR check, fits the mobile session) ·
   `ocr5pages` (all 5 high-MP `ocr-page` docs — desktop-oriented) ·
   `full` (cognitive + `ocr-small` + the 1 light `ocr-page`).
   - Config: `defaultPreset: '…'` (and the `presets` definitions: tasks/samples/repeats).
   - Dispatch: `-f matrix_preset=…` (every leg; forwarded to phones as device env).
     Keep mobile light (`smoke` / `cognitive` / `ocr1page`); `full` and `ocr5pages` are
     desktop-oriented (the heavy `ocr-page` docs can overrun the Device Farm session — raise
     `mobile_timeout_min` if you must run them on a phone).

**5. Desktop platforms × backends.**
   - Dispatch: `-f matrix_desktop=…` — any subset of `{linux,macos,macmini,windows}-{cpu,gpu}`
     (gpu = Vulkan on Linux/Windows, Metal on macOS/Mac mini).
   - Config: backends per preset via `devices` (`null` = both); env `NO_GPU=true`.

**6. Mobile devices × backends (AWS Device Farm).**
   - Dispatch: `-f matrix_mobile=s26,s25,pixel9,iphone16,iphone17,iphone17pro` tokens, each
     optionally suffixed `-cpu`/`-gpu` (bare = both in one session). Empty = no mobile.
     Runs for two-models, and for the **addon** builds of several-sources
     (`addon@candidate`/`@baseline` → one Device Farm session each); the native
     `fabric`/`upstream` CLI sources are desktop-only and skipped on mobile.

**7. Task set** — `scenarios.cjs` defines one `default` set: the 5 VQA tasks
   (textvqa/vizwiz/gqa/docvqa/ai2d) + the OCR tasks (ocr-small/ocr-page). Quality is
   reported per task, **not gated** (different models are compared, so there's no
   candidate-vs-baseline accuracy regression to gate on). OCR tasks score by CER/WER/BLEU
   in a separate table.
   - Config: `config.defaultScenario` (single `default` set today; no dispatch input —
     the `workflow_dispatch` input budget is capped at 10 and `mobile_timeout_min` took the slot).

**8. Samples / repeats / tasks.**
   - Samples — Config: preset `samplesPerTask`; Dispatch: `-f matrix_samples=N`.
   - Repeats / tasks — Config: preset `repeats` / `tasks`; (local env
     `QVAC_VLM_REPEATS` / `QVAC_VLM_TASKS` — no dispatch input).

**Dispatch inputs reference** (GitHub caps `workflow_dispatch` at 10 inputs — the set is full)

| input | overrides | purpose |
|---|---|---|
| `run_matrix` | — | **must be true** to run the matrix at all |
| `ref` | current branch | addon ref to test — branch / tag / **commit SHA**; built as `addon@candidate` (A2) |
| `matrix_mode` | `config.mode` | `two-models` \| `several-sources` (every leg) |
| `matrix_preset` | `config.defaultPreset` | `smoke` \| `cognitive` \| `ocr1page` \| `ocr5pages` \| `full` (every leg) |
| `matrix_models` | `config.defaultModels` | catalog names / `[label=]<llm-url>\|<mmproj-url>[@ctx=N]` / `json:[…]` (CONTRACT.md §3) |
| `matrix_sources` | — | sources to compare: `addon` \| `addon@candidate` \| `addon@baseline` \| `fabric@<ref>` \| `upstream@<ref>` |
| `matrix_desktop` | — | desktop legs: `{linux,macos,macmini,windows}-{cpu,gpu}` (any subset) |
| `matrix_mobile` | — | mobile legs: `{s26,s25,pixel9,iphone16,iphone17,iphone17pro}[-{cpu,gpu}]` (empty = none; two-models, or several-sources addon builds → one session per source) |
| `matrix_samples` | preset `samplesPerTask` | override samples/task, every leg (empty = default) |
| `mobile_timeout_min` | `config.mobileTimeoutMin` | mobile per-leg timeout (min) — raises the Device-Farm Mocha/Android per-test ceiling (≤120; empty = config, null config = 35/30 default) |

**Example** — two-models, mixed leg selection, full preset, one ad-hoc model:

```bash
gh workflow run benchmark-vlm-model-comparison.yml --ref <branch> \
  -f run_matrix=true -f matrix_mode=two-models -f matrix_preset=full \
  -f matrix_models="qwen3.5-q8,challenger=https://huggingface.co/org/NewVLM-GGUF/resolve/<sha>/NewVLM-Q4_K_M.gguf|https://huggingface.co/org/NewVLM-GGUF/resolve/<sha>/mmproj-F16.gguf" \
  -f matrix_desktop=linux-cpu,linux-gpu,macos-gpu \
  -f matrix_mobile=s25-cpu,s25-gpu,iphone17
```

**Example** — candidate-vs-baseline (A2): validate an *unmerged* change against the
published build. `--ref` selects the **workflow** (must be a branch/tag that carries this
A2 workflow); `-f ref` selects the **candidate** addon to build (branch, tag, or commit SHA):

```bash
gh workflow run benchmark-vlm-model-comparison.yml \
  --ref qvac-19371-vlm-benchmark-improve \          # branch hosting the A2 workflow
  -f run_matrix=true -f matrix_mode=several-sources \
  -f matrix_sources=addon@candidate,addon@baseline \
  -f ref=<branch|tag|commit-sha> \                  # the addon built as addon@candidate
  -f matrix_models=qwen3.5-q8 -f matrix_preset=full \
  -f matrix_desktop=linux-cpu
```

Notes: `-f ref` accepts any branch/tag/**commit SHA** reachable in the repo — a same-repo PR
(use its head branch) or a fork PR (use its head **commit SHA**; fork branch *names* don't
resolve in the base repo). `--ref` (the workflow host) must be a branch/tag — `workflow_dispatch`
does not accept a bare SHA there. `prebuild-candidate` builds the **full platform matrix** from
`ref`; a non-linux build failure gates the desktop legs (desktop-only build filter is a follow-up).

**Locally** you can run the harness directly under `bare` (desktop) by exporting
`QVAC_VLM_MATRIX=1` plus any `QVAC_VLM_*` overrides (`QVAC_VLM_MODE`, `QVAC_VLM_PRESET`,
`QVAC_VLM_MODELS`, `QVAC_VLM_SCENARIOS`, `QVAC_VLM_SAMPLES`, `QVAC_VLM_REPEATS`,
`QVAC_VLM_DEVICES`, `QVAC_VLM_TASKS`, `NO_GPU`); the several-sources CLIs are built and
driven by `cli-fixture-runner.cjs`. `node run-desktop.cjs --selfcheck` validates the
config/contract wiring without running any model.

---

## Metrics & report

Two metric families, one per inference: a quality score (matched to the task) and a set
of speed timings. The report rolls them up per (platform × backend × config).

**Quality** — one lmms-eval-style metric per task; the equal-weight mean across tasks is
"Overall %":

| metric | tasks | how |
|---|---|---|
| `vqa` | textvqa, vizwiz, gqa | exact normalized match = 1, else graded partial credit (word-overlap F1 / char similarity); unrelated answers ~0 |
| `anls` | docvqa | same graded text similarity (Average Normalized Levenshtein family) |
| `mc` | ai2d | the stated letter (explicit "answer: X" or a short letter-led reply) |
| `relaxed` | (numeric charts) | numeric within ±5% or string match — defined, not used by the current task set |
| `cer` / `wer` / `bleu` | ocr-small, ocr-page | OCR error/overlap rates — reported in a **separate** table (↓ CER/WER, ↑ BLEU), never folded into "Overall %" |

**Speed** — `mmproj` vision-encode ms (the headline for an mmproj quant; parsed from
llama.cpp native stderr), TTFT, decode TPS, wall ms.

**Report layout** — (1) **Highlights** — a one-line verdict (in two-models mode: a
leading 🚀/⚖️/🐢 emoji + candidate-vs-baseline avg speed (vis-encode+TTFT) and quality
across all legs), then quality / speed / OCR tables; (2) **Details**
(models & origins with Source, HW/SW provenance, full matrices); (3) **Test Results**
(per-target pass counts), (4) **Image samples** (task → image → W×H).

### Measurement stability (warmup + thermal guard)

Cold-start (weight load, JIT, Vulkan shader-compile, cache fill) and **CPU heating /
throttling** can skew latency — **especially on mobile**, which previously ran a single
cold shot. Three layers keep the reported numbers steady-state:

1. **Warmup pass.** Before the measured passes, the harness runs one warmup pass over the
   first item (`WARMUP_REPEATS`, default **1** for single-process runs — mobile and
   desktop-direct), stamped **`block: 0`**. The report **drops `block 0`** from every
   statistic, so the JIT/shader/cache prime is never counted. Warmup rows are still emitted
   (auditable). Override with `QVAC_VLM_WARMUP_REPEATS` (`0` disables).
2. **Stability guard.** After warmup, `methodology.cjs` `stabilityGuard()` waits for a
   **steady thermal state** before the measured pass — a calibrated CPU micro-probe polled
   until its timing stabilises within tolerance over a window, or `maxWaitMs` (best effort).
   Modes: `probe` (default — no privileges, works on phones), `temp` (Mac mini powermetrics —
   hook, not yet wired), `off`. On mobile it's bounded tight (~6 s) to stay under the Device
   Farm per-test ceiling. It emits a **`[VLMBLOCK]`** marker recording what it did
   (`{kind, value_ms, waited_ms}`).
3. **First-encode drop + repeats.** The vision-encode metric additionally drops the first
   segment per cell (the shader-compile spike); measured passes are repeated (`repeats`,
   mean reported).

Tuning lives in `config.cjs` `methodology` (`warmupBlocks`, `stability`, …). The full
interleaved round scheduler (median over measured blocks, blocks interleaved across sources
for fair thermal drift) is a desktop follow-up; the per-process warmup + guard above is what
runs on every target today, including phones.

---

## Extending

The benchmark is meant to grow. The three common changes:

- **Add tasks / refresh images.** `node build-fixture.cjs --per-task 3 --max-side 1024`
  iterates the HuggingFace datasets-server, **filters on resolution without
  downloading**, keeps only open-licensed datasets (allowlist), writes images to
  `./fixture/`, regenerates `fixture.data.cjs`, and updates `fixture.NOTICE.md`
  (per-image attribution). Adding a task = one manifest entry. **The images are not
  committed — they live in a fixture object store** (URI configured in the benchmark
  workflow); after regenerating, upload `./fixture/` to that store. CI syncs it →
  `fixture/` before each run (desktop and, before `stage.cjs`, mobile).
- **Change the models.** Edit `MODEL_1` / `MODEL_2` (two-models) or `SOURCES_MODEL`
  (several-sources) in `config.cjs` — give each blob a `source` descriptor. To compare
  two variants of one model, point both at the same `llm` and vary only the `mmproj`.
- **Add platforms.** Desktop: one case in the `matrix_desktop` → runner map
  (`dmatrix` step of the workflow `context` job). Mobile: one case in the device
  map (`mmatrix` step) — any phone available in the Device Farm fleet. No harness
  changes.

---

## Known limitations

- **several-sources is desktop-only.** `fabric-cli`/`upstream-cli` are native binaries
  built per-OS (Vulkan on Linux/Windows, Metal on macOS); the mobile path runs an addon
  app, not arbitrary CLIs, so phones are excluded from this mode. On Windows the build
  uses the pre-installed clang + Ninja (the runner has no Visual Studio, and the
  GH-Actions user can't run choco), set up by the workflow's Windows-only step.
- **mmproj vision-encode time is unavailable on mobile.** It comes from llama.cpp's native
  stderr, which neither Android logcat nor the iOS console capture carries — the report
  shows `—` there and uses **TTFT** (which includes vision-encode) as the mobile proxy.
- **addon vs CLI prompt parity.** The addon API sends the image as its own `user` turn
  (~+11 tokens) vs the CLIs' single turn, so the *addon-vs-CLI* quality comparison is
  not strictly apples-to-apples. `fabric-cli` vs `upstream-cli` share an identical
  prompt and is the clean engine comparison. (True addon parity needs an addon-side
  single-turn API.)
- **MC (ai2d).** Only an explicit/short letter answer is scored; a reasoning paragraph
  with no stated choice scores 0 (by design — avoids grabbing a random letter from prose).
- **Registry source on mobile.** The P2P registry client isn't bundled into the mobile
  app; registry blobs are fetched via their pinned HTTPS origin (byte-identical) on
  every target.
- **Small n.** Defaults are 3 samples × 3 repeats; raise `samplesPerTask` for tighter
  quality estimates (borderline single-sample flips otherwise move the mean).

---

## Contract & parallel development

Active development (QVAC-19371 umbrella) is split into two independent workstreams —
**runner** (sources, methodology, metrics: `harness.cjs`, `models.cjs`, `sources.cjs`,
`methodology.cjs`, `run-desktop.cjs`, `config.cjs`, the workflow run jobs) and
**report** (scenarios, scoring, views: `scenarios.cjs`, `aggregate.js`,
`combine.cjs`, `fixture*`, `score-check.cjs`, the workflow inputs + combine job).
They meet only at the frozen interface in **`CONTRACT.md`** (marker schema v2, env
vars, launch grammar); `markers-v2.sample.txt` is its executable sample — the report
side develops against it, `node run-desktop.cjs --selfcheck` validates it.

---

## Files

All in `packages/llm-llamacpp/benchmarks/vlm-benchmark/` unless noted:

| | |
|---|---|
| `CONTRACT.md`, `markers-v2.sample.txt` | **the frozen runner↔report contract** (marker schema v2, env vars, launch grammar) + its executable sample |
| `config.cjs` | run-side source of truth: modes, presets, model catalog, sources, methodology |
| `scenarios.cjs` | the task set (VQA + OCR) the benchmark runs — report-side owned |
| `models.cjs` | `matrix_models` grammar → canonical model specs (any model via two URLs) |
| `sources.cjs`, `methodology.cjs` | source tokens (incl. addon@candidate/@baseline prebuild resolution, A2) + measurement methodology helpers (A3 builds on these) |
| `run-desktop.cjs` | desktop run driver scaffold + `--selfcheck` contract guard |
| `combine.cjs` | combine driver: log discovery, host tagging, provenance, report render (descriptive — no accuracy gate) |
| `vlm-matrix.test.js`, `harness.cjs` | harness (loads models, emits markers) |
| `aggregate.js` | parses markers → report |
| `cli-fixture-runner.cjs` | runs the fixture through a native CLI (several-sources) |
| `cli-case-runner.js`, `stdout-parser.js`, `accuracy.js`, `utils.js`, `cli-source-config.js`, `build-cli-sources.js` | **vendored** native-CLI helpers — build + run fabric/upstream `llama-mtmd-cli` (several-sources). Self-contained; not imported from `vlm-performance` |
| `build-fixture.cjs` | open-licensed fixture generator |
| `fixture.data.cjs`, `fixture.NOTICE.md` | the frozen fixture manifest + attribution (images are in S3, synced into `fixture/` by CI) |
| `score-check.cjs` | offline metric-tuning harness — re-scores real predictions without re-running inference |
| `stage.cjs` | copies the above into `test/integration/` + `testAssets/` for the mobile build |
| `.github/workflows/benchmark-vlm-model-comparison.yml` | `run_matrix` jobs (desktop legs, mobile, combine) |

**Reused from the package** (on `main`, not copied): the addon (`../../index.js`) and
`ensureModel` (`../../test/integration/utils.js`). The several-sources native-CLI helpers
are **vendored** into this folder (above) so the benchmark is self-contained.
