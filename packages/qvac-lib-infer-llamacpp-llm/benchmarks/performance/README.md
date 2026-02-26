# LLM Performance Benchmarks

Full-factorial parameter sweep for `@qvac/llm-llamacpp`, measuring TTFT, TPS, and quality across quantizations, devices, context sizes, batch sizes, and cache configurations.

## Table of Contents

- [Addon Source](#addon-source)
- [Setup](#setup)
- [Quick Start](#quick-start)
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
cd packages/qvac-lib-infer-llamacpp-llm/benchmarks/performance
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

## Sweep Flags

All sweep dimensions accept comma-separated values for full-factorial grid.

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--models` | `str` | All in manifest | Comma-separated model IDs |
| `--quantization` | `str` | `Q4_0,Q4_K_M,Q8_0,F16` | Quantization levels |
| `--device` | `str` | `gpu` | `gpu`, `cpu` |
| `--ctx-size` | `str` | `2048` | Context sizes |
| `--batch-size` | `str` | `512,2048` | Batch sizes |
| `--ubatch-size` | `str` | `128,512` | Micro-batch sizes (must be <= batch-size) |
| `--threads` | `str` | `2,4,8` | Thread counts |
| `--flash-attn` | `str` | `off,on` | Flash attention |
| `--cache-type-k` | `str` | `f16,q8_0,q4_0` | KV cache key type |
| `--cache-type-v` | `str` | `f16,q8_0,q4_0` | KV cache value type |
| `--repeats` | `int` | `5` | Repeats per case |
| `--results-dir` | `str` | `results/parameter-sweep/` | Output directory |
| `--prompts-file` | `str` | `test-prompts.json` | Prompts file path |
| `--addon-source` | `str` | `local` | `local` or `npm` |
| `--debug` | flag | - | Verbose logging |

## Prompt Cases

Each parameter combination runs three prompt cases:

| Case | Description | Prompt Selection |
|------|-------------|-----------------|
| `long` | Long-output generation | Static `long` prompt |
| `ctx-filling` | Maximizes context fill | `ctx-filling__ctx={ctx-size}` |
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
