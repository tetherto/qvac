# Engines: orchestrator + driver layout

`@qvac/asr-ggml` serves two ASR engines — **Whisper** (whisper.cpp) and
**NVIDIA Parakeet** (parakeet-cpp) — from one npm package, one native
prebuild, and one public class. This document describes how that split is
organized and what it takes to add a third engine.

It is the current-state companion to the two heritage design docs kept in
this folder ([`architecture.md`](architecture.md),
[`data-flows-detailed.md`](data-flows-detailed.md)), which still describe the
pre-merge whisper-only internals in detail.

## Table of Contents

- [The layering rule](#the-layering-rule)
- [JS: orchestrator and drivers](#js-orchestrator-and-drivers)
- [Native: one module, two model interfaces](#native-one-module-two-model-interfaces)
- [Engine resolution](#engine-resolution)
- [Error codes across engines](#error-codes-across-engines)
- [Adding an engine](#adding-an-engine)

## The layering rule

One rule drives the whole design:

> **Verbs are shared; vocabularies are engine-scoped.**

Everything a caller *does* (`load`, `run`, `runStreaming`, `reload`,
`cancel`, `status`, `unload`, `destroy`) has exactly one signature and one
meaning regardless of engine. Everything a caller *configures* stays inside
that engine's own namespace — `config.whisperConfig` for whisper,
`config.parakeetConfig` for parakeet — and is validated only by that
engine's driver.

There is deliberately **no third, merged configuration vocabulary**. A key
that means something to whisper is not silently accepted by parakeet and
vice versa; passing an unknown key throws instead of being ignored.

## JS: orchestrator and drivers

```
src/
  index.ts                     # ASRGgml — the orchestrator (public API)
  lib/
    types.ts                   # engine-agnostic public types
    audio.ts                   # shared audio normalization to f32
    error.ts                   # ERR_CODES + QvacErrorAddonASRGgml
    constants.ts
  engines/
    types.ts                   # AsrDriver contract, DriverContext, EngineType
    whisper/
      driver.ts                # WhisperDriver implements AsrDriver
      whisper.ts               # WhisperInterface (native job runner)
      configChecker.ts         # whisper config whitelist
    parakeet/
      driver.ts                # ParakeetDriver implements AsrDriver
      parakeet.ts              # ParakeetInterface (native job runner)
```

### What the orchestrator owns (`src/index.ts`)

- Constructor options parsing and **engine resolution** (see below).
- The shared `state` machine (`configLoaded` / `weightsLoaded` /
  `destroyed`).
- The single serialized queue behind `exclusiveRun`, with two release
  policies:
  - `"onSettle"` — used by `run()`. The slot is held until the returned
    `QvacResponse` settles, so queued batch runs never overlap.
  - `"onReturn"` — used by `runStreaming()`, `reload()`, `unload()`,
    `destroy()`. The slot is released when the call returns; for
    `runStreaming()` that is the moment the native session is *open*, so a
    minutes-long session does not block the queue.
- The open-streaming-session flag (`STREAMING_SESSION_ACTIVE`, 6020) that
  rejects a concurrent `run()`/`runStreaming()`.
- `pause()` / `unpause()` rejection with `NOT_SUPPORTED` (6019).
- One `JobHandler` from `@qvac/infer-base`, created once and handed to the
  driver through `DriverContext`.

The orchestrator never touches an engine-specific config key and never
imports a native binding.

### What a driver owns (`engines/<engine>/driver.ts`)

The `AsrDriver` contract in [`src/engines/types.ts`](../src/engines/types.ts)
is the whole seam:

| Member | Responsibility |
| --- | --- |
| `engineType` | `"whisper"` \| `"parakeet"` |
| `supportsReload` | Whether `reload()` can be honoured in place; `false` makes `reload()` reject with `NOT_SUPPORTED` (6019) |
| `validateConfig()` | Throws on unknown/invalid engine config keys (called from the constructor) |
| `normalizeAudio(input)` | Maps any public `AudioInput` shape onto an f32 chunk stream |
| `load()` / `unload()` / `reload()` | Native instance lifecycle |
| `cancelActive(jobId?)` / `status()` / `getBackendInfo()` | Passthroughs |
| `run(audio)` | Starts the batch job on `ctx.job`, pumps audio, returns the response |
| `createStreamingSession(audio, opts)` | Duplex streaming; resolves once the native session is OPEN, then pumps detached |

Drivers own **all** engine-specific event mapping. Native events reach
`ctx.job.output(...)` / `ctx.job.end(...)` / `ctx.job.fail(...)` from inside
the driver, which is where the two engines' differing native event
vocabularies are flattened onto the shared output types in
[`src/lib/types.ts`](../src/lib/types.ts):

- Bare `TranscriptionSegment[]` (or a single segment) for transcript output —
  there is no `{ type: 'segment' }` wrapper.
- `{ type: 'vad', ... }` for voice-activity events (whisper/Silero today,
  `source: "energy"` reserved for parakeet).
- `{ type: 'endOfTurn', ... }` for turn boundaries, with
  `source: "vad-silence"` (whisper) or `source: "model-eou"` (parakeet's
  `<EOU>` token).

Both drivers respect `ctx.enableStats`: on `JobEnded` they call
`ctx.job.end(stats)` when it is true and `ctx.job.end()` when it is not.

## Native: one module, two model interfaces

The native addon is a single Bare module — `BARE_MODULE(qvac_asr_ggml, ...)`
in [`addon/src/js-interface/binding.cpp`](../addon/src/js-interface/binding.cpp) —
exporting one engine-agnostic verb table:

```
createInstance   runJob   reload   getBackendInfo
startStreaming   appendStreamingAudio   endStreaming
loadWeights      activate  cancel   destroyInstance
setLogger        releaseLogger
```

`cancel` and `destroyInstance` route through the streaming-aware wrappers
(`cancelWithStreaming` / `destroyInstanceWithStreaming`) so an open session
is torn down first; `cancel` takes no job id.

```
addon/src/
  js-interface/
    binding.cpp                # BARE_MODULE qvac_asr_ggml + verb table
    JSAdapter.{hpp,cpp}        # JS object -> per-engine config struct
  addon/
    AddonJs.hpp                # the shared JS-facing entrypoints
    AddonCpp.hpp
    AsrErrors.hpp              # errors::whisper::* and errors::parakeet::*
    GgmlLogForwarding.hpp      # ggml log -> addon logger
    StreamingSessionRegistry.hpp
  model-interface/
    StreamingProcessor.{hpp,cpp}
    ParakeetStreamingProcessor.{hpp,cpp}
    WhisperTypes.hpp / ParakeetTypes.hpp
    whisper/                   # WhisperModel, WhisperConfig, WhisperHandlers
    parakeet/                  # ParakeetModel, ParakeetConfig
```

`JSAdapter::readEngineType` decides which config struct to build from a
`createInstance` payload, in this order:

1. an explicit `engineType: "whisper" | "parakeet"` wins (any other
   non-empty value is a hard error);
2. otherwise a top-level model-file key (`modelPath` / `path`) infers
   parakeet — whisper's weights arrive later via `loadWeights`, and its
   config nests under `whisperConfig` / `contextParams` / `miscConfig`;
3. otherwise whisper, the default engine.

Both JS drivers always send `engineType` explicitly, so steps 2 and 3 only
matter for hand-rolled native callers.

## Engine resolution

`ASRGgml` resolves its engine once, in the constructor, from three sources in
strict precedence order:

1. **`config.engine`** — authoritative when `config` is present. If `config`
   is given without `engine`, or with an unknown value, the constructor
   throws `INVALID_ENGINE` (6021). This is the recommended form.
2. **`engine`** (top-level option) — convenience alias used when no `config`
   is passed. An unknown value throws `INVALID_ENGINE`.
3. **Model-file sniffing** — last resort. The first four bytes of
   `files.model` are read: `GGUF` ⇒ parakeet, anything else ⇒ whisper
   (legacy GGML `.bin`).

Sniffing is a convenience for scripts, not a supported integration path: it
opens the model file synchronously in the constructor, cannot distinguish a
GGUF whisper build from a GGUF parakeet build. A model file that is absent is
reported as `MODEL_NOT_FOUND` (24009) before sniffing runs; `INVALID_ENGINE`
(6021) is reserved for a file that exists but cannot be read. Library and SDK
callers should always pass
`config.engine`.

## Error codes across engines

The public `ERR_CODES` map in [`src/lib/error.ts`](../src/lib/error.ts) is a
single table spanning two numeric ranges, because both parents' codes had to
stay resolvable:

- **Shared verbs are canonical in the historical whisper `6xxx` range**
  (`FAILED_TO_LOAD_WEIGHTS` = 6001, …, `VAD_MODEL_NOT_FOUND` = 6018), and new
  asr-ggml codes are appended there (`NOT_SUPPORTED` 6019,
  `STREAMING_SESSION_ACTIVE` 6020, `INVALID_ENGINE` 6021).
- **Parakeet-only names keep their historical `24xxx` numbers**
  (`MODEL_NOT_FOUND` 24009, `INVALID_AUDIO_FORMAT` 24010, `INVALID_CONFIG`
  24015, `INSTANCE_DESTROYED` 24018, `JOB_CANCELLED` 24019).
- The parakeet driver additionally emits shared verbs from its own internal
  `ERR_CODES_PARAKEET` table so a parakeet append failure still surfaces as
  24003 rather than 6003. That table is internal — it is not part of the
  package's public type surface.

Every number from both historical tables is registered with `addCodes`, so
old numeric codes remain resolvable to a name and message.

## Adding an engine

Adding engine `foo` touches these places and nothing else:

**JS**

1. `src/engines/types.ts` — widen `EngineType` with `"foo"`, and add
   `FooStreamingOptions` / `FooReloadConfig` to the
   `ASRStreamingOptions` / `ASRGgmlReloadConfig` unions.
2. `src/engines/foo/driver.ts` — a `FooDriver implements AsrDriver`, plus
   `FooConfig` and a `FooEngineConfig { engine: "foo"; fooConfig?: FooConfig }`
   branch. Validate the config vocabulary in `validateConfig()`; reject
   unknown keys.
3. `src/engines/foo/foo.ts` — the interface over the native verbs, mirroring
   `whisper.ts` / `parakeet.ts`.
4. `src/index.ts` — add the branch to `ASRGgmlConfig`, to `isKnownEngine`,
   to the driver construction in the constructor, and (if the checkpoint has
   a distinguishable magic) to `sniffEngine`. Add an `ENGINE_FOO` static.
5. `src/lib/types.ts` — extend `RuntimeStats` with `FooRuntimeStats` and
   re-export it from the `ASRGgml` namespace in `index.ts`.
6. `src/lib/error.ts` — append any genuinely new code in the `6xxx` range.
   Do **not** renumber existing codes; if the engine has a legacy range of
   its own, register it the way `ERR_CODES_PARAKEET` is registered.

**Native**

7. `addon/src/model-interface/foo/` — `FooModel` + `FooConfig`, and a
   streaming processor if the engine streams.
8. `addon/src/js-interface/JSAdapter.{hpp,cpp}` — a `buildFooConfig`, and a
   `readEngineType` arm for `"foo"`. Keep the "explicit wins, unknown is a
   hard error" shape.
9. `addon/src/addon/AsrErrors.hpp` — an `errors::foo` namespace with its own
   `ADDON_ID`, `Code` enum, `toString`, and `makeStatus`.
10. `CMakeLists.txt` — add the new `.cpp` files to both the `asr-ggml`
    module target and the `asr_ggml_tests` target.

**Everything else**

11. `package.json` — an `example:foo` script and any model-staging scripts.
12. `README.md` — the engine's row in the engines table and its config
    vocabulary section; this document's tables.
13. `benchmarks/` — a `config-foo*.yaml`, a `src/foo/` client module wired
    into `src/main.py`'s dispatcher, a `server/src/services/foo.js` branch on
    the `/run` engine discriminator, and a `manual-results/foo/` directory.
14. `scripts/run-rtf-benchmark-matrix.js` — an `ENGINES.foo` entry with its
    npm script and default matrix entries.

The verb table in `binding.cpp` should **not** grow. If a new engine seems to
need a new verb, that is a signal the verb belongs on the driver seam
instead.
