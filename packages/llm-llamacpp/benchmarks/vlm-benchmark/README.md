# VLM Benchmark

A **universal quality + speed benchmark** for vision-language inference with
`@qvac/llm-llamacpp`. It runs one frozen, open-licensed image fixture through a
chosen configuration and renders a single consolidated report, so the same numbers
are produced — and directly comparable — across platforms and backends.

It is built to be **flexible first, with sensible defaults**: out of the box it
compares Qwen3.5 mmproj-F16 vs mmproj-Q8 across a desktop and a mobile platform, but
every axis (model, engine, platform, backend, tasks, samples) is configurable.

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
fixture into `test/integration/` and the images into `test/mobile/testAssets/` (both
git-ignored) so the mobile test generator and app bundler pick them up. The
`../../`-relative requires resolve identically from either location.

---

## Platforms & backends

A run targets one or more **(platform × backend)** pairs. The benchmark is
platform-agnostic — adding an OS or a device is a runner/workflow change, not a config
change.

| Platform | Default target | Backends |
|---|---|---|
| **desktop** | Linux | CPU, GPU (where the runner supports it) |
| **mobile** | Samsung Galaxy S25 (AWS Device Farm) | CPU, GPU |

- **Desktop legs** are token-driven: the `matrix_linux` input (`linux-cpu,linux-gpu`)
  maps to runners in the workflow's `context` job. Add another desktop OS by adding a
  case there.
- **Mobile** reuses the `integration-mobile-test-llm-llamacpp.yml` workflow. Point it at
  a different phone by changing the Device Farm pool; the harness is unchanged.
- The config never names a platform — it only selects backends via `devices`
  (`cpu` / `gpu` / both).

---

## Modes

The benchmark runs in exactly one **comparison mode** per run. Each mode fixes one axis
and varies another.

| | **two-models** | **several-sources** |
|---|---|---|
| Varies | the **model** | the **inference engine** |
| Holds fixed | the engine (default `addon`) | the model |
| Compares | two mmproj variants of one model **or** two different models | `addon` vs `fabric-cli` vs `upstream-cli` |
| Default example | Qwen3.5 `mmproj-F16` vs `mmproj-Q8` | Qwen3.5 + q8 mmproj across all three engines |
| Targets | desktop + mobile, CPU + GPU | **desktop only** (CLIs are native binaries) |
| Headline metric | mmproj vision-encode time (e.g. Q8 vs F16) | per-engine quality + encode/TTFT |

**two-models** is the general comparison: each "cell" is a `{model, mmproj}` pair, and
the mode compares any two cells. Two cells of the same model with different mmproj
quants → a quantization study (the default); two cells with different `model` keys → a
head-to-head between models. The `base`/`candidate` config fields just label the two
report columns.

---

## Configuration

All behavior lives in **`config.cjs`** — the single source of truth, staged to the
device so it configures every target. You tune the benchmark by editing presets (or
adding new ones) and, for desktop, overriding individual fields by env.

**Presets** bundle the run settings. The shipped set is what we currently evaluate; it
is not exhaustive — clone one and adjust:

| preset | mode | what it runs |
|---|---|---|
| `compare` | two-models | **default** — Qwen3.5 f16 vs q8 mmproj · 5 tasks × 3 samples |
| `full` | two-models | all model·mmproj cells × all tasks (incl. qwen-vs-gemma) |
| `smoke` | two-models | 1 cell / 1 task / 1 sample — wiring check |
| `sources` | several-sources | Qwen3.5 q8 across addon + fabric-cli + upstream-cli |

**Run knobs** (preset fields). On desktop each is overridable by env; mobile always
uses the preset as written (Device Farm forwards no env):

| field | env override | meaning |
|---|---|---|
| `samplesPerTask` | `QVAC_VLM_SAMPLES` | images per task |
| `repeats` | `QVAC_VLM_REPEATS` | runs per sample, mean reported (default 3 desktop / 1 mobile) |
| `devices` | `QVAC_VLM_DEVICES`, `NO_GPU` | backends; `null` = CPU + GPU where applicable |
| `tasks` | `QVAC_VLM_TASKS` | task subset; `null` = all fixture tasks |

**Which preset runs where.** Desktop uses `QVAC_VLM_PRESET` (set from the workflow's
`matrix_preset` input), falling back to `defaultPreset`. Mobile always uses
`defaultPreset` — to change what mobile runs, edit that field.

**Model sources.** Each model blob carries a `source` descriptor — `hf` (pinned
HuggingFace commit), `url` (direct link), `s3` (presigned URL) — plus an optional
`registry` annotation (a published QVAC-registry entry; reported as Source = "Registry",
bytes fetched from its canonical pinned URL). See `resolveBlob()` in `harness.cjs`.

