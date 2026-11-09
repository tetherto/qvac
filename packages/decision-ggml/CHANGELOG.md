# Changelog

## [Unreleased]

### Added

- `@qvac/decision-ggml`, QVAC's decision addon. It runs two engines, chosen by
  the caller from the model:
  - `LayaDecisions`: fabric-format Laya checkpoints, moved unchanged from
    `@qvac/embed-llamacpp`.
  - `DecisionEngine`: upstream llama.cpp decision models (openjev, lev, kev,
    clef, upstream-format laya, ...), run in-process through upstream's
    `server-context`, which this addon links statically from `@qvac/fabric`.
    Requests and results use upstream's `/v1/systemone` shapes, one state per
    run; `info()` reports the model's decision capabilities. One request runs
    at a time and a second is rejected while it does; cancellation reaches a
    job even before its run starts. A model without decision metadata is
    rejected from its GGUF header before loading, and a request rejected by
    the model fails with `err.code` `DECISION_INVALID_REQUEST`.
  - Load errors carry this addon's own ID, `[ Decision :: <code> ]`, for both
    engines. Embed's `LayaDecisions` keeps reporting `[ GTE :: <code> ]`.
