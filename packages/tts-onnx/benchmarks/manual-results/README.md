# Manual Performance Results

Drop additional ONNX TTS benchmark JSON files in this directory when you need
to include supported GPU backends or devices that are **not available on CI**
(ROCm, discrete-GPU DirectML, specific Android OEMs not on Device Farm,
Windows CUDA-specific runs, etc.), or when you just want to capture a number
from a local engineer box.

This directory is read by **two** independent aggregators, each of which uses a
slightly different record shape. Both aggregators silently ignore records they
do not recognise, so it is safe to mix files for the two pipelines in the same
directory.

## Schema 1 — Supertonic desktop benchmark (Python + Whisper round-trip)

Use this shape when you have results from the Supertonic HTTP-server benchmark
(addon vs Python baseline + WER/CER). The preferred input is the JSON artifact
shape emitted by the Supertonic benchmark client, for example:

```json
{
  "benchmark": "supertonic-rtf",
  "platform": "linux-x64",
  "implementation": {
    "key": "addon",
    "name": "supertone-onnx-addon"
  },
  "labels": {
    "device": "local-rocm-box",
    "runner": "manual",
    "backend": "rocm"
  },
  "requested": {
    "useGPU": true
  },
  "dataset": {
    "language": "en"
  },
  "model": {
    "variant": "supertonic-v1"
  },
  "summary": {
    "rtf": {
      "mean": 0.42,
      "p50": 0.41,
      "p95": 0.46
    },
    "generationMs": {
      "mean": 812
    },
    "loadTimeMs": {
      "mean": 245
    }
  },
  "quality": {
    "wer": {
      "mean": 0.031
    },
    "cer": {
      "mean": 0.012
    }
  }
}
```

These files are picked up automatically by:

- `scripts/perf-report/aggregate-supertonic-rtf.js`
- `.github/workflows/benchmark-performance-tts-onnx.yml`

Use this directory for results such as:

- Linux ROCm devices
- Windows CUDA-specific runs
- Any other supported backend or desktop device combination that the CI matrix cannot host

## Schema 2 — ONNX TTS RTF benchmark (rtf-benchmark.test.js)

Use this shape when you have results from the multi-engine RTF benchmark
(`test/benchmark/rtf-benchmark.test.js`).

These files are read automatically by:

- `scripts/perf-report/aggregate-onnx-tts-rtf.js` (via its `--manual-dir` arg)
- The `summarize` job in `.github/workflows/benchmark-rtf-tts-onnx.yml`

### Starter templates (copy, don't edit in place)

Two ready-to-fill templates live next to this README:

- `ROCM_TEMPLATE.json.example` — full schema (same as what the desktop
  benchmark writes into `benchmarks/results/rtf-benchmark-*.json`).
- `COMPACT_SUMMARY_TEMPLATE.json.example` — compact "summary-only" shape (same
  shape the mobile log extractor produces).

Files ending in `.json.example` are **skipped** by the aggregator. Rename to
`.json` to activate. Any `.json` file in this directory is picked up.

### Schema overview (v2)

The canonical shape includes:

| Field                         | Type     | Required | What it means |
|-------------------------------|----------|----------|---------------|
| `schemaVersion`               | number   | no       | Report schema version (currently `2`). |
| `platform` / `platformName` / `arch` | string   | yes      | e.g. `linux-x64`, `linux`, `x64`. Used for platform column. |
| `engine`                      | string   | yes      | `chatterbox-en` / `chatterbox-multi` / `supertonic`. |
| `model.variant`               | string   | yes      | `fp32` / `fp16` / `q4` / `q4f16`. |
| `model.sizeBytes`             | number   | no       | Sum of model files on disk. Shown as `Model (MB)`. |
| `labels.backend`              | string   | yes      | `cpu` / `coreml` / `cuda` / `directml` / `nnapi` / `rocm`. |
| `labels.device`               | string   | yes      | Human-readable device identifier (goes into the `Device` column). |
| `labels.label`                | string   | no       | Free-form tag — used for variant / thread sweeps. |
| `requested.useGPU`            | boolean  | yes      | `true` → `GPU` row; `false` → `CPU` row. |
| `requested.numThreads`        | number?  | no       | Only meaningful on CPU. Shown as `threads=N` in the label column. |
| `correlation.githubRunId/Sha/Actor/Workflow` | string | no | Optional trace back to a CI run. Blank for local/manual. |
| `summary.rtf.{mean,p50,p95,stddev,count}` | object  | yes      | RTF stats across measured runs. |
| `summary.wallMs.{mean,...}`   | object   | yes      | Per-run wall time. |
| `summary.tokensPerSecond.{mean,...}` | object | no    | Available on engines that report `tokensPerSecond`. |
| `summary.coldRtf`             | number?  | no       | RTF of the first warmup run (captures cold path). |
| `summary.modelLoadMs`         | number?  | no       | `load()` wall time. |
| `summary.peakRssBytes`        | number?  | no       | Max RSS observed across warmup + measured runs. |
| `summary.modelSizeBytes`      | number?  | no       | Same value as `model.sizeBytes`; either field is acceptable. |
| `summary.noisy`               | boolean? | no       | When `true`, aggregator prints `⚠` in the Noisy column. If absent, it's derived from `stddev/mean > 0.15`. |

Absolute minimum to get a row rendered: `platform`, `engine`, `model.variant`,
`labels.backend`, `labels.device`, `requested.useGPU`, `summary.rtf.{mean,p50,p95}`.

### File naming convention

Any filename ending in `.json` in this directory is picked up. The
convention used by CI artifacts is:

```
rtf-benchmark-<platform>-<engine>-<variant>-<cpu|gpu>[-<label>].json
```

Using that same convention for manual files is optional but keeps the
`Notes` column readable.

### Typical use cases

- **ROCm** desktops (AMD GPU, not on CI).
- **Discrete DirectML** on Windows dev boxes (the hosted `windows-2022`
  runner uses the Microsoft Basic Render driver).
- **Specific Android OEMs** that aren't in the AWS Device Farm pool (e.g.
  Qualcomm QNN variants).
- **Pre-hardware-pool** engineer numbers — "my M1 Mac Mini before we wire up
  CI for this device".

### Quickstart

```bash
# 1. Capture locally
QVAC_ONNX_TTS_BENCHMARK_USE_GPU=true \
QVAC_ONNX_TTS_BENCHMARK_BACKEND=rocm \
QVAC_ONNX_TTS_BENCHMARK_DEVICE=my-rocm-box \
QVAC_ONNX_TTS_BENCHMARK_RUNNER=manual-zbig \
npm --prefix packages/tts-onnx run test:benchmark:rtf

# 2. Copy the artifact in, rename / commit
cp packages/tts-onnx/benchmarks/results/rtf-benchmark-*.json \
   packages/tts-onnx/benchmarks/manual-results/

# 3. Re-run the aggregator to see the row locally
node scripts/perf-report/aggregate-onnx-tts-rtf.js \
  --dir benchmark-artifacts \
  --manual-dir packages/tts-onnx/benchmarks/manual-results \
  --output /tmp/onnx-tts-performance-findings.md
```
