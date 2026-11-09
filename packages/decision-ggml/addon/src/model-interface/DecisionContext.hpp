#pragma once

#include <functional>
#include <memory>
#include <string>

#include <llama/common/common.h>

namespace qvac_lib_inference_addon_decision {

/// Maximum nesting of the values inside a request body: a state, instruction
/// or description may be nested this many levels deep, the same limit
/// upstream applies to the values it walks recursively (llama.cpp #30242). The
/// body object itself adds one level. Deeper requests are rejected before any
/// recursive code sees them: running in-process there is no crash isolation,
/// and catching an exception cannot recover from a stack overflow.
constexpr int DECISION_MAX_JSON_DEPTH = 128;

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
  ///    "n_ctx": int, "model": string}
  [[nodiscard]] const std::string& info() const noexcept;

  /// Runs one /v1/systemone request (one state), blocks until it finishes and
  /// returns upstream's response JSON. Upstream checks @p shouldStop between
  /// result polls, so a stop takes effect at the next poll, not in the middle
  /// of a backend computation.
  ///
  /// Throws std::runtime_error("Job cancelled") when @p shouldStop (or the
  /// context's destruction) stopped the run, even if upstream returned a
  /// response; StatusError InvalidRequest for a request the model rejects
  /// (bad JSON, nesting deeper than DECISION_MAX_JSON_DEPTH, upstream
  /// validation), whose message starts with "invalid request: "; StatusError
  /// DecodeFailed for an execution failure.
  std::string
  run(const std::string& requestJson, const std::function<bool()>& shouldStop);

  struct State;

private:
  std::unique_ptr<State> state_;
};

} // namespace qvac_lib_inference_addon_decision
