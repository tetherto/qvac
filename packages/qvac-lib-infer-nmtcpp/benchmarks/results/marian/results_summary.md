# Aggregated Benchmark Results

This summary consolidates benchmarking results across all language pairs using QVAC SDK.

Original Model: [MarianMT](https://huggingface.co/docs/transformers/en/model_doc/marian#marianmt)

| Src lang | Dest lang | SDK Version | Model ID | Hyperdrive Key | COMET | BLEU | Dataset | Notes |
|----------|-----------|-------------|----------|----------------|-------|------|---------|-------|
| en | it | 0.3.0 | model.bin | 9ef58f31c20d5556722e0b58a5d262fd89801daf2e6cb28e3f21ac6e9228088f | 0.85 | 47.58 | Flores+ | Performed on GPU |
| it | en | 0.3.0 | model.bin | 68778c8375fbb1e7f5c20b4e6087131206e9ddba1872655e20931b7e08fe3954 | 0.86 | 43.91 | Flores+ | Performed on GPU |

## Reference

### COMET (Crosslingual Optimized Metric for Evaluation of Translation)

A modern neural metric trained to match human judgments. Most useful for capturing semantic adequacy, especially for low-resource or morphologically rich languages.

Range: 0 - 1, **Higher = better**

| **Score Range** | **Interpretation** |
|----------------|--------------------|
| 0.75 - 1      | Human-parity or better; stylistic variations only |
| 0.60 - 0.75   | High-quality MT; minor or rare issues |
| 0.40 - 0.60   | Adequate; understandable but potentially error-prone |
| < 0.40       | Low quality; meaning often lost or garbled |

### BLEU (Bilingual Evaluation Understudy)

A traditional MT quality metric based on n-gram overlap between model output and reference translations. Most useful for comparing models on the same domain and dataset. Less sensitive to subtle meaning shifts.

Range: 0 - 100, **Higher = better**

| **Score Range** | **Interpretation** |
|----------------|--------------------|
| > 50           | Excellent; near human quality, minimal post-editing needed |
| 30 - 50        | Adequate; understandable but with notable errors |
| < 30           | Weak; major issues in grammar, fluency, or meaning |
