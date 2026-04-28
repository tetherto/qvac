# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.2]

### Fixed
- Fixed model activation failure on Windows when the user lacks `SeCreateSymbolicLinkPrivilege`. The external data staging in `loadTDTSessions` and `loadCTCSessions` now uses a symlink → hardlink → copy fallback chain. Staging directories are created next to the model files so hardlinks stay on the same volume, avoiding unnecessary multi-GB copies.

### Added
- Integration test `external-data-staging.test.js` that validates model loading with external data files (`.onnx.data`) via the staging fallback mechanism.

## [0.3.1]

### Added
- Registered ONNX Runtime execution providers for GPU acceleration when `useGPU: true` is set. The `useGPU` config flag was previously accepted but never applied to session creation. Platform EPs are now active: CoreML (macOS/iOS), DirectML (Windows), NNAPI (Android). Falls back to CPU automatically if the GPU provider fails.

### Changed
- Session options are now built via `onnx_addon::buildSessionOptions()` from `@qvac/onnx`, replacing manual `Ort::SessionOptions` construction. This aligns Parakeet with the same EP registration logic used by the OCR package.

## [0.3.0]

This release replaces the two-argument `TranscriptionParakeet` constructor with a clean single-options interface, removes the external loader dependency, and simplifies the internal job-management pipeline.

## Breaking Changes

### Unified constructor interface — `new TranscriptionParakeet({ files, config })`

The constructor signature has changed from the legacy two-argument form `(args, config)` to a single `opts` object. The old `args` accepted `loader`, `modelName`, and `diskPath`; the old `config` held all named file paths at the top level. The new interface groups model file paths under a `files` map and non-path settings under `config`.

**BEFORE:**
```javascript
const model = new TranscriptionParakeet(
  { loader, modelName, diskPath },
  {
    encoderPath: '/path/to/encoder-model.onnx',
    decoderPath: '/path/to/decoder_joint-model.onnx',
    vocabPath: '/path/to/vocab.txt',
    preprocessorPath: '/path/to/preprocessor.onnx',
    parakeetConfig: { modelType: 'tdt', maxThreads: 4, useGPU: false }
  }
)
```

**AFTER:**
```javascript
const model = new TranscriptionParakeet({
  files: {
    encoder: '/path/to/encoder-model.onnx',
    decoder: '/path/to/decoder_joint-model.onnx',
    vocab: '/path/to/vocab.txt',
    preprocessor: '/path/to/preprocessor.onnx'
  },
  config: {
    parakeetConfig: { modelType: 'tdt', maxThreads: 4, useGPU: false }
  }
})
```

### `downloadWeights()` removed

The public `downloadWeights()` method has been removed. External weight downloading is no longer part of this package's responsibility. Use the `files` map to supply pre-downloaded model paths directly.

### `BaseInference` inheritance removed

`TranscriptionParakeet` no longer extends `BaseInference` and no longer depends on `WeightsProvider`. It is now a self-contained class that manages its own logger, run queue, and job lifecycle.

## New APIs

### `TranscriptionParakeetFiles`

A new exported `TranscriptionParakeetFiles` interface captures all model file paths accepted by the constructor:

```typescript
interface TranscriptionParakeetFiles {
  encoder?: string;      // TDT encoder-model.onnx
  encoderData?: string;  // TDT encoder-model.onnx.data
  decoder?: string;      // TDT decoder_joint-model.onnx
  vocab?: string;        // TDT vocab.txt
  preprocessor?: string; // TDT preprocessor.onnx
  model?: string;        // CTC model.onnx
  modelData?: string;    // CTC model.onnx_data
  tokenizer?: string;    // CTC/EOU tokenizer.json
  eouEncoder?: string;   // EOU encoder.onnx
  eouDecoder?: string;   // EOU decoder_joint.onnx
  sortformer?: string;   // sortformer.onnx
}
```

### `status()`, `pause()`, `unpause()`

Three new public methods expose addon lifecycle control: `status()` queries the native addon status, `pause()` suspends inference, and `unpause()` resumes it.

## Other

Job management is now handled by `createJobHandler()` from `@qvac/infer-base ^0.4.0`, replacing the manual `_hasActiveResponse` flag and `_failAndClearActiveResponse()` helper. `_resolveFilePath()` now takes only a `filename` argument. Dead helpers `_hasNamedPaths()` and `_getModelFilePath()` have been removed.

## [0.2.7]

