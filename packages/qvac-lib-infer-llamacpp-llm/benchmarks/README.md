# LlamaCpp Benchmark Suite

Comprehensive benchmarking system for evaluating **@qvac/llm-llamacpp addon** across reasoning, comprehension, and knowledge tasks. Supports single model evaluation and comparative analysis against HuggingFace Transformers.

## 📋 Table of Contents

- [Platform Support](#️-platform-support)
- [Quick Start](#-quick-start)
- [Supported Datasets](#-supported-datasets)
- [Model Formats](#️-model-formats)
- [Tunable Parameters](#️-tunable-parameters)
- [Results](#-results)
- [Architecture](#️-architecture)

## 🖥️ Platform Support

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

## 🎯 Quick Start

```bash
# Single model evaluation
npm run benchmarks -- \
  --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" \
  --samples 10

# Comparative analysis (addon vs transformers)
npm run benchmarks -- \
  --compare \
  --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" \
  --transformers-model "meta-llama/Llama-3.2-1B-Instruct" \
  --samples 10

# Hyperdrive P2P model
npm run benchmarks -- \
  --gguf-model "hd://afa79ee07c0a138bb9f11bfaee771fb1bdfca8c82d961cff0474e49827bd1de3/Llama-3.2-1B-Instruct-Q4_0.gguf" \
  --samples 10
```

## 📊 Supported Datasets

| Dataset | Type | Description | Metrics |
|---------|------|-------------|---------|
| **SQuAD** | Reading Comprehension | Question answering from passages | F1 Score |
| **ARC** | Scientific Reasoning | AI2 Reasoning Challenge questions | Accuracy |
| **MMLU** | Knowledge | Massive multitask language understanding | Accuracy |
| **GSM8K** | Math Reasoning | Grade-school math word problems | Accuracy |

## 🎛️ Model Formats

**GGUF Model Specifications** (for `@qvac/llm-llamacpp` addon):
- **HuggingFace**: `"owner/repo:quantization"` 
  - Example: `"bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0"`
- **Hyperdrive P2P**: `"hd://key/model.gguf"` 
  - Example: `"hd://afa79ee07c0a138bb9f11bfaee771fb1bdfca8c82d961cff0474e49827bd1de3/Llama-3.2-1B-Instruct-Q4_0.gguf"`

**Transformers Model** (for comparative mode only):
- **HuggingFace**: `"owner/repo"` 
  - Example: `"meta-llama/Llama-3.2-1B-Instruct"`

## 🎛️ Tunable Parameters

| Parameter | Type | Description | Range | Default |
|-----------|------|-------------|-------|---------|
| `--samples` | `int` | Samples per dataset | `1-1000+` | `10` |
| `--datasets` | `str` | Comma-separated list or "all" | `squad,arc,mmlu,gsm8k` | `all` |
| `--device` | `str` | Device type | `cpu,gpu` | `gpu` |
| `--temperature` | `float` | Randomness in generation | `0.0-2.0` | `0.7` |
| `--ctx-size` | `int` | Context window size | `512-32768` | `8192` |
| `--gpu-layers` | `str` | GPU layers to offload | `'0'-'999'` | `'99'` |
| `--top-p` | `float` | Nucleus sampling threshold | `0.0-1.0` | `0.9` |
| `--top-k` | `int` | Top-k sampling (limits choices) | `1-100` | `40` |
| `--n-predict` | `int` | Max tokens to generate | `-1,50-4096` | `4096` |
| `--repeat-penalty` | `float` | Penalize token repetition | `1.0-2.0` | `1.0` |
| `--seed` | `int` | Random seed for reproducibility | any int | `-1` (random) |

## 📂 Results

Results are stored in `benchmarks/results/{model_name}/YYYY-MM-DD.md`:

```
benchmarks/results/
├── Llama-3.2-1B-Instruct-GGUF_Q4_0/
│   └── 2025-11-07.md
└── Llama-3.2-1B-Instruct-GGUF_Q4_0_vs_meta-llama_Llama-3.2-1B-Instruct/
    └── 2025-11-07.md
```

Each result file includes:
- Side-by-side accuracy comparison
- Per-dataset breakdown (accuracy/F1 metrics)
- Model configuration parameters used

## 🏗️ Architecture

### System Overview

```
┌─────────────────────────────────────────┐
│   Shell Script (run-benchmarks.sh)     │
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
    │  - VRAM cleanup    │       │  - Dataset loading │
    │  - Crash logging   │       │  - Results handler │
    └──────────┬─────────┘       └────────────────────┘
               │
    ┌──────────▼──────────────────────────────────────┐
    │  @qvac/llm-llamacpp Addon (C++ Native)         │
    │  - llama.cpp GGUF loading                      │
    │  - Hardware acceleration (GPU/CPU)             │
    │  - Model inference                             │
    └────────────────────────────────────────────────┘
```

### Project Structure

```
benchmarks/
├── client/                         # Python evaluation client
│   ├── evaluate_llama.py           # Main entry point
│   ├── model_handler.py            # Handlers (Qvac, Transformers, Evaluator)
│   ├── comparative_evaluator.py   # Comparative evaluation orchestration
│   ├── results_handler.py          # Results formatting & output
│   ├── utils.py                    # Dataset configs & loading utilities
│   └── requirements.txt            # Python dependencies
├── server/                         # Node.js benchmark server
│   ├── index.js                    # Server entry point
│   ├── src/
│   │   ├── server.js               # HTTP server
│   │   ├── services/
│   │   │   ├── modelManager.js    # Singleton model manager
│   │   │   ├── p2pModelLoader.js  # P2P model loading
│   │   │   └── runAddon.js        # Addon interface
│   │   ├── validation/
│   │   │   └── index.js           # Request validation schemas
│   │   └── utils/
│   │       ├── logger.js          # Server logging
│   │       └── constants.js       # Server constants
│   └── package.json               # Server dependencies
├── results/                       # Benchmark results (generated)
│   └── {model_name}/
│       └── YYYY-MM-DD.md
└── README.md                      # This file
```


