# GGML TTS RTF + Streaming + Quality Benchmarks

This document covers the **cross-platform RTF, streaming latency, and optional
round-trip speech quality** benchmark
system for the GGML (tts-cpp) TTS backend — the one wired into the
`Benchmark Performance (TTS GGML)` GitHub Actions workflow, with ingestion paths for
self-hosted `qvac-*` runners, the mobile AWS Device Farm leg, and off-CI manual
drops.

It follows the same RTF and streaming benchmark methodology used across QVAC's
TTS backends so the consolidated findings tables line up column-for-column.

Two benchmark tracks:

| Track                                     | Entry point (npm)           | What it measures                                                                                              | Artifact prefix              |
| ----------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Real-Time Factor (RTF) + optional quality | `test:benchmark:rtf`        | End-to-end RTF, P50/P95, cold RTF, load time, peak RSS, model size, tokens/s, and opt-in Whisper CER/WER.     | `rtf-benchmark-*.json`       |
| Streaming latency                         | `test:benchmark:streaming`  | Time-to-First-Audio (TTFA) + inter-chunk gap + chunk count, for `run({ streamOutput: true })`.                | `streaming-benchmark-*.json` |
| Matrix (per-CI-job)                       | `test:benchmark:rtf:matrix` | Iterates multiple `(engine, useGPU, backend, threads)` combos in a single CI job, emitting one artifact each. | same as RTF                  |

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
  `supertonic-mtl`, `supertonic3` (the ONNX `chatterbox-en` / `chatterbox-multi`
  split maps to `chatterbox` / `chatterbox-mtl`). `supertonic3` loads the
  `supertonic3-<quant>.gguf` tier via the same `ENGINE_SUPERTONIC` code path;
  the benchmark `variant` label picks the tier (`q4`→`q4_0`, `q8`→`q8_0`,
  `f16`→`f16`).
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

# Single combo — CPU, Chatterbox English, 1 warmup + 5 measured runs.
# Whisper round-trip quality is enabled by default.
npm --prefix packages/tts-ggml run test:benchmark:rtf

# Performance-only run without Whisper transcription.
QVAC_TTS_GGML_BENCHMARK_QUALITY=false \
npm --prefix packages/tts-ggml run test:benchmark:rtf

# Single combo — Vulkan GPU
QVAC_TTS_GGML_BENCHMARK_USE_GPU=true \
QVAC_TTS_GGML_BENCHMARK_BACKEND=vulkan \
QVAC_TTS_GGML_BENCHMARK_DEVICE="RTX 4090 box" \
QVAC_TTS_GGML_BENCHMARK_RUNNER=manual-zbig \
npm --prefix packages/tts-ggml run test:benchmark:rtf

# Matrix via one npm invocation. `enhancer` / `denoiser` fields add the LavaSR
# axes; the none/denoise/enhance/full quartet below isolates each stage's cost.
# `enhancerVariant` selects the enhancer quant tier per row (default f16).
QVAC_TTS_GGML_BENCHMARK_MATRIX_JSON='[
  {"engine":"chatterbox","useGPU":false,"backendHint":"cpu"},
  {"engine":"chatterbox-mtl","useGPU":false,"backendHint":"cpu"},
  {"engine":"supertonic","useGPU":false,"backendHint":"cpu"},
  {"engine":"supertonic-mtl","useGPU":false,"backendHint":"cpu"},
  {"engine":"supertonic","useGPU":false,"backendHint":"cpu","denoiser":"lavasr"},
  {"engine":"supertonic","useGPU":false,"backendHint":"cpu","enhancer":"lavasr"},
  {"engine":"supertonic","useGPU":false,"backendHint":"cpu","enhancer":"lavasr","enhancerVariant":"q8_0"},
  {"engine":"supertonic","useGPU":false,"backendHint":"cpu","denoiser":"lavasr","enhancer":"lavasr"}
]' npm --prefix packages/tts-ggml run test:benchmark:rtf:matrix

# Streaming latency (TTFA + inter-chunk gap)
QVAC_TTS_GGML_BENCHMARK_ENGINE=chatterbox \
npm --prefix packages/tts-ggml run test:benchmark:streaming

