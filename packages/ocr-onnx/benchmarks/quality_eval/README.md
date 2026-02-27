# OCR Quality Evaluation Framework

Benchmarking framework for comparing OCR backends on the OCRBench_v2 dataset.

## Overview

This framework evaluates OCR accuracy and speed for:
- **EasyOCR** - Python-based OCR library
- **QVAC OCR** - ONNX-based OCR addon for Bare runtime

## Installation

### Prerequisites

1. Python 3.8+
2. For QVAC backend: [Bare runtime](https://docs.pears.com/bare-reference/overview) (>= 1.17.3)

### Install Python Dependencies

```bash
cd benchmarks/quality_eval
pip install -r requirements.txt
```

### Download OCRBench_v2 Dataset

Download from [Google Drive](https://drive.google.com/file/d/1Hk1TMu--7nr5vJ7iaNwMQZ_Iw9W_KI3C/view) and extract:

```
OCRBench_v2/
├── EN_part/           # English images
├── CN_part/           # Chinese images
└── OCRBench_v2.json   # Dataset annotations
```

## Usage

### Basic Evaluation

```bash
# Evaluate both backends on text recognition tasks
python evaluate.py --dataset-path /path/to/OCRBench_v2

# Evaluate only EasyOCR
python evaluate.py --dataset-path /path/to/OCRBench_v2 --backends easyocr

# Evaluate only QVAC OCR
python evaluate.py --dataset-path /path/to/OCRBench_v2 --backends qvac
```

### Options

```
--dataset-path      Path to OCRBench_v2 directory (required)
--backends          Comma-separated backends: easyocr,qvac (default: both)
--task-types        Task types to benchmark (default: text recognition tasks)
--metrics           Metrics to compute: cer,wer,anls (default: all)
--results-dir       Output directory (default: ./results)
--skip-existing     Skip already evaluated samples (default: true)
--limit             Limit samples per task (0 = all)
--qvac-addon-path   Custom path to QVAC addon
--gpu               Use GPU acceleration
```

### Examples

```bash
# Limit to 100 samples per task type for quick testing
python evaluate.py --dataset-path /path/to/OCRBench_v2 --limit 100

# Use GPU for EasyOCR
python evaluate.py --dataset-path /path/to/OCRBench_v2 --backends easyocr --gpu

# Evaluate specific task types
python evaluate.py --dataset-path /path/to/OCRBench_v2 \
    --task-types "text recognition en,full-page OCR en"

# Custom results directory
python evaluate.py --dataset-path /path/to/OCRBench_v2 --results-dir ./my_results
```

## Metrics

### Accuracy Metrics

| Metric | Description | Range |
|--------|-------------|-------|
| **CER** | Character Error Rate - edit distance normalized by reference length | 0 (perfect) to 1+ (more errors) |
| **WER** | Word Error Rate - word-level edit distance | 0 (perfect) to 1+ |
| **ANLS** | Average Normalized Levenshtein Similarity | 0 to 1 (higher = better) |

### Speed Metrics

- **Inference time** - Time per image in seconds
- **Throughput** - Images processed per second

## Results Format

Results are saved as JSON files:

```
results/
├── easyocr/
│   └── text_recognition_en/
│       ├── sample_8600.json    # Individual results
│       ├── sample_8601.json
│       └── aggregate.json      # Summary statistics
├── qvac/
│   └── text_recognition_en/
│       └── ...
└── summary.json                # Cross-backend comparison
```

### Sample Result

```json
{
  "id": 8600,
  "ground_truth": "1000",
  "prediction": "1000",
  "metrics": {
    "cer": 0.0,
    "wer": 0.0,
    "anls": 1.0
  },
  "inference_time": 0.234,
  "confidence": 0.95
}
```

### Aggregate Result

```json
{
  "backend": "easyocr",
  "task_type": "text recognition en",
  "total_samples": 500,
  "metrics": {
    "cer": {"mean": 0.12, "std": 0.08, "min": 0.0, "max": 0.45},
    "wer": {"mean": 0.15, "std": 0.10, "min": 0.0, "max": 0.50},
    "anls": {"mean": 0.82, "std": 0.12, "min": 0.5, "max": 1.0}
  },
  "speed": {
    "total_time": 234.5,
    "mean_time_per_image": 0.469,
    "throughput_images_per_sec": 2.13
  }
}
```

## Task Types

The framework focuses on text extraction tasks from OCRBench_v2:

| Task Type | Description |
|-----------|-------------|
| `text recognition en` | Single word/number recognition |
| `full-page OCR en` | Full document text extraction |
| `fine-grained text recognition en` | Text recognition within specific regions |

## Architecture

```
benchmarks/quality_eval/
├── evaluate.py           # Main CLI script
├── backends/             # OCR backend implementations
│   ├── base.py          # Abstract base class
│   ├── easyocr_backend.py
│   └── qvac_ocr_backend.py
├── metrics/             # Metric implementations
│   ├── cer.py           # Character Error Rate
│   ├── wer.py           # Word Error Rate
│   └── anls.py          # ANLS
├── dataset/             # Dataset loading
│   └── ocrbench_loader.py
├── utils/               # Utilities
│   ├── timing.py
│   └── text_utils.py
└── ocr_cli.js           # QVAC CLI wrapper
```

## Adding New Backends

1. Create a new file in `backends/` (e.g., `my_backend.py`)
2. Inherit from `OCRBackend` base class
3. Implement `initialize()`, `run_ocr()`, and `cleanup()` methods
4. Register in `evaluate.py`'s `AVAILABLE_BACKENDS` dict

## License

Apache-2.0 License - see the main repository LICENSE file.
