# Manual Performance Results (GGML TTS)

Drop GGML TTS RTF benchmark JSON files in this directory when you need to
include supported backends or devices that are **not available on CI** —
Adreno OpenCL phones, discrete-GPU Vulkan boxes outside the self-hosted runner
pool, hosted-macOS Metal (which crashes ggml's encoder under CI), or numbers
from a local engineer box.

Files are read by the RTF aggregator via its `--manual-dir` argument:

- `scripts/perf-report/aggregate-tts-ggml-rtf.js`
- the `summarize` job in `.github/workflows/benchmark-rtf-tts-ggml.yml`

Any `.json` file in this directory is picked up. Files ending in `.json.example`
are **skipped** — rename to `.json` to activate. Records the aggregator does not
recognise are silently ignored.

## Starter templates (copy, don't edit in place)

Two ready-to-fill templates live next to this README:

- `VULKAN_TEMPLATE.json.example` — full schema (same shape the desktop benchmark
  writes into `benchmarks/results/rtf-benchmark-*.json`).
- `COMPACT_SUMMARY_TEMPLATE.json.example` — compact "summary-only" shape (same
  shape the mobile log extractor produces).

## Schema overview (v2)

The canonical shape includes:

| Field                         | Type     | Required | What it means |
|-------------------------------|----------|----------|---------------|
| `schemaVersion`               | number   | no       | Report schema version (currently `2`). |
| `platform` / `platformName` / `arch` | string   | yes      | e.g. `linux-x64`, `linux`, `x64`. Used for the platform column. |
| `engine`                      | string   | yes      | `chatterbox` / `chatterbox-mtl` / `supertonic` / `supertonic-mtl`. |
| `model.variant`               | string   | no       | Label: `q4` / `q8` / `f16` / `mixed` (default `q4`). |
| `model.sizeBytes`             | number   | no       | Sum of the engine's GGUF files on disk. Shown as `Model (MB)`. |
| `labels.backend`              | string   | yes      | `cpu` / `metal` / `vulkan` / `opencl`. |
| `labels.device`               | string   | yes      | Human-readable device identifier (goes into the `Device` column). |
| `labels.label`                | string   | no       | Free-form tag. |
| `requested.useGPU`            | boolean  | yes      | `true` → `GPU` row; `false` → `CPU` row. |
| `requested.numThreads`        | number?  | no       | Shown as `threads=N` in the label column. |
| `correlation.githubRunId/Sha/Actor/Workflow` | string | no | Optional trace back to a CI run. Blank for local/manual. |
| `summary.rtf.{mean,p50,p95,stddev,count}` | object  | yes      | RTF stats across measured runs. |
| `summary.wallMs.{mean,...}`   | object   | yes      | Per-run wall time. |
| `summary.tokensPerSecond.{mean,...}` | object | no    | Available on engines that report `tokensPerSecond`. |
| `summary.coldRtf`             | number?  | no       | RTF of the first warmup run (captures cold path). |
| `summary.modelLoadMs`         | number?  | no       | `load()` wall time. |
| `summary.peakRssBytes`        | number?  | no       | Max RSS observed across warmup + measured runs. |
| `summary.modelSizeBytes`      | number?  | no       | Same value as `model.sizeBytes`; either field is acceptable. |
| `summary.noisy`               | boolean? | no       | When `true`, aggregator prints `⚠`. If absent, derived from `stddev/mean > 0.15`. |

Absolute minimum to get a row rendered: `platform`, `engine`, `labels.backend`,
`labels.device`, `requested.useGPU`, `summary.rtf.{mean,p50,p95}`.

## File naming convention

The convention used by CI artifacts is:

```
rtf-benchmark-<platform>-<engine>-<variant>-<cpu|gpu>[-<label>].json
```

Using that same convention for manual files is optional but keeps the `Notes`
column readable.

## Typical use cases

- **Discrete-GPU Vulkan** desktops outside the self-hosted runner pool.
- **Adreno OpenCL** Android phones not in the AWS Device Farm pool.
- **Apple Silicon Metal** numbers from a local Mac (hosted macOS runners force
  `NO_GPU=true` because the Paravirtual Metal device crashes ggml's encoder).
- **Pre-hardware-pool** engineer numbers.

## Quickstart

```bash
# 1. Capture locally
QVAC_TTS_GGML_BENCHMARK_USE_GPU=true \
QVAC_TTS_GGML_BENCHMARK_BACKEND=vulkan \
QVAC_TTS_GGML_BENCHMARK_DEVICE=my-vulkan-box \
QVAC_TTS_GGML_BENCHMARK_RUNNER=manual-zbig \
npm --prefix packages/tts-ggml run test:benchmark:rtf

# 2. Copy the artifact in
cp packages/tts-ggml/benchmarks/results/rtf-benchmark-*.json \
   packages/tts-ggml/benchmarks/manual-results/

# 3. Re-run the aggregator to see the row locally
node scripts/perf-report/aggregate-tts-ggml-rtf.js \
  --dir packages/tts-ggml/benchmarks/results \
  --manual-dir packages/tts-ggml/benchmarks/manual-results \
  --output /tmp/tts-ggml-performance-findings.md
```