# LavaSR enhancer axis (48 kHz bandwidth extension layered on the engine).
# The published fp16/fp32 tiers fetch from the registry automatically (like the
# engine GGUF) and hard-fail if unreachable; point LAVASR_ENHANCER_GGUF at a
# converted GGUF to run offline or to benchmark a not-yet-published tier.
QVAC_TTS_GGML_BENCHMARK_ENGINE=supertonic \
QVAC_TTS_GGML_BENCHMARK_ENHANCER=lavasr \
LAVASR_ENHANCER_GGUF=/path/to/lavasr-enhancer.gguf \
npm --prefix packages/tts-ggml run test:benchmark:rtf

# LavaSR denoiser axis (speech denoiser that runs before the enhancer). Enable it
# alone, or together with the enhancer for the full LavaSR chain. Both default to
# the registry GGUF; LAVASR_DENOISER_GGUF points at a local copy (see below).
QVAC_TTS_GGML_BENCHMARK_ENGINE=supertonic \
QVAC_TTS_GGML_BENCHMARK_DENOISER=lavasr \
QVAC_TTS_GGML_BENCHMARK_ENHANCER=lavasr \
npm --prefix packages/tts-ggml run test:benchmark:rtf

# Aggregate what you've run so far (no CI required)
node scripts/perf-report/aggregate-tts-ggml-rtf.js \
  --dir packages/tts-ggml/benchmarks/results \
  --manual-dir packages/tts-ggml/benchmarks/manual-results \
  --output /tmp/tts-ggml-performance-findings.md \
  --output-json /tmp/tts-ggml-performance-findings.json
```

## Environment variables

### Controlling a single run (both RTF and streaming benchmarks accept these)

| Env var                                    | Default      | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QVAC_TTS_GGML_BENCHMARK_ENGINE`           | `chatterbox` | One of `chatterbox` / `chatterbox-mtl` / `supertonic` / `supertonic-mtl` / `supertonic3`.                                                                                                                                                                                                                                                                                                                                                                                 |
| `QVAC_TTS_GGML_BENCHMARK_VARIANT`          | `q4`         | Label only — one of `q4` / `q8` / `f16` / `mixed`. The GGUF on the registry determines the real quant.                                                                                                                                                                                                                                                                                                                                                                    |
| `QVAC_TTS_GGML_BENCHMARK_ENHANCER`         | `none`       | One of `none` / `lavasr`. `lavasr` layers the LavaSR 48 kHz bandwidth-extension enhancer on top of the engine output. A published tier (`f16`/`f32`) hard-fails if its GGUF can't be fetched (like the engine GGUF); an unpublished tier soft-skips (green). Adds `-lavasr` to the artifact name + a trailing token to the canonical label, and populates the `Enhancer` findings column.                                                                                 |
| `QVAC_TTS_GGML_BENCHMARK_ENHANCER_VARIANT` | `f16`        | Enhancer quant tier: one of `f16` / `f32` / `q8_0`. Only meaningful when `ENHANCER=lavasr`; picks which enhancer GGUF is fetched. `f16` is byte-stable (no extra token); any other tier appends `-<tier>` to the artifact name and renders as `lavasr/<tier>` in the `Enhancer` column. The published `f16`/`f32` tiers hard-fail if their GGUF can't be fetched (like the engine GGUF); a not-yet-published tier (`q8_0`) soft-skips (green) until its GGUF lands on S3. |
| `QVAC_TTS_GGML_BENCHMARK_DENOISER`         | `none`       | One of `none` / `lavasr`. `lavasr` runs the LavaSR speech denoiser before the enhancer. Orthogonal to the enhancer, so any of none/denoise/enhance/full can run. The denoiser is published, so it hard-fails if its GGUF can't be fetched (like the engine GGUF). Adds `-denoise` to the artifact name + a trailing token to the canonical label, and populates the `Denoiser` findings column.                                                                           |
| `QVAC_TTS_GGML_BENCHMARK_USE_GPU`          | `0`          | `1` / `true` to request GPU. Backend auto-derives from platform (Vulkan / Metal). The enhancer and denoiser share this switch (run on the same GPU backend as the engine).                                                                                                                                                                                                                                                                                                |
| `QVAC_TTS_GGML_BENCHMARK_BACKEND`          | (derived)    | `cpu` / `metal` / `vulkan` / `cuda` / `opencl`. Used in reports and to differentiate rows.                                                                                                                                                                                                                                                                                                                                                                                |
| `QVAC_TTS_GGML_BENCHMARK_DEVICE`           | —            | Device label rendered in the `Device` column.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `QVAC_TTS_GGML_BENCHMARK_RUNNER`           | —            | CI / runner label rendered in reports.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `QVAC_TTS_GGML_BENCHMARK_LABEL`            | —            | Free-form tag. Appears in the artifact filename and in the `Label` column.                                                                                                                                                                                                                                                                                                                                                                                                |
| `QVAC_TTS_GGML_BENCHMARK_NUM_THREADS`      | —            | Override `std::thread::hardware_concurrency()` (forwarded to the engine as `threads`).                                                                                                                                                                                                                                                                                                                                                                                    |

