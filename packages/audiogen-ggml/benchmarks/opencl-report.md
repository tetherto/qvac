# QVAC AudioGen-GGML — Adreno OpenCL Report

This report summarizes the last successful mobile RTF benchmark run of the
QVAC ACE-Step stack on Adreno 830 (Samsung Galaxy S25 Ultra) through OpenCL,
captured on [workflow run 32412564427](https://github.com/tetherto/qvac/actions/runs/32412564427).
It is a standalone, single-run companion to
[`ACESTEP-CPP-COMPARISON.md`](./ACESTEP-CPP-COMPARISON.md) (Attempt 3), scoped
to the OpenCL execution path only.

## Summary

- **Result**: PASSED — full mobile RTF benchmark row captured on Adreno 830.
- **Observed backend**: `opencl` (execution provider `gpu`), authoritative from
  `AcestepModel::runtimeStats` (`backendDevice=1`, `backendId=4`).
- **Requested backend hint**: `vulkan` — the engine's Adreno 700+ preference in
  `backend_gpu_init` correctly routed the request to OpenCL on this device.
- **Mean RTF (turbo-q4)**: **2.199** (cold 2.058, P50 2.199, P95 2.256), on
  ~14.72 s of generated audio.
- **Model load**: 9.18 s. **Peak RSS**: 1577 MB (~1.54 GiB).
- **Noise gate**: `noisy=false` (stddev/mean < 15% across 2 measured runs + 1
  warmup).
- **Cross-variant on the same device**: OpenCL delivers mean RTF **2.199**
  (turbo-q4), **1.957** (turbo-q8), **4.698** (sft) — 3.8×–4.0× faster than
  CPU on the same variants.

The run is the smallest reproducible artefact that proves the current pinned
`speech-cpp 2026-08-18#2` → `ggml-speech 2026-08-18#0` →
`qvac-ext-ggml@0a76e3ed` resolves the OpenCL `SIGABRT` observed on the
published `@qvac/audiogen-ggml@0.2.3` prebuild without any monorepo or engine
code change.

## Build and device identity

| Field | Value |
|---|---|
| Workflow run | [`32412564427`](https://github.com/tetherto/qvac/actions/runs/32412564427) |
| Trigger | Mobile benchmark lane, `run_desktop=false`, `run_mobile=true`, full DiT variant sweep |
| QVAC monorepo commit at build | `27da3551b255d3a5d76fa38ff1c511e3c9d87846` (`main` at dispatch) |
| Resolved `speech-cpp` | `2026-08-18#2` |
| Resolved `speech-cpp` port tree | [`ca390a477fa1815628d4793afb96883681cbfd5d`](https://github.com/tetherto/qvac-registry-vcpkg/tree/ca390a477fa1815628d4793afb96883681cbfd5d) |
| Resolved engine source | [`qvac-ext-lib-whisper.cpp@792b68921bc323a2daff93bc580a15b55ee71b9b`](https://github.com/tetherto/qvac-ext-lib-whisper.cpp/tree/792b68921bc323a2daff93bc580a15b55ee71b9b) |
| Resolved `ggml-speech` source | [`qvac-ext-ggml@0a76e3ed969781da6de41d6c9a1c3fc471c0978b`](https://github.com/tetherto/qvac-ext-ggml/tree/0a76e3ed969781da6de41d6c9a1c3fc471c0978b) |
| Prebuild package identifier | Freshly built in the workflow run (not the published `0.2.3` prebuild) |
| Device manufacturer / model | Samsung Galaxy S25 Ultra |
| Device hardware identifier | `pa3quew`; model/build family `S938U1` |
| Android version / API level | Android 15 |
| Build fingerprint | `samsung/pa3quew/pa3q:15/AP3A.240905.015.A2/S938U1UEU1AYA1_OYM1AYA1:user/release-keys` |
| SoC | Qualcomm SM8750 ("sun", Snapdragon 8 Elite) |
| GPU | Adreno 830 |
| Adreno OpenCL driver | Not captured directly; the co-loaded Vulkan driver reported by AdrenoVK-0 was QUALCOMM build `7a7d1616fb`, shader compiler `E031.47.18.13`, driver `0800.17.11` (Dec 18, 2024). OpenCL ships in `/vendor/lib64/libOpenCL.so`. |

## Fixed workload

| Field | Value |
|---|---|
| DiT variant (headline row) | `turbo-q4` |
| Full sweep variants | `turbo-q4`, `turbo-q8`, `sft` |
| Text encoder GGUF | `Qwen3-Embedding-0.6B-Q8_0.gguf` |
| LM GGUF | `acestep-5Hz-lm-0.6B-Q8_0.gguf` |
| DiT GGUF (turbo-q4) | `acestep-v15-turbo-Q4_K_M.gguf` |
| VAE GGUF | `vae-BF16.gguf` |
| Total model size (turbo-q4) | `3,277,122,816` bytes (`3.05` GiB) |
| Prompt | `Upbeat pop rock with driving electric guitars, punchy drums and a catchy hook` |
| Lyrics | `[Instrumental]` |
| Seed | Fixed by RTF harness (specific value not surfaced by the runner) |
| Requested duration | `~15` seconds (`DEFAULT_DURATION_S=15`) |
| Warmup / measured run count | `1` warmup / `2` measured |
| OpenCL reporting hint | `QVAC_AUDIOGEN_GGML_BENCHMARK_BACKEND=opencl` (label only; `activeBackend` + `backendId` remain authoritative) |

## Adreno OpenCL row — `turbo-q4` on Samsung Galaxy S25 Ultra

| Field | Value |
|---|---|
| Observed backend / execution provider | `opencl` / `gpu` |
| Requested backend | `vulkan` (Adreno 700+ preference in `backend_gpu_init` routed to OpenCL) |
| `backendDevice` / `backendId` | `1` (GPU) / `4` (OpenCL) |
| DiT variant | `turbo-q4` |
| Clip duration (mean) | 14.72 s |
| Mean RTF | **2.199** |
| Cold RTF | 2.058 |
| P50 / P95 RTF | 2.199 / 2.256 |
| Mean wall time | 32.4 s |
| Model load time | 9.18 s |
| Avg RSS | 630 MB |
| Peak RSS | 1577 MB (~1.54 GiB) |
| Reclaimed after destroy | 0 MB |
| Sample count | 2 measured runs (+ 1 warmup) |
| Noisy | false (`stddev / mean < 15%`) |
| Artifact | `perf-report-audiogen-ggml-Android-turbo-q4-gpu-7/Samsung_Galaxy_S25_Ultra/performance-report.json` on [run 32412564427](https://github.com/tetherto/qvac/actions/runs/32412564427) |

## Full Android matrix landed in the same run

For context — not the subject of this report; it does not turn a QVAC-only
measurement into a matched two-engine comparison.

| Device (GPU) | Variant | Provider | Backend | Mean RTF | Wall (ms) | Peak RSS (MB) |
|---|---|---|---|---:|---:|---:|
| **Samsung Galaxy S25 Ultra (Adreno 830)** | **turbo-q4** | **gpu** | **opencl** | **2.199** | **32401** | **1577** |
| Samsung Galaxy S25 Ultra (Adreno 830) | turbo-q4 | cpu | cpu | 8.493 | 122331 | 2205 |
| Samsung Galaxy S25 Ultra (Adreno 830) | turbo-q8 | gpu | opencl | 1.957 | 28824 | 1968 |
| Samsung Galaxy S25 Ultra (Adreno 830) | turbo-q8 | cpu | cpu | 7.344 | 105771 | 2173 |
| Samsung Galaxy S25 Ultra (Adreno 830) | sft | gpu | opencl | 4.698 | 43261 | 2061 |
| Samsung Galaxy S25 Ultra (Adreno 830) | sft | cpu | cpu | 19.012 | 174961 | 2029 |
| Google Pixel 9a (Mali) | turbo-q4 | gpu | vulkan | 12.925 | 187761 | 3243 |
| Google Pixel 9 (Tensor CPU) | turbo-q4 | cpu | cpu | 15.201 | 220822 | 2177 |
| Google Pixel 9 Pro XL (Mali) | sft | gpu | vulkan | 47.944 | 441218 | 3189 |

## Cross-device observations

Bounded to these rows; no extrapolation beyond what was measured.

- On Adreno 830, the QVAC OpenCL path is **~3.9× faster than the same device
  on CPU** for `turbo-q4` (RTF 2.199 vs 8.493) and ~3.8× for `turbo-q8`
  (1.957 vs 7.344).
- The Pixel 9a Mali Vulkan `turbo-q4` row (RTF 12.925) is **~5.9× slower**
  than the S25 Ultra Adreno OpenCL `turbo-q4` row (2.199). CI does not reach
  Adreno with Vulkan on the same device, so this is a device-vs-device
  observation, not a backend-vs-backend claim on identical hardware.
- The Adreno OpenCL `turbo-q8` row (1.957) is fractionally faster than the
  `turbo-q4` row (2.199). Both share the specialized
  `ggml_cl_mul_mat_q8_0_f32_adreno` fast path for the Q8_0 LM; the spread is
  within the sample-count-2 measurement floor and is not treated as a general
  quantization tradeoff claim.

## Acceptance criteria satisfied by this run

- Observed `activeBackend=opencl` and `backendId=4` on Adreno 830.
- No CPU-fallback diagnostic recorded in logcat for the OpenCL rows.
- Output was 48,000 Hz, two channels, finite, and non-empty (test-gated by the
  RTF harness).
- Noise gate satisfied: `stddev/mean < 15%` on measured runs.

## Related

- [`ACESTEP-CPP-COMPARISON.md`](./ACESTEP-CPP-COMPARISON.md) — full QVAC vs.
  `ServeurpersoCom/acestep.cpp` source, build, and OpenCL wiring comparison,
  including Attempts 1–3 on Adreno 830.
- [`RTF-BENCHMARKS.md`](./RTF-BENCHMARKS.md) — RTF harness and reporting
  format.
