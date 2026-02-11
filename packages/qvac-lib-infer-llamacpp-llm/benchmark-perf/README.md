# LLM Perf Benchmark

This directory contains a side-by-side performance benchmark for:
- QVAC addon (JS, Bare runtime)
- PyTorch baseline (Python)

Both scripts use the same `perf-config.json` so parameters, prompts, and repetitions stay aligned.

## Scripts

- `qvac-perf.js` - runs the QVAC addon benchmark
- `pytorch-perf.py` - runs the PyTorch benchmark
- `judge.js` - optional accuracy scoring (QVAC judge model)
- `analysis/analyze.py` - plots and comparisons

## Usage

```bash
cd packages/qvac-lib-infer-llamacpp-llm

# Valid params:
# quantization,device,ctx_size,no-mmap,threads,batch-size,ubatch-size,
# no-kv-offload,flash-attn,cache-type-k,cache-type-v

# All-in-one runner (macOS/Linux)
./benchmark-perf/run-perf.sh --params device,ctx_size --reps 3 --judge --analyze --addon @qvac/llm-llamacpp

# Quick smoke run (single model, single prompt, reps=1, minimal values per param)
./benchmark-perf/run-perf.sh --quick

# Run with a published addon version
./benchmark-perf/run-perf.sh --addon @qvac/llm-llamacpp@0.8.8

# Optional: Hugging Face token for gated models
./benchmark-perf/run-perf.sh --hf-token "$HF_TOKEN"

# All-in-one runner (Windows)
powershell -ExecutionPolicy Bypass -File ./benchmark-perf/run-perf.ps1 -Params device,ctx_size -Reps 3 -Judge -Analyze -Addon @qvac/llm-llamacpp

# Quick smoke run (single model, single prompt, reps=1, minimal values per param)
powershell -ExecutionPolicy Bypass -File ./benchmark-perf/run-perf.ps1 -Quick

# Run with a published addon version
powershell -ExecutionPolicy Bypass -File ./benchmark-perf/run-perf.ps1 -Addon @qvac/llm-llamacpp@0.8.8

# Optional: Hugging Face token for gated models
powershell -ExecutionPolicy Bypass -File ./benchmark-perf/run-perf.ps1 -HfToken $env:HF_TOKEN

# QVAC perf
bare benchmark-perf/qvac-perf.js --params device,ctx_size --addon @qvac/llm-llamacpp

# PyTorch perf
python3 benchmark-perf/pytorch-perf.py --params device,ctx_size

# Judge results (optional)
bare benchmark-perf/judge.js --input benchmark-perf/results/qvac_*.jsonl

# Analyze
python3 benchmark-perf/analysis/analyze.py --input benchmark-perf/results --output benchmark-perf/analysis/plots
```

### Using `npm run`

When invoking via npm, pass script args after `--`:

```bash
npm run benchmark-perf -- --addon @qvac/llm-llamacpp@0.8.7
```

## Dependencies

Node deps are listed in `benchmark-perf/package.json`:

```bash
npm install --prefix benchmark-perf
```

The runner will also install addon dependencies in `packages/qvac-lib-infer-llamacpp-llm` if missing. If you don't pass `--addon`, ensure local prebuilds exist by running `npm run build`.

Python deps are listed in `benchmark-perf/requirements.txt` and are installed into a venv at `benchmark-perf/.venv` by the runner.

If you use gated models, set `HF_TOKEN` or pass `--hf-token`/`-HfToken`.

Python 3.10+ is required for the PyTorch baseline.

On macOS, the PyTorch baseline only supports `F16` quantization. The runner limits both QVAC and PyTorch to `F16` on macOS to keep comparisons fair; Q4/Q8 should be run on Linux. This aligns with bitsandbytes’ macOS support being CPU-only/experimental (no CUDA GPU quantization). See the bitsandbytes installation guide: https://huggingface.co/docs/bitsandbytes/en/installation

## Analysis

`analysis/analyze.py` reads all JSONL results in `benchmark-perf/results` and produces a set of plots plus CSV summaries that help compare parameters across platforms and implementations.

### What It Produces

- **Per-parameter effect plots**: one plot per metric for each parameter value (TTFT, TPS, load time, unload time, and accuracy if judge results exist). Plots use mean with standard deviation error bars.
- **Prompt throughput plot**: promptTokens/TTFT vs ctx_size, colored by batch-size to show prefill efficiency trends.
- **PCA plots**: dimensionality reduction views over core perf metrics to visualize clustering by parameter values.
- **QVAC vs PyTorch deltas**: side-by-side comparison for TTFT and TPS across identical params.
- **Memory RSS plot**: end-of-run RSS per param value.
- **Composite score plot**: a weighted, normalized score for quick ranking.
- **Best-config summary**: `analysis/plots/best_configs_pareto.csv` with Pareto-optimal configs by platform/arch/backend/impl.
- **Mean/std summary**: `analysis/plots/summary_mean_std.csv` with per-config metric mean and standard deviation.

### How to Read the Plots

- **Per-parameter effects**: Use these to see whether a parameter consistently helps or hurts TTFT/TPS across prompts and devices.
- **Prompt throughput**: Higher promptTokens/TTFT indicates better prefill efficiency; cross-check against memory if values are high.
- **PCA**: Clusters suggest parameter combinations that behave similarly; outliers often indicate unstable settings or unsupported backends.
- **Deltas**: Positive TPS delta means QVAC is faster; negative TTFT delta means QVAC has lower latency.
- **Memory RSS**: Use it to identify configs that improve speed at the cost of memory.

### Best-Config Selection

The best-config summary uses a Pareto front on **TTFT (min)** and **TPS (max)**. This prevents a single metric from dominating. Use the CSV to pick a configuration per platform without hardcoding device logic.

### Composite Score

The score is a weighted, min-max normalized blend of the metrics. Higher is better.
Positive weights mean higher values improve the score; negative weights mean lower values improve the score. Larger magnitudes mean the metric has more influence.

Weights:
- `tps` = +0.30
- `ttftMs` = -0.30
- `promptTokensPerTtft` = +0.10
- `modelLoadMs` = -0.10
- `modelUnloadMs` = -0.05
- `memory_end_rss` = -0.05
- `accuracyScore` = +0.20

## Operational Notes

### Quick Mode
`--quick` reduces runtime by:
- Running one model (baseline model if present)
- Running only the first prompt
- Using one repetition
- Selecting two values per parameter: baseline + first alternative

This is intended to validate end-to-end flow, not to produce final metrics.

### Error Tracking
When a run fails, the JSONL entry includes:
- `errorStage` (e.g., `load`, `run`, `unload`)
- `error` and `errorStack`

This prevents failed runs from being silently ignored or misinterpreted.

### Cleanup Requirements (QVAC)
QVAC must always call `addon.unload()` and `loader.close()` even on errors to
release native handles. Without this, the process can remain alive after
`All QVAC runs completed` and block PyTorch/judge/analysis.

### PyTorch Batch Generation
Transformers `TextStreamer` only supports batch size 1, so batch runs use:
- A forward pass to estimate TTFT
- `model.generate()` per micro-batch to measure generation TPS

This keeps batch-sized tests working while still capturing TTFT + TPS.

## Adding Parameters

Update `perf-config.json`:
- Add the parameter to `params`
- Add baseline default (if needed)

Both scripts will pick up the change automatically.