### RTF benchmark only

| Env var                                   | Default                  | Purpose                                                                                                                                                                                                                                                       |
| ----------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QVAC_TTS_GGML_BENCHMARK_WARMUP_RUNS`     | `1`                      | Warmup iterations before measurement (1st becomes `summary.coldRtf`).                                                                                                                                                                                         |
| `QVAC_TTS_GGML_BENCHMARK_RUNS`            | `5` desktop / `3` mobile | Measured iterations.                                                                                                                                                                                                                                          |
| `QVAC_TTS_GGML_BENCHMARK_RTF_UPPER_BOUND` | —                        | If set, test **fails** when mean RTF exceeds it. Use as a catastrophic-regression guard. No bound = numbers-only.                                                                                                                                             |
| `QVAC_TTS_GGML_BENCHMARK_QUALITY`         | `true`                   | Enable Whisper round-trip transcription and report mean/P50/P95 CER and WER. Set to `false` for a performance-only run. Quality evaluation runs after timed TTS synthesis and TTS memory collection.                                                          |
| `QVAC_TTS_GGML_BENCHMARK_WHISPER_MODEL`   | `ggml-small.bin`         | Whisper GGML model filename under `models/whisper/`: `ggml-tiny.bin`, `ggml-small.bin`, or `ggml-medium.bin`. The selected model is downloaded on demand when missing. Mobile benchmark runs use the smaller `ggml-tiny.bin`, which is pre-staged on Android. |
| `QVAC_TTS_GGML_BENCHMARK_WER_UPPER_BOUND` | —                        | Optional mean WER assertion as a ratio (`0.4` = 40%). Only applied when quality evaluation is enabled.                                                                                                                                                        |
| `QVAC_TTS_GGML_BENCHMARK_CER_UPPER_BOUND` | —                        | Optional mean CER assertion as a ratio (`0.2` = 20%). Only applied when quality evaluation is enabled.                                                                                                                                                        |

### Streaming benchmark only

| Env var                               | Default                  | Purpose              |
| ------------------------------------- | ------------------------ | -------------------- |
| `QVAC_TTS_GGML_STREAMING_WARMUP_RUNS` | `1`                      | Warmup iterations.   |
| `QVAC_TTS_GGML_STREAMING_RUNS`        | `3` desktop / `2` mobile | Measured iterations. |

### Matrix runner only

| Env var                                    | Default                | Purpose                                                                  |
| ------------------------------------------ | ---------------------- | ------------------------------------------------------------------------ |
| `QVAC_TTS_GGML_BENCHMARK_MATRIX_JSON`      | (4-engine CPU default) | JSON array of `(engine, useGPU, backendHint, ...)` entries.              |
| `QVAC_TTS_GGML_BENCHMARK_ENTRY_TIMEOUT_MS` | `600000`               | Per-entry watchdog — a hung engine is SIGTERM'd so the matrix continues. |

Matrix entries may set `quality`, `whisperModel`, `werUpperBound`, and
`cerUpperBound` to override the corresponding quality settings per row.

### Mobile (Device Farm)

| Env var                                 | Default | Purpose                                                                                                                                                                                                                          |
| --------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QVAC_TTS_GGML_RUN_BENCHMARK_ON_MOBILE` | (unset) | Gates the `test/integration/{rtf,streaming}-benchmark.test.js` shims. The mobile workflow only sets it when dispatched with `run_rtf_benchmarks: true`; otherwise the shims soft-skip and the matrix entry goes green-with-skip. |

Mobile quality reports identify their Whisper evaluator model so results produced
with `ggml-tiny.bin` are not conflated with desktop `ggml-small.bin` rows.

### GitHub Actions correlation (forwarded automatically)

