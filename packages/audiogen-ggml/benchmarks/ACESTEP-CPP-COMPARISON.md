# ACE-Step C++ Implementation Comparison

This report compares the QVAC `@qvac/audiogen-ggml` stack with
`ServeurpersoCom/acestep.cpp`, with Android Adreno OpenCL as the target
deployment question. It is a source and build comparison, followed by a
real-device validation protocol and its first attempted result. It is not a
claim that the two projects have been benchmarked like-for-like on Adreno.

## Decision summary

QVAC is the more complete base for an Android product integration. Its package,
engine, ggml fork, mobile prebuilds, backend packaging, and on-device telemetry
form one integrated path. However, the released `@qvac/audiogen-ggml@0.2.3`
failed the S25 Ultra acceptance run described below: the process aborted inside
`ggml_cl_compute_forward` before generation completed. The comparison project
is the stronger reference for the full ACE-Step workstation/server feature
set, especially batching, additional task types, model selection, and explicit
VRAM policy.

The central OpenCL finding is unambiguous:

- The comparison application does not enable or link OpenCL in its CMake
  targets. Its backend link loop covers CPU, BLAS, CUDA, Metal, Vulkan, and
  SYCL, but not OpenCL.
- It has no production Android application build or Android CI lane. Its
  `buildtermux.sh` is a CPU/BLAS Termux convenience build, not an Android
  package, NDK integration, OpenCL build, or device validation pipeline.
- Its pinned ggml fork contains substantial generic, Adreno-aware OpenCL
  infrastructure and kernels, but OpenCL has no implementation of the two
  custom VAE operations that the application documents as required:
  `GGML_OP_SNAKE` and `GGML_OP_COL2IM_1D`.
- QVAC's resolved `ggml-speech` source implements both operations in OpenCL,
  and the QVAC engine deliberately prefers OpenCL on Adreno 700+.

Therefore, an Adreno result from QVAC must not be presented as a benchmark of
the comparison application. It validates QVAC's port and product integration.

## Immutable comparison basis

The audit is pinned to these revisions:

