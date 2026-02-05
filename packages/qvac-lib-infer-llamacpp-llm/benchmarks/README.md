# LlamaCpp Benchmark Suite

Comprehensive benchmarking system for evaluating `@qvac/llm-llamacpp` across reasoning, comprehension, and knowledge tasks. Supports both single-model addon evaluation and comparative analysis against HuggingFace Transformers.

## Table of Contents

- [Addon Source](#addon-source)
- [Prerequisites](#prerequisites)
- [Platform Support](#platform-support)
- [Quick Start](#quick-start)
- [Supported Datasets](#supported-datasets)
- [Model Formats](#model-formats)
- [Tunable Parameters](#tunable-parameters)
- [Results](#results)
- [Architecture](#architecture)

## Addon Source

Benchmarks can run against two addon sources:

| Source | When to use | Command |
|--------|-------------|---------|
| Locally built addon (default) | Development and local validation | `npm run benchmarks -- ...` |
| Published npm package | CI/release verification | `npm run benchmarks -- --addon-version "0.8.0" ...` |

```bash
# Local addon (default)
npm run benchmarks -- --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0"

# Published addon
npm run benchmarks -- --addon-version "0.8.0" --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0"
```

## Prerequisites

- Python 3.10+ with `venv`
- Node.js 18+ with `npm`
- Bare runtime (`npm install -g bare`)

## Platform Support

### Unix/Linux/macOS

```bash
npm run benchmarks -- [options]
```

### Windows (PowerShell)

```powershell
.\benchmarks\run-benchmarks.ps1 [options]
# or
npm run benchmarks:windows -- [options]
```

## Quick Start

```bash
# Single model evaluation
npm run benchmarks -- \
  --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" \
  --samples 10

# Comparative mode (addon vs transformers)
npm run benchmarks -- \
  --compare \
  --gguf-model "bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0" \
  --transformers-model "meta-llama/Llama-3.2-1B-Instruct" \
  --hf-token "$HF_TOKEN" \
  --samples 10

# Hyperdrive GGUF model
npm run benchmarks -- \
  --gguf-model "hd://afa79ee07c0a138bb9f11bfaee771fb1bdfca8c82d961cff0474e49827bd1de3/Llama-3.2-1B-Instruct-Q4_0.gguf" \
  --samples 10
```

## Supported Datasets

| Dataset | Type | Description | Metric |
|---------|------|-------------|--------|
| SQuAD | Reading comprehension | Question answering from passages | F1 |
| ARC | Scientific reasoning | AI2 Reasoning Challenge | Accuracy |
| MMLU | Knowledge | Multitask language understanding | Accuracy |
| GSM8K | Math reasoning | Grade-school math word problems | Accuracy |

## Model Formats

### GGUF model specification (`--gguf-model`)

- HuggingFace: `"owner/repo"` or `"owner/repo:quantization"`
  - Example: `"bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_0"`
- Hyperdrive: `"hd://key/model.gguf"`
  - Example: `"hd://afa79ee.../Llama-3.2-1B-Instruct-Q4_0.gguf"`

### Transformers model (`--transformers-model`, comparative mode)

- HuggingFace: `"owner/repo"`
  - Example: `"meta-llama/Llama-3.2-1B-Instruct"`

## Tunable Parameters

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `--gguf-model` | str | GGUF model identifier/spec | required |
| `--transformers-model` | str | HF model for comparative mode | - |
| `--hf-token` | str | HF token for gated/private models | - |
| `--samples` | int | Samples per dataset | 10 |
| `--datasets` | str | Comma-separated list or `all` | all |
| `--device` | str | `cpu` or `gpu` | gpu |
| `--gpu-layers` | str | GPU layers to offload | 99 |
| `--ctx-size` | int | Context size | 8192 |
| `--temperature` | float | Sampling temperature | 0.7 |
| `--top-p` | float | Nucleus sampling threshold | 0.9 |
| `--top-k` | int | Top-k sampling | 40 |
| `--n-predict` | int | Max generated tokens | 4096 |
| `--repeat-penalty` | float | Repetition penalty | 1.0 |
| `--seed` | int | Random seed (`-1` random) | -1 |
| `--addon-version` | str | Install specific addon version | local |
| `--skip-existing` | flag | Skip if today's results exist | false |
| `--port` | int | Server port | 7357 |

## Results

Results are written under:

```text
benchmarks/client/benchmarking_results/{model_or_comparison}/YYYY-MM-DD.md
```

Reports include:
- Per-dataset scores
- Comparative summary (in compare mode)
- Full runtime parameter snapshot

## Architecture

```text
run-benchmarks.sh / run-benchmarks.ps1
  -> benchmark server (Node.js + bare)
  -> Python client (evaluate_llama.py, comparative_evaluator.py)
  -> @qvac/llm-llamacpp native addon
```

Project structure:

```text
benchmarks/
├── client/
│   ├── evaluate_llama.py
│   ├── comparative_evaluator.py
│   ├── model_handler.py
│   ├── results_handler.py
│   ├── config.yaml
│   └── requirements.txt
├── server/
│   ├── index.js
│   ├── src/server.js
│   ├── src/services/
│   │   ├── modelManager.js
│   │   ├── p2pModelLoader.js
│   │   └── runAddon.js
│   └── package.json
├── run-benchmarks.sh
├── run-benchmarks.ps1
└── README.md
```

## License

Apache-2.0