The matrix runner forwards `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, `GITHUB_SHA`,
`GITHUB_REF_NAME`, `GITHUB_ACTOR`, `GITHUB_WORKFLOW`, `GITHUB_JOB`,
`GITHUB_SERVER_URL`, and `GITHUB_REPOSITORY` into each child benchmark run so
every report links back to the CI run that produced it.

## LavaSR enhancer + denoiser axes

LavaSR is not a standalone engine — it is a pair of post/pre-processing stages
that layer on an existing engine's output. Each is benchmarked as its own axis,
orthogonal to `engine` / `variant` / `useGPU` and to each other:

- **Enhancer** (`QVAC_TTS_GGML_BENCHMARK_ENHANCER` = `none` (default) | `lavasr`):
  a 48 kHz neural bandwidth-extension model that upsamples the engine's native
  24 kHz / 44.1 kHz output to 48 kHz. `QVAC_TTS_GGML_BENCHMARK_ENHANCER_VARIANT`
  (default `f16`) selects the enhancer quant tier — see "Enhancer quant tiers".
- **Denoiser** (`QVAC_TTS_GGML_BENCHMARK_DENOISER` = `none` (default) | `lavasr`):
  the UL-UNAS speech denoiser, which runs **before** the enhancer in the chain.

When a stage is on:

- both benchmark suites construct the model with `files.lavasrEnhancer` /
  `files.lavasrDenoiser` (each path is the "on" switch) and both stages share the
  engine's `useGPU` switch, so `useGPU:true` runs them on the same GPU backend
  (Vulkan / Metal);
- the stage's GGUF size is folded into the reported `Model (MB)`;
- the artifact name gains a `-lavasr` (enhancer) and/or `-denoise` (denoiser) tag,
  plus a `-<tier>` tag for a non-`f16` enhancer quant tier, right after `-lavasr`
  (`rtf-benchmark-<platform>-<engine>-<variant>-<cpu|gpu>[-lavasr][-<tier>][-denoise][-<label>].json`)
  and the canonical `[PERF_REPORT_START]` label gains the matching trailing
  token(s), so the aggregator surfaces the run in the `Enhancer` / `Denoiser`
  columns and dedupes each combination (including each quant tier) as a separate row.

### Isolating each stage's cost

The two axes are independent booleans, so the **none / denoise / enhance / full**
quartet for one `(engine, variant, gpu)` isolates each stage's marginal cost:
`denoise - none` is the denoiser's added RTF, `enhance - none` is the enhancer's,
and `full - none` is the combined chain (the matrix example above runs exactly
this quartet for Supertonic CPU). The addon reports one wall-clock / RTF per run
(no per-stage timers), so isolation comes from differencing these paired rows
rather than from a stage breakdown inside a single run.

### Resolving the enhancer GGUF

`test/utils/downloadModel.js` `ensureLavaSREnhancerGguf({ quant })` resolves, in
order (the selected tier picks both the on-disk filename and the registry path):

1. `LAVASR_ENHANCER_GGUF` (absolute path to a local GGUF);
2. a locally-staged `models/lavasr/lavasr-enhancer.gguf` (fp16 default) or
   `models/lavasr/lavasr-enhancer-<tier>.gguf` for any other tier (plus a couple
   of fallbacks), so tiers coexist on disk;
3. the QVAC registry — `qvac_models_compiled/ggml/lavasr/2026-06-26/lavasr-enhancer-<tier>.gguf`
   by default, or the path in `LAVASR_ENHANCER_REGISTRY_PATH` (+ optional
   `LAVASR_ENHANCER_REGISTRY_SOURCE`, default `s3`) to pull a one-off build.

The fp16 (~28 MB) and fp32 (~56 MB) enhancer GGUFs are published on the QVAC
registry under `qvac_models_compiled/ggml/lavasr/2026-06-26/`, so `enhancer=lavasr`
desktop rows fetch them the same way the engine GGUFs are fetched and collect
numbers with no extra setup. Because these tiers are published, a failure to
resolve one of them (registry unreachable / offline and no local copy) is a real
error and the row **hard-fails**, exactly like the engine GGUF — this keeps a
transient registry / network / auth failure from silently recording a false
green. Only a tier that isn't on S3 yet (currently `q8_0`) **soft-skips** (the
brittle test passes with a skip comment and writes no artifact) until its GGUF
lands; the `enhancer=none` rows still produce artifacts, so the desktop "zero
artifacts" guard never trips.

### Enhancer quant tiers

The enhancer weights are block-quantizable independently of the engine, so
`QVAC_TTS_GGML_BENCHMARK_ENHANCER_VARIANT` sweeps the enhancer as its own quant
axis (the C++ loader dequantizes the tier at load, so the forward math matches
fp32 and only the GGUF shrinks):

| Tier                    | Built by                                                        | On registry today   |
| ----------------------- | --------------------------------------------------------------- | ------------------- |
| `f16` (default) / `f32` | `scripts/convert-lavasr-enhancer-to-gguf.py --ftype <f16\|f32>` | yes                 |
| `q8_0`                  | `scripts/requantize-gguf.py <f16.gguf> <out.gguf> q8_0`         | not yet (soft-skip) |

`f16` is byte-stable: it keeps the historical `lavasr-enhancer.gguf` name, adds no
artifact/label token, and renders as `lavasr` in the `Enhancer` column. `f32` and
`q8_0` live at `lavasr-enhancer-<tier>.gguf`, append `-<tier>` after the `-lavasr`
artifact token, and render as `lavasr/<tier>`. The desktop CI matrix sweeps the
non-`f16` tiers on `supertonic` across CPU + the platform GPU; the `q8_0` row
soft-skips (green) until its GGUF lands on S3.

### Resolving the denoiser GGUF

`test/utils/downloadModel.js` `ensureLavaSRDenoiserGguf()` mirrors the enhancer
resolver, in order:

1. `LAVASR_DENOISER_GGUF` (absolute path to a local GGUF);
2. a locally-staged `models/lavasr/lavasr-denoiser.gguf` (and a couple of fallbacks);
3. the QVAC registry — `qvac_models_compiled/ggml/lavasr/2026-07-03/lavasr-denoiser-f16.gguf`
   by default, or the path in `LAVASR_DENOISER_REGISTRY_PATH` (+ optional
   `LAVASR_DENOISER_REGISTRY_SOURCE`, default `s3`).

The denoiser GGUF is published on the QVAC registry (fp16 ~0.5 MB, under
`qvac_models_compiled/ggml/lavasr/2026-07-03/`), so
`denoiser=lavasr` desktop rows fetch it automatically. Because it's published, an
unresolved denoiser **hard-fails** (like the engine GGUF and the published
enhancer tiers) rather than soft-skipping, so a real fetch failure surfaces
instead of a false green.

### Collecting LavaSR numbers locally

```bash
# 1. Run any engine with the enhancer and/or denoiser on (Supertonic + Chatterbox
#    are supported). Both GGUFs are pulled from the QVAC registry automatically,
#    exactly like the engine GGUFs (needs registry access + @qvac/registry-client).
QVAC_TTS_GGML_BENCHMARK_ENGINE=supertonic \
QVAC_TTS_GGML_BENCHMARK_ENHANCER=lavasr \
QVAC_TTS_GGML_BENCHMARK_DENOISER=lavasr \
QVAC_TTS_GGML_BENCHMARK_DEVICE="my-box" \
QVAC_TTS_GGML_BENCHMARK_RUNNER=manual-zbig \
npm --prefix packages/tts-ggml run test:benchmark:rtf

