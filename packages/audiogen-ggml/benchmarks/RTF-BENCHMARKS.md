# ACE-Step RTF Benchmarks

Performance measurement for `@qvac/audiogen-ggml` (the ACE-Step music engine).

## What is measured

**RTF (Real-Time Factor)** is the headline metric:

```
RTF = generation wall time / rendered audio duration
```

- `RTF < 1` — faster than real-time (a 15 s clip rendered in under 15 s)
- `RTF = 1` — exactly real-time
- `RTF > 1` — slower than real-time

Because RTF is normalised by clip length, rows with different `duration` values
stay comparable. Wall time and load time do not, so read those alongside the
configuration column.

Each run also records:

| Metric | Meaning |
|--------|---------|
| `Cold RTF` | RTF of the first warmup render, i.e. the cold path right after load. |
| `Load (ms)` | `load()` wall time — parsing and allocating four multi-GB GGUFs. |
| `Avg RSS` / `Peak RSS` | Process resident set size sampled during inference. |
| `Reclaimed` | RSS returned to the OS after `destroy()`, sampled after a settle delay. |
| `Noisy` | Set when stddev exceeds 15% of the mean; do not compare a noisy row against another device. |

## The DiT variant axis

ACE-Step's Diffusion Transformer ships in three interchangeable variants, and
this is the model axis of the sweep. The other three stages (text encoder, LM,
VAE) are fixed.

| Variant | Schedule | Notes |
|---------|----------|-------|
| `turbo-q4` | ~8 steps | Default. Smallest and fastest. |
| `turbo-q8` | ~8 steps | Same schedule, higher-precision weights. |
| `sft` | ~50 steps | Several times slower than turbo; the quality reference. |

Step count and shift are left unset by default so the engine picks the schedule
matching the variant. Override them only to study the schedule itself.

## Determinism

Every render uses a fixed seed and `[Instrumental]` lyrics, and rotates over a
fixed three-caption corpus. Only the hardware changes between rows.

## Running locally

Fetch the models once (the default variant, or all three for a full sweep):

```bash
cd packages/audiogen-ggml
npm run download-models:registry                  # turbo-q4 only
npm run download-models:registry:all              # all three DiT variants
```

One configuration:

```bash
QVAC_AUDIOGEN_GGML_BENCHMARK_DIT_VARIANT=turbo-q4 \
QVAC_AUDIOGEN_GGML_BENCHMARK_USE_GPU=true \
QVAC_AUDIOGEN_GGML_BENCHMARK_BACKEND=vulkan \
QVAC_AUDIOGEN_GGML_BENCHMARK_DEVICE=my-box \
npm run test:benchmark:rtf
```

A sweep of configurations in one process:

```bash
QVAC_AUDIOGEN_GGML_BENCHMARK_MATRIX_JSON='[
  {"ditVariant":"turbo-q4","useGPU":false,"backendHint":"cpu"},
  {"ditVariant":"turbo-q8","useGPU":true,"backendHint":"vulkan"}
]' npm run test:benchmark:rtf:matrix
```

The matrix runner keeps going when an entry fails, so one bad backend does not
cost you the rest of the sweep. Failures are collected and reported, and the
process still exits 0 so partial artifacts reach the aggregator; a sweep that
produced nothing at all is caught by the workflow's verification step. With no
matrix set, a single `turbo-q4` CPU entry runs.

Every field of an entry is optional except `useGPU`:

| Field | Default | Meaning |
|---|---|---|
| `ditVariant` | `turbo-q4` | `turbo-q4` / `turbo-q8` / `sft`. |
| `useGPU` | `false` | Request the platform GPU backend. |
| `backendHint` | derived | `cpu` / `metal` / `vulkan` / `opencl`. |
| `deviceLabel`, `runnerLabel`, `label` | inherited from the environment | Report labels. |
| `numWarmup`, `numRuns`, `durationS` | matrix-wide env defaults | Per-entry overrides. |
| `inferenceSteps`, `shift` | engine default | `0` also means engine default. |
| `numThreads` | engine default | CPU thread count. |
| `rtfUpperBound` | none | Fails the entry when the mean RTF exceeds it. |

Results land in `benchmarks/results/rtf-benchmark-*.json` (git-ignored). Render
the table:

```bash
node scripts/perf-report/aggregate-audiogen-ggml-rtf.js \
  --dir packages/audiogen-ggml/benchmarks/results \
  --manual-dir packages/audiogen-ggml/benchmarks/manual-results \
  --output /tmp/audiogen-ggml-performance-findings.md
```

### Environment variables

All are optional; every one is read by both the desktop and the on-device lane.

| Variable (prefix `QVAC_AUDIOGEN_GGML_BENCHMARK_`) | Default | Meaning |
|---|---|---|
| `DIT_VARIANT` | `turbo-q4` | `turbo-q4` / `turbo-q8` / `sft`. |
| `USE_GPU` | `false` | Request the platform GPU backend. |
| `BACKEND` | derived | Label hint only. The backend the engine actually used is read back from the run stats. |
| `DEVICE` / `RUNNER` | empty | Labels carried into the report. |
| `LABEL` | empty | Tag appended to the artifact filename. |
| `WARMUP_RUNS` | `1` | Unmeasured renders before the measured ones. |
| `RUNS` | `3` desktop, `2` mobile | Measured renders. |
| `DURATION_S` | `15` | Target clip length. |
| `INFERENCE_STEPS` / `SHIFT` | engine default | Override the variant's schedule. |
| `NUM_THREADS` | engine default | CPU thread count. |
| `RTF_UPPER_BOUND` | none | Fails the run when the mean RTF exceeds it, on both lanes. |

