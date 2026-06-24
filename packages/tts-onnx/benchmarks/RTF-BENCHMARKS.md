# ONNX TTS RTF + Streaming Benchmarks

This document covers the **cross-platform RTF and streaming latency** benchmark
system — the one wired into the `Benchmark RTF (ONNX TTS)` GitHub Actions
workflow, with ingestion paths for GitHub-hosted runners, self-hosted runners,
and off-CI manual drops. For the separate quality / accuracy vs Python-native
comparison, see [`README.md`](./README.md) in this directory.

Two benchmark tracks:

| Track | Entry point (npm) | What it measures | Artifact prefix |
|-------|-------------------|------------------|-----------------|
| Real-Time Factor (RTF) | `test:benchmark:rtf` | End-to-end RTF, P50/P95, cold RTF, load time, peak RSS, model size, tokens/s. | `rtf-benchmark-*.json` |
| Streaming latency | `test:benchmark:streaming` | Time-to-First-Audio (TTFA) + inter-chunk gap + chunk count, for `run({ streamOutput: true })`. | `streaming-benchmark-*.json` |
| Matrix (per-CI-job) | `test:benchmark:rtf:matrix` | Iterates multiple `(engine, useGPU, variant, threads)` combos in a single CI job, emitting one artifact each. | same as RTF |

All three write JSON under `benchmarks/results/` (git-ignored for CI; committed
manually only in `benchmarks/manual-results/`). Every measured run also prints
canonical marker lines (`[PERF_REPORT_START]<json>[PERF_REPORT_END]`, plus
chunked `[PERF_CHUNK:id:idx:total]<fragment>` for transports with line-length
limits) carrying the shared perf-report schema (`addon: 'onnx-tts'`). The
shared `scripts/perf-report/extract-from-log.js` rebuilds the JSON from logs
when the filesystem isn't accessible, then `aggregate.js` +
`render-step-summary.js` produce the rendered Step Summary.

> **Mobile RTF benchmarks** (Android / iOS via AWS Device Farm) are tracked
> separately under QVAC-18544 and are intentionally NOT wired into this
> orchestrator yet. The aggregator and report schema already understand
> mobile-shaped records, so once the mobile pipeline lands the consolidated
> findings table will pick them up automatically.

## Quickstart (local)

```bash
# Single combo — CPU, Chatterbox English, q4, 1 warmup + 5 measured runs
npm --prefix packages/tts-onnx run test:benchmark:rtf

# Single combo — CoreML on Apple silicon
QVAC_ONNX_TTS_BENCHMARK_USE_GPU=true \
QVAC_ONNX_TTS_BENCHMARK_BACKEND=coreml \
QVAC_ONNX_TTS_BENCHMARK_DEVICE="M3 Pro MacBook" \
QVAC_ONNX_TTS_BENCHMARK_RUNNER=manual-zbig \
npm --prefix packages/tts-onnx run test:benchmark:rtf

# Matrix via one npm invocation
QVAC_ONNX_TTS_BENCHMARK_MATRIX_JSON='[
  {"engine":"chatterbox-en","useGPU":false,"backendHint":"cpu"},
  {"engine":"chatterbox-multi","useGPU":false,"backendHint":"cpu"},
  {"engine":"supertonic","useGPU":false,"backendHint":"cpu"}
]' npm --prefix packages/tts-onnx run test:benchmark:rtf:matrix

# Streaming latency (TTFA + inter-chunk gap)
QVAC_ONNX_TTS_BENCHMARK_ENGINE=supertonic \
npm --prefix packages/tts-onnx run test:benchmark:streaming

# Aggregate what you've run so far (no CI required)
node scripts/perf-report/aggregate-onnx-tts-rtf.js \
  --dir packages/tts-onnx/benchmarks/results \
  --manual-dir packages/tts-onnx/benchmarks/manual-results \
  --output /tmp/onnx-tts-performance-findings.md \
  --output-json /tmp/onnx-tts-performance-findings.json
```

