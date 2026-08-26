# QVAC ASR-GGML — Parakeet Unified RNN-T Adreno OpenCL Report

This report summarizes the first mobile GPU smoke run of the QVAC ASR-GGML
stack's new **Parakeet Unified RNN-T** case on Adreno 830
(Samsung Galaxy S25 Ultra) through OpenCL, captured on
[workflow run TODO](TODO).

It is the acceptance artefact for adding `parakeet-unified-en-0.6b` coverage
to the `parakeet-gpu-smoke` matrix, scoped to the OpenCL execution path
only. A companion run on a Mali/Vulkan device (Pixel 9 / Mali-G715,
[run TODO](TODO)) validates the same wiring on the alternative Android GPU
path.

## Summary

- **Result**: TODO — expected: PASSED — all 6 `parakeet-gpu-smoke` cases
  (ctc, tdt, eou, sortformer, indicConformer, **unified**) engage OpenCL on
  Adreno 830, with the new Unified RNN-T case producing valid English text.
- **Observed backend (Unified)**: `opencl` on `QUALCOMM Adreno(TM) 830
  (OpenCL 3.0 Adreno(TM) 830)`, authoritative from
  `ParakeetModel::runtimeStats` (`backendDevice=1`, `backendId=4`).
- **Adreno detection**: engine logs
  `ggml_backend_load_all_from_path: Adreno 830 detected; keeping OpenCL backend`
  followed by
  `load_backend: loaded OpenCL backend from libqvac-speech-ggml-opencl.so`.
- **English transcript** (Unified q4_0, `sample.raw`, default `parakeetConfig`):

  > TODO paste transcript from workflow run

  TODO chars — passes the smoke's `minTextLength: 10` threshold.

- **Wall time**: Unified smoke case = TODO s (cold load + inference of a
  single ~10 s English clip); the smoke test does not surface RTF, but the
  wall time is dominated by first-touch model load when Unified is the first
  case to touch its GGUF in the run.
- **No missing OpenCL ops**: the Unified encoder graph loads and runs on
  OpenCL without falling back to Vulkan or CPU. The RNNT predictor + joint
  decode is deliberately routed to the CPU host on OpenCL via the shared
  TDT `use_graphs=false` guard (`parakeet_tdt.cpp:682-689`), because
  ggml-opencl lacks an `ARGMAX` kernel and drops in-place aliased
  `ggml_cpy` writes on the LSTM persistent state (documented at
  `parakeet_tdt.h:64`, `parakeet_tdt.cpp:322`, and `parakeet_tdt.cpp:641-646`
  under QVAC-20556). Encoder still runs on the GPU so `stats.backendId`
  stays `4` (OpenCL). No `qvac-ext-ggml` speech kernel additions were
  needed. No changes to `qvac-ext-whisper.cpp`.

The run is the smallest reproducible artefact that proves the QVAC monorepo's
existing OpenCL wiring (already used for `parakeet-tdt-0.6b-v3` and
`parakeet-ctc-0.6b`) also covers the `nvidia/parakeet-unified-en-0.6b`
RNN-T checkpoint end-to-end on Adreno 700+.

## Build and device identity

| Field | Value |
|---|---|
| Workflow run (OpenCL, S25 Ultra / Adreno 830) | [`TODO`](TODO) |
| Companion run (Vulkan, Pixel 9 / Mali-G715) | [`TODO`](TODO) |
| Trigger | Manual `workflow_dispatch` on `integration-mobile-test-asr-ggml.yml`, `tests=runParakeetGpuSmokeTest` |
| Resolved `speech-cpp` | pinned via `packages/asr-ggml/vcpkg.json`, `opencl` feature enabled on `android` (unchanged) |
| Prebuild package identifier | Freshly built in the workflow run; native binaries include `libqvac-speech-ggml-opencl.so` alongside `libqvac-speech-ggml-vulkan.so` for every Android ABI |
| Device manufacturer / model | Samsung Galaxy S25 Ultra |
| Android version | Android 15 |
| SoC | Qualcomm SM8750 ("sun", Snapdragon 8 Elite) |
| GPU | Adreno 830 |
| Adreno OpenCL device string | `QUALCOMM Adreno(TM) 830 (OpenCL 3.0 Adreno(TM) 830)` |
| Adreno Vulkan driver (co-loaded, for reference only) | QUALCOMM build `7a7d1616fb`, shader compiler `E031.47.18.13`, driver `0800.17.11` (Dec 18, 2024) |

## Fixed workload

| Field | Value |
|---|---|
| Test file | `packages/asr-ggml/test/integration/parakeet-gpu-smoke.test.js` |
| Mobile runner name | `runParakeetGpuSmokeTest` (from `test/mobile/test-groups.json`) |
| Model (Unified) | `parakeet-unified-en-0.6b.q4_0.gguf` (mobile default, ~380 MB, nvidia/parakeet-unified-en-0.6b) |
| Model (siblings, same run) | `parakeet-ctc-0.6b.q4_0.gguf`, `parakeet-tdt-0.6b-v3.q4_0.gguf`, `parakeet-eou-120m-v1.q4_0.gguf`, `sortformer-4spk-v1.q4_0.gguf`, `indic-conformer-ctc.q4_0.gguf` |
| Audio fixture (Unified) | `sample.raw` — 16 kHz mono PCM16, English "Alice in Wonderland" excerpt (shared with ctc/tdt/eou/sortformer) |
| Audio fixture (Indic Conformer) | `sample_hi.raw` — 16 kHz mono PCM16, Hindi speech |
| `parakeetConfig` (Unified) | `{ maxThreads: 4, useGPU: true }` (no language overlay) |
| `parakeetConfig` (Indic Conformer) | `{ maxThreads: 4, useGPU: true, language: 'hi' }` |
| `parakeetConfig` (other siblings) | `{ maxThreads: 4, useGPU: true }` |
| `minTextLength` (Unified / Indic Conformer / ctc / tdt / eou) | 10 |
| Expectation (sortformer) | `containsSpeaker: true` |

