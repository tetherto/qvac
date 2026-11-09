#pragma once

#include <atomic>
#include <memory>
#include <string>

/// @brief Upstream llama.cpp's decision execution (tools/server
/// server-context), run in-process without an HTTP server.
///
/// Upstream keeps decision parsing, prompt rendering, task scheduling and
/// answer calculation. This class owns one engine's lifecycle (its
/// server_context, routes and loop thread), cancellation, the request depth
/// guard and the mapping of outcomes to explicit statuses. Upstream's server
/// classes stay in DecisionRuntime.cpp; callers see JSON strings and a status.
/// Requests and results use upstream's /v1/systemone JSON shapes.
namespace qvac_lib_infer_llamacpp_decision {

/// Maximum nesting of the values inside a request body: a state, instruction
/// or description may be nested this many levels deep, the same limit
/// upstream applies to the values it walks recursively (llama.cpp #30242). The
/// body object itself adds one level. Deeper requests are rejected before any
/// recursive code sees them: running in-process there is no crash isolation,
/// and catching an exception cannot recover from a stack overflow.
constexpr int kDecisionMaxJsonDepth = 128;

enum class DecisionStatus {
  Ok,
  /// The run was cancelled (its token was cancelled, or the runtime is being
  /// destroyed). Never reported as Ok, even if upstream returned a response.
  Cancelled,
  /// The request (or, for create(), the parameters or the model) was
  /// rejected: bad JSON, nesting deeper than kDecisionMaxJsonDepth, or
  /// upstream validation (unknown question type, too many options, ...).
  InvalidRequest,
  /// Execution failed.
  Error,
  /// The runtime no longer accepts runs (destruction has started).
  Unavailable,
};

/// A cancellation flag shared by the thread that runs a request and the
/// thread that cancels it. Thread-safe and sticky.
class DecisionCancelToken {
public:
  void request() noexcept { requested_.store(true, std::memory_order_release); }
  [[nodiscard]] bool requested() const noexcept {
    return requested_.load(std::memory_order_acquire);
  }

private:
  std::atomic<bool> requested_{false};
};

/// The outcome of create() or run(). `json` is upstream's result object for an
/// Ok run, and {"error": {"message": ..., "type": ...}} otherwise.
struct DecisionOutcome {
  DecisionStatus status = DecisionStatus::Error;
  std::string json;
};

class DecisionRuntime {
public:
  /// Loads a decision model and starts its execution loop on a thread the
  /// runtime owns. paramsJson fields (all optional except "model"):
  ///   "model"              string  GGUF path
  ///   "mmproj"             string  projector GGUF path, for media input
  ///   "lora"               array   [{"path": string, "scale": number}]
  ///   "n_ctx", "n_batch", "n_ubatch", "n_parallel", "n_gpu_layers",
  ///   "n_threads"          integer; n_parallel, n_batch and n_ubatch must be
  ///                        at least 1 and n_ctx at least 0
  ///   "mmproj_use_gpu"     boolean (default true)
  ///   "sleep_idle_seconds" integer (default -1, never sleep)
  /// A model without upstream decision metadata is rejected from its GGUF
  /// header, before loading. On failure `runtime` is null, nothing is left
  /// running, and `outcome` describes the failure.
  struct Created {
    std::unique_ptr<DecisionRuntime> runtime;
    DecisionOutcome outcome;
  };
  static Created create(const std::string& paramsJson);

  /// Stops accepting runs, cancels the runs in flight and waits for them to
  /// return, stops the execution loop, joins its thread and frees the model.
  ~DecisionRuntime();

  DecisionRuntime(const DecisionRuntime&) = delete;
  DecisionRuntime& operator=(const DecisionRuntime&) = delete;
  DecisionRuntime(DecisionRuntime&&) = delete;
  DecisionRuntime& operator=(DecisionRuntime&&) = delete;

  /// The loaded model's decision capabilities, as a JSON object:
  ///   {"decision_type": "openjev", "noul": "probability" | "expected_rating",
  ///    "joint": bool, "shared_prefix": bool, "images": bool, "audio": bool,
  ///    "score_levels": {"min": 2, "max": 10}, "max_json_depth": 128,
  ///    "n_ctx": int, "model": string}
  [[nodiscard]] const std::string& info() const noexcept;

  /// Runs one /v1/systemone request (one state) and blocks until it finishes.
  /// `cancel` may be null. Several runs may be in flight; upstream schedules
  /// their tasks over its n_parallel slots. Upstream checks cancellation
  /// between result polls, so a cancel takes effect at the next poll, not in
  /// the middle of a backend computation.
  DecisionOutcome
  run(const std::string& requestJson,
      const std::shared_ptr<const DecisionCancelToken>& cancel);

  struct State;

private:
  explicit DecisionRuntime(std::unique_ptr<State> state);
  std::unique_ptr<State> state_;
};

} // namespace qvac_lib_infer_llamacpp_decision
