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
| Compares | `MODEL_1` vs `MODEL_2` | `addon` vs `fabric-cli` vs `upstream-cli` |
| Default example | Qwen3.5 mmproj-F16 vs mmproj-Q8 | Qwen3.5 + q8 mmproj across all three engines |
| Targets | desktop + mobile, CPU + GPU | **desktop only** (CLIs are native binaries) |
| Headline metric | per-model quality + vision-encode time | per-engine quality + encode/TTFT |

**two-models** compares the two complete VLMs configured as `MODEL_1` and `MODEL_2`.
Each is a main LLM blob + an mmproj blob. They can be **two blobs/variants of the same
model** (the default — Qwen3.5 with the projector at F16 vs Q8: same `llm`, different
`mmproj`) or **two different models** (point the two `llm` blobs at different models).
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

**Presets** are pure run-size bundles (independent of mode):

| preset | tasks × samples × repeats | use |
|---|---|---|
| `smoke` | 1 task × 1 × 1 | a single inference per config — wiring check |
| `base` | 5 tasks × 3 × 1 | **default** evaluation |
| `full` | 5 tasks × 5 × 1 | the complete fixture |

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

The benchmark is driven by the **Benchmark VLM (model comparison)** workflow
(`.github/workflows/benchmark-vlm-model-comparison.yml`). *Run workflow* (or `gh workflow run`)
→ set `run_matrix = true`, then pick the axes via the dispatch inputs below.

> **Important:** the same workflow also hosts a *separate* source-engines benchmark
> (the `desktop` job — addon/fabric/upstream legs across many platforms). It is **on by
> default**. For a clean matrix-only run, turn it off:
> `run_addon=false run_fabric_cli=false run_upstream_cli=false run_android=false`
> (that zeroes the `desktop`/`summarize`/`android` jobs so only the matrix runs).

### Launch configuration checklist

There are **two ways to configure a launch**, and each item below shows both:

- **Config (committed):** edit `config.cjs` and push. Required for the model choice and
  for anything the **mobile (S25) leg** does — Device Farm forwards **no env**, so the
  phone always runs the committed `config.mode` / `defaultPreset` / models.
- **Dispatch (`-f`):** pass to `gh workflow run` (or the *Run workflow* UI). Overrides the
  config on the **desktop legs only**, no commit needed.

Walk it top-to-bottom. Steps 1–2 (model + source versions) decide *what* is measured;
3–9 decide *how* it runs.

**1. Set the model(s).** *(config only — no dispatch input)*
   - two-models: edit `MODEL_1` and `MODEL_2`. Two blobs of one model → keep the same
     `llm`, change the `mmproj` (default: Qwen3.5 F16 vs Q8). Two different models →
     point the two `llm` blobs at different repos. Give each a distinct `label`.
   - several-sources: edit `SOURCES_MODEL` (the one VLM run through every engine).
   - Each blob's bytes come from its `source` (pinned `hf` commit / `url` / `s3`).

**2. Update the source versions.**
   - **Inference engines** (several-sources): `-f fabric_ref=v8189.0.2`,
     `-f upstream_ref=b8189` (the native CLI tags); the addon source is the published
     `@qvac/llm-llamacpp@latest` npm prebuild.
   - **Model version:** bump the pinned commit in `config.cjs` (`SHA.*` / the blob's
     `source.sha`) — config only.
   - **Fixture images:** stored in S3 (`s3://tether-ai-dev/vlm-benchmark/`), you may download them seperately for local tests.
     Regenerate with `build-fixture.cjs`, then `aws s3 sync ./images/ s3://…`; CI pulls
     them per run (needs the `release` environment for the OIDC role).

**3. Mode** — what's compared.
   - Config: `mode: 'two-models' | 'several-sources'`.
   - Dispatch: `-f matrix_mode=…` (desktop). *Mobile uses `config.mode`.*

**4. Preset** — run size (`smoke` 1×1×1 · `base` 5×3×1 · `full` 5×5×1).
   - Config: `defaultPreset: '…'` (and the `presets` definitions: tasks/samples/repeats).
   - Dispatch: `-f matrix_preset=…` (desktop). *Mobile uses `defaultPreset`.*

**5. Desktop platforms × backends.**
   - Dispatch: `-f matrix_linux=linux-cpu,linux-gpu` (drop one for a single backend).
   - Config: backends per preset via `devices` (`null` = both); env `NO_GPU=true`.

**6. Mobile (Samsung S25).**
   - Dispatch: `-f run_matrix_s25=true` (two-models only; ignored for several-sources).
   - Config: the phone's run is `config.mode` + `defaultPreset` — set them before pushing.
     Keep it light (`base`); `full` overruns the Device Farm session window.

**7. Engine / sources.**
   - two-models engine — Config: `engine: 'addon'`; Dispatch: `-f matrix_engine=addon`.
   - several-sources set — Config only: `engines: ['addon','fabric-cli','upstream-cli']`.

