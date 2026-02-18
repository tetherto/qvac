# Performance Benchmarks

This directory contains performance benchmark runners for `@qvac/llm-llamacpp`.

## Setup

From `packages/qvac-lib-infer-llamacpp-llm/benchmarks/performance`:

```bash
npm install
```

## Parameter Sweep

Run from `packages/qvac-lib-infer-llamacpp-llm/benchmarks/performance`:

```bash
npm run run:param-sweep
```

This command runs:

1. `prepare-models.js --target addon`
2. Bare benchmark runner (`llm-parameter-sweep.js`)

Prompt generation is standalone. Prompts are static fixtures in `benchmarks/performance/test-prompts.json`.
Prompt content is static at execution time; the runner does not generate or rewrite prompts during the sweep.

## Run Guide (All Common Cases)

### 1) Fresh clone / first-time setup

From repo root:

```bash
cd packages/qvac-lib-infer-llamacpp-llm/benchmarks/performance
npm install
npm run run:param-sweep
```

### 2) Normal repeat run (use committed static prompts)

```bash
cd packages/qvac-lib-infer-llamacpp-llm/benchmarks/performance
npm run run:param-sweep
```

### 3) Run using published npm addon (instead of local build)

```bash
cd packages/qvac-lib-infer-llamacpp-llm/benchmarks/performance
npm install --workspaces=false @qvac/llm-llamacpp@latest
npm run run:param-sweep -- --addon-source npm
```

### 4) Resume after interruption/failure

- Re-run the same command.
- The runner resumes from `benchmarks/performance/results/parameter-sweep/llm-parameter-sweep.progress.json`.

### 5) Force a fresh restart (ignore prior progress)

```bash
cd packages/qvac-lib-infer-llamacpp-llm/benchmarks/performance
rm -f ./results/parameter-sweep/llm-parameter-sweep.progress.json
npm run run:param-sweep
```

### 6) Prompt maintenance (only when prompt tooling/config changed)

Use this when prompt templates/constants, tokenizer behavior, or hardcoded ctx/batch values change.

```bash
cd packages/qvac-lib-infer-llamacpp-llm/benchmarks/performance
npm run prepare:prompts
npm run verify:prompts
```

Then run sweep normally (`npm run run:param-sweep`).

### 7) Targeted/debug runs

```bash
cd packages/qvac-lib-infer-llamacpp-llm/benchmarks/performance
npm run run:param-sweep -- --models "qwen3-1.7b" --repeats 1 --debug
```

### 8) Run semantic judge pass (after sweep)

```bash
cd packages/qvac-lib-infer-llamacpp-llm/benchmarks/performance
npm run run:judge
```

By default this reads the latest sweep JSONL and writes a sibling `*.judged.jsonl` file.
It also reuses existing `qualityJudge` values unless you pass `-- --force`.

Optional judge flags:

- `--results-dir <dir>` (default: parameter-sweep results dir)
- `--input <jsonl-file>` (default: latest sweep jsonl in results dir)
- `--output <jsonl-file>` (default: `<input>.judged.jsonl`)
- `--addon-source local|npm`
- `--judge-model <model-id>`
- `--judge-quantization <quantization>`
- `--judge-device cpu|gpu`
- `--judge-ctx-size <int>`
- `--judge-batch-size <int>`
- `--judge-ubatch-size <int>`
- `--judge-n-predict <int>`
- `--force` (ignore existing `qualityJudge` values and rescore)
- `--debug`

## Addon Source Selection

Addon source is explicit (no automatic fallback). Use:

- `--addon-source local` (default): load local addon from `../../index`
- `--addon-source npm`: load installed `@qvac/llm-llamacpp`

Examples:

```bash
# Local addon (default)
npm run run:param-sweep -- --addon-source local

# npm package addon
npm run run:param-sweep -- --addon-source npm
```

## Optional Sweep Flags

- `--models "qwen3-1.7b,qwen3-4b"`
- `--results-dir ./benchmarks/performance/results/custom`
- `--prompts-file ./my-prompts.json` (must be JSON array of message objects)
- `--repeats 5`
- `--debug`
- Any sweep dimension can be overridden with CSV values, for example:
  - `--quantization=Q8_0,F16`
  - `--device=gpu,cpu`
  - `--threads=2`
  - `--batch-size=4096,8192`
  - `--ubatch-size=512,1024`
  - `--ctx-size=4096`
  - `--flash-attn=off,on`
  - `--cache-type-k=f16,q8_0`
  - `--cache-type-v=f16,q8_0`
  - `--no-mmap=true,false`
  - `--no-kv-offload=true,false`

