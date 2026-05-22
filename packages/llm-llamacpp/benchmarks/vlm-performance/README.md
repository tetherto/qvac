# VLM Performance Benchmark

A reproducible measurement of how fast and how correctly a VLM (via LLM Addon)
answers a fixed visual question. The benchmark loads Qwen3.5-VL, asks it
to list the objects in `assets/seven_objects.jpg`, and records both the
inference timings and an object-recall score against a known ground
truth. Output is one row per (source, backend) cell so you can directly
compare an optimization candidate to a baseline addon build.

## What this benchmark currently covers

- **Model**: Qwen3.5-0.8B-Q8_0 (+ `mmproj-F16`). Configurable; other
  Qwen3.5 sizes / quants are addressable through the registry config.
- **Image + task**: one committed image of seven everyday objects,
  prompt `List only short English object names (comma-separated)`,
  deterministic sampling (`temperature=0`, `seed=42`).
- **Reasoning mode toggle**: Qwen3.5's `<think>` chain-of-thought is
  off by default (`reasoning-budget=0`, halves wall time without
  affecting recall on this task). Override with `--thinking=on` /
  workflow input.
- **Metrics**: vision-encode ms, TTFT, decode TPS, prompt-processing
  TPS, wall-clock ms, prompt + generated token counts. Aggregated as
  median (with min/max in raw JSON) across `measured-runs`.
- **Accuracy**: object-recall against the 7-object ground truth. The
  scorer normalises with a plural / synonym whitelist from the config
  and falls back from strict comma-split matching to a word-bounded
  substring search for prose answers. It also strips any
  `<think>...</think>` block so the metric is robust whether reasoning
  mode is on or off.
- **Comparison sources**: `addon@candidate` (your working tree) +
  optional `addon@baseline` (any git ref, or a pre-built addon at an
  arbitrary path). `--skip-baseline` runs candidate-only.
- **Local run**: works end-to-end on the machine you launch it from.
- **CI**: manual-dispatch GitHub Actions workflow that fans out to
  Windows + Linux GitHub-hosted runners and aggregates the per-platform
  outputs into one consolidated report (see "Running in CI").

## What this benchmark does not yet cover

- **Android / Mac / iOS in CI**: the Android leg in the CI workflow is
  a placeholder today; Mac and iOS are not in the matrix at all. The
  on-device test-bundle integration that would make the Android leg
  real is planned next.
- **Self-hosted GPU runners in CI**: today both desktop legs are
  GitHub-hosted (CPU-only). The matrix will extend to
  `qvac-win25-x64-gpu` and `ai-run-linux-gpu` once the CPU path is
  stable.
- **Source-level baseline diff in CI**: today the `compare_baseline`
  input gives you a version-level diff (it installs the
  `@qvac/llm-llamacpp` version pinned at the merge-base commit and
  runs as the baseline). This works when the branch bumped the addon
  version; otherwise the consolidated report shows a warning that
  candidate == baseline. A true source-level compare (building the
  addon at both commits) is planned — it needs the clang-22 + vcpkg
  toolchain orchestration that currently lives in
  `prebuilds-llm-llamacpp.yml`.
- **Accuracy as a gate**: recall is reported but does not fail the run.
  Gating is planned once we trust the metric across models.
- **Additional models and scenarios**: Gemma-4 VL and OCR-heavy
  scenarios are planned as follow-up cells next to this one.
- **External-source comparison**: comparing against `fabric@<commit>`
  or upstream `llama.cpp@<commit>` via `llama-mtmd-cli` is planned.
- **PR-comment automation**: planned alongside in-CI baseline diff.

## Layout

```
vlm-performance/
├── vlm-bench.config.js          # defaults - every field is CLI-overridable
├── prepare-models.js            # node - resolves model files (registry → HF → local)
├── source-resolver.js           # node - picks candidate/baseline sources
├── run-vlm-bench.js             # node - orchestrator
├── case-runner.js               # bare - one (source, backend) cell
├── accuracy.js                  # object-recall scoring
├── stdout-parser.js             # parses vision-encode + eval timings from logs
├── reporters.js                 # markdown + json output per platform
├── math.js
├── utils.js
├── scripts/
│   └── aggregate-platforms.js   # CI - merges per-platform JSONs into one report
├── assets/seven_objects.jpg
└── results/                     # generated - JSON + .md per run
```

The matching GitHub Actions workflow lives at
`.github/workflows/benchmark-vlm-llm-llamacpp.yml`.

---

## Running locally

This is the path an optimization engineer uses while iterating on the
addon — fast turnaround, no PR/CI involvement.

### Local quick start

```bash
cd packages/llm-llamacpp/benchmarks/vlm-performance

# One-time per checkout:
npm install                                            # installs bare runtime + benchmark deps locally
npm run prepare:models                                 # downloads model + mmproj (~1 GB)

# Smoke run - candidate only, single measured iteration, CPU backend.
npm run run:vlm-bench -- --skip-baseline --warmup-runs=0 --measured-runs=1 --backends=cpu

# Full run - defaults (1 warmup + 3 measured), all platform-default backends.
npm run run:vlm-bench -- --skip-baseline
```

