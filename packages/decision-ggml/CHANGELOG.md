# Changelog

## [Unreleased]

### Added

- `@qvac/decision-ggml`, QVAC's decision addon. `DecisionEngine` runs upstream
  llama.cpp decision models (laya, openjev, lev, kev, clef, ...) in-process
  through upstream's `server-context`, which this addon links statically from
  its own build of the `qvac-fabric` port, at the version the installed
  `@qvac/fabric` runtime records.
  - Requests and results use upstream's `/v1/systemone` shapes, one state per
    run; `info()` reports the model's decision capabilities.
  - One request runs at a time and a second is rejected while it does;
    cancellation reaches a job even before its run starts.
  - A model without decision metadata is rejected from its GGUF header before
    loading, and a request rejected by the model fails with `err.code`
    `DECISION_INVALID_REQUEST`.
  - Load errors carry this addon's own ID, `[ Decision :: <code> ]`.
  - Laya checkpoints run in upstream format, converted from their Hugging Face
    checkpoints with upstream's converter. Fabric-format Laya files do not
    load.