Example:

```bash
npm run run:param-sweep -- --quantization=Q8_0,F16 --device=gpu,cpu --threads=2 --batch-size=4096,8192
```

Supported sweep override keys:

- `quantization`
- `device`
- `ctx-size`
- `no-mmap`
- `threads`
- `batch-size`
- `ubatch-size`
- `no-kv-offload`
- `flash-attn`
- `cache-type-k`
- `cache-type-v`

## Why Overrides Are Needed

The default LLM sweep is a strict full-factorial grid. With two models, 5 prompts per case, and 5 repeats,
this can exceed 2 million prompt runs on a single invocation. That is intentional for exhaustive validation, but it is too large for most iterative local debugging sessions.

Dimension overrides let you keep full-factorial behavior while shrinking the search space safely:

- Keep only target quantizations (for example `Q8_0,F16`)
- Restrict devices/threads to one or two values
- Focus on large `batch-size` / specific `ctx-size` points
- Keep metric/report shape identical so results remain comparable

The final JSON/JSONL/Markdown reports include the exact `sweep` dimensions used, plus case/run totals.
This makes the run reproducible and auditable even when overrides are applied.

Default output directory:

- `benchmarks/performance/results/parameter-sweep/`

## Runtime Defaults

Baseline/default runtime settings are defined in `llm-parameter-sweep.config.js`:

- `BENCH_DEFAULT_RUNTIME` (global defaults for all models)
- `MODEL_RUNTIME_OVERRIDES` (optional per-model overrides)

Model list and quantization files come from:

- `models.manifest.json`
- `resolved-models.json` (generated by model preparation)

## Script Reference (In This Folder)

- `npm run prepare:models:addon`
- `npm run prepare:models:all`
- `npm run prepare:prompts`
- `npm run verify:prompts`
- `npm run run:param-sweep`
- `npm run run:judge`

## Benchmark Workflow

1. **Model Preparation**: Downloads GGUF models listed in `models.manifest.json` to `benchmarks/performance/models/`
2. **Prompt Generation (standalone)**: Creates static prompts including:
   - Short prompts (~50 tokens)
   - Medium prompts (~200 tokens)
   - Long prompts (~1000 tokens)
   - `ctx-filling__ctx=<ctx-size>` variants (one per hardcoded `ctx-size`)
   - `batch-spanning__ctx=<ctx-size>__bs=<batch-size>` variants (one per hardcoded pair)
3. **Case Prompt Selection**: Runner picks exactly one static fill/span variant per case:
   - Context tests use the matching `ctx-filling__ctx=<ctx-size>` prompt.
   - Batch tests use the matching `batch-spanning__ctx=<ctx-size>__bs=<batch-size>` prompt.
   - If `batch-size > ctx-size`, the prompt is generated as the longest safe prompt under ctx budget (documented in prompt metadata).
4. **Baseline Run**: Runs with default config, saves output for quality comparison
5. **Parameter Sweep**: Runs all parameter combinations (full factorial design)
   - Model is loaded once per case and reused for all prompts and repeats
   - Progress is tracked and can be resumed after crashes (debounced saves)
6. **Quality Check**: Compares each combination's output with exact-match and judge-model scoring
   - Fixed prompts use global baseline outputs
   - Fill/span prompts use per-variant baseline keys so scoring remains valid per exact shape
   - Exact-match (`qualityMatch`) is computed during sweep
   - Judge score (`qualityJudge`) is computed in a separate pass via `npm run run:judge`
7. **Report Generation**: Creates JSON and Markdown reports with performance metrics

## Output Quality Comparison

The benchmark compares outputs using two signals:
- Baseline outputs are saved for each prompt
- Each parameter combination's output is compared with baseline
- `qualityMatch`: 1.0 (exact match) or 0.0 (different)
- `qualityJudge`: model-judged semantic agreement score in [0, 1]

`qualityJudge` is intentionally separated from the timed sweep. This avoids benchmark distortion from extra inference calls, allows a singleton judge runtime with conservative worst-case settings, and makes re-scoring possible without re-running the full parameter grid.
The judge pass is optimized to score only unique `(baseline, candidate)` text pairs and then reuse scores across repeats/cases.

