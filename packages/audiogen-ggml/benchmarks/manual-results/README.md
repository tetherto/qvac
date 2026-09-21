# Manual Performance Results (AudioGen GGML)

Drop ACE-Step RTF benchmark JSON files here to get rows for hardware or backends
CI cannot cover — CUDA and OpenCL (both outside the default audiogen-cpp
cascade), discrete-GPU boxes outside the self-hosted runner pool, or a phone
that is not in the AWS Device Farm pool.

The aggregator reads this directory through its `--manual-dir` argument:

- `scripts/perf-report/aggregate-audiogen-ggml-rtf.js`
- the `summarize` job in `.github/workflows/benchmark-performance-audiogen-ggml.yml`

Any `.json` file here is picked up. Files ending in `.json.example` are skipped —
copy one to `.json` to activate it. Records the aggregator does not recognise are
ignored.

## Accepted shapes

Three shapes work, so you can usually drop an artifact in unmodified:

1. **Full artifact** — exactly what `npm run test:benchmark:rtf` writes into
   `benchmarks/results/rtf-benchmark-*.json`. Just copy the file.
2. **Canonical report** — the `[PERF_REPORT_START]` payload the mobile lane
   emits (`schema_version: "1.0"`, `addon: "audiogen-ggml"`).
3. **Flat record** — the hand-authored shape below, for numbers you measured
   without the harness.

A file may also contain an array of records, or `{ "records": [...] }`.

## Flat record fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `device` | string | yes | Human-readable device identifier (the `Device` column). |
| `platform` | string | yes | e.g. `linux-x64`, `darwin-arm64`. |
| `platformFamily` | string | no | `linux` / `darwin` / `win32` / `android` / `ios`. Used to resolve the backend when `backend` is absent. |
| `ditVariant` | string | no | `turbo-q4` (default) / `turbo-q8` / `sft`. |
| `useGPU` | boolean | no | `true` renders a `gpu` row, `false` a `cpu` row. |
| `backend` | string | no | `cpu` / `vulkan` / `metal` / `cuda` / `opencl`. Wins over the platform default — this is how a CUDA or OpenCL row gets labelled. |
| `gpuModel` | string | no | e.g. `RTX 4090`, `Adreno 750`. |
| `label` | string | no | Free-form tag. |
| `durationS` | number | no | Clip length in seconds. |
| `inferenceSteps` / `numThreads` | number | no | Schedule and thread overrides, when not the engine defaults. |
| `meanRtf` | number | yes | Mean RTF across measured runs. |
| `p50` / `p95` / `stddev` | number | no | RTF distribution. |
| `coldRtf` | number | no | RTF of the first warmup render. |
| `wallMs` / `audioMs` | number | no | Mean per-run wall time and rendered audio duration. |
| `modelLoadMs` | number | no | `load()` wall time. |
| `avgRssMb` / `peakRssMb` / `reclaimedMb` | number | no | Memory figures; render as `n/a` when absent. |
| `modelSizeMb` | number | no | Total size of the variant's four GGUFs. |
| `noisy` | boolean | no | Derived from `stddev / mean > 0.15` when omitted. |
| `notes` | string | no | Free text; defaults to the filename. |

Minimum for a usable row: `device`, `platform`, `ditVariant`, `useGPU`,
`backend`, `meanRtf`.

## Quickstart

```bash
# 1. Capture locally
QVAC_AUDIOGEN_GGML_BENCHMARK_DIT_VARIANT=turbo-q8 \
QVAC_AUDIOGEN_GGML_BENCHMARK_USE_GPU=true \
QVAC_AUDIOGEN_GGML_BENCHMARK_BACKEND=cuda \
QVAC_AUDIOGEN_GGML_BENCHMARK_DEVICE=my-cuda-box \
QVAC_AUDIOGEN_GGML_BENCHMARK_RUNNER=manual \
npm --prefix packages/audiogen-ggml run test:benchmark:rtf

# 2. Copy the artifact in
cp packages/audiogen-ggml/benchmarks/results/rtf-benchmark-*.json \
   packages/audiogen-ggml/benchmarks/manual-results/

# 3. Render the table to check the row landed
node scripts/perf-report/aggregate-audiogen-ggml-rtf.js \
  --dir packages/audiogen-ggml/benchmarks/results \
  --manual-dir packages/audiogen-ggml/benchmarks/manual-results \
  --output /tmp/audiogen-ggml-performance-findings.md
```