Open `results/vlm-perf-<TS>.md` for the matrix and the full model
answer. Raw per-run JSON is at `results/vlm-perf-<TS>.json`; bare's
stdout/stderr per cell is at `results/cell-<N>-stderr.log`.

### Local prerequisites

The benchmark resolves everything it needs from its own `node_modules`,
so the only host-level requirement is the project's standard toolchain
(Node 20+, working npm).

- **Node.js 20+**.
- **npm** with internet access (downloads `bare`, `bare-runtime-*`,
  `@qvac/llm-llamacpp` and its bundled prebuilds).
- **A Hugging Face token** is not required by default; set `HF_TOKEN`
  if you hit rate limits on first download.
- **No global `bare` install required.** A local `bare` is pinned in
  `package.json` and invoked through `./node_modules/bare/bin/bare`.
- **No workspace addon build required.** The npm-published
  `@qvac/llm-llamacpp` ships per-platform prebuilds; the benchmark
  uses those directly.

### Benchmark workflow (local)

The goal is to measure whether your branch makes the addon faster
without making it less correct. Run the benchmark twice — once against
a known-good baseline, once against your branch — and read the delta.

1. **Pick a baseline.** Today the simplest options are:
   - A pre-built addon at a known path. Easiest if you keep a stable
     reference checkout:
     ```bash
     git worktree add ../qvac-baseline <baseline-sha-or-branch>
     (cd ../qvac-baseline/packages/llm-llamacpp && npm install \
         && bare-make generate && bare-make build && bare-make install)
     ```
     Then point the benchmark at it via `--baseline-addon-path`.
   - The npm-published version. Edit `vlm-bench.config.js` so
     `sources.baseline = { type: 'addon', source: 'npm' }` and pin the
     desired version in `package.json` deps.
2. **Measure the baseline.** This gives you the numbers your candidate
   will be compared against:
   ```bash
   npm run run:vlm-bench -- --baseline-addon-path=../../../../../qvac-baseline/packages/llm-llamacpp
   ```
   Look at `results/vlm-perf-<TS>.md` and confirm baseline recall is
   `7/7` and timings look sensible.
3. **Iterate.** Make your changes in
   `packages/llm-llamacpp/addon/`, rebuild the local addon, and re-run
   the same command. The orchestrator runs baseline + candidate
   back-to-back; the `.delta.md` shows the candidate-vs-baseline
   percentages.
4. **Interpret the deltas.** Negative `vis-enc` / `TTFT` / `wall` is a
   win. Positive `TPS` is a win. Recall should stay at `7/7`; a drop
   is a correctness regression and should block the change even if
   speed improved.
5. **For fast iteration**, drop the baseline (`--skip-baseline`) and
   the warmup (`--warmup-runs=0 --measured-runs=1`). You lose
   comparison precision but you turn a ~3-minute run into ~20 seconds.

### Useful CLI flags (full list)

Every field in `vlm-bench.config.js` is overridable on the command line:

| Flag | Default | Effect |
|---|---|---|
| `--skip-baseline` | off | Run candidate only. |
| `--baseline-commit=<sha\|tag\|branch>` | `merge-base` with `main` | Resolve baseline ref. |
| `--baseline-addon-path=<path>` | none | Use a pre-built addon tree as the baseline. |
| `--backends=cpu,gpu` | from `config.platforms[<this host>]` | Override backend list. |
| `--warmup-runs=<n>` | `1` | Discarded warmup iterations. |
| `--measured-runs=<n>` | `3` | Counted iterations; reported as median. |
| `--cooldown-ms=<ms>` | `5000` | Sleep between iterations. |
| `--thinking=on\|off` (or `--enable-thinking` / `--disable-thinking`) | off | Toggle the model's `<think>` reasoning block via the addon's `reasoning-budget` config (`0` = off, `-1` = unrestricted). Reasoning roughly doubles wall time for the same final answer. |
| `--local-model=<path>` | none | Skip download; use existing file. |
| `--local-mmproj=<path>` | none | Same, for mmproj. |
| `--results-dir=<path>` | `./results` | Output directory. |
| `--force-prepare` | off | Re-run prepare-models even if cached. |

Model resolution order in `prepare-models.js`:
1. `--local-model` / `--local-mmproj` (path on disk).
2. Registry server (when `QVAC_REGISTRY_URL` is set — used by CI).
3. Hugging Face URL pinned to a specific revision (default).

### Troubleshooting locally

- **Cell shows `FAIL: spawn`.** Open the linked
  `results/cell-<N>-stderr.log`. Common causes: addon dependency
  missing, model file not found, OS-level OOM.
- **Recall is `0/7` but the model clearly named the objects.** The
  answer may have been truncated. Bump `reporting.answerTruncChars` in
  the config and re-run.
- **Vision-encode column is blank.** `image slice encoded in N ms` is
  emitted once per addon load. If your `measured-runs` count is high
  and warmups bury the marker, raise the bash log file's window or
  inspect `cell-<N>-stderr.log` directly.
- **Run is slow on a GPU machine but you used `--backends=cpu`.** Pass
  `--backends=gpu` explicitly; the default backend list is per-platform.

