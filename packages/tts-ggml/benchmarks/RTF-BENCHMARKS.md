# GGML TTS RTF + Streaming Benchmarks

This document covers the **cross-platform RTF and streaming latency** benchmark
system for the GGML (tts-cpp) TTS backend — the one wired into the
`Benchmark Performance (TTS GGML)` GitHub Actions workflow, with ingestion paths for
self-hosted `qvac-*` runners, the mobile AWS Device Farm leg, and off-CI manual
drops.

It mirrors the ONNX TTS benchmark suite
([`packages/tts-onnx/benchmarks/RTF-BENCHMARKS.md`](../../tts-onnx/benchmarks/RTF-BENCHMARKS.md))
so the two TTS backends share tooling and the consolidated findings tables line
up column-for-column.

Two benchmark tracks:

| Track | Entry point (npm) | What it measures | Artifact prefix |
|-------|-------------------|------------------|-----------------|
| Real-Time Factor (RTF) | `test:benchmark:rtf` | End-to-end RTF, P50/P95, cold RTF, load time, peak RSS, model size, tokens/s. | `rtf-benchmark-*.json` |
| Streaming latency | `test:benchmark:streaming` | Time-to-First-Audio (TTFA) + inter-chunk gap + chunk count, for `run({ streamOutput: true })`. | `streaming-benchmark-*.json` |
| Matrix (per-CI-job) | `test:benchmark:rtf:matrix` | Iterates multiple `(engine, useGPU, backend, threads)` combos in a single CI job, emitting one artifact each. | same as RTF |

All three write JSON under `benchmarks/results/` (CI-only; committed manually
only in `benchmarks/manual-results/`). Every measured run also prints canonical
marker lines (`[PERF_REPORT_START]<json>[PERF_REPORT_END]`, plus chunked
`[PERF_CHUNK:id:idx:total]<fragment>` for transports with line-length limits)
carrying the shared perf-report schema (`addon: 'tts-ggml'`). The shared
`scripts/perf-report/extract-from-log.js` rebuilds the JSON from Device Farm
logs when the filesystem isn't accessible.

## GGML vs ONNX — what's different

- **Quantisation is baked into the GGUF.** The QVAC model registry serves
  `q4_0` weights for the T3 / Supertonic models and `f16` for the S3Gen
  vocoder. There is no `fp32 / fp16 / q4 / q4f16` file-selection axis like ONNX;
  the `variant` field is a **label** (default `q4`) used for the artifact name
  and report column.
- **Engines** are `chatterbox`, `chatterbox-mtl`, `supertonic`,
  `supertonic-mtl` (the ONNX `chatterbox-en` / `chatterbox-multi` split maps to
  `chatterbox` / `chatterbox-mtl`).
- **GPU backends** are Vulkan (linux / win32 / android), Metal (darwin / ios),
  and CUDA / OpenCL only when explicitly hinted. The active backend is reported
  by the addon as `stats.backendId` (0=CPU, 1=Metal, 2=CUDA, 3=Vulkan,
  4=OpenCL).
- **Models come from the QVAC registry**, not HuggingFace. CI runs
  `npm run download-models:registry` on the `qvac-*` self-hosted runners before
  the benchmark; the `test/utils/downloadModel.js` `ensure*` helpers also fetch
  opportunistically via `@qvac/registry-client` (a devDependency).

## Quickstart (local)

```bash
# Pull the GGUFs first (registry-client devDependency required)
npm --prefix packages/tts-ggml run download-models:registry

# Single combo — CPU, Chatterbox English, 1 warmup + 5 measured runs
npm --prefix packages/tts-ggml run test:benchmark:rtf

# Single combo — Vulkan GPU
QVAC_TTS_GGML_BENCHMARK_USE_GPU=true \
QVAC_TTS_GGML_BENCHMARK_BACKEND=vulkan \
QVAC_TTS_GGML_BENCHMARK_DEVICE="RTX 4090 box" \
QVAC_TTS_GGML_BENCHMARK_RUNNER=manual-zbig \
npm --prefix packages/tts-ggml run test:benchmark:rtf

# Matrix via one npm invocation
QVAC_TTS_GGML_BENCHMARK_MATRIX_JSON='[
  {"engine":"chatterbox","useGPU":false,"backendHint":"cpu"},
  {"engine":"chatterbox-mtl","useGPU":false,"backendHint":"cpu"},
  {"engine":"supertonic","useGPU":false,"backendHint":"cpu"},
  {"engine":"supertonic-mtl","useGPU":false,"backendHint":"cpu"}
]' npm --prefix packages/tts-ggml run test:benchmark:rtf:matrix

# Streaming latency (TTFA + inter-chunk gap)
QVAC_TTS_GGML_BENCHMARK_ENGINE=chatterbox \
npm --prefix packages/tts-ggml run test:benchmark:streaming

# Aggregate what you've run so far (no CI required)
node scripts/perf-report/aggregate-tts-ggml-rtf.js \
  --dir packages/tts-ggml/benchmarks/results \
  --manual-dir packages/tts-ggml/benchmarks/manual-results \
  --output /tmp/tts-ggml-performance-findings.md \
  --output-json /tmp/tts-ggml-performance-findings.json
```

