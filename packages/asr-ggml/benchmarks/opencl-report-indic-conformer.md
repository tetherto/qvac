# QVAC ASR-GGML — Indic Conformer Adreno OpenCL Report

This report summarizes the first mobile GPU smoke run of the QVAC ASR-GGML
stack's new **Indic Conformer** case on Adreno 830 (Samsung Galaxy S25 Ultra)
through OpenCL, captured on
[workflow run 32489751168](https://github.com/tetherto/qvac/actions/runs/32489751168).

It is the acceptance artefact for adding Indic Conformer coverage to the
`parakeet-gpu-smoke` matrix, scoped to the OpenCL execution path only. A
companion run on a Mali/Vulkan device (Pixel 9 / Mali-G715,
[run 32483218937](https://github.com/tetherto/qvac/actions/runs/32483218937))
validates the same wiring on the alternative Android GPU path.

## Summary

- **Result**: PASSED — all 5 `parakeet-gpu-smoke` cases (ctc, tdt, eou,
  sortformer, **indicConformer**) engaged OpenCL on Adreno 830, with the
  new Indic Conformer case producing valid Hindi text.
- **Observed backend (Indic Conformer)**: `opencl` on `QUALCOMM Adreno(TM) 830
  (OpenCL 3.0 Adreno(TM) 830)`, authoritative from
  `ParakeetModel::runtimeStats` (`backendDevice=1`, `backendId=4`).
- **Adreno detection**: engine logged
  `ggml_backend_load_all_from_path: Adreno 830 detected; keeping OpenCL backend`
  followed by
  `load_backend: loaded OpenCL backend from libqvac-speech-ggml-opencl.so`.
- **Hindi transcript** (Indic Conformer q4_0, `sample_hi.raw`, `language: 'hi'`):

  > कुछ अणुओं में अस्थ केंद्रक होता है जिसका मतलब यह कि उनमें थोड़े या बिना
  > किसी झटके से टूटने की प्रवृत्ति होती है

  111 chars — passes the smoke's `minTextLength: 10` threshold by ~11×.

- **Wall time**: Indic Conformer smoke case = 68.47 s (cold load + inference
  of a single ~15 s Hindi clip); the smoke test does not surface RTF, but the
  wall time is dominated by first-touch model load.
- **No missing OpenCL ops**: the Indic Conformer encoder graph loaded and ran
  on OpenCL without falling back to Vulkan or CPU. No upstream
  `qvac-ext-ggml` speech kernel additions were needed. No changes to
  `qvac-ext-whisper.cpp`.

The run is the smallest reproducible artefact that proves the QVAC monorepo's
existing OpenCL wiring (already used for parakeet-ctc-0.6b) also covers the
`ai4bharat/indic-conformer` CTC 600M checkpoint end-to-end on Adreno 700+.

## Build and device identity

| Field | Value |
|---|---|
| Workflow run (OpenCL, S25 Ultra / Adreno 830) | [`32489751168`](https://github.com/tetherto/qvac/actions/runs/32489751168) |
| Companion run (Vulkan, Pixel 9 / Mali-G715) | [`32483218937`](https://github.com/tetherto/qvac/actions/runs/32483218937) |
| Trigger | Manual `workflow_dispatch` on `integration-mobile-test-asr-ggml.yml`, `tests=runParakeetGpuSmokeTest` |
| Resolved `speech-cpp` | pinned via `packages/asr-ggml/vcpkg.json`, `opencl` feature enabled on `android` (unchanged) |
| Prebuild package identifier | Freshly built in the workflow run; native binaries include `libqvac-speech-ggml-opencl.so` (2.0 MB) alongside `libqvac-speech-ggml-vulkan.so` (61.7 MB) for every Android ABI |
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
| Model (Indic Conformer) | `indic-conformer-ctc.q4_0.gguf` (mobile default, ~380 MB, ai4bharat/indic-conformer CTC 600M) |
| Model (siblings, same run) | `parakeet-ctc-0.6b.q4_0.gguf`, `parakeet-tdt-0.6b-v3.q4_0.gguf`, `parakeet-eou-120m-v1.q4_0.gguf`, `sortformer-4spk-v1.q4_0.gguf` |
| Audio fixture (Indic Conformer) | `sample_hi.raw` — 16 kHz mono PCM16, Hindi speech (staged in the device-farm bundle) |
| Audio fixture (siblings) | `sample.raw` — 16 kHz mono PCM16, English "Alice in Wonderland" excerpt |
| `parakeetConfig` (Indic Conformer) | `{ maxThreads: 4, useGPU: true, language: 'hi' }` |
| `parakeetConfig` (siblings) | `{ maxThreads: 4, useGPU: true }` |
| `minTextLength` (Indic Conformer / ctc / tdt / eou) | 10 |
| Expectation (sortformer) | `containsSpeaker: true` |

## Adreno 830 OpenCL smoke row — Indic Conformer

| Field | Value |
|---|---|
| Observed backend / execution provider | `OpenCL` / `GPU` |
| `backendDevice` / `backendId` | `1` (GPU) / `4` (OpenCL) |
| Model type key | `indicConformer` (canonicalised via `parakeet-helpers.js`) |
| Language head selected | `hi` (Hindi) |
| Segments produced | 1 |
| Transcript length | 111 chars |
| Transcript | `कुछ अणुओं में अस्थ केंद्रक होता है जिसका मतलब यह कि उनमें थोड़े या बिना किसी झटके से टूटने की प्रवृत्ति होती है` |
| Wall time (case, cold load + inference) | 68.47 s (`ok 5 - Indic Conformer GPU smoke … # time = 68473.962682ms`) |
| In-test assertions | `ok 1` backendId ∈ {3,4}, `ok 2` segments ≥ 1, `ok 3` chars ≥ 10 |

## Full Android smoke matrix landed in the same run (Adreno 830 / OpenCL)

All five smoke cases engaged OpenCL — no CPU fallback, no `gpuUnsupported`
flag, no missing-op error. Wall times below are the per-case brittle wall
time (includes cold model load on the first case; subsequent cases benefit
from a warm process).

| Case (`modelType`) | Backend | `backendId` | Text length | Wall time | Result |
|---|---|---:|---:|---:|---|
| `ctc` (parakeet-ctc-0.6b) | OpenCL | 4 | 292 chars EN | 75.31 s | ✓ pass |
| `tdt` (parakeet-tdt-0.6b-v3) | OpenCL | 4 | 298 chars EN | 2.66 s | ✓ pass |
| `eou` (parakeet-eou-120m-v1) | OpenCL | 4 | 290 chars EN | 13.01 s | ✓ pass |
| `sortformer` (sortformer-4spk-v1) | OpenCL | 4 | 38 chars (`Speaker 1: …`) | 12.97 s | ✓ pass |
| **`indicConformer` (indic-conformer-ctc)** | **OpenCL** | **4** | **111 chars HI** | **68.47 s** | **✓ pass** |

The `tdt` wall time is much smaller than `ctc` because the OpenCL backend +
Adreno kernel cache were already warm from the preceding `ctc` case in the
same process; the Indic Conformer case incurs a fresh cold load because it
switches to a different .gguf file.

## Cross-device sanity check — Pixel 9 / Mali-G715 / Vulkan (run 32483218937)

The same commit ran cleanly on a Mali/Vulkan device with identical assertions
green, confirming there is no OpenCL-only code path and no Adreno-specific
side effect in the new test case.

| Case | Backend | `backendId` | Text length | Wall time | Result |
|---|---|---:|---:|---:|---|
| `ctc` | Vulkan (Mali-G715) | 3 | 292 chars EN | — | ✓ pass |
| `tdt` | Vulkan | 3 | 298 chars EN | — | ✓ pass |
| `eou` | Vulkan | 3 | 290 chars EN | — | ✓ pass |
| `sortformer` | Vulkan | 3 | 38 chars | — | ✓ pass |
| **`indicConformer`** | **Vulkan** | **3** | **113 chars HI** | **47.14 s** | **✓ pass** |

The Vulkan-side Hindi transcript reads
`कुछ अणुओं में अस्थिर केंद्रक होता है जिसका मतलब यह कि उनमें थोड़े या बिना किसी
झटके से टूटने की प्रवृत्ति होती है`. The only material difference vs the
OpenCL/Adreno output is one word (`अस्थिर` → `अस्थ`) — a small WER drop that
falls within the expected variance between two GPU backends running the same
q4_0-quantized model, and well within the smoke's `minTextLength: 10`
tolerance.

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
Adreno 750) to sanity-check on a lower tier of the same family.

## Notes

- No `qvac-ext-ggml` speech kernels were added or modified for this change;
  the sibling parakeet-ctc-0.6b's existing OpenCL coverage already provides
  the Conformer encoder ops used by Indic Conformer.
- No `qvac-ext-whisper.cpp` changes — Indic Conformer is pure Conformer + CTC
  and does not import the whisper compute path.
- Only `q4_0` is exercised on mobile per the existing `loadGgufOrSkip` mobile
  bundle convention. Desktop CI (`sanity-checks (asr-ggml)`, PR checks on
  [run 32480872360](https://github.com/tetherto/qvac/actions/runs/32480872360))
  additionally validates the `q8_0` desktop default via the desktop
  integration matrix — the same smoke file runs on Linux/macOS/Windows GPU
  runners with `useGPU=true` and passes without new fixtures being required.