# 1b. Offline / a custom build: point LAVASR_ENHANCER_GGUF / LAVASR_DENOISER_GGUF
#     at local GGUFs, or set LAVASR_{ENHANCER,DENOISER}_REGISTRY_PATH to pull a
#     different build (e.g. the fp32 enhancer).

# 1c. Isolate each stage: run the none/denoise/enhance/full quartet (drop the env
#     var to turn a stage off) and diff the paired rows in the findings table.

# 2. For a row on a backend CI can't reach (CUDA, Adreno OpenCL, hosted Metal),
#    copy the artifact into manual-results/ (see manual-results/LAVASR_TEMPLATE.json.example).
```

### CI wiring

- **Desktop** (`integration-test-tts-ggml.yml`): each matrix branch carries
  `enhancer:"lavasr"` and `denoiser:"lavasr"` rows for `supertonic` + `chatterbox`
  (CPU everywhere, plus Vulkan/Metal on GPU runners), plus an enhancer quant sweep
  (`enhancerVariant` = `f32` / `q8_0`) on `supertonic` across CPU + the platform
  GPU. They fetch the GGUFs from the registry and collect numbers; a published row
  (the `f16`/`f32` enhancer tiers and the denoiser) hard-fails if its GGUF can't be
  fetched, so a real registry failure surfaces instead of a false green, while the
  not-yet-published `q8_0` tier soft-skips (green) until it lands on S3.
- **Mobile** (`integration-mobile-test-tts-ggml.yml`): Device Farm rows benchmark
  the fp16 enhancer (CPU + GPU) and the denoiser (CPU) on supertonic + chatterbox.
  The on-device runtime reads `QVAC_TTS_GGML_BENCHMARK_ENHANCER` /
  `QVAC_TTS_GGML_BENCHMARK_ENHANCER_VARIANT` / `QVAC_TTS_GGML_BENCHMARK_DENOISER`
  (threaded through the inject-env step). iOS resolves the GGUFs from the registry
  on-device (like the engine GGUFs); Android has no on-device network, so the fp16
  enhancer + denoiser are pre-signed into the mobile model manifest and adb-pushed
  into `<models>/lavasr/` by the prestage step, where `ensureLavaSR*Gguf` scans for
  them. The enhancer quant-tier sweep stays desktop-only.

## How the CI pipeline fits together

```
workflow_dispatch
  └── benchmark-performance-tts-ggml.yml  (orchestrator)
         ├── prebuilds-tts-ggml.yml          (build native addon)
         ├── desktop-benchmarks              (desktop matrix: CPU everywhere, Vulkan on GPU runners)
         ├── mobile-benchmarks               (run_mobile=true → Device Farm CPU + GPU, engine sweep)
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