## Environment variables

### Controlling a single run (both RTF and streaming benchmarks accept these)

| Env var | Default | Purpose |
|---------|---------|---------|
| `QVAC_TTS_GGML_BENCHMARK_ENGINE` | `chatterbox` | One of `chatterbox` / `chatterbox-mtl` / `supertonic` / `supertonic-mtl`. |
| `QVAC_TTS_GGML_BENCHMARK_VARIANT` | `q4` | Label only — one of `q4` / `q8` / `f16` / `mixed`. The GGUF on the registry determines the real quant. |
| `QVAC_TTS_GGML_BENCHMARK_USE_GPU` | `0` | `1` / `true` to request GPU. Backend auto-derives from platform (Vulkan / Metal). |
| `QVAC_TTS_GGML_BENCHMARK_BACKEND` | (derived) | `cpu` / `metal` / `vulkan` / `cuda` / `opencl`. Used in reports and to differentiate rows. |
| `QVAC_TTS_GGML_BENCHMARK_DEVICE` | — | Device label rendered in the `Device` column. |
| `QVAC_TTS_GGML_BENCHMARK_RUNNER` | — | CI / runner label rendered in reports. |
| `QVAC_TTS_GGML_BENCHMARK_LABEL` | — | Free-form tag. Appears in the artifact filename and in the `Label` column. |
| `QVAC_TTS_GGML_BENCHMARK_NUM_THREADS` | — | Override `std::thread::hardware_concurrency()` (forwarded to the engine as `threads`). |

### RTF benchmark only

| Env var | Default | Purpose |
|---------|---------|---------|
| `QVAC_TTS_GGML_BENCHMARK_WARMUP_RUNS` | `1` | Warmup iterations before measurement (1st becomes `summary.coldRtf`). |
| `QVAC_TTS_GGML_BENCHMARK_RUNS` | `5` desktop / `3` mobile | Measured iterations. |
| `QVAC_TTS_GGML_BENCHMARK_RTF_UPPER_BOUND` | — | If set, test **fails** when mean RTF exceeds it. Use as a catastrophic-regression guard. No bound = numbers-only. |

### Streaming benchmark only

| Env var | Default | Purpose |
|---------|---------|---------|
| `QVAC_TTS_GGML_STREAMING_WARMUP_RUNS` | `1` | Warmup iterations. |
| `QVAC_TTS_GGML_STREAMING_RUNS` | `3` desktop / `2` mobile | Measured iterations. |

### Matrix runner only

| Env var | Default | Purpose |
|---------|---------|---------|
| `QVAC_TTS_GGML_BENCHMARK_MATRIX_JSON` | (4-engine CPU default) | JSON array of `(engine, useGPU, backendHint, ...)` entries. |
| `QVAC_TTS_GGML_BENCHMARK_ENTRY_TIMEOUT_MS` | `600000` | Per-entry watchdog — a hung engine is SIGTERM'd so the matrix continues. |

### Mobile (Device Farm)

| Env var | Default | Purpose |
|---------|---------|---------|
| `QVAC_TTS_GGML_RUN_BENCHMARK_ON_MOBILE` | (unset) | Gates the `test/integration/{rtf,streaming}-benchmark.test.js` shims. The mobile workflow only sets it when dispatched with `run_rtf_benchmarks: true`; otherwise the shims soft-skip and the matrix entry goes green-with-skip. |

### GitHub Actions correlation (forwarded automatically)