---

## Running it

The benchmark is driven by the **Benchmark (LLM)** workflow
(`.github/workflows/benchmark-llm-llamacpp.yml`). *Run workflow* → set `run_matrix =
true`, then pick the axes via the dispatch inputs below.

| input | purpose |
|---|---|
| `matrix_mode` | `two-models` \| `several-sources` |
| `matrix_preset` | `compare` \| `full` \| `smoke` \| `sources` (desktop) |
| `matrix_engine` | fixed engine for two-models: `addon` \| `fabric-cli` \| `upstream-cli` |
| `matrix_linux` | desktop legs, e.g. `linux-cpu,linux-gpu` |
| `matrix_samples` | override samples/task (empty = preset default) |
| `run_matrix_s25` | also run the mobile (S25) leg |

Locally you can run the harness directly under `bare` (desktop) by exporting
`QVAC_VLM_MATRIX=1` plus any `QVAC_VLM_*` overrides; the several-sources CLIs are built
and driven by `cli-fixture-runner.cjs`.

---

## Metrics & report

Two metric families, one per inference: a quality score (matched to the task) and a set
of speed timings. The report rolls them up per (platform × backend × config).

**Quality** — one lmms-eval-style metric per task; the equal-weight mean across tasks is
"Overall %":

| metric | tasks | how |
|---|---|---|
| `vqa` | textvqa, vizwiz, gqa | normalized exact match vs the answer set (min(1, hits/3)) |
| `anls` | docvqa | Average Normalized Levenshtein Similarity (≥0.5) |
| `relaxed` | (chartqa) | numeric within ±5% or string match |
| `mc` | ai2d | the stated letter (explicit "answer: X" or a short letter-led reply) |

**Speed** — `mmproj` vision-encode ms (the headline for an mmproj quant; parsed from
llama.cpp native stderr), TTFT, decode TPS, wall ms.

**Report layout** — (1) **Highlights** (quality + speed at a glance), (2) **Details**
(models & origins with Source, HW/SW provenance, full matrices), (3) **Test Results**
(per-target pass counts), (4) **Image samples** (task → image → W×H).

---

## Extending

The benchmark is meant to grow. The three common changes:

- **Add tasks / refresh images.** `node build-fixture.cjs --per-task 3 --max-side 1024`
  iterates the HuggingFace datasets-server, **filters on resolution without
  downloading**, keeps only open-licensed datasets (allowlist), writes images to
  `./images/`, regenerates `fixture.data.cjs`, and updates `fixture.NOTICE.md`
  (per-image attribution). Adding a task = one manifest entry.
- **Add models / variants.** Add a blob to the catalog in `config.cjs` with a `source`
  descriptor, then reference it from a preset's `cells`.
- **Add platforms.** Desktop: add a case to the `matrix_linux` → runner map in the
  workflow `context` job. Mobile: change the Device Farm pool. No harness changes.

---

## Known limitations

- **several-sources is desktop-only.** `fabric-cli`/`upstream-cli` are native binaries;
  the mobile path runs an addon app, not arbitrary CLIs.
- **mmproj vision-encode is unavailable on mobile.** It comes from llama.cpp's native
  stderr, which Android logcat doesn't capture — the report shows `—` there and uses
  **TTFT** (which includes vision-encode) as the mobile proxy.
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

## Files

All in `packages/llm-llamacpp/benchmarks/vlm-benchmark/` unless noted:

| | |
|---|---|
| `config.cjs` | the single source of truth: modes, presets, model catalog |
| `vlm-matrix.test.js`, `harness.cjs` | harness (loads models, emits markers) |
| `aggregate.js` | parses markers → report |
| `cli-fixture-runner.cjs` | runs the fixture through a native CLI (several-sources) |
| `build-fixture.cjs` | open-licensed fixture generator |
| `fixture.data.cjs`, `fixture.NOTICE.md`, `images/` | the frozen fixture + attribution |
| `stage.cjs` | copies the above into `test/integration/` + `testAssets/` for the mobile build |
| `.github/workflows/benchmark-llm-llamacpp.yml` | `run_matrix` jobs (desktop legs, mobile, combine) |

**Reused from elsewhere in the package** (not copied): the addon (`../../index.js`),
`ensureModel` (`../../test/integration/utils.js`), and the native CLI helpers
(`../vlm-performance/cli-case-runner.js`, `stdout-parser.js`, `scripts/build-cli-sources.js`).
