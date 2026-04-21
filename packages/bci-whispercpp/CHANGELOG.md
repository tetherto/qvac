# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0]

Initial POC release of `@qvac/bci-whispercpp`, a brain-computer-interface neural
signal transcription addon powered by a BCI-patched fork of whisper.cpp.

### Added

- `BCIWhispercpp` client class (standalone, built on `createJobHandler` +
  `exclusiveRunQueue` from `@qvac/infer-base`) with `load()`, `transcribe()`,
  `transcribeFile()`, `unload()`, `destroy()`, `cancel()`, `getState()`.
- Low-level `BCIInterface` (`./bci` subpath export) for users that need direct
  control over the native addon lifecycle.
- `./addonLogging` subpath exposing `setLogger` / `releaseLogger` for wiring a
  native log handler.
- C++ native addon (`NeuralProcessor`, `BCIModel`, `BCIConfig`) using the
  `qvac-lib-inference-addon-cpp` framework, with BCI-specific preprocessing
  (Gaussian smoothing, low-rank day projection, softsign non-linearity) and
  mel-layout injection into a patched whisper.cpp encoder.
- Integration tests for load/destroy, batch transcription, and a 5-sample
  WER measurement (avg 6.0% on the reference fixtures).
- GoogleTest C++ unit tests covering mel shape, gaussian smoothing, padded
  frames, truncation handling, invalid-config rejection, and range validation.
- `scripts/convert-model.py` to convert a BrainWhisperer checkpoint into the
  GGML model + embedder binary pair consumed at runtime.
- `scripts/download-models.sh` to fetch the reference model and test fixtures
  from the `bci-test-assets-v0.1.0` GitHub release.

### Known Limitations

- Streaming transcription is not implemented in this release; see follow-up
  work tracked under QVAC-17062.
- Inference error codes live in the `26001-27000` range in the current
  implementation.
