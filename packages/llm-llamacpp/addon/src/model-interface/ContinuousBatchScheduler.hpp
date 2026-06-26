#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <exception>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include <common/sampling.h>
#include <concurrentqueue/concurrentqueue.h>
#include <llama.h>

#include "LlmContext.hpp"
#include "MultiRequestBatcher.hpp"
#include "SequenceDriver.hpp"
#include "ToolsCompactController.hpp"

namespace qvac_lib_inference_addon_llama::batching {

/// Fire the terminal lifecycle hook for a finished sequence. A sequence that
/// ran generation goes through onCancel (cancel/error) or onGenerationFinished
/// (natural stop) so onGenerationCompletePolicy runs; a prefill-only slot only
/// flushes via onSequenceEnd. One place for the mapping every terminal path
/// shares (normal drain, cancel-all, decode-error finalization).
void finalizeTerminalDriver(
    SequenceDriver& driver, StopReason reason, bool prefillOnly,
    const std::function<void(const std::string&)>& outputCallback);

/// Per-request streaming sinks. Both are optional; missing callbacks
/// are no-ops.
struct StreamCallbacks {
  std::function<void(uint32_t seqId, const std::string& text)> onToken;
  std::function<void(uint32_t seqId)> onDone;
};

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

/// Aggregated per-scheduler runtime stats. `avgConcurrentSeq`/`elapsedMs`
/// are derived getters computed from live state, not stored.
struct RuntimeStatsSnapshot {
  int64_t cacheTokens = 0;
  int64_t contextSlides = 0;
  int64_t thinkingBlockDiscards = 0;
  int64_t generatedTokens = 0;
  int64_t promptTokens = 0;

  void reset();

  /// Account for one `llama_decode` step of `stepDuration`. A step carrying
  /// any decode token is charged wholly to decode; only pure-prefill steps
  /// feed the prefill bucket, so prompt tokens piggybacking a decode step
  /// never inflate the prefill rate.
  void recordDecodeStep(
      uint64_t numActiveSequences, uint64_t prefillTokens,
      uint64_t decodeTokens, std::chrono::nanoseconds stepDuration);

  /// Fold one completed slot's contribution into the running totals.
  void accumulateSlot(
      int64_t nPast, int64_t nSlides, int64_t thinkingDiscards,
      const Request& req);

  [[nodiscard]] double avgConcurrentSeq() const;
  [[nodiscard]] double elapsedMs() const;

  /// Generation throughput (tok/s) from decode-step timing, 0 if none. Batch
  /// analogue of single-prompt `TPS`.
  [[nodiscard]] double decodeTokensPerSecond() const;
  /// Prompt-processing throughput (tok/s) from pure-prefill-step timing, 0 if
  /// none. Batch analogue of `ppTPS`.
  [[nodiscard]] double prefillTokensPerSecond() const;

private:
  uint64_t decodeStepCount_ = 0;
  uint64_t concurrentSeqSum_ = 0;
  double decodeTimeMs_ = 0.0;
  double prefillTimeMs_ = 0.0;
  uint64_t decodeTokenCount_ = 0;
  uint64_t prefillTokenCount_ = 0;
  std::chrono::steady_clock::time_point start_ =
      std::chrono::steady_clock::now();
};

struct BatchResult {
  std::vector<std::string> outputs;
  RuntimeStatsSnapshot stats;
};

/// Continuous-batching driver: owns the underlying `MultiRequestBatcher`,
/// per-slot `common_sampler` + UTF-8 buffers, and the production wiring
/// to `llama_decode`, `common_sampler_*`, `common_token_to_piece`,
/// `llama_vocab_is_eog` and `llama_memory_seq_rm`.
///
/// Callers enqueue request groups and wait for their result. A scheduler-owned
/// worker thread admits queued requests into free slots, runs decode chunks,
/// and refills slots as soon as completed requests are drained.
class ContinuousBatchScheduler {
public:
  /// @param shared             Live llama handles. Must outlive `*this`.
  /// @param maxChunkSize       Tokens fed per slot per step (typically
  /// n_batch).
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
      LlmModelContext shared, unsigned maxChunkSize, unsigned ctxTotalTokens,
      size_t batchSize, int32_t batchCapacity, const common_params& baseParams,
      llama_pos configuredNDiscarded,
      std::optional<ToolsCompactProfile> toolsCompactProfile);

  ContinuousBatchScheduler(const ContinuousBatchScheduler&) = delete;
  ContinuousBatchScheduler& operator=(const ContinuousBatchScheduler&) = delete;
  ContinuousBatchScheduler(ContinuousBatchScheduler&&) = delete;
  ContinuousBatchScheduler& operator=(ContinuousBatchScheduler&&) = delete;