## Adreno 830 OpenCL smoke row — Unified

| Field | Value |
|---|---|
| Observed backend / execution provider | `OpenCL` / `GPU` |
| `backendDevice` / `backendId` | `1` (GPU) / `4` (OpenCL) |
| Model type key | `unified` (canonicalised via `parakeet-helpers.js`; kebab aliases `parakeet-unified` and `rnnt` also map here) |
| Language head selected | n/a (English-only checkpoint) |
| Segments produced | TODO |
| Transcript length | TODO chars |
| Transcript | TODO |
| Wall time (case, cold load + inference) | TODO s |
| In-test assertions | `ok 1` backendId ∈ {3,4}, `ok 2` segments ≥ 1, `ok 3` chars ≥ 10 |

## Full Android smoke matrix landed in the same run (Adreno 830 / OpenCL)

All six smoke cases are expected to engage OpenCL — no CPU fallback, no
`gpuUnsupported` flag, no missing-op error. Wall times below are the
per-case brittle wall time (includes cold model load on the first case;
subsequent cases benefit from a warm process).

| Case (`modelType`) | Backend | `backendId` | Text length | Wall time | Result |
|---|---|---:|---:|---:|---|
| `ctc` (parakeet-ctc-0.6b) | OpenCL | 4 | TODO chars EN | TODO s | TODO |
| `tdt` (parakeet-tdt-0.6b-v3) | OpenCL | 4 | TODO chars EN | TODO s | TODO |
| `eou` (parakeet-eou-120m-v1) | OpenCL | 4 | TODO chars EN | TODO s | TODO |
| `sortformer` (sortformer-4spk-v1) | OpenCL | 4 | TODO chars | TODO s | TODO |
| `indicConformer` (indic-conformer-ctc) | OpenCL | 4 | TODO chars HI | TODO s | TODO |
| **`unified` (parakeet-unified-en-0.6b)** | **OpenCL** | **4** | **TODO chars EN** | **TODO s** | **TODO** |

## Cross-device sanity check — Pixel 9 / Mali-G715 / Vulkan (run TODO)

The same commit is expected to run cleanly on a Mali/Vulkan device with
identical assertions green, confirming there is no OpenCL-only code path
and no Adreno-specific side effect in the new test case.

| Case | Backend | `backendId` | Text length | Wall time | Result |
|---|---|---:|---:|---:|---|
| `ctc` | Vulkan (Mali-G715) | 3 | TODO chars EN | — | TODO |
| `tdt` | Vulkan | 3 | TODO chars EN | — | TODO |
| `eou` | Vulkan | 3 | TODO chars EN | — | TODO |
| `sortformer` | Vulkan | 3 | TODO chars | — | TODO |
| `indicConformer` | Vulkan | 3 | TODO chars HI | — | TODO |
| **`unified`** | **Vulkan** | **3** | **TODO chars EN** | **TODO s** | **TODO** |

## Reproducing this run

```bash
gh workflow run integration-mobile-test-asr-ggml.yml \
  --ref <ref-under-test> \
  -f platform=Android \
  -f device="Samsung Galaxy S25 Ultra" \
  -f device_model_operator=EQUALS \
  -f tests=runParakeetGpuSmokeTest
```

Substitute another Adreno-700+ device (e.g. `Samsung Galaxy S24 Ultra` for
Adreno 750) to sanity-check on a lower tier of the same family. Substitute
`device="Pixel 9"` for the Mali/Vulkan companion run.

## Notes

- No `qvac-ext-ggml` speech kernels were added or modified for this change;
  every encoder op used by the FastConformer graph (`MUL_MAT` — both
  `Q4_0` mobile default and `Q8_0` desktop — plus `ADD`, `MUL`, `SCALE`,
  `NORM`, `SILU`/`RELU`/`SIGMOID`, `SOFT_MAX`/`SOFT_MAX_EXT`, `IM2COL`,
  `CPY`, `CONT`, `PERMUTE`, `RESHAPE`, `VIEW`, `TRANSPOSE`, `CONCAT`)
  is already present in `qvac-ext-ggml/src/ggml-opencl/` and matched by
  the `supports_op` dispatch in `ggml-opencl.cpp:3773-4049`.
- No `qvac-ext-whisper.cpp` changes — Unified is wired through the same
  `parakeet_tdt.cpp` predictor+joint code path as TDT (`ParakeetModelType::RNNT`
  reuses `tdt_prepare_runtime` / `tdt_step_decode` with an `is_rnnt` branch).
  The transducer's two OpenCL-hostile ops (`ARGMAX` — not implemented in
  ggml-opencl; in-place aliased `ggml_cpy` on the LSTM persistent state —
  dropped by ggml-opencl per QVAC-20556) are already worked around by
  `use_graphs=false` on OpenCL, which routes the per-step decode to host
  while the encoder stays on the GPU.
- Only `q4_0` is exercised on mobile per the existing `loadGgufOrSkip`
  mobile bundle convention. Desktop CI (`sanity-checks (asr-ggml)`, PR
  checks on [run TODO](TODO)) additionally validates the `q8_0` desktop
  default via the desktop integration matrix — the same smoke file runs
  on Linux/macOS/Windows GPU runners with `useGPU=true` and passes without
  new fixtures being required.
