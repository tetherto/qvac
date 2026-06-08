# VLM Matrix Benchmark

A cross-platform **quality + speed** benchmark for vision-language inference with
`@qvac/llm-llamacpp`. It runs one frozen, open-licensed image fixture through the
addon (and, on Linux, the native `llama-mtmd-cli` engines) on **Linux CPU/GPU** and
**Samsung S25 (AWS Device Farm)**, and renders a single consolidated report.

**How it works.** The harness (`vlm-matrix.test.js` → `harness.cjs`) loads a model,
runs every fixture sample, and prints `[VLMROW]` / `[VLMSEG]` / `[VLMMETA]` markers to
the log. CI collects the logs from each platform and `aggregate.js`
parses the markers, scores them, and writes a Markdown report to the workflow **step
summary**, a **PR comment**, and an artifact. The *same* harness runs on Linux and
on-device, so platforms are directly comparable.

Everything ships from **this one directory** (`packages/llm-llamacpp/benchmarks/vlm-benchmark/`).
The Linux legs run the files in place; the mobile build first runs `stage.cjs`, which copies
the entry + harness + config + fixture into `test/integration/` and the images into
`test/mobile/testAssets/` (both git-ignored) so the mobile test generator and app bundler
pick them up. The `../../`-relative requires resolve identically from either location.

Triggered from the **Benchmark (LLM)** workflow (`.github/workflows/benchmark-llm-llamacpp.yml`)
→ *Run workflow* → set `run_matrix = true`.

---

## Two modes

| | **two-models** | **several-sources** |
|---|---|---|
| Varies | the **model** blob (base vs candidate mmproj) | the **engine** |
| Fixed | the engine (default `addon`) | the model (Qwen3.5 + q8 mmproj) |
| Compares | e.g. `mmproj-F16` vs `mmproj-Q8` | `addon` vs `fabric-cli` vs `upstream-cli` |
| Platforms | **Linux CPU/GPU + S25 CPU/GPU** | **Linux CPU/GPU only** (CLIs are native binaries) |
| Headline metric | mmproj vision-encode time (Q8 vs F16) | per-engine quality + encode/TTFT |

---

## Configure

Everything lives in **`config.cjs`** (staged to the device by `stage.cjs`, so it
configures both legs). It defines the model catalog, the mode settings, and named
**presets** that bundle the run knobs.

**Dispatch inputs** (workflow): `matrix_mode` (`two-models` | `several-sources`),
`matrix_preset` (`compare` | `full` | `smoke` | `sources`), `matrix_engine`
(`addon` | `fabric-cli` | `upstream-cli`), `matrix_linux` (`linux-cpu,linux-gpu`),
`matrix_samples` (override samples/task; empty = preset default), `run_matrix_s25` (true/false).

**Presets** (in the config):

| preset | mode | what it runs |
|---|---|---|
| `compare` | two-models | Qwen3.5 f16 vs q8 mmproj · 5 tasks × 3 samples (default) |
| `full` | two-models | all model·mmproj cells × all tasks |
| `smoke` | two-models | 1 cell / 1 task / 1 sample (wiring check) |
| `sources` | several-sources | Qwen3.5 q8 across addon + fabric-cli + upstream-cli |

**Run knobs** (preset fields, each overridable by env on Linux):
`samplesPerTask` (`QVAC_VLM_SAMPLES`), `repeats` — runs per sample, mean reported
(`QVAC_VLM_REPEATS`, default 3 desktop / 1 mobile), `devices` (`QVAC_VLM_DEVICES`,
`NO_GPU`), `tasks` (`QVAC_VLM_TASKS`).

**Model sources.** Each model blob carries a `source` descriptor — `hf` (pinned
HuggingFace), `url`, `s3` (presigned URL), or a `registry` annotation (published QVAC
registry entry, fetched from its canonical pinned URL). See `resolveBlob()` in
`harness.cjs`.