| Component | Immutable revision | Resolution evidence |
|---|---|---|
| QVAC monorepo | [`b9dc5d971aef5bf6e1ecc4cb471bc90c3dcf56d6`](https://github.com/tetherto/qvac/tree/b9dc5d971aef5bf6e1ecc4cb471bc90c3dcf56d6) | Local `HEAD` and all local paths in this report |
| QVAC `speech-cpp` version | `2026-08-18#2`, port tree [`ca390a477fa1815628d4793afb96883681cbfd5d`](https://github.com/tetherto/qvac-registry-vcpkg/tree/ca390a477fa1815628d4793afb96883681cbfd5d) | [`versions/s-/speech-cpp.json`](https://github.com/tetherto/qvac-registry-vcpkg/blob/6abef47d396143286153203be55830d67bf7ed79/versions/s-/speech-cpp.json) |
| QVAC umbrella engine source | [`tetherto/qvac-ext-lib-whisper.cpp@792b68921bc323a2daff93bc580a15b55ee71b9b`](https://github.com/tetherto/qvac-ext-lib-whisper.cpp/tree/792b68921bc323a2daff93bc580a15b55ee71b9b) | `speech-cpp` [`portfile.cmake`](https://github.com/tetherto/qvac-registry-vcpkg/blob/6abef47d396143286153203be55830d67bf7ed79/ports/speech-cpp/portfile.cmake) sets this exact `REF`; `engines/audiogen` is the `audiogen-cpp` source |
| QVAC `ggml-speech` source | [`tetherto/qvac-ext-ggml@0a76e3ed969781da6de41d6c9a1c3fc471c0978b`](https://github.com/tetherto/qvac-ext-ggml/tree/0a76e3ed969781da6de41d6c9a1c3fc471c0978b) | `ggml-speech` [`2026-08-18` portfile](https://github.com/tetherto/qvac-registry-vcpkg/blob/e77bde02e7f160e7d0264a4c42446d49b9b18f80/ports/ggml-speech/portfile.cmake) |
| Comparison application | [`ServeurpersoCom/acestep.cpp@9761469d95fc204b5468623c68a1a2203e50b1f9`](https://github.com/ServeurpersoCom/acestep.cpp/tree/9761469d95fc204b5468623c68a1a2203e50b1f9) | Explicit comparison pin |
| Comparison ggml submodule | [`ServeurpersoCom/ggml@c044c6f03892f9d5e98213b05f8afea1f8b0d3c9`](https://github.com/ServeurpersoCom/ggml/tree/c044c6f03892f9d5e98213b05f8afea1f8b0d3c9) | `ggml` submodule entry at the application pin |

The exact QVAC engine revision resolved by `speech-cpp 2026-08-18#2` is
`792b68921bc323a2daff93bc580a15b55ee71b9b`, not the thin addon wrapper's
monorepo commit.

### Registry reproducibility note

At the QVAC pin, `packages/audiogen-ggml/vcpkg-configuration.json` names
registry baseline
[`cf1500e91d595db131c41421d4e1455f9143ec6e`](https://github.com/tetherto/qvac-registry-vcpkg/tree/cf1500e91d595db131c41421d4e1455f9143ec6e),
while `packages/audiogen-ggml/vcpkg.json` requires `speech-cpp >=
2026-08-18#2`. The baseline snapshot itself predates that version record; the
registry version record maps the requested version to immutable port tree
`ca390a...`, which in turn pins engine source `792b689...`. No package-local
`vcpkg-lock.json` was present in this checkout. Reproducing the audited build
should therefore record the resolved vcpkg graph or preserve the corresponding
binary cache metadata in addition to retaining the manifest and baseline.

## Methodology and limitations

The QVAC wrapper, package build, tests, benchmark harness, and CI were inspected
locally at the pinned commit. The resolved `speech-cpp`, `audiogen-cpp`,
`ggml-speech`, comparison application, and comparison ggml sources were
inspected through read-only GitHub API requests at immutable revisions. No
external code was downloaded or executed.

Claims in this report are limited to source, build wiring, committed tests,
committed documentation, and the proposed QVAC measurement protocol:

- A phone functional acceptance run was attempted; it crashed before any
  benchmark measurement completed.
- No measured value is inferred from README performance statements or old log
  files.
- The two implementations do not expose identical model sets, batching,
  residency policies, backend selection, or output encoding, so raw timings
  would need a separately controlled protocol.
- The comparison application cannot currently produce a genuine OpenCL Adreno
  row without implementation and build changes. Substituting its Vulkan,
  desktop, or Termux CPU result would not answer the OpenCL question.
- QVAC's engine README mentions informal parity observations, but correctly
  labels them non-reproducible because the model set, command, upstream
  revision, metric definition, and artifact were not pinned. They are not used
  as evidence here.

## Stack and architecture

### QVAC

The product call path is:

```text
AudioGen
  -> Bare native binding
  -> qvac::audiogenggml::acestep::AcestepModel
  -> tts_cpp::acestep::Engine
  -> LM -> FSQ detokenizer -> text/condition encoders -> DiT -> VAE
```

The relevant local boundaries are:

- `packages/audiogen-ggml/src/audiogen.ts`: `AudioGenInterface` owns and calls
  the native handle.
- `packages/audiogen-ggml/addon/src/js-interface/binding.cpp`:
  `qvac_audiogen_ggml_exports` exposes lifecycle and job functions to Bare.
- `packages/audiogen-ggml/addon/src/js-interface/JSAdapter.cpp`:
  `JSAdapter::buildAcestepConfig` translates the JS configuration.
- `packages/audiogen-ggml/addon/src/model-interface/acestep/AcestepModel.cpp`:
  `AcestepModel::loadLocked`, `generate`, and `runtimeStats` call and report the
  engine.
- Resolved engine
  [`engines/audiogen/src/acestep/engine.cpp`](https://github.com/tetherto/qvac-ext-lib-whisper.cpp/blob/792b68921bc323a2daff93bc580a15b55ee71b9b/engines/audiogen/src/acestep/engine.cpp):
  `Engine::create` selects backends and `Engine::generate` orchestrates stages.

The facade is designed for embedding: it returns interleaved float PCM to the
addon, which peak-normalizes non-edit output and converts it to interleaved
Int16 PCM. Progress is reported by stage; final audio is emitted after the full
generation.

### Comparison application

The comparison project is a standalone application and server. Its
[`ModelStore`](https://github.com/ServeurpersoCom/acestep.cpp/blob/9761469d95fc204b5468623c68a1a2203e50b1f9/src/model-store.h)
owns modules shared by three distinct pipelines:

- `pipeline-lm`: caption/lyrics to metadata and audio codes;
- `pipeline-synth`: text/condition encoding, DiT, and VAE synthesis;
- `pipeline-understand`: audio to metadata, lyrics, and codes.

It builds an HTTP server, dedicated CLI tools, a standalone VAE codec, an MP3
codec, and a quantizer. This separation makes pipeline stages independently
callable and allows latent reuse between endpoints. QVAC instead presents a
smaller embedded `Engine` contract optimized for addon lifecycle, cancellation,
progress, and consistent multi-platform packaging.

## Models, tasks, and controls

| Area | QVAC addon and resolved engine | Comparison application |
|---|---|---|
| ACE-Step model set | QVAC registry combinations use Qwen3-Embedding 0.6B Q8, ACE-Step LM 0.6B Q8, BF16 VAE, and `turbo-q4`, `turbo-q8`, or `sft` DiT | LM 0.6B/1.7B/4B; turbo, SFT, base, shift, continuous, and documented XL DiTs; multiple quantizations |
| Additional architecture | Resolved `audiogen-cpp` also contains desktop-only, CPU-only MiniMax-Music3; `@qvac/audiogen-ggml` binds `tts_cpp::acestep::Engine`, not MiniMax | ACE-Step only |
| Generation | Text/lyrics, language, BPM, key, time signature, duration, fixed or random seed, metadata caption augmentation | Same core controls, plus independent LM seed, negative prompt, and LM modes |
| Sampling | Turbo/base auto steps and shift, LM temperature/top-p/top-k/CFG, DCW controls | Custom timesteps, Euler/SDE/DPM3M/STORK4 solvers, latent shift/rescale, CFG split control, FP16 clamp |
| Audio conditioning | Timbre reference, source audio, `cover-nofsq`; full FSQ `cover` is accepted but not implemented | Cover, cover-nofsq, repaint/outpaint, lego, extract, and complete |
| Editing | Ordered, repeatable FlowEdit and repaint operations; FlowEdit is deliberately restricted to its validated Turbo/Euler/no-CFG path | Region repaint/outpaint and source tasks; broader task dispatcher |
| Reverse and codec paths | No addon reverse-understand or standalone VAE endpoint | Understand pipeline and standalone VAE encode/decode endpoint; latent inputs can bypass repeated VAE encoding |
| Output | 48 kHz stereo Int16 PCM at addon boundary; package encoding helpers can produce files | 48 kHz stereo WAV16/WAV24/WAV32 or MP3 |
| Adapters | Not exposed by the QVAC ACE-Step API | PEFT and ComfyUI LoRA adapter selection and scale |

The comparison project has greater ACE-Step surface area. QVAC has the more
deliberate embedded API, mobile constraints, fallback telemetry, and ordered
editing contract.

## Android and OpenCL wiring

### QVAC path

QVAC's Android dependency is explicit in
[`packages/audiogen-ggml/vcpkg.json`](https://github.com/tetherto/qvac/blob/b9dc5d971aef5bf6e1ecc4cb471bc90c3dcf56d6/packages/audiogen-ggml/vcpkg.json):

```text
speech-cpp[audiogen,vulkan,opencl]
```

That expands through `speech-cpp` into `ggml-speech[vulkan,opencl]`. The
resolved `ggml-speech` port enables `GGML_BACKEND_DL`,
`GGML_CPU_ALL_VARIANTS`, and `GGML_CPU_REPACK` on Android, disables Vulkan
cooperative-matrix paths there, and installs generated backend modules.

QVAC then completes the runtime path:

1. `packages/audiogen-ggml/CMakeLists.txt` enumerates
   `GGML_AVAILABLE_BACKENDS` and packages backend targets and loose
   `libqvac-speech-ggml-*.so` modules beside the `.bare` addon.
2. It applies Android 16 KiB ELF page-size linker options.
3. `AcestepModel::loadLocked` composes the per-target backend directory and
   passes `EngineOptions::backends_dir`.
4. Resolved engine symbol
   [`load_backends`](https://github.com/tetherto/qvac-ext-lib-whisper.cpp/blob/792b68921bc323a2daff93bc580a15b55ee71b9b/engines/audiogen/src/acestep/backend_registry.h)
   calls `ggml_backend_load_all_from_path` before backend acquisition.
5. `backend_gpu_init` accepts discrete and integrated devices, tries every
   candidate, and explicitly prefers an OpenCL device whose name or description
   identifies Adreno 700+.
6. `resolve_stage_placement` keeps DiT and VAE on the selected GPU and uses a
   measured allowlist for encoders, LM, and FSQ detokenizer. OpenCL on Adreno
   740 is the committed validation basis for LM and detokenizer placement.
7. `AcestepModel::runtimeStats` maps the resolved engine backend name to
   `backendDevice` and `backendId`, so CPU or Vulkan fallback is observable.

Mobile smoke tests currently accept Vulkan (`backendId=3`) or OpenCL
(`backendId=4`) for a general GPU request. The Adreno validation defined below
is intentionally stricter: it requires `backendId=4`.

### Comparison application path

The pinned application
[`CMakeLists.txt`](https://github.com/ServeurpersoCom/acestep.cpp/blob/9761469d95fc204b5468623c68a1a2203e50b1f9/CMakeLists.txt)
adds the ggml submodule and links known backend targets in
`link_ggml_backends`. OpenCL is absent from that target list. The documented
builds and committed CI cover desktop CPU, CUDA, Metal, and Vulkan. The
[`ci-build.yml`](https://github.com/ServeurpersoCom/acestep.cpp/blob/9761469d95fc204b5468623c68a1a2203e50b1f9/.github/workflows/ci-build.yml)
matrix is Ubuntu and macOS only.

The repository's
[`buildtermux.sh`](https://github.com/ServeurpersoCom/acestep.cpp/blob/9761469d95fc204b5468623c68a1a2203e50b1f9/buildtermux.sh)
enables BLAS and performs a local CMake build in Termux. It does not enable
OpenCL, use the Android NDK, package backend modules, build an APK/AAR/Bare
module, or run Android CI. It is not a production Android path.

## OpenCL operation gap and Adreno hardening

The comparison application's VAE documentation says
`GGML_OP_SNAKE` and `GGML_OP_COL2IM_1D` are required. At pinned ggml commit
`c044c6f...`, implementations exist for CPU and selected GPU backends, including
CUDA/Vulkan/SYCL paths, but its `src/ggml-opencl/kernels` tree contains neither
`snake.cl` nor `col2im_1d.cl`. The application therefore cannot merely add
`opencl` to its backend target loop; the VAE graph would still lack required
OpenCL operations.

This does not mean its ggml fork lacks Adreno work. Its pinned
[`ggml-opencl.cpp`](https://github.com/ServeurpersoCom/ggml/blob/c044c6f03892f9d5e98213b05f8afea1f8b0d3c9/src/ggml-opencl/ggml-opencl.cpp)
contains Adreno generation and compiler detection, Qualcomm large-buffer
handling, Adreno kernel selection, compiler-version exclusions, and generic
matrix/attention kernels. Those facilities are valuable but do not fill the
two application-specific VAE operation gaps.

QVAC's resolved ggml source contains:

- OpenCL
  [`snake.cl`](https://github.com/tetherto/qvac-ext-ggml/blob/0a76e3ed969781da6de41d6c9a1c3fc471c0978b/src/ggml-opencl/kernels/snake.cl)
  and
  [`col2im_1d.cl`](https://github.com/tetherto/qvac-ext-ggml/blob/0a76e3ed969781da6de41d6c9a1c3fc471c0978b/src/ggml-opencl/kernels/col2im_1d.cl),
  plus backend dispatch for the corresponding ggml operations;
- `ggml_opencl_should_use_wide_gemv`, which checks a compiled kernel's actual
  `CL_KERNEL_WORK_GROUP_SIZE` before selecting a wide Adreno GEMV launch;
- `kernel_diag_mask_inf_8` bounds checks and a host launch rounded to a safe
  local size, using wide unsigned element counts for padded work-items;
- `log_opencl_enqueue_failure`, which preserves kernel/op/global/local-size
  diagnostics in normal and profiling builds;
- tests `test-opencl-workgroup` and backend-op coverage for these launch rules;
- engine-side `parse_adreno_version`, `backend_dev_prefers_opencl`, and
  `backend_gpu_init`, which prevent generic backend enumeration order from
  selecting Vulkan first on a validated Adreno OpenCL device.

These are concrete integration and compiler/driver hardenings, not a generic
claim that every Adreno device or driver is supported.

## Memory, residency, and batching

### QVAC

Resolved `Engine::Impl` defaults to sequential stage residency. `Engine::create`
reads lightweight metadata, while `Engine::generate` uses `ensure_*` immediately
before a stage and `free_*` after it. The design bounds model weight residency
to roughly one major stage instead of retaining all six runtime weight sets,
which is important under Android/iOS memory pressure.

`ACESTEP_KEEP_STAGES` is an opt-in latency/throughput mode that eagerly loads
and retains stages. VAE decode separately adapts its window to the backend's
allocation cap. The public addon handles one generation job per model instance;
there is no exposed LM or DiT multi-song batch.

Strength: conservative mobile peak memory and simple lifecycle. Weakness:
repeated requests can repay model load costs unless stage retention is enabled,
and the addon does not expose the richer throughput controls.

### Comparison application

`ModelStore` formalizes two policies:

- `EVICT_STRICT`: at most one GPU module resident at a time;
- `EVICT_NEVER` (`--keep-loaded`): retain the complete working set.

It shares one LM instance between generation and understand pipelines, caches
small CPU metadata, uses keyed/refcounted module handles, and exposes VAE tile
size and overlap. It also supports LM batches and synth batches; the synthesis
dispatcher accepts batches up to nine and combines request arrays with
`synth_batch_size`.

Strength: explicit server-grade residency and batching model. Weakness: more
policy surface and fewer product-level mobile constraints or telemetry.

## Tests and benchmark evidence

QVAC has coverage at three levels:

- Resolved engine C++ unit and integration tests under
  [`engines/audiogen/test`](https://github.com/tetherto/qvac-ext-lib-whisper.cpp/tree/792b68921bc323a2daff93bc580a15b55ee71b9b/engines/audiogen/test),
  including stage-placement policy, deterministic logic, editing, model-backed
  API generation, progress, and cancellation.
- Addon unit/integration/mobile tests under
  `packages/audiogen-ggml/test`, including lifecycle, output format, memory,
  backend reporting, registry model resolution, and CPU/GPU generation.
- RTF infrastructure in
  `packages/audiogen-ggml/benchmarks/RTF-BENCHMARKS.md`,
  `packages/audiogen-ggml/test/utils/benchmark-runner.js`, and
  `scripts/perf-report/aggregate-audiogen-ggml-rtf.js`. It records requested
  and observed backends separately, load time, wall time, RTF, RSS, model size,
  audio duration, sample format, and signal energy.

The comparison project compiles `test-philox`, `test-model-store`, and
`test-lm-prompt`; it also commits CPU/CUDA/Metal/Vulkan comparison logs and
debug cosine scripts. Its CI builds and smoke-checks tools but does not download
models or run full generation. There is no committed Android/OpenCL lane or
controlled Adreno benchmark.

Neither repository supplies a pinned, like-for-like cross-implementation
Adreno benchmark at these revisions.

## Build reproducibility, license, and provenance

QVAC:

- pins the monorepo, vcpkg port trees, engine source, and ggml source through
  manifests and immutable Git references;
- builds a library-only `speech-cpp[audiogen]` engine with a shared
  `ggml-speech` dependency and turns engine tests/executables off in the
  consumer port;
- uses QVAC registry model paths and named four-file combinations; the model
  manifest identifies the `2026-07-22` build folder;
- licenses `@qvac/audiogen-ggml` under Apache-2.0, with `audiogen-cpp` and ggml
  components under MIT and component attribution in
  `packages/audiogen-ggml/NOTICE`;
- must preserve model-weight and upstream model terms separately from code
  licenses.

The comparison project:

- pins its ggml submodule at the audited commit and embeds its application Git
  revision into binaries;
- offers build scripts, but distributed dependency/toolchain inputs are less
  centrally pinned than QVAC's vcpkg graph;
- publishes and documents broader Hugging Face GGUF choices, so a benchmark
  must record exact filenames, sizes, and hashes rather than only "turbo";
- is MIT licensed, while ACE-Step model weights and original model code retain
  their own terms and provenance.

Both projects credit ACE-Step 1.5. Code-license compatibility does not grant
rights to redistribute model weights.

## Strengths and weaknesses

### QVAC

Strengths:

- complete embedded addon path across JS, Bare, C++, ggml, prebuilds, and mobile
  CI;
- explicit Android Vulkan/OpenCL features and dynamic backend packaging;
- required VAE operations implemented on OpenCL;
- Adreno 700+ OpenCL preference and backend-specific stage placement;
- resolved backend telemetry that exposes fallback;
- low-memory sequential residency, cancellation, progress, and structured RTF
  reporting.

Weaknesses:

- narrower ACE-Step model/task/control surface;
- no public multi-song batching;
- no reverse-understand or latent-service API;
- the attempted S25 Ultra OpenCL acceptance run aborted inside ggml's OpenCL
  compute path before producing audio or backend telemetry;
- registry resolution should be captured more completely for audit-grade build
  replay.

### Comparison application

Strengths:

- broadest ACE-Step feature surface and workstation/server tooling;
- clear `ModelStore` policy, multi-request batching, adapters, alternate
  solvers, reverse understanding, latent reuse, and codec tools;
- useful per-stage debugging and parity workflow;
- broad desktop backend source and committed reference logs.

Weaknesses for this target:

- no linked OpenCL application path;
- required VAE OpenCL operations are missing;
- no production Android packaging or CI;
- no authoritative runtime backend telemetry equivalent to the addon's
  `backendId`;
- broader options make an uncontrolled benchmark easier to misconfigure.

## Ranked recommendations

### 1. Adopt or match

1. Treat the S25 Ultra `ggml_cl_compute_forward` abort as a release-readiness
   blocker for ACE-Step on Adreno OpenCL. Symbolize the failing OpenCL frames,
   identify the operation or enqueue error, fix it, and rerun this protocol.
2. Keep QVAC as the Android/Adreno implementation and validation vehicle.
3. Keep observed backend identity authoritative. Require `backendId=4` for the
   Adreno OpenCL acceptance run; reject Vulkan or CPU fallback.
4. Preserve QVAC's dynamic backend packaging, 16 KiB Android linker settings,
   OpenCL VAE operations, per-kernel workgroup validation, padded dispatch
   safety, and enqueue diagnostics.
5. Match the comparison project's explicit residency vocabulary in engineering
   documentation: low-memory/strict versus keep-loaded, including load-time and
   peak-memory consequences.
6. Match its benchmark provenance discipline where useful: exact model
   filenames/hashes, engine and ggml commits, full device/driver/build identity,
   and cold versus steady-state runs.

### 2. Evaluate separately

1. Multi-song LM/DiT batching and server-oriented stage retention.
2. Full `cover`, lego/extract/complete, understand, and latent reuse.
3. Independent LM seed/negative prompt, custom timesteps, and alternate
   solvers.
4. Adapter support and larger LM/DiT variants.
5. VAE chunk/overlap tuning as a supported API only after mobile quality and
   memory tests establish safe bounds.

Each item changes API, memory, numerical behavior, or product scope and should
have its own design and validation work.

### 3. Do not copy directly

1. Do not copy the comparison application's backend link loop for Android; it
   omits OpenCL and QVAC needs dynamic modules.
2. Do not treat `buildtermux.sh` as an Android product build.
3. Do not import generic Adreno OpenCL kernels and assume ACE-Step works; the
   two custom VAE operations and host dispatch are mandatory.
4. Do not copy desktop batch or keep-loaded defaults onto phones without
   memory-pressure evidence.
5. Do not publish the comparison project's old logs or README timings as
   QVAC, OpenCL, or like-for-like evidence.

## QVAC real-device validation

Attempt 1 was run on 2026-08-20 through AWS Device Farm:
[workflow run 32359647987](https://github.com/tetherto/qvac/actions/runs/32359647987).
The workflow-level conclusion is `success` because the mobile job is
non-blocking, but the `Build Android and Run E2E Tests` job and Device Farm run
failed. The app aborted with `SIGABRT` about 12 seconds after
`testGenerateMusicOnGpu` started. The native backtrace contains
`ggml_abort`, `ggml_cl_compute_forward`, `ggml_backend_graph_compute`, and
`tts_cpp::acestep::Engine::generate`, proving execution reached the OpenCL
backend before the crash. No audio, resolved `backendId`, or benchmark summary
was emitted.

This is a failed acceptance result, not an OpenCL performance result. Preserve
the protocol and remaining fields below for the rerun after the native abort is
diagnosed.

### Acceptance protocol

- Model: `turbo-q4`, recording all four exact GGUF filenames and hashes.
- Prompt: fixed and recorded verbatim.
- Lyrics: `[Instrumental]`.
- Seed: fixed and recorded.
- Requested duration: 10-15 seconds; use one value for all runs.
- GPU request: enabled.
- OpenCL reporting hint:
  `QVAC_AUDIOGEN_GGML_BENCHMARK_BACKEND=opencl`.
- Warmup: one cold run immediately after load.
- Measured runs: at least two steady-state runs.
- Required observed backend: `activeBackend=opencl` and `backendId=4`.
- Output gate: 48,000 Hz, two channels, non-empty, finite signal with recorded
  peak and RMS.

> `QVAC_AUDIOGEN_GGML_BENCHMARK_BACKEND=opencl` is a reporting hint, not a
> runtime backend selector. It cannot prove OpenCL execution. The resolved
> `activeBackend` and `backendId` telemetry are authoritative. A row with
> `backendId=3`, `0`, `99`, or missing telemetry fails this OpenCL validation,
> regardless of the requested label.

### Build and device identity

| Field | Value |
|---|---|
| QVAC commit | `b9dc5d971aef5bf6e1ecc4cb471bc90c3dcf56d6` |
| Resolved `speech-cpp` | `2026-08-18#2` / port tree `ca390a477fa1815628d4793afb96883681cbfd5d` |
| Resolved engine source | `792b68921bc323a2daff93bc580a15b55ee71b9b` |
| Resolved `ggml-speech` source | `0a76e3ed969781da6de41d6c9a1c3fc471c0978b` |
| Prebuild package/artifact identifier | `@qvac/audiogen-ggml@0.2.3`; native `libqvac__audiogen-ggml.0.2.3.so` |
| Build run ID and attempt | [`32359647987`, attempt 1](https://github.com/tetherto/qvac/actions/runs/32359647987) |
| Build type/toolchain/NDK | Device Farm workflow build; exact toolchain/NDK not captured in the collected evidence |
| Device manufacturer/model | Samsung Galaxy S25 Ultra |
| Device hardware identifier | `pa3quew`; model/build family `S938U1` |
| Android version/API level/build fingerprint | Android 15; `samsung/pa3quew/pa3q:15/AP3A.240905.015.A2/S938U1UEU1AYA1_OYM1AYA1:user/release-keys`; API level not captured |
| SoC | Not captured in the collected evidence |
| GPU | Adreno device; exact reported model string not captured |
| OpenCL driver/device version | Not captured; Vulkan initialization separately reported compiler `E031.47.18.13` and driver `0800.17.11`, which must not be substituted for OpenCL identity |
| Available RAM before run | Not captured |

### Fixed workload

| Field | Value |
|---|---|
| DiT variant | `turbo-q4` |
| Text encoder GGUF and SHA-256 | `Qwen3-Embedding-0.6B-Q8_0.gguf`; hash not captured |
| LM GGUF and SHA-256 | `acestep-5Hz-lm-0.6B-Q8_0.gguf`; hash not captured |
| DiT GGUF and SHA-256 | `acestep-v15-turbo-Q4_K_M.gguf`; hash not captured |
| VAE GGUF and SHA-256 | `vae-BF16.gguf`; hash not captured |
| Total model size | `3,277,122,816` bytes (`3.05` GiB), from the four Device Farm push records |
| Prompt | `Upbeat pop rock with driving electric guitars, punchy drums and a catchy hook` |
| Lyrics | `[Instrumental]` |
| Seed | Not specified by `testGenerateMusicOnGpu` |
| Requested duration | `10` seconds |
| Inference steps/shift | `8` / `3.0` |
| Warmup/measured run count | `0` completed / `0` measured; process aborted during the first generation |

### Observed results

| Metric | Value |
|---|---|
| Acceptance result | **FAILED — native `SIGABRT` in OpenCL compute path** |
| Requested backend hint | No reporting hint captured for this functional-test dispatch |
| `activeBackend` | Not emitted; native stack reached `ggml_cl_compute_forward` |
| `backendId` | Not emitted; required value `4` therefore not proven through runtime telemetry |
| `backendDevice` | Not emitted |
| Model load time | Not emitted |
| Cold wall time | Not completed; test started at `10:46:32.645Z`, process aborted at `10:46:45.073Z` |
| Mean measured wall time | Not available |
| Cold RTF | Not available |
| Mean RTF | Not available |
| Average RSS | Not available |
| Last observed process PSS | `1,025,273,856` bytes immediately before the abort |
| Output duration | No output |
| Sample rate | Not observed |
| Channels | Not observed |
| Peak amplitude | Not available |
| RMS amplitude | Not available |
| Artifact/report path | GitHub artifact `console-logs-qvac-audiogen-ggml-Android` on run `32359647987` |
| Run notes, thermal state, and failures | Test result JSON: `crashed: true`, 0 passed/0 failed, test remained `running`; native backtrace: `ggml_abort` → `ggml_cl_compute_forward` → `ggml_backend_graph_compute` → `Engine::generate` |

Record both the machine-readable benchmark artifact and the exact generated
WAV. If any measured run reports a different backend ID, keep the artifact as
fallback evidence but do not include it as OpenCL coverage.