  ~ContinuousBatchScheduler();

  /// Queue a group of requests and block until every request in the group has
  /// completed, failed, or been cancelled. Outputs are returned in input order.
  [[nodiscard]] BatchResult processBatch(std::vector<SubmitRequest>&& requests);

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

  [[nodiscard]] bool hasWork() const;

  [[nodiscard]] unsigned numActive() const;

  void resetRuntimeStats();
  [[nodiscard]] RuntimeStatsSnapshot runtimeStats() const;

  /// Cancel one slot: frees the per-slot sampler and KV-cache entries
  /// and fires onDone with `Cancelled`. While the worker thread is
  /// running, the cancellation is only recorded and applied by the
  /// worker between decode steps -- the worker releases `mutex_` across
  /// `llama_decode`, so mutating the shared `llama_context` from the
  /// calling thread would race the in-flight decode. Applied
  /// synchronously when no worker has been started.
  /// @return whether the slot was occupied when the cancel was issued.
  bool cancel(uint32_t seqId);
  void requestCancelAll();

  /// Cancel every active request. Deferred to the worker thread when it
  /// is running, for the same reason as `cancel(seqId)`.
  void clear();

  /// Override the decode function used by stepLocked(). For unit tests only --
  /// inject a stub that returns a non-zero rc to exercise the decode-error
  /// path without a real llama_decode call succeeding.
  using DecodeFunc = std::function<int(llama_context*, llama_batch&)>;
  void setDecodeFuncForTesting(DecodeFunc fn) { decodeFunc_ = std::move(fn); }

private:
  struct BatchGroup {
    explicit BatchGroup(size_t requestCount) : outputs(requestCount) {}

    std::vector<std::string> outputs;
    RuntimeStatsSnapshot stats;
    size_t completedCount = 0;
    size_t totalCount = 0;
    bool done = false;
    std::exception_ptr error;
  };

  struct QueuedRequest {
    SubmitRequest request;
    std::shared_ptr<BatchGroup> group;
    size_t outputIndex = 0;
  };

  struct SlotState {
    StreamCallbacks streams;
    std::unique_ptr<ToolsCompactController> tools;
    std::unique_ptr<SequenceDriver> driver;
    std::string cacheKey;
    std::shared_ptr<BatchGroup> group;
    size_t outputIndex = 0;
    bool saveCacheToDisk = false;
    bool prefillOnly = false;
  };

  void ensureWorkerStartedLocked();
  void workerLoop();
  void admitPendingIntoFreeSlotsLocked();
  [[nodiscard]] uint32_t submitLocked(QueuedRequest&& queued);
  [[nodiscard]] bool stepLocked(std::unique_lock<std::mutex>* lock = nullptr);
  [[nodiscard]] bool hasWorkLocked() const;
  [[nodiscard]] unsigned numActiveLocked() const;
  void completeGroupRequestLocked(const std::shared_ptr<BatchGroup>& group);
  void failGroupLocked(
      const std::shared_ptr<BatchGroup>& group, std::exception_ptr error);
  void cancelPendingLocked();
  void clearLocked();
  void cancelSlotLocked(uint32_t seqId);
  /// Apply teardown requests recorded by cancel()/clear() while the
  /// worker was mid-step. Must run before admitting pending requests so
  /// a deferred cancel can never hit a freed-and-reused slot.
  void applyDeferredTeardownLocked();
  void notifyDone(uint32_t seqId);
  void freeSlot(uint32_t seqId);
  void finalizeFinishedSequences();
  std::function<void(const std::string&)>
  getOutputCallback(SlotState& slot, uint32_t seqId);
  std::function<bool(const Request&)> hasValidDriverF() const;
  void saveCacheForSlot(uint32_t seqId, const SlotState& slot);
  void accumulateSlotRuntimeStats(const SlotState& slot, const Request& req);

  LlmModelContext shared_;

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
  mutable std::mutex mutex_;
  std::condition_variable workCv_;
  moodycamel::ConcurrentQueue<QueuedRequest> pending_;
  std::thread worker_;
  bool workerStarted_ = false;
  bool stopping_ = false;
  std::vector<uint32_t> pendingSlotCancels_;
  bool clearRequested_ = false;
  RuntimeStatsSnapshot stats_;

  /// Decode function used in stepLocked(). Defaults to llama_decode; can be
  /// overridden via setDecodeFuncForTesting() to inject a failing stub.
  DecodeFunc decodeFunc_;
};

} // namespace qvac_lib_inference_addon_llama::batching
