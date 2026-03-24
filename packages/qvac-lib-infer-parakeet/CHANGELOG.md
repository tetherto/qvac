# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