## Environment variables

### Controlling a single run (both RTF and streaming benchmarks accept these)

| Env var | Default | Purpose |
|---------|---------|---------|
| `QVAC_ONNX_TTS_BENCHMARK_ENGINE` | `chatterbox-en` | One of `chatterbox-en` / `chatterbox-multi` / `supertonic`. |
| `QVAC_ONNX_TTS_BENCHMARK_VARIANT` | `q4` | One of `fp32` / `fp16` / `q4` / `q4f16`. |
| `QVAC_ONNX_TTS_BENCHMARK_USE_GPU` | `0` | `1` / `true` to request GPU. Backend auto-derives from platform. |
| `QVAC_ONNX_TTS_BENCHMARK_BACKEND` | (derived) | `cpu` / `coreml` / `cuda` / `directml` / `nnapi` / `rocm`. Used in reports and to differentiate rows. |
| `QVAC_ONNX_TTS_BENCHMARK_DEVICE` | — | Device label rendered in the `Device` column. |
| `QVAC_ONNX_TTS_BENCHMARK_RUNNER` | — | CI / runner label rendered in reports. |
| `QVAC_ONNX_TTS_BENCHMARK_LABEL` | — | Free-form tag. Used for variant sweeps (`variant-sweep`) and thread sweeps (`threads-4`). Appears in the artifact filename and in the `Label` column. |

### RTF benchmark only

| Env var | Default | Purpose |
|---------|---------|---------|
| `QVAC_ONNX_TTS_BENCHMARK_WARMUP_RUNS` | `1` | Warmup iterations before measurement (1st of these becomes `summary.coldRtf`). |
| `QVAC_ONNX_TTS_BENCHMARK_RUNS` | `5` desktop / `3` mobile | Measured iterations. |
| `QVAC_ONNX_TTS_BENCHMARK_RTF_UPPER_BOUND` | — | If set, test **fails** when mean RTF exceeds it. Use as a catastrophic-regression guard (e.g. `10.0`). No bound = numbers-only, no pass/fail gate on RTF. |
| `QVAC_ONNX_TTS_BENCHMARK_NUM_THREADS` | — | Requested CPU thread count. **Currently plumbed into the report, but the ONNX addon's `numThreads` option is still landing** via QVAC-17236 — the field is reported but does not yet change thread count until that PR merges and the utility loaders (`test/utils/runChatterboxTTS.js`, `test/utils/runSupertonicTTS.js`) forward the option. |

### Streaming benchmark only

| Env var | Default | Purpose |
|---------|---------|---------|
| `QVAC_ONNX_TTS_STREAMING_WARMUP_RUNS` | `1` | Warmup iterations. |
| `QVAC_ONNX_TTS_STREAMING_RUNS` | `3` desktop / `2` mobile | Measured iterations (streaming is slower to accumulate). |

### GitHub Actions correlation (forwarded automatically)

The matrix runner forwards `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, `GITHUB_SHA`,
`GITHUB_REF_NAME`, `GITHUB_ACTOR`, `GITHUB_WORKFLOW`, `GITHUB_JOB`,
`GITHUB_SERVER_URL`, and `GITHUB_REPOSITORY` into each child benchmark run so
every report links back to the CI run that produced it. For local runs these
are simply empty.

## How the CI pipeline fits together

```
workflow_dispatch / cron schedule
  └── benchmark-rtf-tts-onnx.yml  (orchestrator)
         ├── prebuilds-tts-onnx.yml       (build native addon)
         ├── integration-test-tts-onnx.yml  (run_rtf_benchmarks=true)
         │     ├── github-hosted matrix (q4 on every unique platform; +variant sweep on darwin-arm64)
         │     └── self-hosted benchmarks (CPU baseline + CUDA gap; +numThreads sweep on CPU)
         └── summarize job
               ├── downloads rtf-results-tts-*
               ├── runs aggregate-onnx-tts-rtf.js --manual-dir benchmarks/manual-results
               └── writes combined markdown + JSON to $GITHUB_STEP_SUMMARY + artifact
