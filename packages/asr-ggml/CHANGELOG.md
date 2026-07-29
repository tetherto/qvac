# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`@qvac/asr-ggml` is the merge of two previously separate packages:
`@qvac/transcription-whispercpp` (final release `0.12.1`) and
`@qvac/transcription-parakeet` (final release `0.10.1`). Version numbering
restarts at `0.1.0`; the two pre-merge histories are preserved verbatim as
[`docs/WHISPER-CHANGELOG.md`](docs/WHISPER-CHANGELOG.md) and
[`docs/PARAKEET-CHANGELOG.md`](docs/PARAKEET-CHANGELOG.md).

## [Unreleased]

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
  slot is now released once the native session is *open* (`"onReturn"`), the
  same policy `reload()`, `unload()` and `destroy()` use. A concurrent
  `run()`/`runStreaming()` while a session is open is rejected explicitly with
  `STREAMING_SESSION_ACTIVE` (6020) instead of silently queueing behind it.
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
  `INVALID_AUDIO_INPUT` (6011) with the offending length.

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
