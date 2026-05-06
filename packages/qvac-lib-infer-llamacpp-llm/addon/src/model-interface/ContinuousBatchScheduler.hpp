#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <common/sampling.h>
#include <llama.h>

#include "LlmContext.hpp"
#include "MultiRequestBatcher.hpp"
#include "TextLlmContext.hpp"
#include "ToolsCompactController.hpp"

namespace qvac_lib_inference_addon_llama::batching {

/// Per-request streaming sinks. Both are optional; missing callbacks
/// are no-ops.
struct StreamCallbacks {
  std::function<void(uint32_t seqId, const std::string& text)> onToken;
  std::function<void(uint32_t seqId)> onDone;
};

/// One request admitted into the scheduler.
struct SubmitRequest {
  std::vector<common_chat_msg> chatMsgs;
  std::vector<common_chat_tool> tools;
  PromptLayout layout;
  bool prefill = false;
  std::string cacheKey;
  bool saveCacheToDisk = false;
  /// Per-request sampling/generation overrides on top of the scheduler's
  /// baseline `common_params_sampling` + `n_predict`. When empty the
  /// slot reuses its pre-built base sampler; otherwise the scheduler
  /// builds a per-request override sampler via
  /// `applyGenerationParamsToContext`. The merged `n_predict` is enforced
  /// strictly against the scheduler's per-seq ceiling (`ctxTotalTokens /
  /// batchSize`); requests with `prompt + n_predict` over that ceiling
  /// are rejected at admission rather than silently truncated.
  GenerationParams overrides;
  StreamCallbacks streams;
};

struct RuntimeStatsSnapshot {
  double avgConcurrentSeq = 0.0;
  int64_t cacheTokens = 0;
  int64_t contextSlides = 0;
  int64_t generatedTokens = 0;
  int64_t promptTokens = 0;
  double elapsedMs = 0.0;
};

/// Continuous-batching driver: owns the underlying `MultiRequestBatcher`,
/// per-slot `common_sampler` + UTF-8 buffers, and the production wiring
/// to `llama_decode`, `common_sampler_*`, `common_token_to_piece`,
/// `llama_vocab_is_eog` and `llama_memory_seq_rm`.
///
/// Step protocol (caller invokes `step()` in a loop while `hasWork()`):
///   1. fill batch from active slots
///   2. llama_decode
///   3. advance slot positions
///   4. sample for every just-idle slot, fire onToken
///   5. mark EOG / limit-reached slots finished
///   6. extract finished slots, fire onDone, KV-clear
///
/// Single-threaded by contract: callers must not invoke `submit`,
/// `step`, `cancel`, or `clear` concurrently.
class ContinuousBatchScheduler {
public:
  /// @param ctx                Live llama_context. Must outlive `*this`.
  /// @param model              Live llama_model. Must outlive `*this`.
  /// @param maxChunkSize       Tokens fed per slot per step (typically n_batch).
  /// @param ctxTotalTokens     Whole-pool KV-cache size (== llama_n_ctx).
  ///                            Partitioned uniformly across `batchSize`
  ///                            slots; per-seq ceiling is
  ///                            `ctxTotalTokens / batchSize`.
  /// @param batchSize          Concurrent slots (== llama_n_seq_max).
  /// @param batchCapacity      Underlying llama_batch token capacity.
  /// @param baseParams          Baseline llama/common params copied into each
  ///                            admitted slot policy before request overrides
  ///                            are applied.
  ContinuousBatchScheduler(
      llama_context* ctx, llama_model* model, unsigned maxChunkSize,
      unsigned ctxTotalTokens, size_t batchSize, int32_t batchCapacity,
      const common_params& baseParams, llama_pos configuredNDiscarded,
      std::optional<ToolsCompactProfile> toolsCompactProfile);