**8. Samples / repeats / tasks.**
   - Samples — Config: preset `samplesPerTask`; Dispatch: `-f matrix_samples=N`.
   - Repeats / tasks — Config: preset `repeats` / `tasks`; (local env
     `QVAC_VLM_REPEATS` / `QVAC_VLM_TASKS` — no dispatch input).

**9. Silence the source-engines benchmark** (for a clean matrix-only run).
   - Dispatch: `-f run_addon=false -f run_fabric_cli=false -f run_upstream_cli=false -f run_android=false`
     (zeroes the `desktop`/`summarize`/`android` jobs). Always set `-f run_matrix=true`.

**Dispatch inputs reference**

| input | overrides | purpose |
|---|---|---|
| `run_matrix` | — | **must be true** to run the matrix at all |
| `matrix_mode` | `config.mode` | `two-models` \| `several-sources` (desktop) |
| `matrix_preset` | `config.defaultPreset` | `smoke` \| `base` \| `full` (desktop) |
| `matrix_engine` | `config.engine` | two-models fixed engine |
| `matrix_linux` | — | desktop legs, e.g. `linux-cpu,linux-gpu` |
| `matrix_samples` | preset `samplesPerTask` | override samples/task (empty = default) |
| `run_matrix_s25` | — | also run the mobile (S25) leg (two-models only) |
| `fabric_ref` / `upstream_ref` | — | native CLI versions (several-sources) |
| `run_addon` / `run_fabric_cli` / `run_upstream_cli` / `run_android` | — | source-engines legs — **false** for matrix-only |

**Example** — clean two-models, desktop CPU+GPU + S25, base preset:

```bash
gh workflow run benchmark-vlm-model-comparison.yml --ref <branch> \
  -f run_matrix=true -f matrix_mode=two-models -f matrix_preset=base \
  -f matrix_engine=addon -f matrix_linux=linux-cpu,linux-gpu -f run_matrix_s25=true \
  -f run_addon=false -f run_fabric_cli=false -f run_upstream_cli=false -f run_android=false
```

**Locally** you can run the harness directly under `bare` (desktop) by exporting
`QVAC_VLM_MATRIX=1` plus any `QVAC_VLM_*` overrides (`QVAC_VLM_MODE`, `QVAC_VLM_PRESET`,
`QVAC_VLM_SAMPLES`, `QVAC_VLM_REPEATS`, `QVAC_VLM_DEVICES`, `QVAC_VLM_TASKS`, `NO_GPU`);
the several-sources CLIs are built and driven by `cli-fixture-runner.cjs`.

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
  (per-image attribution). Adding a task = one manifest entry. **The images are not
  committed — they live in S3** (`s3://tether-ai-dev/vlm-benchmark/`); after
  regenerating, upload them (`aws s3 sync ./images/ s3://tether-ai-dev/vlm-benchmark/`).
  CI syncs S3 → `images/` before each run (desktop and, before `stage.cjs`, mobile).
- **Change the models.** Edit `MODEL_1` / `MODEL_2` (two-models) or `SOURCES_MODEL`
  (several-sources) in `config.cjs` — give each blob a `source` descriptor. To compare
  two variants of one model, point both at the same `llm` and vary only the `mmproj`.
- **Add platforms.** Desktop: add a case to the `matrix_linux` → runner map in the
  workflow `context` job. Mobile: change the Device Farm pool. No harness changes.

---

## Known limitations

- **several-sources is desktop-only.** `fabric-cli`/`upstream-cli` are native binaries;
  the mobile path runs an addon app, not arbitrary CLIs.
- **mmproj vision-encode time is unavailable on mobile.** It comes from llama.cpp's native
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
| `cli-case-runner.js`, `stdout-parser.js`, `accuracy.js`, `utils.js`, `cli-source-config.js`, `build-cli-sources.js` | **vendored** native-CLI helpers — build + run fabric/upstream `llama-mtmd-cli` (several-sources). Self-contained; not imported from `vlm-performance` |
| `build-fixture.cjs` | open-licensed fixture generator |
| `fixture.data.cjs`, `fixture.NOTICE.md` | the frozen fixture manifest + attribution (images are in S3, synced into `images/` by CI) |
| `score-check.cjs` | offline metric-tuning harness — re-scores real predictions without re-running inference |
| `stage.cjs` | copies the above into `test/integration/` + `testAssets/` for the mobile build |
| `.github/workflows/benchmark-vlm-model-comparison.yml` | `run_matrix` jobs (desktop legs, mobile, combine) |

**Reused from the package** (on `main`, not copied): the addon (`../../index.js`) and
`ensureModel` (`../../test/integration/utils.js`). The several-sources native-CLI helpers
are **vendored** into this folder (above) so the benchmark is self-contained.
