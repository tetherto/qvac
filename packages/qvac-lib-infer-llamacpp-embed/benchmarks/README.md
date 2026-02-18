# Embedding Benchmark Suite

Comprehensive benchmarking system for evaluating **@qvac/embed-llamacpp addon** on embedding tasks using the [MTEB (Massive Text Embedding Benchmark)](https://github.com/embeddings-benchmark/mteb) framework. Supports single model evaluation and comparative analysis against SentenceTransformers.

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
| **Published npm package** | CI/CD, release verification, regression testing | `npm run benchmarks -- --addon-version "0.10.0" ...` |


```bash
# Default: Uses locally built addon (file:../../)
npm run benchmarks -- --gguf-model "ChristianAzinn/gte-large-gguf:F16"

# Use specific published version from npm
npm run benchmarks -- \
  --addon-version "0.10.0" \
  --gguf-model "ChristianAzinn/gte-large-gguf:F16" \
  --samples 10

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
  --gguf-model "ChristianAzinn/gte-large-gguf:F16"
```

### Common Examples

**Quick Test (small sample for fast iteration)**
```bash
# Run with just 100 samples - great for testing setup
npm run benchmarks -- \
  --gguf-model "ChristianAzinn/gte-large-gguf:F16" \
  --samples 100

# Single dataset
npm run benchmarks -- \
  --gguf-model "ChristianAzinn/gte-large-gguf:F16" \
  --samples 50 \
  --datasets "SciFact"
```

**Full Benchmark (production-quality results)**
```bash
# Full evaluation on all datasets
# Uses default gpu-layers=99, batch-size=2048
npm run benchmarks -- \
  --gguf-model "ChristianAzinn/gte-large-gguf:F16"

# Full evaluation with larger token batch (high VRAM)
npm run benchmarks -- \
  --gguf-model "ChristianAzinn/gte-large-gguf:F16" \
  --batch-size 4096
```

**P2P Model Loading (Hyperdrive)**
```bash
# Load GTE-Large FP16 via Hyperdrive P2P
npm run benchmarks -- \
  --gguf-model "hd://{KEY}/gte-large_fp16.gguf"

# P2P with quick test (1 sample, 1 dataset)
npm run benchmarks -- \
  --gguf-model "hd://{KEY}/gte-large_fp16.gguf" \
  --samples 1 \
  --datasets "SciFact"
```

**Comparative Analysis**
```bash
# Compare addon vs SentenceTransformers
npm run benchmarks -- \
  --compare \
  --gguf-model "ChristianAzinn/gte-large-gguf:F16" \
  --transformers-model "thenlper/gte-large" \
  --samples 100

# Full comparative benchmark
npm run benchmarks -- \
  --compare \
  --gguf-model "ChristianAzinn/gte-large-gguf:F16" \
  --transformers-model "thenlper/gte-large"
```

**Specific Datasets**
```bash
# Run only on selected datasets
npm run benchmarks -- \
  --gguf-model "ChristianAzinn/gte-large-gguf" \
  --datasets "ArguAna,SciFact"

# Single dataset for focused testing
npm run benchmarks -- \
  --gguf-model "ChristianAzinn/gte-large-gguf:F16" \
  --datasets "NFCorpus" \
  --samples 500
```

**Hardware Tuning**
```bash
# CPU-only mode (no GPU)
npm run benchmarks -- \
  --gguf-model "ChristianAzinn/gte-large-gguf:F16" \
  --device cpu \
  --samples 100

# Low VRAM systems (reduce GPU layers and batch size)
npm run benchmarks -- \
  --gguf-model "ChristianAzinn/gte-large-gguf:F16" \
  --gpu-layers 20 \
  --batch-size 1024

# High VRAM systems (larger batch for throughput)
npm run benchmarks -- \
  --gguf-model "ChristianAzinn/gte-large-gguf:F16" \
  --batch-size 4096

# Verbose output for debugging
npm run benchmarks -- \
  --gguf-model "ChristianAzinn/gte-large-gguf:F16" \
  --verbosity 2 \
  --samples 50
```

**Gated/Private Models**
```bash
# With HuggingFace token for gated models
npm run benchmarks -- \
  --gguf-model "org/gated-model" \
  --hf-token "$HF_TOKEN"
```

## Supported Datasets

| Dataset | Type | Description | Corpus Size | Queries |
|---------|------|-------------|-------------|---------|
| **ArguAna** | Argument Retrieval | Argument analysis and retrieval | 8,674 | 1,406 |
| **NFCorpus** | Medical Retrieval | Natural feedback corpus | 3,633 | 323 |
| **SciFact** | Fact Verification | Scientific fact verification | 5,183 | 300 |
| **TRECCOVID** | Scientific Retrieval | COVID-19 literature retrieval | 171,332 | 50 |
| **SCIDOCS** | Document Similarity | Scientific document similarity | 25,657 | 1,000 |
| **FiQA2018** | Financial QA | Financial opinion mining and QA | 57,638 | 648 |

## Performance Notes

**Processing speed** depends on hardware and is measured in tokens/second:
- Typical GPU (RTX 3080/M1 Pro): ~4,000 tokens/sec
- CPU-only: ~500-1,000 tokens/sec

**Important**: The `--samples` parameter limits **queries only**, not the corpus. MTEB retrieval tasks require encoding the **full corpus** for accurate metrics. Corpus encoding time is proportional to corpus size:

| Dataset | Corpus Docs | Avg Tokens/Doc | Est. Corpus Encoding |
|---------|-------------|----------------|----------------------|
| NFCorpus | 3,633 | ~200 | ~3 min |
| SciFact | 5,183 | ~330 | ~7 min |
| ArguAna | 8,674 | ~150 | ~5 min |
| SCIDOCS | 25,657 | ~200 | ~20 min |
| FiQA2018 | 57,638 | ~150 | ~35 min |
| TRECCOVID | 171,332 | ~150 | ~100+ min |

**Tips:**
- Use `--datasets "NFCorpus"` or `"SciFact"` for faster testing
- Use `--skip-existing` to avoid re-running completed benchmarks
- Increase `--batch-size` (e.g., 4096) for higher throughput on high VRAM systems

## Model Formats

**GGUF Model Specifications** (for `@qvac/embed-llamacpp` addon):

| Format | Example | Description |
|--------|---------|-------------|
| HuggingFace | `"owner/repo"` | Auto-downloads from HuggingFace Hub |
| HuggingFace + quant | `"owner/repo:F16"` | Specific quantization variant |
| P2P Hyperdrive | `"hd://key/model.gguf"` | Load via Hyperdrive P2P |

**SentenceTransformers Model** (for comparative mode only):
- **HuggingFace**: `"owner/repo"` 
  - Example: `"thenlper/gte-large"`

## Tunable Parameters

| Parameter | Type | Description | Range | Default |
|-----------|------|-------------|-------|---------|
| `--gguf-model` | `str` | GGUF model specification (see formats above) | - | Required |
| `--hf-token` | `str` | HuggingFace token for gated models | - | - |
| `--samples` | `int` | Samples per dataset (omit for full dataset) | `1-10000+` | - |
| `--datasets` | `str` | Comma-separated list or "all" | See list above | `all` |
| `--device` | `str` | Device type | `cpu,gpu` | `gpu` |
| `--batch-size` | `int` | Tokens for processing multiple prompts together | `512-8192` | `2048` |
| `--gpu-layers` | `int` | GPU layers to offload | `0-999` | `99` |
| `--verbosity` | `str` | Verbosity level | `0-3` | `0` |
| `--addon-version` | `str` | Install specific @qvac/embed-llamacpp version | e.g., `0.9.0` | - |
| `--skip-existing` | flag | Skip if results already exist for today | - | `false` |
| `--port` | `int` | Server port | `1024-65535` | `7357` |

## Results

All results are consolidated in `benchmarks/results/`:

```
benchmarks/results/
├── gte-large-gguf_F16/                           # Single model results
│   └── 2026-01-16.md                             # Markdown report
├── gte-large-gguf_F16_vs_thenlper_gte-large/     # Comparative results  
│   └── 2026-01-16.md
│   └── mteb_raw/                                  # Raw predictions for comparative
│       ├── addon/                                 # Addon model predictions
│       │   └── NFCorpus_predictions.json
│       └── transformers/                          # Transformers model predictions
│           └── NFCorpus_predictions.json
└── mteb_raw/                                      # Raw predictions for single model
    └── gte-large-gguf_F16/
        └── NFCorpus_predictions.json
```

### Understanding the Results

#### Result Types

| Folder | Contents | Purpose |
|--------|----------|---------|
| `{model_name}/` | Markdown reports (`YYYY-MM-DD.md`) | Human-readable summaries with scores |
| `mteb_raw/{model_name}/` | `{Dataset}_predictions.json` | Per-query similarity scores for debugging |

#### Markdown Report Structure

**Single Model Report** (`gte-large-gguf_F16/2026-01-16.md`):
```markdown
# Benchmark Results for gte-large-gguf_F16
**Date:** 2026-01-16  
**Model:** gte-large-gguf_F16

**Datasets:** NFCorpus
**Samples:** 2

## Scores

| Dataset | nDCG@10 | MRR@10 | Recall@10 | Precision@10 |
|---------|---------|--------|-----------|--------------|
| NFCorpus | 34.42% | 75.00% | 9.92% | 25.00% |

## Model Configuration
- **Device:** gpu
- **GPU Layers:** 99
- **Context Size:** 512
- **Batch Size:** 2048
```

**Comparative Report** (`gte-large-gguf_F16_vs_thenlper_gte-large/2026-01-16.md`):
```markdown
# Comparative Benchmark Results
**Addon Model (@qvac/embed-llamacpp):** gte-large-gguf_F16  
**Transformers Model (SentenceTransformers):** thenlper/gte-large

## Results Summary (nDCG@10)
| Dataset   | Addon   | Transformers | Difference | Winner       |
|-----------|---------|--------------|------------|--------------|
| NFCorpus  | 34.21%  | 34.89%       | -0.68%     | Transformers |

## Detailed Results
### NFCorpus
| Metric       | Addon   | Transformers |
|--------------|---------|--------------|
| nDCG@10      | 34.21%  | 34.89%       |
| MRR@10       | 51.23%  | 52.15%       |
| Recall@10    | 12.45%  | 12.67%       |
| Precision@10 | 9.12%   | 9.34%        |
```

> **Note**: Results will differ slightly between addon (GGUF/llama.cpp) and transformers 
> (PyTorch) due to precision differences, especially with quantized models.

### Metrics Reference

| Metric | What it Measures | How to Interpret |
|--------|-----------------|------------------|
| **nDCG@10** | Ranking quality considering position | Higher = better ranking of relevant docs at top |
| **MRR@10** | How quickly the first relevant result appears | Higher = first relevant doc appears sooner |
| **Recall@10** | Coverage of relevant documents | Higher = more relevant docs found |
| **Precision@10** | Accuracy of top results | Higher = fewer irrelevant docs in top 10 |

#### Interpreting Scores

**What's a good score?**
- Scores vary significantly by dataset difficulty
- **Compare relative performance** between models, not absolute numbers
- Reference baselines from [MTEB Leaderboard](https://huggingface.co/spaces/mteb/leaderboard)

**Expected ranges for GTE-Large:**
| Dataset | Expected nDCG@10 |
|---------|-----------------|
| ArguAna | 50-55% |
| NFCorpus | 33-38% |
| SciFact | 68-73% |
| TRECCOVID | 70-80% |
| SCIDOCS | 15-20% |

**Red flags:**
- All zeros → Server crash or model loading failure
- Significantly below expected → Check model quantization, ctx_size
- Addon much worse than Transformers → Check configuration alignment

### Raw MTEB Predictions

The `mteb_raw/` folder contains JSON files with **per-query similarity predictions**:

**File**: `mteb_raw/{model_name}/{Dataset}_predictions.json`

```json
{
  "mteb_model_meta": {
    "model_name": "thenlper/gte-large",
    "revision": "4bef63f39fcc5e2d6b0aae83089f307af4970164"
  },
  "default": {
    "test": {
      "PLAIN-133": {
        "MED-2282": 0.7401,
        "MED-1725": 0.7451,
        "MED-3632": 0.7401,
        ...
      },
      "PLAIN-634": {
        "MED-4580": 0.7647,
        "MED-3854": 0.7695,
        ...
      }
    }
  }
}
```

**Structure:**
- `mteb_model_meta`: Model name and HuggingFace revision used
- `default` → `test`: The dataset subset and split
- Query IDs (e.g., `PLAIN-133`): Each evaluated query
- Document IDs → Scores: Similarity score (0-1) between query and corpus document

**Use this for:**
- **Debugging**: Why did a query return unexpected results?
- **Analysis**: Which documents are consistently ranked high/low?
- **Comparison**: Compare per-query scores between addon vs transformers

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
    │  (Node.js + bare)  │◄──────┤  (evaluate_embed)  │
    │                    │       │                    │
    │  - ModelManager    │       │  - MTEBWrapper     │
    │  - P2P Loader      │       │  - HF Downloader   │
    │  - VRAM cleanup    │       │  - Dataset loading │
    │  - HTTP API        │       │  - Results handler │
    └──────────┬─────────┘       └────────────────────┘
               │
    ┌──────────▼──────────────────────────────────────┐
    │  @qvac/embed-llamacpp Addon (C++ Native)       │
    │  - llama.cpp GGUF loading                      │
    │  - Hardware acceleration (GPU/CPU)             │
    │  - Embedding generation                        │
    └────────────────────────────────────────────────┘
```

### Project Structure

```
benchmarks/
├── client/                         # Python evaluation client
│   ├── evaluate_embed.py           # Main entry point
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
│   │   │   ├── modelManager.js     # Local model manager
│   │   │   ├── p2pModelLoader.js   # P2P Hyperdrive loader
│   │   │   └── runAddon.js         # Addon interface + routing
│   │   ├── validation/
│   │   │   └── index.js            # Request validation
│   │   └── utils/
│   │       ├── ApiError.js         # Custom API error class
│   │       ├── constants.js        # Server constants
│   │       ├── helper.js           # Helper utilities
│   │       └── logger.js           # Server logging
│   └── package.json                # Server dependencies
├── results/                        # All benchmark results (single source of truth)
│   ├── {model_name}/               # Markdown reports
│   │   └── YYYY-MM-DD.md
│   └── mteb_raw/                   # Raw MTEB predictions for debugging
│       └── {model_name}/
│           └── {Dataset}_predictions.json
├── run-benchmarks.sh               # Unix automation script
├── run-benchmarks.ps1              # Windows PowerShell script
└── README.md                       # This file
```

## License

Apache-2.0
