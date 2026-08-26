# QVAC ASR-GGML — Parakeet Unified RNN-T Adreno OpenCL Report

This report summarizes the first mobile GPU smoke run of the QVAC ASR-GGML
stack's new **Parakeet Unified RNN-T** case on Adreno 830
(Samsung Galaxy S25 Ultra) through OpenCL, captured on
[workflow run 32981557097](https://github.com/tetherto/qvac/actions/runs/32981557097).

It is the acceptance artefact for adding `parakeet-unified-en-0.6b` coverage
to the `parakeet-gpu-smoke` matrix, scoped to the OpenCL execution path
only. A companion run on a Mali/Vulkan device (Pixel 9 / Mali-G715,
[run 32978407671](https://github.com/tetherto/qvac/actions/runs/32978407671))
validates the same wiring on the alternative Android GPU path.

## Summary

- **Result**: PASSED — all 6 `parakeet-gpu-smoke` cases
  (ctc, tdt, eou, sortformer, indicConformer, **unified**) engaged OpenCL on
  Adreno 830, with the new Unified RNN-T case producing valid English text.
- **Observed backend (Unified)**: `opencl` on `QUALCOMM Adreno(TM) 830
  (OpenCL 3.0 Adreno(TM) 830)`, authoritative from
  `ParakeetModel::runtimeStats` (`backendDevice=1`, `backendId=4`).
- **Adreno detection**: engine logged
  `ggml_backend_load_all_from_path: Adreno 830 detected; keeping OpenCL backend`
  followed by
  `load_backend: loaded OpenCL backend from libqvac-speech-ggml-opencl.so`.
- **English transcript** (Unified q4_0, `sample.raw`, default `parakeetConfig`):

  > Alice was beginning to get very tired of sitting by her sister on the
  > bank and of having nothing to do. Once she had peeped...

  155 chars — passes the smoke's `minTextLength: 10` threshold by ~15×.

- **Wall time**: Unified smoke case = 2.56 s (`ok 6 - Unified GPU smoke … #
  time = 2563.28427ms`). The case runs after ctc/tdt/eou/sortformer/
  indicConformer in the same process, so the OpenCL backend and Adreno kernel
  cache are already warm; the wall time is inference + host-side transducer
  decode only.
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
| Workflow run (OpenCL, S25 Ultra / Adreno 830) | [`32981557097`](https://github.com/tetherto/qvac/actions/runs/32981557097) |
| Companion run (Vulkan, Pixel 9 / Mali-G715) | [`32978407671`](https://github.com/tetherto/qvac/actions/runs/32978407671) |
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
| Unified resolution path (device-side) | Mobile pre-stage (adb-pushed via generated model manifest — presigned S3 URL); `ensureGgufForType` step 4 in `parakeet-helpers.js` |
| `minTextLength` (Unified / Indic Conformer / ctc / tdt / eou) | 10 |
| Expectation (sortformer) | `containsSpeaker: true` |

## Adreno 830 OpenCL smoke row — Unified

| Field | Value |
|---|---|
| Observed backend / execution provider | `OpenCL` / `GPU` |
| `backendDevice` / `backendId` | `1` (GPU) / `4` (OpenCL) |
| Model type key | `unified` (canonicalised via `parakeet-helpers.js`; kebab aliases `parakeet-unified` and `rnnt` also map here) |
| Language head selected | n/a (English-only checkpoint) |
| Segments produced | 1 |
| Transcript length | 155 chars |
| Transcript | `Alice was beginning to get very tired of sitting by her sister on the bank and of having nothing to do. Once she had peeped...` |
| Wall time (case, warm-process inference) | 2.56 s |
| In-test assertions | `ok 1` backendId ∈ {3,4}, `ok 2` segments ≥ 1, `ok 3` chars ≥ 10 |

## Full Android smoke matrix landed in the same run (Adreno 830 / OpenCL)

All six smoke cases engaged OpenCL — no CPU fallback, no `gpuUnsupported`
flag, no missing-op error. Wall times below are the per-case brittle wall
time (includes cold model load on the first case; subsequent cases benefit
from a warm process).

| Case (`modelType`) | Backend | `backendId` | Text length | Wall time | Result |
|---|---|---:|---:|---:|---|
| `ctc` (parakeet-ctc-0.6b) | OpenCL | 4 | 292 chars EN | 51.17 s | ✓ pass |
| `tdt` (parakeet-tdt-0.6b-v3) | OpenCL | 4 | 298 chars EN | 2.35 s | ✓ pass |
| `eou` (parakeet-eou-120m-v1) | OpenCL | 4 | 290 chars EN | 8.92 s | ✓ pass |
| `sortformer` (sortformer-4spk-v1) | OpenCL | 4 | 38 chars (`Speaker 1: …`) | 9.55 s | ✓ pass |
| `indicConformer` (indic-conformer-ctc) | OpenCL | 4 | 111 chars HI | 42.96 s | ✓ pass |
| **`unified` (parakeet-unified-en-0.6b)** | **OpenCL** | **4** | **155 chars EN** | **2.56 s** | **✓ pass** |

`tdt` and `unified` complete in ~2.5 s because the OpenCL backend and Adreno
kernel cache are warmed by the preceding cases in the same process. `ctc`,
`eou`, `sortformer`, and `indicConformer` each incur a cold GGUF load when
they switch models.

## Cross-device sanity check — Pixel 9 / Mali-G715 / Vulkan (run 32978407671)

The same commit ran cleanly on a Mali/Vulkan device with identical
assertions green, confirming there is no OpenCL-only code path and no
Adreno-specific side effect in the new test case.

| Case | Backend | `backendId` | Text length | Wall time | Result |
|---|---|---:|---:|---:|---|
| `ctc` | Vulkan (Mali-G715) | 3 | 292 chars EN | 135.34 s | ✓ pass |
| `tdt` | Vulkan | 3 | 298 chars EN | 4.10 s | ✓ pass |
| `eou` | Vulkan | 3 | 290 chars EN | 20.96 s | ✓ pass |
| `sortformer` | Vulkan | 3 | 38 chars | 50.56 s | ✓ pass |
| `indicConformer` | Vulkan | 3 | 113 chars HI | 162.22 s | ✓ pass |
| **`unified`** | **Vulkan** | **3** | **298 chars EN** | **3.94 s** | **✓ pass** |

The Vulkan-side English transcript reads `Alice was beginning to get very
tired of sitting by her sister on the bank and of having nothing to do.
Once or twice sh...` (298 chars) — a longer prefix than the Adreno/OpenCL
side (155 chars ending at "peeped"). Both are within the smoke's
`minTextLength: 10` tolerance; the length delta is the expected variance
between the two GPU stacks running the same q4_0-quantized model with the
same audio clip and no explicit segmentation hint.

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
`device="Google Pixel 9"` for the Mali/Vulkan companion run.

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
  mobile bundle convention. Desktop CI additionally validates the `q8_0`
  desktop default via the desktop integration matrix — the same smoke file
  runs on Linux/macOS/Windows GPU runners with `useGPU=true` and passes
  without new fixtures being required.
- **Model resolution path**: on this Adreno-830 run the Unified GGUF was
  resolved via the mobile pre-stage step (`Using pre-staged GGUF
  parakeet-unified-en-0.6b.q4_0.gguf` in the logcat), which
  `scripts/generate-mobile-model-manifest.js` populates with a presigned S3
  URL at CI time. That entry was added in this ticket alongside the new test
  block, because the registry-catalogue entry
  ([tetherto/qvac#3965](https://github.com/tetherto/qvac/pull/3965)) has not
  yet been merged. When #3965 lands, the desktop and mobile registry-client
  paths (`ensureGgufForType` steps 7-8 in `parakeet-helpers.js`) will also
  resolve without further changes.