## Prompt Tooling (What/Why/How)

- **What**: `prepare-prompts.js` generates static fill/span prompt variants for all hardcoded sweep values.
- **Why**: Avoid runtime prompt mutation and token-estimation drift; keep sweep deterministic and auditable.
- **How**:
  - Uses the addon runtime tokenizer path (`response.stats.promptTokens`) for token-exact sizing.
  - `ctx-filling` variants target `ctx-size - n_predict_reserve - overhead_reserve`.
  - `batch-spanning` variants target `min(ctx-budget, batch-size*3)`.
  - For impossible span cases (`batch-size > ctx-size`), it intentionally uses the longest safe prompt that still fits context.
  - `verify-prompts.js` re-checks all variants and fails on budget overflow/missing IDs.

## How `targetPromptTokens` Is Derived

All target values are deterministic and come from hardcoded constants in `prepare-prompts.js` / `verify-prompts.js`:

- `CTX_SIZES = [2048, 4096, 8192]`
- `BATCH_SIZES = [512, 2048, 4096, 8192]`
- `N_PREDICT_RESERVE = 256`
- `PROMPT_OVERHEAD_RESERVE = 128`

Formulas:

- `ctxBudget(ctx) = max(256, ctx - N_PREDICT_RESERVE - PROMPT_OVERHEAD_RESERVE)`
- `batchDesired(batch) = max(512, batch * 3)` (aim for multi-batch prefill)
- `batchBudget(ctx, batch) = max(256, min(ctxBudget(ctx), batchDesired(batch)))`

This yields:

- `ctx-filling`
  - `ctx=2048 -> targetPromptTokens=1664`
  - `ctx=4096 -> targetPromptTokens=3712`
  - `ctx=8192 -> targetPromptTokens=7808`
- `batch-spanning`
  - `ctx=2048`: `bs=512 -> 1536`, `bs=2048 -> 1664`, `bs=4096 -> 1664`, `bs=8192 -> 1664`
  - `ctx=4096`: `bs=512 -> 1536`, `bs=2048 -> 3712`, `bs=4096 -> 3712`, `bs=8192 -> 3712`
  - `ctx=8192`: `bs=512 -> 1536`, `bs=2048 -> 6144`, `bs=4096 -> 7808`, `bs=8192 -> 7808`

Why this is safe and accurate:

- Prompt sizing uses the addon's own tokenizer stats (`promptTokens`), not word/token heuristics.
- `prepare-prompts.js` tunes each prompt up to the highest safe value under budget.
- `verify-prompts.js` recomputes budgets with the same formulas and fails if any prompt exceeds budget or is too short for the intended span behavior.
- Final static prompts and metadata in `test-prompts.json` are therefore reproducible and auditable for both baseline and sweep cases.

## Performance Metrics

Per-repeat samples:
- `runMs`, `ttftMs`, `tps`, `promptTokens`, `generatedTokens`, `runtimeMemory.{rssMb,heapUsedMb,externalMb}`
- `loadMs` / `unloadMs` are measured per case (model lifecycle), then attached to each prompt result

Persisted metrics fields (mean/std across repeats):
- `loadMsMean`, `loadMsStd`
- `runMsMean`, `runMsStd`
- `ttftMsMean`, `ttftMsStd`
- `tpsMean`, `tpsStd`
- `unloadMsMean`, `unloadMsStd`
- `promptTokensMean`, `promptTokensStd`
- `generatedTokensMean`, `generatedTokensStd`
- `runtimeMemory.{rssMbMean,rssMbStd,heapUsedMbMean,heapUsedMbStd,externalMbMean,externalMbStd}`

## Reporting Details

- Case-level JSONL records now include:
  - `metrics` with explicit `*Mean` + `*Std` naming for TTFT/TPS/run/load/unload and token/memory fields
  - `promptResults[]` with per-prompt metrics, exact-match scores, prompt-level errors, and raw outputs for judge post-processing
- `npm run run:judge` writes `*.judged.jsonl` with populated per-prompt and per-case `qualityJudge`.
- Final JSON report includes the same per-case information.

## Deferred Work

- **Native/GPU memory telemetry**: current memory metrics are process-level JS memory (`rss`, `heapUsed`, `external`).  
  Addon/C++ side metrics for native allocations and VRAM usage are planned later.