  ContinuousBatchScheduler(const ContinuousBatchScheduler&) = delete;
  ContinuousBatchScheduler&
  operator=(const ContinuousBatchScheduler&) = delete;
  ContinuousBatchScheduler(ContinuousBatchScheduler&&) = delete;
  ContinuousBatchScheduler&
  operator=(ContinuousBatchScheduler&&) = delete;

  ~ContinuousBatchScheduler();

  /// Admit one request and return the assigned slot id (`seqId`).
  ///
  /// When `request.overrides.hasOverrides()` is true, builds a
  /// per-request `common_sampler` via `applyGenerationParamsToContext`
  /// (matching the validation surface of the single-prompt path);
  /// otherwise resets and reuses the slot's pre-built base sampler.
  ///
  /// Throws `qvac_errors::StatusError(InvalidArgument)` for any failure:
  /// invalid per-request overrides (malformed `json_schema` or `grammar`
  /// rejected by `common_sampler_init`), no free slot, empty prompt,
  /// prompt exceeding the per-sequence token cap, or
  /// `prompt + n_predict` exceeding the per-sequence cap. Caller is
  /// responsible for tearing down already-admitted slots (e.g. via
  /// `clear()`) when admitting a batch and any one request fails.
  [[nodiscard]] uint32_t submit(SubmitRequest&& request);

  /// Drives one fillBatch + decode + advance + sample iteration.
  /// Returns `true` on a successful decode *or* a no-op (no slot had
  /// tokens to feed). Returns `false` if `llama_decode` reported a
  /// non-zero rc; in that case every still-active slot has already
  /// been finalised with `StopReason::DecodeError`, KV-cleared, and
  /// drained, so the caller's only obligation is to break out of its
  /// driving loop.
  [[nodiscard]] bool step();

  /// True while at least one slot has tokens to feed or sample.
  [[nodiscard]] bool hasWork() const;

  /// Number of currently occupied slots.
  [[nodiscard]] unsigned numActive() const;

  void resetRuntimeStats();
  [[nodiscard]] RuntimeStatsSnapshot runtimeStats() const;

  /// Cancel one slot. Frees the per-slot sampler and KV-cache entries
  /// and fires onDone with `Cancelled`.
  bool cancel(uint32_t seqId);
  void requestCancelAll();

  /// Cancel every active request.
  void clear();

private:
  struct SlotState {
    StreamCallbacks streams;
    std::unique_ptr<ToolsCompactController> tools;
    std::unique_ptr<TextLlmContext> policy;
    std::string cacheKey;
    bool saveCacheToDisk = false;
    bool prefillOnly = false;
  };

  void notifyDone(uint32_t seqId);
  void freeSlot(uint32_t seqId);
  void saveCacheForSlot(uint32_t seqId, const SlotState& slot);
  void accumulateSlotRuntimeStats(const SlotState& slot, const Request& req);

  llama_context* ctx_;
  llama_model* model_;
  const llama_vocab* vocab_;

  /// Baseline sampling block + n_predict, used when admitting requests
  /// to derive per-request sampling and cap.
  common_params_sampling baseSampling_;
  int baseNPredict_;
  common_params baseParams_;
  llama_pos configuredNDiscarded_;
  std::optional<ToolsCompactProfile> toolsCompactProfile_;

  /// Per-seq hard ceiling = ctxTotalTokens / batchSize. Drives prompt-size
  /// admission and per-request `prompt + n_predict` validation.
  unsigned perSeqMaxTokens_;
  MultiRequestBatcher batcher_;
  LlamaBatch batch_;
  std::vector<std::optional<SlotState>> slots_;
  std::atomic<bool> cancelRequested_ = false;
  uint64_t decodeStepCount_ = 0;
  uint64_t concurrentSeqSum_ = 0;
  int64_t completedCacheTokens_ = 0;
  int64_t completedContextSlides_ = 0;
  int64_t completedGeneratedTokens_ = 0;
  int64_t completedPromptTokens_ = 0;
  std::chrono::steady_clock::time_point statsStart_;
};

} // namespace qvac_lib_inference_addon_llama::batching