### Changed
- Bumped `qvac-lib-inference-addon-cpp` to `1.1.5`.
- Restored JS-owned job ID routing after addon-cpp reverted the accidental `1.1.3` native callback `jobId` contract and `cancel(jobId)` API break.

### Added
- Regression coverage for JS-owned cancel handling of active, buffered, and stale wrapper job IDs.

## [0.2.6]

### Changed
- Switched ONNX Runtime linkage from direct vcpkg dependency to `@qvac/onnx` shared module, aligning with the OCR package pattern for consistent cross-addon runtime sharing

## [0.2.5]

### Changed
- Switched desktop Parakeet prebuilds to static ONNX Runtime linking so packaged platform artifacts stay as a single `.bare` addon plus exports file
- Aligned the secondary native build path and Linux linkage behavior with the desktop packaging update to keep runtime loading working after removing bundled shared libraries

### Fixed
- Apple prebuild compatibility by replacing the `std::ranges::find` sample-rate check with a `std::find` implementation that works on the current Xcode toolchains

## [0.2.4]

Security hardening release from comprehensive security audit.

### Fixed
- Add 500 MB buffer limit to audio accumulation to prevent OOM from unbounded buffering (#1080)
- Add SHA-256 integrity verification to model download scripts using HuggingFace LFS checksums (#1081)
- Sanitize error messages to remove filesystem paths from thrown errors (#1084)
- Wrap job ID counter at `Number.MAX_SAFE_INTEGER` to prevent precision loss (#1085)
- Harden benchmark server: add library allowlist, restrict file paths to allowed directories, remove dynamic `npm install`, add body size limit, restrict CORS to localhost (#1086)

## [0.2.3]

### Added
- RTF benchmark integration test (`rtf-benchmark.test.js`) that captures Real-Time Factor and 12 other timing metrics from the C++ addon's `runtimeStats` callback
- `test:benchmark:rtf` npm script for on-demand RTF benchmark runs
- RTF benchmark step in integration test CI workflow (non-blocking, all 6 runners) with JSON artifact upload

## [0.2.2]

This release documents Parakeet runtime statistics and transcription output in TypeScript so consumers can type `response.stats` and `run()` results against the native addon.

## New APIs

### `RuntimeStats` and `ParakeetRunOutput` in `index.d.ts`

The `TranscriptionParakeet` namespace now exports **`RuntimeStats`**, aligned with `ParakeetModel::runtimeStats()` (throughput, audio duration, token and transcription counts, pipeline timing fields through `totalEncodedFrames`). **`ParakeetRunOutput`** is **`TranscriptionSegment[] | TranscriptionSegment`**, matching array or single-segment updates from the addon. **`run()`** is typed to return **`Promise<QvacResponse<ParakeetRunOutput>>`**, with documentation that **`response.stats`** matches **`RuntimeStats`** when stats collection is enabled via `opts.stats`.

## [0.2.1]

This release fixes `reload()` for setups that use per-file model paths (TDT, CTC, EOU, Sortformer), so the native addon keeps receiving the same paths after a reload as on the initial load.

## Bug Fixes

### reload() missing named path passthrough

`reload()` rebuilt configuration without the individual file paths (`encoderPath`, `decoderPath`, `vocabPath`, and the other named path fields). After `reload()`, the addon no longer saw those paths and could not load the model correctly. `reload()` now builds configuration through the same `_buildConfigurationParams()` helper as `_load()`, so named paths are always included. When named paths are in use, `reload()` also skips streaming weights via `_loadModelWeights`, matching initial load behavior and avoiding redundant large file reads.

## Added

### Integration coverage for reload with named paths

A new integration test exercises `TranscriptionParakeet` with TDT named paths: transcribe, call `reload()` with updated `parakeetConfig`, then transcribe again and verify output quality.

## [0.2.0]

### Changed
- Migrated the native addon implementation to `qvac-lib-inference-addon-cpp` 1.x (`IModel`/`IModelCancel` + `AddonJs`/`AddonCpp`), replacing the removed legacy templated addon API
- Updated the JS/native pipeline to `createInstance` + `runJob` while preserving public transcription API behavior and output semantics
- Hardened cancel/reload/job lifecycle behavior in runtime and integration paths to match expected production behavior

### Added
- Dedicated `AddonCpp` test coverage plus expanded cancellation and lifecycle regression coverage for the addon-cpp runtime path

## [0.1.11]

### Changed
- All model types (TDT, CTC, EOU, Sortformer) now require named file paths — buffer-based `_loadModelWeights` fallback removed
- `_hasNamedPaths()` unified to cover all model types; `_hasAnyNamedPaths()` removed
- `_load()` passes all named paths (TDT, CTC, EOU, Sortformer) to C++
- `JSAdapter` parses CTC (`ctcModelPath`, `ctcModelDataPath`, `tokenizerPath`), EOU (`eouEncoderPath`, `eouDecoderPath`), and Sortformer (`sortformerPath`) path properties
- `loadTDTSessions` requires `encoderPath` and `decoderPath`, removes buffer fallback
- `loadCTCSessions` requires `ctcModelPath`, loads with C++-side temp staging for ONNX external data, reads tokenizer from `tokenizerPath`
- `loadEOUSessions` requires `eouEncoderPath` and `eouDecoderPath`, reads tokenizer from `tokenizerPath`
- `loadSortformerSessions` requires `sortformerPath`

## [0.1.10]

### Added
- CTC model support (`parakeet-ctc-0.6b`) with tokenizer.json-based vocabulary decoding
- End-of-Utterance (EOU) streaming model support (`parakeet-eou-120m-v1`) for real-time transcription
- Sortformer speaker diarization model support (`sortformer-4spk-v2`) with per-speaker labelled output
- Named file path parameters for CTC (`ctcModelPath`, `ctcModelDataPath`), EOU (`eouEncoderPath`, `eouDecoderPath`), and Sortformer (`sortformerPath`) models
- Shared `tokenizerPath` config for CTC and EOU tokenizer.json loading
- `modelType` configuration parameter (`'tdt'`, `'ctc'`, `'eou'`, `'sortformer'`) to select inference pipeline
- Integration tests for all model types (desktop and mobile)
- `nlohmann-json` vcpkg dependency for tokenizer.json parsing

### Changed
- C++ `ParakeetModel` refactored to support multiple model architectures with shared mel-spectrogram and encoder pipeline
- `_resolveFilePath` extended to map CTC/EOU/Sortformer file names to named config paths
- `_hasAnyNamedPaths()` added to detect any named path override (TDT or non-TDT)
- `_loadModelWeights` routes weight files by model type using `getRequiredModelFiles()`
- Mobile integration tests hardened with explicit `unloadWeights()` and `destroyInstance()` cleanup in `finally` blocks

### Fixed
- Tokenizer vocabulary validation rejects empty vocab after parsing
- JobEnded/Output race condition in C++ job tracker

## [0.1.9]

### Changed
- Logger type in `TranscriptionParakeetArgs` now uses `LoggerInterface` from `@qvac/logging` instead of a package-specific type, aligning with the shared logging interface used across all addons

## [0.1.7]

### Added
- Native C++ support for loading ONNX sessions directly from individual file paths (`encoderPath`, `encoderDataPath`, `decoderPath`, `vocabPath`, `preprocessorPath`)
- Encoder external data staging via temporary symlink directory, cleaned up after session creation
- Vocabulary loading directly from `vocabPath` when named paths are provided

### Changed
- `_load()` skips buffer-based `_loadModelWeights` when named paths are detected, reducing memory overhead
- `_downloadWeights()` short-circuits when named paths are provided

## [0.1.6]

### Added
- Individual named file path parameters (`encoderPath`, `encoderDataPath`, `decoderPath`, `vocabPath`, `preprocessorPath`) as alternative to `filePaths` map

### Fixed
- Removed unused `Loader` type and `Readable` import from type declarations; `loader` argument now typed as `unknown`

## [0.1.5]

### Added
- `NOTICE` file with full third-party dependency attributions
- `LICENSE` and `NOTICE` now included in the published npm package

### Changed
- S3 download script now requires `MODEL_S3_BUCKET` environment variable instead of hardcoded bucket

### Removed
- `@qvac/dl-hyperdrive` from `devDependencies` and `peerDependencies`

## [0.1.2]

### Added
- Unified `transcribe.js` script with CLI flags (`--file`, `--model`) replacing individual language scripts

### Changed
- Replaced multiple `if` status checks with `std::ranges::find` in `Addon.cpp`
- Extracted `computeFeatures()` and `runInferencePipeline()` helper functions in `ParakeetModel.cpp`
- Updated `README.md`, `QUICKSTART.md`, and `download-models-s3.sh` documentation

### Removed
- Individual language transcription scripts (`es-transcribe.js`, `fr-transcribe.js`, `hr-transcribe.js`)
