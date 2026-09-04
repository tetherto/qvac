# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`@qvac/asr-ggml` is the merge of two previously separate packages:
`@qvac/transcription-whispercpp` (final release `0.12.1`) and
`@qvac/transcription-parakeet` (final release `0.10.1`). Version numbering
restarts at `0.1.0`; the two pre-merge histories are preserved verbatim as
[`docs/WHISPER-CHANGELOG.md`](https://github.com/tetherto/qvac/blob/main/packages/asr-ggml/docs/WHISPER-CHANGELOG.md) and
[`docs/PARAKEET-CHANGELOG.md`](https://github.com/tetherto/qvac/blob/main/packages/asr-ggml/docs/PARAKEET-CHANGELOG.md).

## [Unreleased]

### Changed

- Raise the `speech-cpp` floor to 2026-09-03. Silero VAD now honors
  `use_gpu`: the compute backends match the weight placement, fixing the
  ggml_backend_sched abort ("pre-allocated tensor in a buffer that cannot
  run the operation") that killed every `use_gpu=true` VAD context init on
  GPU builds (Metal, Vulkan, CUDA, HIP), and the VAD LSTM input is made
  contiguous to satisfy the CUDA mul-mat-vec kernel's stride requirement.
  The addon creates its VAD context with the default (CPU) parameters, so
  runtime behavior is unchanged; the fix matters for anything that opts
  VAD into the GPU.

## [0.4.2] - 2026-09-01

### Changed

- Drop CUDA from the published linux-x64 prebuild so the npm tarball stays
  under the registry size limit. `use_gpu` / `useGPU: true` uses Vulkan on
  Linux. CUDA remains opt-in at build time via `ASR_CUDA=ON`.

- Raise the `speech-cpp` floor to 2026-09-01#2, which brings in ggml-speech
  2026-09-02. The CUDA backend now skips, at registration, GPUs whose
  compute capability has no compiled code in the fatbin, so a
  `use_gpu` / `useGPU: true` run on such a card (Turing and older) falls
  back to Vulkan or CPU instead of failing at the first kernel launch. The
  CUDA fatbin now carries native code for every architecture the prebuilds
  target — Turing (7.5), Ampere (8.0, 8.6), Ada (8.9), Hopper (9.0) and
  Blackwell (12.0, 12.1) — with 8.0 PTX for anything newer, so Turing is
  supported again and Blackwell no longer pays a first-use JIT. The roll
  also brings the compute-buffer OOM handling and k-quant GET_ROWS fixes, and
  fixes two multi-GPU faults on a host that mixes supported and unsupported
  NVIDIA cards: backend initialisation no longer aborts when the unsupported
  card enumerates first, and a row-split buffer no longer allocates on the
  skipped card.

## [0.4.1] - 2026-08-28

### Added

- CUDA GPU acceleration on linux x64: the prebuild now builds with
  `ASR_CUDA=ON` and bundles the CUDA backend alongside Vulkan and the
  per-arch CPU variants as runtime-loaded modules, and `use_gpu` /
  `useGPU: true` prefers CUDA on NVIDIA hosts (whisper and parakeet). CUDA
  engages where the NVIDIA driver and CUDA 13 runtime libraries (cudart,
  cuBLAS) are present; on every other host the CUDA module is skipped and
  the addon behaves as before (Vulkan or CPU). The whisper backend loader
  now also runs
  on desktop linux-x64 (previously Android and linux-arm64 only) so the
  modules register before `whisper_init`.

### Changed

- CUDA builds no longer link the CUDA runtime into the addon and no longer
  export `CUDAHOSTCXX`: on linux-x64 the CUDA backend is a runtime-loaded
  module carrying its own runtime dependencies, and nvcc's clang host
  compiler comes from the shared linux toolchain. A CUDA build now loads on
  hosts without the CUDA runtime instead of failing with unresolved cudart
  symbols.

- Raise the `speech-cpp` floor to 2026-08-28, which brings in ggml-speech
  2026-08-28. Unused IQ / Q1_0 / MXFP4 / NVFP4 and training Vulkan shader
  payloads are replaced with tiny no-ops so the published natives stay
  under the npm tarball size limit. CUDA fatbins keep Ampere and Ada
  (`80-virtual;86-real;89-real`) and drop Turing sm75 and Blackwell
  sm120/121.

### Fixed

- Vulkan device-loss and fence failures now return a graph-compute error
  instead of aborting the process or continuing with an unusable device.
  Transcription surfaces the error rather than empty output, and pending
  compute state is unwound after the failure.

## [0.4.0] - 2026-08-27

### Added

- **CUDA GPU backend for both engines on Linux / Windows (NVIDIA).** The
  addon already resolved and reported CUDA at runtime (`BackendId.CUDA`, `2`),
  but no build ever compiled the backend in. `asr-ggml[cuda]` now forwards to
  `speech-cpp[cuda]` → `ggml-speech[cuda]` (`GGML_CUDA=ON`), gated behind the
  new `ASR_CUDA` CMake option and the `npm run build:cuda` /
  `build:native:cuda` scripts. It is opt-in rather than default because it
  needs `nvcc` on the build host, which the published prebuilds do not carry;
  only the NVIDIA driver is needed at runtime. CUDA is compiled alongside
  Vulkan, and ggml registers CUDA first, so a `use_gpu` / `useGPU` request
  prefers CUDA and falls back to Vulkan when no supported device is present.
  Apple and Android are excluded (`supports: !(osx | ios | android)`).

  Enabling it also required two build fixes, both of which made the CUDA path
  unbuildable before now:

  - On Linux the `ASR_CUDA` block exports `CUDAHOSTCXX=clang++` for the vcpkg
    child process. `nvcc` otherwise defaults to `g++`, which rejects the
    `-stdlib=libc++` the Linux triplets put in `VCPKG_CXX_FLAGS` /
    `VCPKG_LINKER_FLAGS`, so `enable_language(CUDA)` failed its ABI check.
    Deliberately not set in `vcpkg-overlays/toolchains/linux-clang.cmake`: that
    file's contents feed the vcpkg ABI hash of every package on the Linux
    triplets, so editing it invalidates the binary cache for non-CUDA builds
    too and forces every port to rebuild from source.
  - The addon links `CUDA::cudart` / `cublas` / `cublasLt` itself.
    `ggml-config.cmake` only adds a CUDA runtime to `ggml::ggml-cuda`'s
    interface under `if (GGML_STATIC)`, but `GGML_STATIC` also means
    `add_link_options(-static)` in ggml's own build and so cannot be enabled
    for a shared bare module. Without this the module linked `libcuda.so.1`
    and then aborted at load with
    `undefined symbol: __cudaRegisterFatBinary`. The dynamic runtime matches
    `diffusion-cpp`, so loading both addons into one process
    (`packages/ggml-coload-smoke`) cannot produce two CUDA runtime instances.

### Changed

- Renamed engine repository references from `qvac-ext-lib-whisper.cpp` to
  `qvac-fabric-speech.cpp` in the package documentation, following the
  upstream repository rename. Old GitHub links keep working via redirect.

- **The GPU integration tests accept CUDA as a desktop backend.**
  `gpu.test.js` and `parakeet-gpu-smoke.test.js` asserted
  `backendId === 3` (Vulkan) on Linux / Windows, which was written when Vulkan
  was the only GPU backend wired there. Both now accept CUDA (`2`) or Vulkan
  (`3`), because a CUDA-enabled build compiles both in and ggml registers CUDA
  first.
- Raise the `speech-cpp` floor to 2026-08-26#1, aligning all speech addons
  (`asr-ggml`, `tts-ggml`, `audiogen-ggml`, `bci-whispercpp`) on the same
  port and ggml-speech cut. Relative to 2026-08-26 the bundled ggml computes
  explicit-f32-precision matmuls in true f32 on CUDA and adds CONCAT support
  for all scalar and quantized types; the engine sources for whisper and
  parakeet are unchanged.
- Raise the `speech-cpp` floor to 2026-08-26, including the new opt-in `cuda`
  feature's own floor, which brings in ggml-speech
  2026-08-26. Sortformer finalization is now deterministic: every non-cancelled
  finalize ends with exactly one synthetic terminator, where before a real
  trailing segment could carry the final flag instead. The speaker spans this
  package emits are unchanged, because it keys off the terminator's negative
  speaker id rather than the flag. Indic Conformer multilingual CTC also runs on
  Vulkan now. The Whisper engine sources are unchanged. On the ggml side the
  update adds Vulkan `im2col`/`col2im` tiling, CUDA kernels and launch guards for
  the `conv_transpose_1d`, `im2col` and `pad` paths, and Adreno OpenCL launch
  validation with GEMV work-group limits.

### Fixed

- **Parakeet duplex streaming no longer drops the tail of the transcript when
  the audio stream ends while the engine still has a buffered backlog.** 
  `endStreaming()` joins the native worker only after it has drained all buffered
  audio, but the drained segments are delivered to JS asynchronously (uv_async);
  the parakeet driver then cleared the active job and emitted a synthetic `JobEnded`
  *before* those queued `Output` events arrived, so `_addonOutputCallback`
  discarded every one of them (`jobId === null`). Apps feeding audio faster
  than realtime (e.g. the SDK's `transcribeStream` fed from a file, then `end()`)
  lost most of the un-processed tail. `ParakeetStreamingProcessor` now queues a terminal
  `RuntimeStats` object (real `audioDurationMs` / `totalSamples`) through the
  **same FIFO output queue** as the drained segments after `finalize()` — exactly
  how the whisper engine's `StreamingProcessor` already signals completion — and
  the JS wrapper waits for that terminal event to flow through the normal
  output-callback path, so every drained segment is delivered, in order, before
  the job resolves. The synthetic `JobEnded` remains only as a fallback when no
  native session existed (`cleaned: false`), and concurrent `endStreaming()`
  calls join the in-flight teardown instead of falling through to it.

## [0.3.3] - 2026-08-20

### Changed

- Bump `@qvac/registry-client` from `^0.4.0` to `^0.6.1` as a development
  dependency so in-repo download and test tooling stays on the hyperdb v6 line.

## [0.3.2] - 2026-08-18

### Changed

- Raise the `speech-cpp` floor to 2026-08-18, which brings in ggml-speech
  2026-08-18. The update prevents unsupported wide OpenCL GEMV workgroups on
  Adreno devices and hardens padded DIAG_MASK_INF launches and diagnostics.

### Fixed

- Declare the Bare process and URL dependencies used by the published mobile
  integration runtime.

## [0.3.1] - 2026-08-17

### Changed

- Raise the `speech-cpp` floor to 2026-08-17, which brings in
  ggml-speech 2026-08-17. The engine sources for this package are unchanged; the
  ggml update fixes an uncatchable abort in the OpenCL elementwise ops on a
  non-contiguous input and speeds up pad, small-M matmul and argmax dispatches
  on Adreno.

### Added

- Add NVIDIA `parakeet-unified-en-0.6b` RNN-T support for CPU and GPU
  transcription, model staging, conversion, examples, and performance coverage.

### Changed

- Recognize the native engine's new `parakeet.model.type = "rnnt"` metadata as
  standard Parakeet ASR.
- Require `speech-cpp` 2026-08-17 for native Unified RNN-T inference.

### Fixed

- Publish a dependency-clean Whisper quickstart with positional audio, model,
  and VAD model arguments.
- Correct public documentation for Whisper VAD naming, engine-specific status
  codes, the `speech-cpp` umbrella dependency, and backend device value types.

## [0.3.0] - 2026-08-12

### Added

- **Choosing a model guide.** README documents which specific Whisper `.bin` or
  Parakeet `.gguf` to pick per use case (default TDT, EOU, CTC, Sortformer
  offline vs streaming, Whisper turbo/small for language breadth / translation).
- **`parakeetConfig.language`.** Optional multilingual CTC language id (e.g.
  `"hi"`, `"ta"`) forwarded to `EngineOptions::language`. Required for Indic
  Conformer GGUFs that advertise `parakeet.ctc.lang_*` ranges; ignored on
  monolingual CTC.

### Changed

- Update `parakeet-cpp` to `2026-08-10#2` for Indic Conformer CTC language
  masking.

### Pull Requests

- [#3702](https://github.com/tetherto/qvac/pull/3702) - QVAC-23279 feat[asr-ggml]:
  Indic Conformer CTC language support and fork registry pin
- [#3674](https://github.com/tetherto/qvac/pull/3674) - QVAC-22512 doc: add speech
  model choice guides for TTS and ASR

## [0.2.0] - 2026-08-06

### Changed

- Align `@qvac/infer-base` and `qvac-lib-inference-addon-cpp` dependency floors
  with the shared addon runtime validated across the live addon consumer set.

### Pull Requests

- [#3567](https://github.com/tetherto/qvac/pull/3567) - QVAC-18397 chore[notask]:
  test addon-cpp 1.3.3 across consumers

## [0.1.1] - 2026-08-03

### Changed
- Update `ggml-speech` dependency version to align with other packages that also depend on it.

## [0.1.0]

Initial release of the unified multi-engine ASR addon. One npm package, one
native prebuild (`BARE_MODULE qvac_asr_ggml`), and one public class —
`ASRGgml` — serving both the Whisper (whisper.cpp) and NVIDIA Parakeet
(parakeet-cpp) engines.

### Added

- `ASRGgml`, an engine-agnostic orchestrator. Verbs (`load`, `run`,
  `runStreaming`, `reload`, `cancel`, `status`, `unload`, `destroy`) have one
  signature regardless of engine; configuration vocabularies stay
  engine-scoped under `config.whisperConfig` / `config.parakeetConfig`. There
  is deliberately no third merged config vocabulary — a key belonging to one
  engine is rejected, not ignored, by the other.
- Engine selection with strict precedence: `config.engine` (authoritative;
  a `config` without `engine`, or with an unrecognized value, throws
  `INVALID_ENGINE`), then the top-level `engine` option, then best-effort
  model-file magic-byte sniffing (`GGUF` ⇒ parakeet, otherwise whisper).
  Sniffing is a convenience for scripts only — library and SDK callers should
  always pass `config.engine`.
- `getEngineType()` returns the resolved engine; `ASRGgml.ENGINE_WHISPER` /
  `ASRGgml.ENGINE_PARAKEET` are exposed as statics.
- `ASRGgml.inferenceManagerConfig` (`{ noAdditionalDownload: true }`) and
  `ASRGgml.getModelKey()` (`'asr-ggml'`) statics, so the SDK's inference
  manager can register the merged addon under one key.
- New error codes in the whisper `6xxx` range: `NOT_SUPPORTED` (6019),
  `STREAMING_SESSION_ACTIVE` (6020), `INVALID_ENGINE` (6021).
- A per-engine driver seam (`AsrDriver` in `src/engines/types.ts`) with
  `WhisperDriver` and `ParakeetDriver` behind it. Documented in
  [`docs/engines.md`](docs/engines.md), including what it takes to add a third
  engine.
- Shared cross-engine output types: `TranscriptionSegment`, `VadEvent`
  (`source: 'silero' | 'energy'`), `EndOfTurnEvent`
  (`source: 'vad-silence' | 'model-eou'`), `BackendInfo`, `BackendId`, and a
  `RuntimeStats` union of `WhisperRuntimeStats` / `ParakeetRuntimeStats` over a
  shared `RuntimeStatsCore`.

### Changed

- **Breaking (parakeet): `exclusiveRun` now serializes `run()` to
  completion.** The pre-merge parakeet queue released its slot as soon as
  `run()` *returned* the `QvacResponse`, so queued batch runs could overlap in
  flight. The merged queue holds the slot until the response settles
  (`"onSettle"`), matching what `exclusiveRun: true` has always implied.
  Callers that relied on overlapping parakeet `run()` calls must pass
  `exclusiveRun: false` explicitly.
- **Breaking (whisper): `runStreaming()` no longer holds the exclusive-run
  slot for the whole session.** Whisper's pre-merge queue treated
  `runStreaming()` exactly like `run()` and held the slot until the response
  settled, so a live session blocked every queued call until it ended. The
  slot is now released once the native session is *open* (`"onReturn"`). A
  concurrent `run()`/`runStreaming()` while a session is open is rejected
  explicitly with `STREAMING_SESSION_ACTIVE` (6020) instead of silently
  queueing behind it.
- `exclusiveRun` serializes on **two independent lanes**: `run()` /
  `runStreaming()` on an inference lane, and `reload()` / `unload()` /
  `destroy()` on a lifecycle lane. Lifecycle calls therefore pre-empt an
  in-flight `run()` (failing its job with `Model was unloaded` / `Model was
  destroyed`) instead of queueing behind it — the behavior both pre-merge
  packages had. Teardown also cannot deadlock on a `run()` whose input
  iterable never terminates (a live mic, a stalled socket): the audio pump
  stops as soon as the job is gone.
- **(parakeet) `status()` before `load()` rejects instead of resolving
  `undefined`.** The pre-merge parakeet wrapper returned
  `this.addon?.status()`, so the promise resolved `undefined` on an unloaded
  instance; the unified `status(): Promise<string>` rejects with
  `FAILED_TO_GET_STATUS` (24004, `adds: 'addon is not loaded'`). Health checks
  shaped like `const s = await model.status(); if (!s) …` must catch instead.
  Whisper's pre-merge behavior (reject) is unchanged.
- **(whisper) `load()` after `destroy()` throws `INSTANCE_DESTROYED`
  (24018)**, not `FAILED_TO_LOAD_WEIGHTS` (6001). The parakeet parent already
  used `INSTANCE_DESTROYED`; the unified orchestrator has one destroyed-state
  guard, and the more specific code wins. Whisper consumers matching
  `err.code === 6001` on load-after-destroy must add 24018.
- **(whisper) an unrecognized `audio_format` is rejected, not coerced.**
  `audio_format` now describes only how raw `Uint8Array` bytes are decoded in
  JS, and the wire format handed to native is pinned to `f32le`, so the native
  `UnsupportedAudioFormat` check can no longer see the caller's string. Any
  value other than `s16le`, `f32le` or `decoded` throws
  `INVALID_AUDIO_FORMAT` (24010) instead of being silently decoded as
  little-endian s16 (which produced a garbage transcript with no error).
- `reload()` consults the driver's `supportsReload` and rejects with
  `NOT_SUPPORTED` (6019) when an engine has no native reload, instead of
  dispatching into a driver that cannot honour it. Both shipped engines
  support reload, so nothing changes for whisper or parakeet callers.
- Error-code registration tolerates a process that also loaded a pre-merge ASR
  package. `@qvac/error`'s duplicate guard is keyed on the owning package
  *name*, so re-registering 6001–6018 / 24001–24019 under `@qvac/asr-ggml`
  would otherwise throw `ERROR_CODE_ALREADY_EXISTS` at `require()` time
  alongside `@qvac/transcription-whispercpp` or
  `@qvac/transcription-parakeet`. Codes already claimed keep the other
  package's (verbatim-identical) definition; the rest register normally.
- **Breaking (parakeet): the constructor now rejects a missing model file.**
  It previously logged a warning and deferred the failure to `load()`. It now
  throws `MODEL_NOT_FOUND` (24009) from the constructor, matching whisper's
  long-standing strict validation. `files.model` must also be a non-empty
  string or the constructor throws `MODEL_REQUIRED` (6017).
- **Breaking: `pause()` and `unpause()` reject with a structured
  `NOT_SUPPORTED` (6019) error.** Neither engine's native side implements a
  correct pause/resume, and both parents' implementations were misleading:
  whisper's `pause()` threw `FAILED_TO_PAUSE` only when the native method was
  absent, and its `unpause()` re-`activate()`d the model (not a resume);
  parakeet's forwarded straight to the addon. Both now reject unconditionally
  with a code callers can match on.
- **Breaking (whisper): `enableStats` is a top-level constructor option
  defaulting to `true`.** It was previously a key inside the config object on
  both parents, and the parakeet wrapper ignored it entirely. It now gates
  whether the job-end payload carries `RuntimeStats` for both engines. Move
  `config.enableStats` to the top level of the constructor options; pass
  `enableStats: false` to opt out of the stats payload.
- **Breaking (whisper): the Linux `symbols.map` version script now applies to
  the whisper half.** The merged bare module links with
  `-Wl,--version-script=symbols.map` (previously parakeet-only), so every
  statically-linked ggml / whisper / parakeet symbol becomes local and only
  `bare_*` / `napi_*` stay global. Co-loaded ggml-based addons no longer
  interpose on each other's symbols. Out-of-tree consumers that were
  `dlsym`-ing whisper.cpp or ggml symbols out of the whisper prebuild will no
  longer find them.
- **Breaking (whisper): Apple builds now force-load Xcode clang's compiler-rt
  builtins archive.** The `-Wl,-force_load,<clang_rtlib>` link step
  (previously parakeet-only) is required so the bare module resolves
  `__isPlatformVersionAtLeast` at load time on macOS/iOS. The build now hard
  errors when Xcode clang's compiler-rt cannot be located, instead of
  producing a prebuild that fails at `dlopen` time.
- Native error text: `errors::whisper::makeStatus` now emits the real code
  name (`MisalignedBuffer`, `NonFiniteSample`, `UnsupportedAudioFormat`, …)
  where the pre-merge whisper implementation ignored its `code` argument and
  always emitted `"WhisperError"`. Message text only — no JS driver
  pattern-matches on it — but consumers scraping the native error string will
  see different values.
- `onUpdate` / `iterate` transcript payloads are bare `TranscriptionSegment[]`
  (or a single segment) on both engines. There is no `{ type: 'segment' }`
  envelope; only the non-transcript events are discriminated
  (`{ type: 'vad' }`, `{ type: 'endOfTurn' }`).
- The public `ERR_CODES` map spans two ranges so no historical numeric code
  moved: shared verbs are canonical in whisper's `6xxx` range, parakeet-only
  names keep their `24xxx` numbers (`MODEL_NOT_FOUND` 24009,
  `INVALID_AUDIO_FORMAT` 24010, `INVALID_CONFIG` 24015, `INSTANCE_DESTROYED`
  24018, `JOB_CANCELLED` 24019). Parakeet-emitted shared verbs also stay in
  `24xxx` (e.g. a parakeet append failure is still 24003, not 6003). Every
  number from both historical tables is registered, so old codes remain
  resolvable to a name and message.
- Errors are `QvacErrorAddonASRGgml` instances (was `QvacErrorAddonWhisper` /
  `QvacErrorAddonParakeet`). Both old classes are gone; match on
  `err.code`, or on `ASRGgml.Error`.
- The native `cancel` verb takes no job id. `ASRGgml.cancel(jobId?)` still
  accepts one for source compatibility, but only the active job is cancelled.
- Benchmarks are engine-keyed: one bare server with an engine-discriminated
  `/run` entrypoint, one Python client whose `src/main.py` dispatches on the
  config's required top-level `engine:` key, `config-whisper*.yaml` /
  `config-parakeet*.yaml`, and `manual-results/{whisper,parakeet}/`.
  `scripts/run-rtf-benchmark-matrix.js` reads engine-keyed matrix entries from
  `QVAC_ASR_GGML_BENCHMARK_MATRIX_JSON` (the per-engine env vars are still
  honoured with the engine implied).

### Fixed

- **(whisper) `Float32Array` audio input is no longer corrupted.** A
  `Float32Array` chunk was previously reinterpreted as `s16le` bytes unless
  `audio_format: 'f32le'` was set, silently producing garbage transcripts. The
  chunk's own class now decides its interpretation: `Float32Array` is f32
  samples, `Int16Array` is s16 samples, and `audio_format` only describes how
  raw `Uint8Array` **bytes** are decoded. Byte views whose offset is not
  4-byte (or 2-byte) aligned are copied before reinterpretation instead of
  throwing, and a byte length that is not a whole number of samples raises
  `INVALID_AUDIO_INPUT` (6011) with the offending length. A **stream** of byte
  chunks is validated in aggregate, not per chunk: a PCM sample split across a
  chunk boundary (arbitrary socket/pipe read sizes, e.g. 1023 bytes then 1025)
  is carried over and joined with the next chunk, and only a stream that *ends*
  mid-sample is rejected. That is the same aggregate check the native decoder
  performed on the pre-merge concatenated batch buffer.
- **The `run()` buffer cap still means 500 MB of caller-supplied audio.** The
  whisper driver converts input to f32 samples in JS before `append()`, which
  doubles the byte count of `s16le` input (the default), so a naive wire-byte
  comparison against `MAX_BUFFERED_BYTES` would have halved the accepted
  duration of s16le audio from ~4.55 h to ~2.27 h at 16 kHz mono. The cap is
  scaled by the source→wire expansion factor, so the same recordings the
  pre-merge whisper package accepted are still accepted;
  `BUFFER_LIMIT_EXCEEDED` (6015) names the source format the budget is
  denominated in.
- Constructor validation and engine sniffing target the file the driver
  actually opens. Whisper honours `config.path` over `files.model`, so a real
  `config.path` alongside a placeholder `files.model` no longer throws
  `MODEL_NOT_FOUND` for a file that is never opened, and the magic-byte sniff
  reads the same file that will be loaded.
- A missing model file reports `MODEL_NOT_FOUND` (24009) even when no engine
  was declared. Existence is checked before the magic-byte sniff, which used to
  run first and rewrap the `ENOENT` as `INVALID_ENGINE` (6021).
- `ASRGgml.addon` exposes the live native interface (`undefined` before
  `load()`), as both pre-merge packages did. It is the escape hatch the SDK's
  model-wide hard cancel uses: unlike `ASRGgml.cancel()`, `addon.cancel()`
  stops the native decode without failing the active job, so a consumer's
  `for await` loop ends instead of throwing.
- **(whisper) a refused double `startStreaming()` no longer corrupts the live
  session.** The interface claimed the new job id and moved to `PROCESSING`
  before calling native, and its catch reset the job id to `null` and the state
  to `LISTENING` — so the native registry's double-start refusal clobbered the
  *running* session's bookkeeping. It now refuses up front, like the parakeet
  interface, and restores the previous state on any native failure.

### Removed

- **Breaking: `stop()`.** The whisper-only method delegated to a native `stop`
  and left the instance in a state no other verb could describe. Use
  `cancel()` to abort the active job, `unload()` to release the model, or
  `destroy()` to retire the instance.
- **Breaking: the `./parakeet` and `./parakeet.js` subpath exports** (the
  low-level `ParakeetInterface` escape hatch). The interface is internal to
  `ParakeetDriver`; drive the engine through `ASRGgml`.
- **Breaking: the `./transcription-addon` subpath export** (whisper's
  low-level addon wrapper). Same reasoning: use `ASRGgml`.
- The `TranscriptionWhispercpp` and `TranscriptionParakeet` classes. The
  default export is `ASRGgml`.