| Platform / Arch | Backend      | CI source                                                                                                                                                                           |
| --------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| linux / x64     | cpu + vulkan | `qvac-ubuntu2204-x64-gpu`, `qvac-ubuntu2404-x64-gpu`                                                                                                                                |
| linux / arm64   | cpu          | `ubuntu-24.04-arm`                                                                                                                                                                  |
| darwin / arm64  | cpu          | `macos-14-xlarge`                                                                                                                                                                   |
| darwin / x64    | cpu          | `macos-15-large`                                                                                                                                                                    |
| win32 / x64     | cpu          | `qvac-win25-x64`                                                                                                                                                                    |
| win32 / x64     | cpu + vulkan | `qvac-win25-x64-gpu`                                                                                                                                                                |
| Android         | cpu + vulkan | `run_mobile=true` — AWS Device Farm. Benchmark matrix sweeps `chatterbox` (CPU q4/q8 + GPU q4), `supertonic` (CPU + GPU q4), `supertonic3` (CPU + GPU q4). `use_gpu:true` → Vulkan. |
| iOS             | cpu + metal  | `run_mobile=true` — AWS Device Farm. Same engine sweep as Android (q4). `use_gpu:true` → Metal.                                                                                     |
| darwin / arm64  | metal        | **Manual** — hosted macOS Metal crashes ggml's encoder; drop JSON under `manual-results/`                                                                                           |
| linux / x64     | cuda         | **Manual** — not in the default tts-cpp backend cascade; drop JSON under `manual-results/`                                                                                          |
| android         | opencl       | **Manual** — Adreno-only; drop JSON under `manual-results/`                                                                                                                         |

## How to read the findings table

The aggregated table carries:

- **Mean RTF / P50 / P95**: core perf numbers. Lower is faster. `< 1` = faster
  than real time.
- **Cold RTF**: RTF of the first warmup run — matters for short-lived processes
  that synthesise once and exit.
- **Mean Wall (ms)**: average wall time per synthesis.
- **Load (ms)**: `model.load()` time (loads + maps the GGUFs once).
- **Peak RSS (MB)**: high-water RSS observed across warmup + measured runs.
- **Model (MB)**: sum of the engine's GGUF files on disk (includes the LavaSR
  enhancer and/or denoiser GGUF when the `Enhancer` / `Denoiser` column is `lavasr`).
- **Enhancer**: `lavasr` when the LavaSR 48 kHz bandwidth-extension enhancer was
  layered on the engine (at its default fp16 tier), `lavasr/<tier>` for a non-fp16
  quant tier (e.g. `lavasr/q8_0`), else `none`. Each `(enhancer, tier)` for the
  same `(engine, variant, gpu)` is kept as a separate row.
- **Denoiser**: `lavasr` when the LavaSR speech denoiser ran before the enhancer,
  else `none`. Combined with `Enhancer`, the none/denoise/enhance/full rows for
  one `(engine, variant, gpu)` isolate each stage's marginal cost.
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