The matrix runner forwards `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, `GITHUB_SHA`,
`GITHUB_REF_NAME`, `GITHUB_ACTOR`, `GITHUB_WORKFLOW`, `GITHUB_JOB`,
`GITHUB_SERVER_URL`, and `GITHUB_REPOSITORY` into each child benchmark run so
every report links back to the CI run that produced it.

## How the CI pipeline fits together

```
workflow_dispatch
  └── benchmark-performance-tts-ggml.yml  (orchestrator)
         ├── prebuilds-tts-ggml.yml          (build native addon)
         ├── desktop-benchmarks              (desktop matrix: CPU everywhere, Vulkan on GPU runners)
         ├── mobile-benchmarks               (run_mobile=true → Device Farm CPU)
         └── summarize job
               ├── downloads rtf-results-tts-ggml-* (desktop) + perf-report-tts-ggml-* (mobile)
               ├── runs aggregate-tts-ggml-rtf.js --manual-dir benchmarks/manual-results
               └── writes combined markdown + JSON to $GITHUB_STEP_SUMMARY + artifact
```

The orchestrator runs on `workflow_dispatch`. Desktop and mobile are both on by
default and can be disabled with the `run_desktop=false` / `run_mobile=false`
dispatch inputs. On-PR workflows do NOT run the benchmarks.

## CI runner coverage

The desktop matrix reuses the integration-test runner matrix. CPU benchmark
entries run across the desktop matrix; Vulkan entries run only on GPU-capable
`qvac-*-gpu` runners where the Vulkan ICD and baseline hardware are stable.

| Platform / Arch | Backend | CI source |
|---|---|---|
| linux / x64 | cpu + vulkan | `qvac-ubuntu2204-x64-gpu`, `qvac-ubuntu2404-x64-gpu` |
| linux / arm64 | cpu | `ubuntu-24.04-arm` |
| darwin / arm64 | cpu | `macos-14-xlarge` |
| darwin / x64 | cpu | `macos-15-large` |
| win32 / x64 | cpu | `qvac-win25-x64` |
| win32 / x64 | cpu + vulkan | `qvac-win25-x64-gpu` |
| Android | cpu | `run_mobile=true` — AWS Device Farm (this matrix runs CPU; GPU is opt-in via `useGPU`) |
| iOS | cpu | `run_mobile=true` — AWS Device Farm |
| darwin / arm64 | metal | **Manual** — hosted macOS Metal crashes ggml's encoder; drop JSON under `manual-results/` |
| linux / x64 | cuda | **Manual** — not in the default tts-cpp backend cascade; drop JSON under `manual-results/` |
| android | opencl | **Manual** — Adreno-only; drop JSON under `manual-results/` |

## How to read the findings table

The aggregated table carries:

- **Mean RTF / P50 / P95**: core perf numbers. Lower is faster. `< 1` = faster
  than real time.
- **Cold RTF**: RTF of the first warmup run — matters for short-lived processes
  that synthesise once and exit.
- **Mean Wall (ms)**: average wall time per synthesis.
- **Load (ms)**: `model.load()` time (loads + maps the GGUFs once).
- **Peak RSS (MB)**: high-water RSS observed across warmup + measured runs.
- **Model (MB)**: sum of the engine's GGUF files on disk.
- **Tokens/s**: populated from the addon's `runtimeStats`. `n/a` when absent.
- **Noisy**: `⚠` when stddev / mean > 15% — compare P50 instead.
- **Run**: links back to the GitHub Actions run.

Streaming rows (separate section below the main table) add TTFA stats and
inter-chunk latency. Supertonic emits a single chunk today, so its TTFA equals
total wall time.

## Adding a new platform

1. Add the matrix row to the `desktop-benchmarks` path in
   `.github/workflows/integration-test-tts-ggml.yml`, or dispatch
   `.github/workflows/benchmark-performance-tts-ggml.yml` with
   `benchmark_matrix_json` containing the `(engine, useGPU, backendHint)` combos.
2. Add the platform's GPU backend, if any, to
   `scripts/perf-report/aggregate-tts-ggml-rtf.js`'s `SUPPORTED_GPU_BACKENDS`.
3. For unavailable backends (CUDA, OpenCL, hosted-macOS Metal), drop fixtures
   under `manual-results/` — see `manual-results/README.md`.

## Regression guarding

The RTF benchmark supports `QVAC_TTS_GGML_BENCHMARK_RTF_UPPER_BOUND`. We
deliberately **don't** set a bound in CI yet — without accumulated baselines,
any bound would either trip on noise or fail to catch real regressions.
Recommended follow-up once the manually dispatched benchmark has a few runs
banked:

1. Read the P95 of the last 4 benchmark runs per `(platform, engine, gpu)` from the
   summarize JSON artifact.
2. Set `QVAC_TTS_GGML_BENCHMARK_RTF_UPPER_BOUND = P95 * 1.5` per matrix row.
3. Re-generate the matrix JSON with those bounds embedded as `rtfUpperBound`.