---

## Running in CI

The benchmark runs as the **Benchmark VLM (LLM)** GitHub Actions
workflow (file: `.github/workflows/benchmark-vlm-llm-llamacpp.yml`).
This is the path for evaluating an optimization branch on a set of
platforms in one shot, without setting up each machine locally.

### CI quick start

1. Push your branch to the repo.
2. GitHub → **Actions** → **Benchmark VLM (LLM)** → **Run workflow**.
3. Fill in the inputs (all have defaults — see below).
4. Wait for the run to finish (~10–25 minutes on GitHub-hosted
   runners).
5. Open the **vlm-perf-consolidated-<run-number>** artifact for the
   cross-platform Markdown report, or scroll to the workflow run's
   **Summary** tab — the same table is posted as a step summary.
   Per-platform raw outputs (JSON + per-cell logs) are uploaded as
   separate `vlm-perf-<platform>-<run-number>` artifacts.

### What runs by default

| Platform | Runner | Backend | Status |
|---|---|---|---|
| Windows | GitHub-hosted `windows-latest` | CPU | Runs the full benchmark |
| Linux | GitHub-hosted `ubuntu-latest` | CPU | Runs the full benchmark |
| Android | (stub, off by default) | — | An earlier iteration reused `integration-mobile-test-llm-llamacpp.yml` in perf-only mode, but that workflow is built for breadth (Android + iOS matrix, many Device-Farm sessions covering tests we don't need) — one invocation took ~20 min. The Android job is now a placeholder so the workflow shape covers Android; a leaner mobile path is planned. For Android perf numbers right now, manually launch `Benchmark Performance (LLM)` (`benchmark-performance-infer-llm-llamacpp.yml`). |

### Workflow inputs

| Input | Default | Effect |
|---|---|---|
| `ref` | current branch | Git ref (branch / tag / SHA) to benchmark. |
| `warmup_runs` | `1` | Discarded warmup iterations per cell. |
| `measured_runs` | `3` | Counted iterations per cell; reported as median. |
| `thinking` | `off` | Toggle Qwen3.5's `<think>` reasoning block (`on` doubles wall time but produces a chain-of-thought trace). |
| `run_windows` | `true` | Include the Windows leg. |
| `run_linux` | `true` | Include the Linux leg. |
| `run_android` | `false` | Include the Android job (today this just emits a placeholder marker — see "What runs by default"). |
| `compare_baseline` | `false` | Compare branch HEAD against the merge-base with `main`. When on, each desktop leg also runs the npm-published `@qvac/llm-llamacpp` pinned in `packages/llm-llamacpp/package.json` at the merge-base commit, and the consolidated report includes a verdict table (better / worse / same per metric, ±2% noise band). Adds ~30 s per leg. |

### Benchmark  workflow (CI)

1. **Push your branch.** Make sure the commit is on the remote.
2. **Launch the workflow.** Defaults are tuned for a quick first-pass
   read: 1 warmup + 3 measured runs, thinking off, all three platforms
   on.
3. **Wait.** Roughly 10–25 min on GitHub-hosted runners. The Windows
   leg is usually the slowest.
4. **Open the consolidated report.** Each row is one
   `(platform, backend, source)` cell with vis-enc / TTFT / TPS /
   wall / recall.
5. **Decide.** Recall must stay at `7/7` — that's the correctness
   floor. Compare speed columns against a previous CI run on the same
   ref (download both artifacts) until in-CI baseline diffing lands.

### CI troubleshooting

- **A desktop leg failed at `Run VLM benchmark`.** Download the
  matching `vlm-perf-<platform>-<run>` artifact and read
  `cell-<N>-stderr.log` — same diagnostic flow as local.
- **Aggregator says "No per-platform reports were found".** All
  desktop legs failed before producing JSON. Look at the individual
  job logs for the underlying error.
- **Run is much slower than expected.** GitHub-hosted runners can vary
  widely under load; rerun if a single number looks like an outlier.
  Self-hosted GPU runners (planned next) will fix this.

---

## Planned features

- **Real Android leg in CI**: wire the benchmark into the mobile test
  bundle so it runs on AWS Device Farm next to the existing image perf
  tests.
- **Mac and iOS legs in CI**.
- **Self-hosted GPU legs in CI** (`qvac-win25-x64-gpu`,
  `ai-run-linux-gpu`).
- **In-CI baseline diff**: auto-build the merge-base commit (or pull
  cached prebuilds) and run candidate + baseline back-to-back on each
  runner, emitting a delta table in the same artifact.
- **PR-comment automation**: post the consolidated delta summary on
  the originating PR when the workflow is triggered with
  `ref=<branch>`.
- **Accuracy as a soft regression gate** once cross-model behaviour is
  understood.
- **Additional cells**: Gemma-4 VL, OCR-heavy scenarios.
- **External-source comparison**: `fabric@<commit>` and upstream
  `llama.cpp@<commit>` via `llama-mtmd-cli` invocations alongside the
  addon path.
- **Per-run interleaving and nominal-temperature gating** for runs
  longer than the existing cool-down can absorb.
