# Llm Benchmark Suite

Comprehensive benchmarking system for evaluating **@qvac/llm-llamacpp addon** across reasoning, comprehension, and knowledge tasks. Supports single model evaluation and comparative analysis against HuggingFace Transformers.

## Table of Contents

- [Addon Source](#addon-source)
- [Prerequisites](#prerequisites)
- [Platform Support](#platform-support)
- [Quick Start](#quick-start)
- [Supported Datasets](#supported-datasets)
- [Performance Notes](#performance-notes)
- [Model Formats](#model-formats)
- [Tunable Parameters](#tunable-parameters)
- [Results](#results)
- [Architecture](#architecture)

## Addon Source

Benchmarks can run against two different addon sources:

| Source | When to Use | Command |
|--------|-------------|---------|
| **Locally built addon** (default) | Development, testing local changes | `npm run benchmarks -- ...` |
| **Published npm package** | CI/CD, release verification, regression testing | `npm run benchmarks -- --addon-version "0.8.0" ...` |

```bash
# Default: Uses locally built addon (file:../../)
npm run benchmarks -- --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0"

# Use specific published version from npm
npm run benchmarks -- --addon-version "0.8.0" --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0"
```


## Prerequisites

- **Python 3.10+** with `venv` module
- **Node.js 18+** with `npm`
- **Bare runtime** (`npm install -g bare`)

## Platform Support

### Unix/Linux/macOS
Use the provided bash script directly:
```bash
npm run benchmarks -- [options]
```

### Windows
**PowerShell (Native)**
```powershell
# Use the PowerShell script directly
.\benchmarks\run-benchmarks.ps1 [options]

# Or via npm
npm run benchmarks:windows -- [options]
```

## Quick Start

```bash
# Single model evaluation (auto-downloads from HuggingFace)
npm run benchmarks -- \
  --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0"
```

### Common Examples

**Quick Test (small sample for fast iteration)**
```bash
# Run with just 10 samples - great for testing setup
npm run benchmarks -- \
  --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" \
  --samples 10

# Single dataset
npm run benchmarks -- \
  --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" \
  --samples 10 \
  --datasets "squad"
```

**Full Benchmark (production-quality results)**
```bash
# Full evaluation on all datasets
npm run benchmarks -- \
  --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0"

# Full evaluation with more samples
npm run benchmarks -- \
  --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" \
  --samples 100
```

**P2P Model Loading (Hyperdrive)**
```bash
# Load model via Hyperdrive P2P
npm run benchmarks -- \
  --gguf-model "hd://{KEY}/Llama-3.2-1B-Instruct-Q4_0.gguf"

# P2P with quick test (10 samples, 1 dataset)
npm run benchmarks -- \
  --gguf-model "hd://{KEY}/Llama-3.2-1B-Instruct-Q4_0.gguf" \
  --samples 10 \
  --datasets "squad"
```

**Comparative Analysis**
```bash
# Compare addon vs HuggingFace Transformers
npm run benchmarks -- \
  --compare \
  --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" \
  --transformers-model "meta-llama/Llama-3.2-1B-Instruct" \
  --samples 10

# Full comparative benchmark
npm run benchmarks -- \
  --compare \
  --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" \
  --transformers-model "meta-llama/Llama-3.2-1B-Instruct"
```

**Specific Datasets**
```bash
# Run only on selected datasets
npm run benchmarks -- \
  --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" \
  --datasets "squad,arc"

# Single dataset for focused testing
npm run benchmarks -- \
  --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" \
  --datasets "mmlu" \
  --samples 50
```

**Hardware Tuning**
```bash
# CPU-only mode (no GPU)
npm run benchmarks -- \
  --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" \
  --device cpu \
  --samples 10

# Low VRAM systems (reduce GPU layers)
npm run benchmarks -- \
  --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" \
  --gpu-layers 20

# Verbose output for debugging
npm run benchmarks -- \
  --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" \
  --verbosity 2 \
  --samples 10
```

**Gated/Private Models**
```bash
# With HuggingFace token for gated models
npm run benchmarks -- \
  --gguf-model "meta-llama/Llama-3.2-1B-Instruct-GGUF" \
  --hf-token "$HF_TOKEN"
```

## Supported Datasets

| Dataset | Type | Description | Samples | Metrics |
|---------|------|-------------|---------|---------|
| **SQuAD** | Reading Comprehension | Question answering from passages | 10,570 | F1 Score |
| **ARC** | Scientific Reasoning | AI2 Reasoning Challenge questions | 1,172 | Accuracy |
| **MMLU** | Knowledge | Massive multitask language understanding | 14,042 | Accuracy |
| **GSM8K** | Math Reasoning | Grade-school math word problems | 1,319 | Accuracy |

## Performance Notes

**Generation speed** depends on hardware and is measured in tokens/second:
- Typical GPU (RTX 3080/M1 Pro): ~50-100 tokens/sec
- CPU-only: ~5-15 tokens/sec

**Important**: LLM benchmarks require generating complete responses for each sample. Benchmark time scales linearly with `--samples`:

| Dataset | Samples | Avg Response Tokens | Est. Time (GPU) |
|---------|---------|---------------------|-----------------|
| SQuAD | 100 | ~50 | ~5 min |
| ARC | 100 | ~20 | ~3 min |
| MMLU | 100 | ~20 | ~3 min |
| GSM8K | 100 | ~100 | ~10 min |

**Tips:**
- Use `--datasets "squad"` or `"arc"` for faster testing
- Use `--skip-existing` to avoid re-running completed benchmarks
- Reduce `--samples` for quick iteration during development

## Model Formats

**GGUF Model Specifications** (for `@qvac/llm-llamacpp` addon):

| Format | Example | Description |
|--------|---------|-------------|
| HuggingFace | `"owner/repo"` | Auto-downloads from HuggingFace Hub |
| HuggingFace + quant | `"owner/repo:Q4_0"` | Specific quantization variant |
| P2P Hyperdrive | `"hd://key/model.gguf"` | Load via Hyperdrive P2P |

**Transformers Model** (for comparative mode only):
- **HuggingFace**: `"owner/repo"` 
  - Example: `"meta-llama/Llama-3.2-1B-Instruct"`

## Tunable Parameters

| Parameter | Type | Description | Range | Default |
|-----------|------|-------------|-------|---------|
| `--gguf-model` | `str` | GGUF model specification (see formats above) | - | Required |
| `--hf-token` | `str` | HuggingFace token for gated models | - | - |
| `--samples` | `int` | Samples per dataset | `1-1000+` | `10` |
| `--datasets` | `str` | Comma-separated list or "all" | See list above | `all` |
| `--device` | `str` | Device type | `cpu,gpu` | `gpu` |
| `--gpu-layers` | `int` | GPU layers to offload | `0-999` | `99` |
| `--ctx-size` | `int` | Context window size | `512-32768` | `8192` |
| `--temperature` | `float` | Randomness in generation | `0.0-2.0` | `0.7` |
| `--top-p` | `float` | Nucleus sampling threshold | `0.0-1.0` | `0.9` |
| `--top-k` | `int` | Top-k sampling (limits choices) | `1-100` | `40` |
| `--n-predict` | `int` | Max tokens to generate | `-1,50-4096` | `4096` |
| `--repeat-penalty` | `float` | Penalize token repetition | `1.0-2.0` | `1.0` |
| `--seed` | `int` | Random seed for reproducibility | any int | `-1` (random) |
| `--verbosity` | `int` | Verbosity level | `0-3` | `0` |
| `--addon-version` | `str` | Install specific @qvac/llm-llamacpp version | e.g., `0.9.0` | - |
| `--skip-existing` | flag | Skip if results already exist for today | - | `false` |
| `--port` | `int` | Server port | `1024-65535` | `7357` |

## Results

All results are consolidated in `benchmarks/results/`:

```
benchmarks/results/
├── Llama-3.2-1B-Instruct-GGUF_Q4_0/                              # Single model results
│   └── 2025-11-07.md                                              # Markdown report
├── Llama-3.2-1B-Instruct-GGUF_Q4_0_vs_meta-llama_Llama-3.2-1B/   # Comparative results
│   └── 2025-11-07.md
└── raw/                                                           # Raw evaluation data
    └── {model_name}/
        └── {dataset}_results.json
```

### Understanding the Results

#### Result Types

| Folder | Contents | Purpose |
|--------|----------|---------|
| `<model_name>/` | Markdown reports | Human-readable summaries |
| `raw/` | JSON files | Raw evaluation data for analysis |

#### Markdown Report Structure

**Single Model Report** (`Llama-3.2-1B-Instruct-GGUF_Q4_0/2025-11-07.md`):
```markdown
# Benchmark Results for Llama-3.2-1B-Instruct-GGUF_Q4_0
**Date:** 2025-11-07
**Model:** bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0

## Scores
| Dataset | Accuracy | F1 Score |
|---------|----------|----------|
| SQuAD   | -        | 72.34%   |
| ARC     | 45.67%   | -        |
| MMLU    | 38.91%   | -        |
| GSM8K   | 12.34%   | -        |

## Model Configuration
- Device: gpu
- GPU Layers: 99
- Context Size: 8192
- Temperature: 0.7
```

**Comparative Report**:
```markdown
# Comparative Benchmark Results
**Addon Model:** Llama-3.2-1B-Instruct-GGUF_Q4_0
**Transformers Model:** meta-llama/Llama-3.2-1B-Instruct

## Results Summary
| Dataset | Addon    | Transformers | Difference | Winner       |
|---------|----------|--------------|------------|--------------|
| SQuAD   | 72.34%   | 73.12%       | -0.78%     | Transformers |
| ARC     | 45.67%   | 44.89%       | +0.78%     | Addon        |
```

### Metrics Reference

| Metric | What it Measures | Used For |
|--------|-----------------|----------|
| **Accuracy** | Correct answers / Total answers | ARC, MMLU, GSM8K |
| **F1 Score** | Harmonic mean of precision and recall | SQuAD (text overlap) |

#### Interpreting Scores

**What's a good score?**
- Scores vary significantly by model size and dataset difficulty
- **Compare relative performance** between models, not absolute numbers
- Reference baselines from model cards and leaderboards

**Expected ranges for Llama-3.2-1B:**
| Dataset | Expected Score |
|---------|----------------|
| SQuAD (F1) | 65-75% |
| ARC | 40-50% |
| MMLU | 35-45% |
| GSM8K | 10-20% |

**Red flags:**
- All zeros → Server crash or model loading failure
- Significantly below expected → Check model quantization, ctx_size
- Addon much worse than Transformers → Check configuration alignment

## Architecture

### System Overview

```
┌─────────────────────────────────────────┐
│   Shell Script (run-benchmarks.sh)      │
│   - Environment setup                   │
│   - Server lifecycle management         │
│   - Argument parsing                    │
└──────────────┬──────────────────────────┘
               │
    ┌──────────▼────────┐       ┌────────────────────┐
    │  Benchmark Server  │       │   Python Client    │
    │  (Node.js + bare)  │◄──────┤  (evaluate_llama)  │
    │                    │       │                    │
    │  - ModelManager    │       │  - ComparativeEval │
    │  - P2P Loader      │       │  - HF Downloader   │
    │  - VRAM cleanup    │       │  - Dataset loading │
    │  - HTTP API        │       │  - Results handler │
    └──────────┬─────────┘       └────────────────────┘
               │
    ┌──────────▼──────────────────────────────────────┐
    │  @qvac/llm-llamacpp Addon (C++ Native)         │
    │  - llama.cpp GGUF loading                      │
    │  - Hardware acceleration (GPU/CPU)             │
    │  - Text generation                             │
    └────────────────────────────────────────────────┘
```

### Project Structure

```
benchmarks/
├── client/                         # Python evaluation client
│   ├── evaluate_llama.py           # Main entry point
│   ├── model_handler.py            # Handlers + HF download
│   ├── comparative_evaluator.py    # Comparative evaluation
│   ├── results_handler.py          # Results formatting
│   ├── utils.py                    # Dataset configs
│   └── requirements.txt            # Python dependencies
├── server/                         # Node.js benchmark server
│   ├── index.js                    # Server entry point
│   ├── src/
│   │   ├── server.js               # HTTP server
│   │   ├── services/
│   │   │   ├── modelManager.js     # Singleton model manager
│   │   │   ├── p2pModelLoader.js   # P2P Hyperdrive loader
│   │   │   └── runAddon.js         # Addon interface + routing
│   │   ├── validation/
│   │   │   └── index.js            # Request validation
│   │   └── utils/
│   │       ├── logger.js           # Server logging
│   │       └── constants.js        # Server constants
│   └── package.json                # Server dependencies
├── results/                        # All benchmark results (single source of truth)
│   ├── {model_name}/               # Markdown reports
│   │   └── YYYY-MM-DD.md
│   └── raw/                        # Raw evaluation data
│       └── {model_name}/
├── run-benchmarks.sh               # Unix automation script
├── run-benchmarks.ps1              # Windows PowerShell script
└── README.md                       # This file
```

## License

Apache-2.0
