# Changelog

## [Unreleased]

### Added

- `@qvac/decision-ggml`, QVAC's decision addon. `DecisionEngine` runs upstream
  llama.cpp decision models (laya, openjev, lev, kev, clef, ...) in-process
  through upstream's `server-context`, which this addon links statically from
  its own build of the `qvac-fabric` port, at the version the installed
  `@qvac/fabric` runtime records.
  - Requests and results use upstream's `/v1/systemone` shapes; `info()`
    reports the model's decision capabilities.
  - `states` answers several states in one run, sent to upstream concurrently
    so its slots batch them; results keep the input order.
  - Unset, `parallel` is llama-server's own default: 4 slots sharing one KV
    cache.
  - `info()` reports `noul` as `probability`, `expected_rating` (lev) or
    `unknown` for a type this addon does not list, and `max_input_tokens`;
    for a causal model that is each slot's share of the context, so a batch
    of states that each fit it cannot together run out of KV cache.
  - The nesting limit applies to each value a request carries (a state, the
    instructions, each criteria entry) from where it starts, 128 levels for
    each, as the SDK counts them. Upstream counts its own 128 levels from the
    prompt input it builds, so it can reject a value a few levels sooner (an
    invalid request too).
  - Runtime stats count a batch's input tokens over all its states.
  - A non-causal model (Laya) reads up to `batch_size` tokens (2048 by
    default) in one pass; a longer input is rejected with
    `DECISION_INVALID_REQUEST`, not reported as an execution failure.
  - One request runs at a time and a second is rejected while it does;
    cancellation reaches a job even before its run starts.
  - A model without decision metadata is rejected from its GGUF header before
    loading, and a request rejected by the model fails with `err.code`
    `DECISION_INVALID_REQUEST`.
  - Load errors carry this addon's own ID, `[ Decision :: <code> ]`.
  - Laya checkpoints run in upstream format, converted from their Hugging Face
    checkpoints with upstream's converter. Fabric-format Laya files do not
    load.