## Result validation

`runRtfBenchmark` refuses to return a measurement it cannot stand behind, so no
artifact is written, no `[PERF_REPORT_START]` record is emitted and no mobile
test reports success unless all of the following hold:

- every requested measured run completed;
- the mean RTF is finite and positive;
- every run rendered audio samples;
- peak RSS is positive and at least the average RSS;
- the mean RTF is within `RTF_UPPER_BOUND`, when that is set.

A failure throws with every unmet condition listed at once.

## Requested vs. observed backend

`BACKEND` and `USE_GPU` describe what was *asked for*. The engine can fall back
to CPU when a GPU backend is unavailable, so the reported backend and execution
provider are always taken from the backend that actually executed, read back
from the run stats. The request is preserved alongside it as
`requested_backend` / `requested_execution_provider`, and the requested backend
is only used as the reported one when no run reported a backend at all. A GPU
row in the findings table therefore always reflects real GPU work.

The matrix runner additionally honours `MATRIX_JSON` (the sweep) and
`ENTRY_TIMEOUT_MS` (per-entry watchdog, 45 min by default).

## Running in CI

There are three entry points.

`.github/workflows/benchmark-performance-audiogen-ggml.yml` is the manual one
(`workflow_dispatch`). It builds prebuilds (or takes a published
`prebuild_package`), fans out to both lanes, and aggregates.

On a pull request, add the **`run-benchmarks`** label alongside
`run-desktop-addon-tests` and `run-mobile-addon-tests`. The lanes then run with
`run_rtf_benchmarks: true` and `summarize-benchmarks` renders the findings table
onto the run summary. Without the label a PR pays nothing, which is the default:
a full sweep renders for hours and downloads every DiT variant.

Both paths share `reusable-summarize-audiogen-ggml-benchmarks.yml`, so the table
on a PR is the table a manual sweep produces.

`.github/workflows/perf-report.yml` is the weekly cross-addon report. It measures
nothing itself: it re-aggregates the artifacts of the last six sweeps into
`reports/audiogen-ggml-performance.md`, which lands in that run's summary
alongside the other addons. ACE-Step is therefore only as fresh as the last
sweep — nothing dispatches one on a schedule.

**Desktop** — `integration-test-audiogen-ggml.yml` with
`run_rtf_benchmarks: true`. Every runner sweeps the three variants on CPU;
GPU-capable runners sweep them again on the platform backend (Vulkan on
linux/win32, Metal on darwin). Artifacts: `rtf-results-audiogen-ggml-*`.

**Mobile** — `integration-mobile-test-audiogen-ggml.yml` with
`run_rtf_benchmarks: true`. One AWS Device Farm row per variant/provider on
Android and iOS, since each row downloads its variant's GGUFs on-device. The
numbers leave the device inside `[PERF_REPORT_START]` log markers, which the
shared extractor scrapes. Artifacts: `perf-report-audiogen-ggml-*`.

Both lanes are `continue-on-error`, so a configuration that OOMs or overruns
shows up as a missing row rather than a failed sweep.

## How the findings table is built

`scripts/perf-report/aggregate-audiogen-ggml-rtf.js` folds three input shapes
into one table:

| Shape | File | Produced by |
|---|---|---|
| desktop | `rtf-benchmark-*.json` | `test/benchmark/rtf-benchmark.test.js` |
| mobile | `performance-report.json` | Device Farm log markers, reassembled by `scripts/perf-report/extract-from-log.js` |
| manual | any JSON under `--manual-dir` | hand-authored, for backends CI cannot cover |

There is one engine (`acestep`); the model axis is the DiT variant. The GPU
backends CI reaches are Vulkan (linux, win32, Android) and Metal (darwin, iOS).
CUDA and OpenCL sit outside the default audiogen-cpp cascade and appear only
from a manual drop or an explicit backend hint. `other-gpu` is what the report
builder emits for a ggml backend id it has no name for.

Manual records are validated rather than coerced: an unknown DiT variant or
backend is rejected with a warning naming the offending value, because reporting
it under a valid-looking label would publish a wrong number.

Rows are keyed on both the observed and the requested backend before duplicates
are folded, so a GPU request that fell back to CPU stays distinct from a genuine
CPU run on the same device and variant. Such a row renders as
`cpu (requested vulkan)` and is counted under the table; it never counts as
coverage for the backend it asked for.

Mobile artifacts carry the shared extractor's per-workflow `run_number`, which is
not a run id, so the `Run` column is filled in from elsewhere. The summarize
workflow passes its own `github.run_id` as `--run-id`, since every artifact it
downloads comes from that run.

That single id cannot describe a report spanning several sweeps, so the weekly
aggregation instead passes `--workflow "Benchmark Performance (AudioGen GGML)"`
and `--runs 6`. The script fetches the artifacts itself and reads each row's run
id from the directory `gh run download` stages it under, which is named for the
run. Point `--dir` at a tree of your own without that layout and the column stays
empty rather than showing a number that cannot be resolved.

## Backends CI cannot reach

CUDA and OpenCL are outside the default audiogen-cpp backend cascade, and some
hardware simply is not in the runner pool. Drop a JSON record into
`benchmarks/manual-results/` and the aggregator will fold it into the same
table — see the README there.
