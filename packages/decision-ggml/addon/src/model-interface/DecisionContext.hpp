#pragma once

#include <functional>
#include <memory>
#include <string>

#include <llama/common/common.h>

namespace qvac_lib_inference_addon_decision {

/// Maximum nesting of each value a request carries: a state (or each of
/// "states"), each question's instructions and each criteria entry may be
/// nested this many levels deep, counted from where the value starts, as the
/// SDK checks. The request's own framing (the body, "questions", a question,
/// "criteria") does not count. Deeper requests are rejected before any
/// recursive code sees them: running in-process there is no crash isolation,
/// and catching an exception cannot recover from a stack overflow.
///
/// Upstream (llama.cpp #30242) applies its own 128-level limit, counted from
/// the prompt input it builds around these values, so it can reject a value a
/// few levels sooner, depending on the model type and where the value sits
/// (for example 125 levels for a laya criteria entry). That rejection is an
/// invalid request too.
constexpr int DECISION_MAX_JSON_DEPTH = 128;

/// What a `noul` answer means for a decision type: "probability" (of the
/// "true" option), "expected_rating" (lev, normalized to 0..1), or "unknown"
/// for a type this addon does not list, which callers must not treat as
/// either.
std::string noulSemantics(common_decision_type type);

/// @brief DecisionEngineModel's context: upstream llama.cpp's decision
/// execution (tools/server server-context), run in-process without an HTTP
/// server. The decision counterpart of llm-llamacpp's LlmContext.
///
/// Upstream keeps decision parsing, prompt rendering, task scheduling and
/// answer calculation. This class owns one server_context, its routes and its
/// loop thread, applies the request depth guard, and throws the addon's
/// errors. Upstream's server classes stay in DecisionContext.cpp. Requests and
/// results use upstream's /v1/systemone JSON shapes.
class DecisionContext {
public:
  /// Loads the model and starts its execution loop on a thread the context
  /// owns. A model without upstream decision metadata is rejected from its
  /// GGUF header, before loading. Throws StatusError: UnsupportedModel (not a
  /// supported decision model) or UnableToLoadModel; nothing is left running.
  explicit DecisionContext(const common_params& params);

  /// Stops accepting runs, stops the runs in flight and waits for them to
  /// return, stops the execution loop, joins its thread and frees the model.
  ~DecisionContext();

  DecisionContext(const DecisionContext&) = delete;
  DecisionContext& operator=(const DecisionContext&) = delete;
  DecisionContext(DecisionContext&&) = delete;
  DecisionContext& operator=(DecisionContext&&) = delete;

  /// The loaded model's decision capabilities, as a JSON object:
  ///   {"decision_type": "openjev", "noul": "probability" | "expected_rating",
  ///    "joint": bool, "shared_prefix": bool, "images": bool, "audio": bool,
  ///    "score_levels": {"min": 2, "max": 10}, "max_json_depth": 128,
  ///    "n_ctx": int, "max_input_tokens": int, "model": string}
  /// "noul" is "unknown" for a type this addon does not list.
  /// "max_input_tokens" is the longest input (a state with one question and
  /// its options) a request can have.
  [[nodiscard]] const std::string& info() const noexcept;

  /// Runs one /v1/systemone request, blocks until it finishes and returns
  /// upstream's response JSON. Upstream checks @p shouldStop between result
  /// polls, so a stop takes effect at the next poll, not in the middle of a
  /// backend computation.
  ///
  /// A request with "states" (an array) instead of "state" is a batch: one
  /// upstream request per state, sent concurrently so upstream batches them
  /// across its slots, at most one per slot in flight. It returns a JSON array
  /// of the responses in input order. The first failure stops the others and
  /// fails the batch; its message names the state ("states[3]: ...").
  ///
  /// Throws std::runtime_error("Job cancelled") when @p shouldStop (or the
  /// context's destruction) stopped the run, even if upstream returned a
  /// response; StatusError InvalidRequest for a request the model rejects
  /// (bad JSON, nesting deeper than DECISION_MAX_JSON_DEPTH, upstream
  /// validation, an input longer than the model reads in one pass), whose
  /// message starts with "invalid request: "; StatusError
  /// DecodeFailed for an execution failure.
  std::string
  run(const std::string& requestJson, const std::function<bool()>& shouldStop);

  /// Tests only: records @p error as the execution loop's failure, as a loop
  /// that throws does, so runs fail with it. The loop thread keeps running.
  void markLoopDeadForTesting(const std::string& error) noexcept;

  struct State;

private:
  std::unique_ptr<State> state_;
};

} // namespace qvac_lib_inference_addon_decision
