# LLM Performance Benchmarks

Full-factorial parameter sweep for `@qvac/llm-llamacpp`, measuring TTFT, TPS, and quality across quantizations, devices, context sizes, batch sizes, and cache configurations.

## Table of Contents

- [Addon Source](#addon-source)
- [Setup](#setup)
- [Quick Start](#quick-start)
- [CI Workflow (GitHub Actions)](#ci-workflow-github-actions)
- [Sweep Flags](#sweep-flags)
- [Prompt Cases](#prompt-cases)
- [Judge Pass](#judge-pass)
- [Resumability](#resumability)
- [Results](#results)
- [Script Reference](#script-reference)

## Addon Source

| Source | When to Use | Flag |
|--------|-------------|------|
| **Local build** (default) | Development, testing local changes | `--addon-source local` |
| **Published npm** | CI/CD, release verification | `--addon-source npm` |

```bash
# Install published package first when using npm source
npm install --workspaces=false @qvac/llm-llamacpp@latest
npm run run:param-sweep -- --addon-source npm
```

## Setup

```bash
cd packages/llm-llamacpp/benchmarks/performance
npm install
```

## Quick Start

```bash
# Full sweep (downloads models, runs all cases)
npm run run:param-sweep
```

### Common Examples

**Targeted debug run**
```bash
npm run run:param-sweep -- --models "qwen3-1.7b" --repeats 1 --debug
```

**Restrict sweep dimensions**
```bash
npm run run:param-sweep -- \
  --quantization=Q8_0,F16 \
  --device=gpu \
  --threads=4 \
  --batch-size=512
```

**Run judge pass after sweep**
```bash
npm run run:judge
```

## CI Workflow (GitHub Actions)

Everything above runs locally. To run the benchmark on CI runners + AWS Device
Farm (desktop **and** mobile), use the **Benchmark Performance — LLM Parameter
Sweep** workflow (`.github/workflows/benchmark-perf-llm-llamacpp.yml`).

Trigger it from the GitHub UI: **Actions → Benchmark Performance — LLM Parameter
Sweep → Run workflow**. There is nothing to configure for a normal run — the
matrix (models, quantizations, reasoning-budget, KV-cache types, repeats) is
fixed in the scripts; edit those to change what runs.

The **mobile** sweep runs one Device Farm session per
`(size, quant, KV-cache)` combination, plus a small additive batch group
(`size x batch` at a fixed `Q4_0` / `f16` baseline) that sweeps `batch-size`
without crossing it into the full matrix — batch is orthogonal to quant and
KV-cache, so it is measured once rather than replicated across every cell. Those
combinations live in a single source of truth,
`test/integration/_benchmark-matrix.js`. The per-combination test files
(`test/integration/benchmark-perf-*.test.js`) and the workflow's mobile
`test_groups` are derived from it and the shard files are **not committed** —
regenerate them with `npm run generate:benchmark-shards` (the CI mobile job does
this automatically before the Device Farm bundle is built, and fails hard if any
shard is missing). To change the mobile grid, edit `_benchmark-matrix.js`, run
`npm run generate:benchmark-shards` and `npm run test:mobile:generate`, then
update the workflow groups from
`node scripts/generate-benchmark-shards.js --groups` and commit
`integration.auto.cjs`. `npm run verify:benchmark-shards` checks they are all in
sync.

### Inputs

| Input | Default | Purpose |
|-------|---------|---------|
| `ref` | launch branch | Branch/tag/SHA of the benchmark code + addon to build and run |
| `run_desktop` | `true` | Run the desktop sweep (Linux GPU runner) |
| `run_mobile` | `true` | Run the mobile sweep (Android + iOS via Device Farm) |
| `summarize_only` | `false` | Re-render a previous run's report in ~1 min, skipping the ~6 h benchmarks. Needs `artifact_run_id` |
| `artifact_run_id` | — | Previous run ID to re-render (the number in that run's URL). Only with `summarize_only` |
| `compare_run_id` | — | Baseline run ID to diff against — adds Δ TTFT / TPS / ppTPS columns |

Run IDs are the number in a run's URL (`.../actions/runs/<run_id>`). You never
supply a run ID for a fresh run — leave them blank.

### Recipes

| Goal | Inputs |
|------|--------|
| Fresh full benchmark (desktop + mobile) | *(all blank)* |
| Desktop only | `run_mobile = false` |
| Mobile only | `run_desktop = false` |
| Benchmark a specific code version | `ref = <branch/tag/SHA>` |
| Re-render a finished run's report | `summarize_only = true`, `artifact_run_id = <run>` |
| Compare two runs (regression check) | `summarize_only = true`, `artifact_run_id = <new run>`, `compare_run_id = <baseline run>` |
| Fresh run that also diffs vs a baseline | `compare_run_id = <baseline run>` |

The comparison downloads both runs' artifacts and prints a `Δ` for every
metric, e.g. `122.37 ± 0.62 | -0.52` (current value ± stddev, then the delta vs
baseline). It works against **any** two runs.

### What the report contains

Rendered into the run summary of the `summarize` job and uploaded as the
`qwen35-benchmark-findings-<n>` artifact. One table per device, identical shape
for desktop and mobile:

- **Header** — addon version, prompt size, repeats per config (e.g.
  `desktop=5, mobile=3`). The version is recorded into the run's artifacts at
  benchmark time, so it is always the version that actually ran and a
  comparison auto-reads each run's own version (nothing to type, nothing to get
  wrong).
- **Columns** — `TTFT (ms) | TPS | ppTPS | Tokens`, each as `mean ± stddev`
  across the repeats (plus `Δ` columns when comparing).
- **Desktop device** — shows the detected GPU (e.g. `Desktop (NVIDIA RTX …)`),
  preserved on re-renders.
- **`Crashed`** — a configuration that crashed or produced no output on that
  device (e.g. quantized KV cache on Adreno GPUs).
- **Best configuration per device** — highest TPS and highest ppTPS.

> Note: the table shape is identical across desktop and mobile, but the
> generation length differs — desktop caps at `n-predict` 1024 tokens, mobile
> at 512. The rate metrics (TPS, ppTPS) stay comparable; the `Tokens` column
> and absolute TTFT reflect those different caps.

## Choosing what to sweep (`--sweep-params`)

**Optional. Omit it and everything is swept, exactly as before** — the default
CI dispatch is unchanged.

When you only care about some parameters, name them and the rest pin to a
single value, so the run costs only the axes it is about:

```bash
# Sweep quantization across its full configured range; pin everything else.
npm run run:param-sweep -- --sweep-params="quantization"

# Two params, both full range.
npm run run:param-sweep -- --sweep-params="quantization,cache-type-k"

# Pick the values too: params separate with "," and values with "|".
npm run run:param-sweep -- --sweep-params="quantization=Q4_0|Q8_0"

# Mix: pinned values for one, full range for the other.
npm run run:param-sweep -- --sweep-params="quantization=Q4_0|Q8_0,cache-type-k"

# Load modes only — skips the ~6h grid entirely.
node ./load-mode-sweep.js --sweep-params="load-mode=auto|mmap"
```

### Naming a grid axis alongside `load-mode` applies to both

```bash
# 2 modes x 2 quantizations = 4 load-mode cells, AND the quantization grid.
--sweep-params="load-mode=auto|mmap,quantization=Q4_0|Q8_0"

# A bare name means every quantization the model has.
--sweep-params="load-mode=auto|mmap,quantization"
```

`quantization`, `device` and `ctx-size` narrow the load-mode sweep the same way
they narrow the grid. This matters because the reason `load_mode` stays out of
the main grid covers the *ratio* between modes, not the absolute cost: load
time and residency both scale with artifact bytes, so whether the
mapped-vs-anonymous gap holds at a larger quantization is a real question the
sweep should answer without a code edit.

**Desktop and mobile have different catalogues, and the selector says so.**
The desktop runner builds its cells at run time from whatever model files are
present, so `quantization` there means any quantization you have. Mobile runs
pre-generated Device Farm shards, and the matrix defines load-mode shards at
`Q4_0`/`f16` only — so `--sweep-params="load-mode,quantization=Q8_0"` fails
with *"No mobile benchmark cases match this selection"* rather than silently
falling back to `Q4_0` or inventing a shard family. Add the shards to
`test/integration/_benchmark-matrix.js` if you need them.

An axis a shard runs *internally* cannot narrow it and is rejected rather than
ignored. A mobile grid shard sweeps both backends and both reasoning budgets
in one session, so `device=gpu` or `threads=8` would have returned all 70
shards while looking filtered; both now fail with the reason.

What stays additive is the relationship to the **70-cell main grid**:
`load-mode` and `batch-sweep` each run as their own sweep rather than being
crossed into it, so cost is bounded by what you asked for instead of
multiplying the whole matrix. That is the PR #3300 precedent, and it is why
`--sweep-params="load-mode,quantization"` gives you the grid plus a
quantization-swept load-mode sweep — not 70 cells × 6 modes.

Two separators, deliberately: `,` between params and `|` between values. With
commas on both sides `a=1,2,b` is ambiguous — there is no way to tell a second
value from a second param. `|` is safe for every value the sweep accepts,
including `mmap+mlock`.

| Param | Sweeps |
|-------|--------|
| `quantization` | GGUF quantization levels |
| `device` | `gpu` / `cpu` |
| `ctx-size` | context sizes |
| `threads` | thread counts |
| `batch-size`, `ubatch-size` | batch / micro-batch sizes |
| `flash-attn` | flash attention on/off |
| `cache-type-k`, `cache-type-v` | KV-cache types |
| `reasoning-budget` | reasoning budget |
| `load-mode` | the additive load-mode sweep (`load-mode-sweep.js`) — load time and resident memory per `load_mode`, not throughput |

A param that is named but unknown fails the run rather than being ignored, so
a typo cannot silently sweep nothing. Naming only `load-mode` skips the
parameter grid; naming only grid params skips the load-mode sweep.

In CI this is the single `sweep_params` input on
**Benchmark Performance — LLM Parameter Sweep**; the same string, same syntax.
Note that a narrowed load-mode run cannot satisfy QVAC-25043's acceptance
criteria — the report marks the modes you left out as coverage gaps rather than
pretending they passed.

## Sweep Flags

Individual dimensions can also be overridden directly. Prefer `--sweep-params`
above for choosing what to vary; these remain for pinning a specific value.

All sweep dimensions accept comma-separated values for full-factorial grid.

Defaults below are the focused set currently pinned in
`llm-parameter-sweep.config.js` (`PARAMETER_SWEEP`). Pass a flag with
comma-separated values to widen any dimension into the full grid.

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--models` | `str` | All in manifest | Comma-separated model IDs |
| `--quantization` | `str` | `Q4_0,Q4_1,Q4_K_M,Q6_K,Q8_0` | Quantization levels |
| `--reasoning-budget` | `str` | `-1,0` | Reasoning budget values |
| `--device` | `str` | `gpu` (desktop) | `gpu`, `cpu` |
| `--ctx-size` | `str` | `2048` | Context sizes |
| `--batch-size` | `str` | `512` | Batch sizes |
| `--ubatch-size` | `str` | `512` | Micro-batch sizes (must be <= batch-size) |
| `--threads` | `str` | `4` | Thread counts |
| `--flash-attn` | `str` | `off` | Flash attention |
| `--cache-type-k` | `str` | `f16` | KV cache key type |
| `--cache-type-v` | `str` | `f16` | KV cache value type |
| `--repeats` | `int` | `5` | Repeats per case |
| `--results-dir` | `str` | `results/parameter-sweep/` | Output directory |
| `--prompts-file` | `str` | `test-prompts.json` | Prompts file path |
| `--addon-source` | `str` | `local` | `local` or `npm` |
| `--debug` | flag | - | Verbose logging |

## Prompt Cases

The main grid runs the `long` prompt case (the focused ~512-token benchmark
prompt) — `PROMPT_CASES = ['long']` in `case-runner.js`. The additive batch
sweep (`BATCH_SWEEP` in `llm-parameter-sweep.config.js`) runs the `ctx-filling`
case at `ctx-size` 8192 instead: `batch-size` only affects prefill throughput
when the prompt is at least batch-length, so a single fixed ~7k-token prompt is
used across all batch sizes to keep `ppTPS` directly comparable. The `span-fill`
fixture still exists in `test-prompts.json` and can be enabled by tagging cases
with it.

The desktop batch sweep holds `Q4_K_M` / `f16` and the mobile batch sweep holds
`Q4_0` / `f16`. Because the batch-scaling curve is invariant across
quantization, the specific baseline quant is arbitrary and the two are not meant
to be compared at an equal quant — each measures its own device's batch curve.

| Case | Description | Prompt Selection |
|------|-------------|-----------------|
| `long` | Long-output generation (main grid) | Static `long` prompt |
| `ctx-filling` | Maximizes context fill (batch sweep) | `ctx-filling__ctx={ctx-size}` |
| `span-fill` | Spans multiple prefill batches | `batch-spanning__ctx={ctx-size}__bs={batch-size}` |

Prompts are static fixtures in `test-prompts.json`. To regenerate after changing prompt tooling:

```bash
npm run prepare:prompts
npm run verify:prompts
```

## Judge Pass

Semantic quality scoring runs separately from the timed sweep to avoid benchmark distortion.

```bash
npm run run:judge
```

| Flag | Default | Description |
|------|---------|-------------|
| `--input` | Latest sweep JSONL | Input file |
| `--output` | `<input>.judged.jsonl` | Output file |
| `--judge-model` | Default from manifest | Model ID for judging |
| `--judge-device` | `gpu` | Device for judge model |
| `--force` | - | Rescore all (ignore existing scores) |
| `--debug` | - | Verbose logging |

## Resumability

The sweep saves progress after each completed case. On interruption:

```bash
# Just re-run — resumes from last completed case
npm run run:param-sweep

# Force fresh start
rm -f ./results/parameter-sweep/llm-parameter-sweep.progress.json
npm run run:param-sweep
```

## Results

Output in `results/parameter-sweep/`:

```
results/parameter-sweep/
├── llm-parameter-sweep-{timestamp}.json      # Full report
├── llm-parameter-sweep-{timestamp}.jsonl     # Per-case records
├── llm-parameter-sweep-{timestamp}.md        # Markdown summary
└── llm-parameter-sweep.progress.json         # Resume checkpoint
```

### Metrics

| Metric | Description |
|--------|-------------|
| `ttftMs` | Time to first token |
| `tps` | Tokens per second |
| `runMs` | End-to-end inference time (excluding load/unload) |
| `loadMs` / `unloadMs` | Model lifecycle time (per case) |
| `promptTokens` / `generatedTokens` | Token counts |
| `qualityMatch` | Exact-match vs baseline (1.0 or 0.0) |
| `qualityJudge` | Semantic agreement score [0, 1] (from judge pass) |

Timing metrics report mean and population standard deviation across repeats. Token counts are from the first successful run.

### Status Values

| Status | Meaning |
|--------|---------|
| `ok` | All repeats succeeded |
| `partial-failure` | Some repeats failed |
| `failed` | All repeats or case setup failed |

## Script Reference

| Script | Description |
|--------|-------------|
| `npm run prepare:models:addon` | Download GGUF models from manifest |
| `npm run prepare:prompts` | Generate static prompt variants |
| `npm run verify:prompts` | Validate prompt token budgets |
| `npm run run:param-sweep` | Run full parameter sweep |
| `npm run run:judge` | Run semantic judge pass |

## Runtime Defaults

Baseline settings from `llm-parameter-sweep.config.js`:

| Setting | Value | Note |
|---------|-------|------|
| `ctx-size` | 2048 | |
| `n-predict` | 1024 | Long-output capped generation |
| `temp` | 0.1 | Low for reproducibility (addon default: 0.8) |
| `seed` | 42 | Deterministic (addon default: -1) |
| `device` | gpu | |

Model list and quantization files come from `models.manifest.json`.
