# LLM Perf Benchmark

This directory contains a side-by-side performance benchmark for:
- QVAC addon (JS, Bare runtime)
- PyTorch baseline (Python)

Both scripts use the same `perf-config.json` so parameters, prompts, and repetitions stay aligned.

## Critical Implementation Differences

**Before running the benchmark, understand these fundamental differences:**

1. **Memory Mapping**: llama.cpp defaults to mmap (lazy loading), PyTorch always does full load. There's no true equivalent - see [Memory Mapping (mmap)](#memory-mapping-mmap) section under Platform Limitations.

2. **Batch Semantics**: `batch-size`/`ubatch-size` in QVAC control token batching for a single prompt (prefill chunking), not batch inference. PyTorch maps these to prefill chunk sizes - see [Batch-Size Comparability](#batch-size-comparability-qvac-vs-pytorch).

3. **Platform Limitations**: 
   - **macOS MPS**: Doesn't support bitsandbytes quantization or Flash Attention 2. Both are silently skipped or blocked.
   - **Linux/Windows CUDA**: Full support for all quantization types and Flash Attention 2.
   - See [Platform Limitations](#platform-limitations) for details.

4. **KV Cache Quantization**: Now supported in both via `QuantizedCache` (PyTorch) and llama.cpp's native support. Requires matching `cache-type-k` and `cache-type-v` - see [KV Cache Quantization (QVAC + PyTorch)](#kv-cache-quantization-qvac-pytorch).

5. **Generation Timing**: PyTorch uses a two-phase approach for batch runs (TTFT estimation + generation loop) because `TextStreamer` only supports batch size 1 - see [PyTorch Generation Timing](#pytorch-generation-timing).

**Platform Detection**: The benchmark automatically detects the platform (macOS/Linux/Windows) and available GPU backends (MPS/CUDA) at runtime using `os.uname()` and PyTorch's backend availability checks. **No hardcoded platform checks** - it will work seamlessly on:
- **Linux with NVIDIA GPU (CUDA)**: Full quantization support (Q4/Q8), Flash Attention 2, all features enabled
- **macOS with Apple Silicon (MPS)**: Limited to F16 quantization, Flash Attention skipped, MPS device mapping
- **Windows with NVIDIA GPU (CUDA)**: Full quantization support (Q4/Q8), Flash Attention 2, all features enabled
- **CPU-only on any platform**: FP32/FP16 only, no bitsandbytes quantization, no Flash Attention

**Verification**: The code uses runtime checks (`torch.cuda.is_available()`, `torch.backends.mps.is_available()`, `os.uname().sysname`) rather than compile-time platform detection. On Linux, it will:
1. Detect platform as "linux" (not "darwin")
2. Skip MPS check (returns False)
3. Use CUDA device mapping when CUDA is available
4. Enable all quantization types (no macOS restriction)
5. Enable Flash Attention 2 when `flash-attn` package is installed

## Scripts

- `qvac-perf.js` - runs the QVAC addon benchmark
- `pytorch-perf.py` - runs the PyTorch benchmark
- `judge.js` - optional accuracy scoring (QVAC judge model)
- `analysis/analyze.py` - plots and comparisons

## Usage

### Two Benchmark Modes

**1. QVAC-Only Mode (Default)** - Primary goal: Find optimal QVAC configurations
- Explores full parameter space without PyTorch constraints
- Allows all quantizations QVAC supports (Q4_0, Q4_K_M, Q8_0, F16) on all platforms
- Allows different `cache-type-k` and `cache-type-v` values
- No `ubatch-size <= batch-size` constraint enforcement
- **Use this to find the best QVAC configuration for each device**

**2. Comparison Mode (`--compare`)** - Secondary goal: Compare with PyTorch
- Applies PyTorch-compatible constraints to QVAC runs
- Limits macOS to `F16` only (matches PyTorch's MPS limitation)
- Syncs `cache-type-k` and `cache-type-v` (PyTorch requires matching)
- Caps `ubatch-size` to `batch-size` when sweeping `batch-size`
- Runs both QVAC and PyTorch for side-by-side comparison
- **Use this only when you need to benchmark against PyTorch**

```bash
cd packages/qvac-lib-infer-llamacpp-llm

# Valid params:
# quantization,device,ctx_size,no-mmap,threads,batch-size,ubatch-size,
# no-kv-offload,flash-attn,cache-type-k,cache-type-v

# QVAC-only mode (default): Full parameter exploration
./benchmark-perf/run-perf.sh --params device,ctx_size --reps 3 --judge --analyze --addon @qvac/llm-llamacpp

# Comparison mode: Run both QVAC and PyTorch with compatible constraints
./benchmark-perf/run-perf.sh --compare --params device,ctx_size --reps 3 --judge --analyze --addon @qvac/llm-llamacpp

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

# QVAC perf (standalone, no constraints)
bare benchmark-perf/qvac-perf.js --params device,ctx_size --addon @qvac/llm-llamacpp

# QVAC perf in comparison mode (applies PyTorch constraints)
bare benchmark-perf/qvac-perf.js --compare --params device,ctx_size --addon @qvac/llm-llamacpp

# PyTorch perf (only runs in comparison mode via run-perf.sh --compare)
python3 benchmark-perf/pytorch-perf.py --params device,ctx_size

# Judge results (optional) - works for both QVAC-only and comparison modes
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

KV cache quantization in the PyTorch baseline uses the `quanto` backend, which is included in `benchmark-perf/requirements.txt`.
Transformers `QuantizedCache` support requires `transformers>=5.1.0`.

### QVAC-Only vs Comparison Mode

**QVAC-Only Mode (Default)**:
- Explores full parameter space without PyTorch constraints
- Allows all quantizations QVAC supports (Q4_0, Q4_K_M, Q8_0, F16) on all platforms
- Allows different `cache-type-k` and `cache-type-v` values (QVAC/llama.cpp supports this)
- No `ubatch-size <= batch-size` constraint enforcement
- **Goal**: Find optimal QVAC configurations per device

**Comparison Mode (`--compare`)**:
- Applies PyTorch-compatible constraints to QVAC runs
- Limits macOS to `F16` only (matches PyTorch's MPS limitation)
- Syncs `cache-type-k` and `cache-type-v` (PyTorch's QuantizedCache requires matching)
- Caps `ubatch-size` to `batch-size` when sweeping `batch-size`
- Runs both QVAC and PyTorch for side-by-side comparison
- **Goal**: Fair comparison between QVAC and PyTorch

On macOS, the PyTorch baseline only supports `F16` quantization. In comparison mode, the runner limits both QVAC and PyTorch to `F16` on macOS to keep comparisons fair; Q4/Q8 should be run on Linux. This is because:

- **MPS (Metal Performance Shaders)** on macOS natively supports FP16 and FP32, but **not** bitsandbytes 4/8-bit quantization
- Bitsandbytes quantization on macOS falls back to CPU (very slow) and is experimental
- **QVAC (llama.cpp)** can run Q4/Q8 on macOS GPU via GGUF, but we cap it to F16 to match PyTorch's limitation for fair comparison

For quantized model testing on macOS, use MLX or GGUF directly (outside this benchmark). See the bitsandbytes installation guide: https://huggingface.co/docs/bitsandbytes/en/installation

## Analysis

`analysis/analyze.py` reads all JSONL results in `benchmark-perf/results` and produces a set of plots plus CSV summaries that help compare parameters across platforms and implementations.

**Works for both modes:**
- **QVAC-only mode**: All plots work correctly. `plot_qvac_vs_torch()` gracefully skips if PyTorch data is missing. Other plots show QVAC data only.
- **Comparison mode**: All plots work, including QVAC vs PyTorch delta comparisons.

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

## Platform Limitations

### macOS (MPS)

**Quantization:**
- **QVAC**: Can run Q4/Q8 via GGUF on macOS GPU, but benchmark limits to `F16` for fair comparison
- **PyTorch**: MPS natively supports FP16/FP32 only. Bitsandbytes 4/8-bit quantization:
  - Falls back to CPU (very slow)
  - Is experimental and not recommended
  - Benchmark blocks it entirely on macOS
- **Result**: Both implementations limited to `F16` on macOS to ensure fair comparison

**Flash Attention:**
- **PyTorch**: Flash Attention 2 requires the `flash-attn` package, which is a CUDA-only kernel library
- **MPS does not support Flash Attention 2** - the benchmark silently skips it on macOS
- **QVAC**: Flash attention support depends on llama.cpp implementation (varies by model/backend)

**Device Mapping:**
- **PyTorch**: Uses `device_map="mps"` or `"auto"` on macOS (not CUDA device mapping). When `no-kv-offload` is set, explicitly uses `device_map="mps"` to keep KV cache on device.
- **QVAC**: Uses Metal backend on macOS (via llama.cpp's Metal backend)
- **Important**: The benchmark detects MPS availability and uses appropriate device mapping. On Linux/Windows with CUDA, uses `device_map={"": 0}` or `"auto"` for CUDA device 0.

### Memory Mapping (mmap)
- **QVAC (llama.cpp)**: Defaults to mmap (memory-mapping, lazy loading from disk). `--no-mmap` disables this and forces full load into RAM.
- **PyTorch**: Always does full load into RAM (no mmap equivalent). PyTorch's default behavior is effectively "no-mmap" - it loads the entire model into RAM/VRAM upfront.
- **Benchmark mapping**:
  - llama.cpp `--no-mmap` (full load) → PyTorch default (full load, no `low_cpu_mem_usage` set)
  - llama.cpp default (mmap) → PyTorch `low_cpu_mem_usage=True` (best-effort approximation, not true mmap)
- **Note**: `low_cpu_mem_usage=True` in PyTorch enables some memory optimizations (direct GPU loading, safetensors optimizations) but is **not** equivalent to mmap's lazy loading from disk. This is a fundamental difference between the two implementations.

### Linux/Windows (CUDA)

**Quantization:**
- **Full support** for bitsandbytes 4/8-bit quantization on CUDA GPUs
- **QVAC**: Supports all GGUF quantization variants (Q4_0, Q4_K_M, Q8_0, F16)
- **PyTorch**: Supports bnb-4bit, bnb-8bit, and fp16 on CUDA
- **No platform restrictions** - all quantization types are available

**Flash Attention:**
- **Flash Attention 2 works on CUDA** when `flash-attn` package is installed
- Requires CUDA-capable GPU and proper installation
- Automatically enabled when `flash-attn` is set and CUDA is available

**Device Mapping:**
- **PyTorch**: Uses `device_map={"": 0}` or `"auto"` for CUDA. When `no-kv-offload` is set, explicitly uses `device_map={"": 0}` to keep KV cache on GPU.
- **QVAC**: Uses Vulkan backend on Linux (via llama.cpp's Vulkan backend)
- **Platform detection**: Automatically detects Linux via `os.uname().sysname.lower() == "linux"` and CUDA via `torch.cuda.is_available()`

**CUDA-Specific Optimizations:**
- TF32 matmul precision adjustments for quantized KV cache
- Float32 matmul precision settings based on cache quantization type

### CPU (All Platforms)

**Quantization:**
- Bitsandbytes quantization is blocked (it's CUDA-only)
- QVAC can run quantized models on CPU via GGUF
- PyTorch uses FP32 on CPU

**Flash Attention:**
- Not applicable on CPU (GPU-only optimization)

## Operational Notes

### Parameter Compatibility

| Param | QVAC (llama.cpp) | PyTorch (Transformers) | Notes |
| --- | --- | --- | --- |
| `quantization` | GGUF quant variants | bitsandbytes 4/8bit or fp16 | macOS: Both QVAC and PyTorch limited to `F16` (MPS doesn't support bnb quantization; bnb falls back to CPU and is very slow). Linux/Windows: Full quantization support |
| `device` | cpu/gpu (Metal/Vulkan) | cpu/mps/cuda | same intent |
| `ctx_size` | context length | tokenizer truncation + `max_new_tokens` cap | same intent |
| `no-mmap` | disable mmap | PyTorch default (full load) | **No true equivalent**: llama.cpp defaults to mmap (lazy loading), PyTorch defaults to full load. When `no-mmap` is set, PyTorch uses default (full load). When not set, PyTorch uses `low_cpu_mem_usage=True` as best-effort approximation (not true mmap) |
| `threads` | CPU threads | `torch.set_num_threads()` | same intent for CPU work |
| `batch-size` | token batch for prefill | prefill chunk size | same intent (single prompt) |
| `ubatch-size` | micro-batch for prefill | prefill micro-chunk size | same intent (single prompt) |
| `no-kv-offload` | keep KV on device | `device_map` without offload | same intent |
| `flash-attn` | flash attention | `attn_implementation="flash_attention_2"` | CUDA-only (requires `flash-attn` package); silently skipped on MPS (macOS) |
| `cache-type-k` | KV cache quant | QuantizedCache (quanto) | PyTorch uses QuantizedCache with `quanto` when both cache types match (`f16`, `q4_0`, `q8_0`) |
| `cache-type-v` | KV cache quant | QuantizedCache (quanto) | PyTorch uses QuantizedCache with `quanto` when both cache types match (`f16`, `q4_0`, `q8_0`) |

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

### Batch-Size Comparability (QVAC vs PyTorch)
**Critical**: QVAC's `batch-size`/`ubatch-size` control **token batching** inside llama.cpp
for a *single prompt* (prefill chunking). This is **not** the same as batch inference
(processing multiple prompts).

**QVAC (llama.cpp):**
- `batch-size`: Token batch size for prefill (how many tokens processed at once during prefill)
- `ubatch-size`: Micro-batch size for prefill (smaller chunks within the batch)
- Always processes a **single prompt** - these parameters control how the prompt is chunked during prefill

**PyTorch mapping:**
- Maps `batch-size`/`ubatch-size` to **prefill chunk sizes** for a single prompt
- Implements chunked prefill: splits the prompt into chunks of `batch-size` tokens, then processes each chunk in micro-batches of `ubatch-size`
- Uses `past_key_values` to maintain state across chunks (same as llama.cpp's approach)
- **Not** batch inference (multiple prompts) - this would be a different workload

This mapping ensures both implementations exercise the same "token-batch" knobs and keeps the comparison fair.

### KV Cache Quantization (QVAC + PyTorch)
`cache-type-k`/`cache-type-v` control KV‑cache quantization in llama.cpp. The
PyTorch baseline uses Transformers `QuantizedCache` with the `quanto` backend
when `cache-type-k` and `cache-type-v` match (`f16`, `q4_0`, or `q8_0`). If the
K/V types differ, the PyTorch run fails with an explicit error because the
QuantizedCache backend quantizes K/V together.

**Mapping:**
- `f16` → No quantization (standard cache)
- `q4_0` → `QuantizedCache` with `nbits=4`
- `q8_0` → `QuantizedCache` with `nbits=8`

**Requirements:**
- `transformers>=5.1.0` (for `QuantizedCache` support)
- `quanto>=0.2.0` (quantization backend)
- Both `cache-type-k` and `cache-type-v` must match (QuantizedCache quantizes both together)

### PyTorch Threading Configuration
PyTorch has two thread pools:
- **Interop threads**: Set once per process (cannot be changed after parallel work starts)
- **Intraop threads**: Can be changed per run via `torch.set_num_threads()`

The benchmark determines the maximum threads needed across all runs and sets interop threads once at startup to avoid the "cannot set number of interop threads after parallel work has started" error.

### PyTorch Generation Timing
For batch runs (when `batch-size` or `ubatch-size` > 1), PyTorch uses a two-phase approach:
1. **TTFT estimation**: Chunked prefill (token batching) + one decode step to estimate first-token latency
2. **Generation TPS**: `model.generate()` per micro-batch, measuring tokens after the first token

This is necessary because `TextStreamer` only supports batch size 1, and we need to measure both TTFT and generation throughput for batch configurations.

**Important**: Generation TPS excludes TTFT time - it only measures the generation loop duration to avoid inflating throughput metrics.

## Unsupported Parameters

Some parameters are intentionally skipped or have limited support:

- **`cache-type-k`/`cache-type-v` on PyTorch**: If K and V types don't match, the run fails with an explicit error (QuantizedCache requires matching types).

- **`flash-attn` on macOS**: Silently skipped (MPS doesn't support Flash Attention 2).

- **Bitsandbytes quantization on macOS or CPU**: Blocked entirely (MPS doesn't support it, bitsandbytes is CUDA-only).

- **Bitsandbytes quantization on CPU**: Blocked (bitsandbytes is CUDA-only, even on CPU device).

When a parameter is unsupported, the benchmark either:
- **Skips silently** (e.g., flash-attn on MPS)
- **Blocks with error** (e.g., bnb quantization on macOS)
- **Fails with explicit error** (e.g., mismatched cache-type-k/v)

All failures are recorded in the JSONL output with `errorStage` and `error` fields.

## Adding Parameters

Update `perf-config.json`:
- Add the parameter to `params`
- Add baseline default (if needed)

Both scripts will pick up the change automatically.

**Important**: When adding a new parameter, ensure:
1. It's mapped correctly in both `qvac-perf.js` and `pytorch-perf.py`
2. Platform limitations are handled (macOS, CPU, etc.)
3. The mapping is documented in the [Parameter Compatibility](#parameter-compatibility) table
4. Any "no equivalent" cases are clearly documented