**Add tasks / refresh images.** `node build-fixture.cjs --per-task 3
--max-side 1024` — iterates the HuggingFace datasets-server, **filters on resolution
without downloading**, keeps only open-licensed datasets (allowlist), writes images to
`./images/`, regenerates `fixture.data.cjs`, and updates
`fixture.NOTICE.md` (per-image attribution). Adding a task = one manifest entry.

**Add platforms.** The Linux legs are token-driven (`matrix_linux` → runner map in the
`context` job); add a case there. Mobile reuses `integration-mobile-test-llm-llamacpp.yml`.

---

## Metrics

**Quality** — one lmms-eval-style metric per task (equal-weight mean = "Overall %"):

| metric | tasks | how |
|---|---|---|
| `vqa` | textvqa, vizwiz, gqa | normalized exact match vs the answer set (min(1, hits/3)) |
| `anls` | docvqa | Average Normalized Levenshtein Similarity (≥0.5) |
| `relaxed` | (chartqa) | numeric within ±5% or string match |
| `mc` | ai2d | the stated letter (explicit "answer: X" or a short letter-led reply) |

**Speed** — `mmproj` vision-encode ms (the headline for mmproj quant; parsed from
llama.cpp native stderr), TTFT, decode TPS, wall ms.

**Report** = (1) **Highlights** (Quality + Speed at a glance), (2) **Details** (models &
origins with Source, HW/SW provenance, full quality/speed matrices), (3) **Test Results**
(per-platform pass counts), (4) **Image samples** (task → image → W×H).

---

## Known limitations

- **several-sources is Linux-only.** `fabric-cli`/`upstream-cli` are native binaries; the
  S25 path runs an addon app, not arbitrary CLIs.
- **mmproj vision-encode is unavailable on S25.** It comes from llama.cpp's native stderr,
  which Android logcat doesn't capture — the report shows `—` there and uses **TTFT** (which
  includes vision-encode) as the mobile proxy.
- **addon vs CLI prompt parity.** The addon API sends the image as its own `user` turn
  (~+11 tokens) vs the CLIs' single turn, so the *addon-vs-CLI* quality comparison is not
  strictly apples-to-apples. `fabric-cli` vs `upstream-cli` share an identical prompt and
  is the clean engine comparison. (True addon parity needs an addon-side single-turn API.)
- **MC (ai2d).** Only an explicit/short letter answer is scored; a reasoning paragraph with
  no stated choice scores 0 (by design — avoids grabbing a random letter from prose).
- **Registry source on-device.** The P2P registry client isn't bundled into the mobile app;
  registry blobs are fetched via their pinned HTTPS origin (byte-identical) on both legs.
- **Small n.** Defaults are 3 samples × 3 repeats; raise `samplesPerTask` for tighter
  quality estimates (borderline single-sample flips otherwise move the mean).

---

## Files

All in `packages/llm-llamacpp/benchmarks/vlm-benchmark/` unless noted:

| | |
|---|---|
| `config.cjs` | config: modes, presets, model catalog |
| `vlm-matrix.test.js`, `harness.cjs` | harness (addon, emits markers) |
| `aggregate.js` | parses markers → report |
| `cli-fixture-runner.cjs` | runs the fixture through a native CLI (several-sources) |
| `build-fixture.cjs` | open-licensed fixture generator |
| `fixture.data.cjs`, `fixture.NOTICE.md`, `images/` | the frozen fixture + attribution |
| `stage.cjs` | copies the above into `test/integration/` + `testAssets/` for the mobile build |
| `.github/workflows/benchmark-llm-llamacpp.yml` | `run_matrix` jobs (Linux legs, S25, combine) |

**Reused from elsewhere in the package** (not copied): the addon (`../../index.js`),
`ensureModel` (`../../test/integration/utils.js`), and the native CLI helpers
(`../vlm-performance/cli-case-runner.js`, `stdout-parser.js`, `scripts/build-cli-sources.js`).