```

The orchestrator runs on `workflow_dispatch` and on `cron: '0 6 * * 1'`
(Monday 06:00 UTC — builds weekly baseline). On-PR workflows do NOT run the
benchmarks; they remain opt-in via `run_rtf_benchmarks: true` on the desktop
workflow.

## CI runner coverage

| Platform / Arch | Backend | CI source |
|---|---|---|
| linux / x64 | cpu | `ubuntu-22.04` (GitHub) + `ai-run-ubuntu-22.04` (self-hosted, stable baseline + thread sweep) |
| linux / arm64 | cpu | `ubuntu-24.04-arm` |
| linux / x64 | cuda | `ai-run-linux-gpu` (self-hosted) |
| darwin / arm64 | cpu + coreml + variant sweep (fp32/fp16/q4/q4f16) | `macos-14-xlarge` |
| darwin / x64 | cpu + coreml | `macos-15-large` |
| win32 / x64 | cpu + directml | `windows-2022` |
| iOS | cpu + coreml | **QVAC-18544** — AWS Device Farm wiring tracked separately |
| Android | cpu + nnapi | **QVAC-18544** — AWS Device Farm wiring tracked separately |
| linux / x64 | rocm | **Manual** — drop JSON under `manual-results/` |

Not yet in this PR: mobile RTF benchmarks (split out under QVAC-18544),
Qualcomm QNN-only Android variants (Device Farm doesn't pool those
separately), discrete-GPU DirectML dev boxes.

## How to read the findings table

The aggregated table carries:

- **Mean RTF / P50 / P95**: core perf numbers. Lower is faster. `< 1` = faster
  than real time.
- **Cold RTF**: RTF of the first warmup run — matters a lot for short-lived
  processes that synthesise once and exit.
- **Mean Wall (ms)**: average wall time per synthesis (useful when comparing
  engines that produce different-length audio).
- **Load (ms)**: `model.load()` time. Separate from warm/cold RTF.
- **Peak RSS (MB)**: high-water RSS observed across warmup + measured runs.
- **Model (MB)**: sum of model files on disk (tokenizer + embed + encoder +
  decoder + LM, as applicable).
- **Tokens/s**: populated from the addon's own `runtimeStats`. `n/a` when the
  engine doesn't report it.
- **Noisy**: `⚠` when stddev / mean > 15% — treat those numbers as advisory,
  compare P50 instead.
- **Run**: links back to the GitHub Actions run (when the report carries
  `correlation.githubRunId`).

Streaming rows (separate section below the main table) add TTFA stats and
inter-chunk latency.

## Adding a new platform

1. Add the matrix row to
   `.github/workflows/integration-test-tts-onnx.yml` under the
   GitHub-hosted matrix (or the `run-benchmarks-self-hosted` job for
   self-hosted runners). Include a `benchmark_matrix_json` with the
   `(engine, useGPU, backendHint)` combos to run.
2. Add the platform's GPU backend, if any, to
   `scripts/perf-report/aggregate-onnx-tts-rtf.js`'s `SUPPORTED_GPU_BACKENDS`.
3. For unavailable GPUs (ROCm, QNN, etc.), drop fixtures under
   `manual-results/` — see `manual-results/README.md`.

## Regression guarding

The RTF benchmark supports `QVAC_ONNX_TTS_BENCHMARK_RTF_UPPER_BOUND`. We
deliberately **don't** set a bound in CI yet — without accumulated baselines,
any bound would either trip on noise (too tight) or fail to catch real
regressions (too loose). Recommended follow-up once the weekly cron has run a
few times:

1. Read the P95 of the last 4 weekly runs per `(platform, engine, gpu)` from
   the summarize JSON artifact.
2. Set `QVAC_ONNX_TTS_BENCHMARK_RTF_UPPER_BOUND = P95 * 1.5` per matrix row.
3. Re-generate the matrix JSON with those bounds embedded as `rtfUpperBound`.
