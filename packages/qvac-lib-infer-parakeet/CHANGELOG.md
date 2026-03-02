# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.9] - 2026-02-27

### Changed
- Logger type in `TranscriptionParakeetArgs` now uses `LoggerInterface` from `@qvac/logging` instead of a package-specific type, aligning with the shared logging interface used across all addons

## [0.1.7] - 2026-02-23

### Added
- Native C++ support for loading ONNX sessions directly from individual file paths (`encoderPath`, `encoderDataPath`, `decoderPath`, `vocabPath`, `preprocessorPath`)
- Encoder external data staging via temporary symlink directory, cleaned up after session creation
- Vocabulary loading directly from `vocabPath` when named paths are provided

### Changed
- `_load()` skips buffer-based `_loadModelWeights` when named paths are detected, reducing memory overhead
- `_downloadWeights()` short-circuits when named paths are provided

## [0.1.6] - 2026-02-19

### Added
- Individual named file path parameters (`encoderPath`, `encoderDataPath`, `decoderPath`, `vocabPath`, `preprocessorPath`) as alternative to `filePaths` map

### Fixed
- Removed unused `Loader` type and `Readable` import from type declarations; `loader` argument now typed as `unknown`

## [0.1.5] - 2026-02-18

### Added
- `NOTICE` file with full third-party dependency attributions
- `LICENSE` and `NOTICE` now included in the published npm package

### Changed
- S3 download script now requires `MODEL_S3_BUCKET` environment variable instead of hardcoded bucket

### Removed
- `@qvac/dl-hyperdrive` from `devDependencies` and `peerDependencies`

## [0.1.2] - 2026-02-18

### Added
- Unified `transcribe.js` script with CLI flags (`--file`, `--model`) replacing individual language scripts

### Changed
- Replaced multiple `if` status checks with `std::ranges::find` in `Addon.cpp`
- Extracted `computeFeatures()` and `runInferencePipeline()` helper functions in `ParakeetModel.cpp`
- Updated `README.md`, `QUICKSTART.md`, and `download-models-s3.sh` documentation

### Removed
- Individual language transcription scripts (`es-transcribe.js`, `fr-transcribe.js`, `hr-transcribe.js`)
