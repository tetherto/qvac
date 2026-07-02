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
#include "MediaLoadOrder.hpp"
#include "MultiRequestBatcher.hpp"
#include "SequenceDriver.hpp"
#include "ToolsCompactController.hpp"

/// Defined in test/unit/test_internal_peers.hpp (tests only); befriended below
/// so unit tests can inject decode/media-eval stubs. Never defined in
/// production builds, where it is only ever named as a friend.
class ContinuousBatchSchedulerTestPeer;

namespace qvac_lib_inference_addon_llama::batching {

/// Fire the terminal lifecycle hook for a finished sequence. A sequence that
/// ran generation goes through onCancel (cancel/error) or onGenerationFinished
/// (natural stop) so onGenerationCompletePolicy runs; a prefill-only slot only
/// flushes via onSequenceEnd. One place for the mapping every terminal path
/// shares (normal drain, cancel-all, decode-error finalization).
void finalizeTerminalDriver(
    SequenceDriver& driver, StopReason reason, bool prefillOnly,
    const std::function<void(const std::string&)>& outputCallback);

/// Decide whether a generating slot may temporarily touch its per-slot token
/// cap because the driver will slide its window back below the ceiling on the
/// next step. Slides only happen during generation (never prefill) and only
/// when sliding is configured.
[[nodiscard]] bool computeSlideCapable(
    const SequenceDriver& driver, bool slideConfigured, bool isPrefill);

/// Whether prompt + generation budget overruns the per-sequence cap at
/// admission. `promptSize` is the position span and `promptKvSize` the KV-cell
/// span of the prompt; for M-RoPE media `promptKvSize >= promptSize`, so the
/// KV-cell span is the binding quantity that must also leave room for
/// `nPredict`. `nPredict <= 0` means "no scheduler cap" (the batcher's ceiling
/// governs), so the budget is never exceeded in that case.
[[nodiscard]] bool generationBudgetExceeded(
    unsigned promptSize, unsigned promptKvSize, int nPredict,
    unsigned perSeqMaxTokens);

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
  /// Raw media payloads (images/audio) referenced by the prompt. Only
  /// accepted when the scheduler's driver factory builds multimodal
  /// drivers; text drivers reject a non-empty list at admission.
  std::vector<std::vector<uint8_t>> media;
  /// Every media marker in prompt order, byte buffers and paths interleaved as
  /// they appear in the prompt. The per-slot driver loads media via this plan
  /// (see `computeMediaLoadOrder`), consuming byte payloads from `media` by
  /// index and paths inline, so each bitmap binds to its marker in order. Like
  /// `media`, only multimodal drivers accept a non-empty list.
  std::vector<PlannedMedia> mediaPlan;
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

/// Builds the per-slot `SequenceDriver` at admission time. The model layer
/// owns the concrete context selection (text vs multimodal) and supplies this
/// factory, so the scheduler depends on no concrete driver type. `params`
/// already carries the merged per-request sampling overrides.
using DriverFactory = std::function<std::unique_ptr<SequenceDriver>(
    const common_params& params, ToolsCompactController& tools, uint32_t seqId,
    llama_pos perSeqCtxCeiling)>;

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
  /// @param driverFactory       Per-slot driver builder. Required and
  ///                            non-empty: the model layer owns the single
  ///                            text-vs-multimodal selection, so the scheduler
  ///                            never names a concrete driver type.
  ContinuousBatchScheduler(
      LlmModelContext shared, unsigned maxChunkSize, unsigned ctxTotalTokens,
      size_t batchSize, int32_t batchCapacity, const common_params& baseParams,
      llama_pos configuredNDiscarded,
      std::optional<ToolsCompactProfile> toolsCompactProfile,
      DriverFactory driverFactory);

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

  /// Decode function used by stepLocked() (defaults to llama_decode) and the
  /// media-segment eval used by serviceNextMediaSegmentLocked() (defaults to
  /// driver.evalMediaSegment()). Unit tests override them through
  /// ContinuousBatchSchedulerTestPeer to inject failing/blocking stubs.
  using DecodeFunc = std::function<int(llama_context*, llama_batch&)>;
  using EvalMediaFunc =
      std::function<llama_pos(SequenceDriver&, size_t, llama_pos)>;

private:
  // Test peer (global namespace) sets decodeFunc_/evalMediaFunc_ directly.
  // See test_internal_peers.hpp.
  friend class ::ContinuousBatchSchedulerTestPeer;

  /// RAII for the two points where a step must drop `mutex_` for a blocking
  /// call (media-segment eval, `llama_decode`): unlocks on construction, and
  /// on destruction reacquires the lock and applies any teardown
  /// (`cancel(seqId)` / `clear()`) recorded while it was dropped, before the
  /// step touches slot state again. Reconciling on every reacquisition is the
  /// invariant that stops a concurrently-cancelled/cleared slot from being
  /// decoded, advanced, or streamed after the unlock window. A null `lock`
  /// (no worker driving the step) is a no-op on both ends.
  class StepUnlockGuard {
  public:
    StepUnlockGuard(
        ContinuousBatchScheduler& scheduler,
        std::unique_lock<std::mutex>* lock);
    /// `noexcept`: the deferred-teardown work it runs is `noexcept`, but
    /// re-acquiring `mutex_` is not. The only exception that step can raise is
    /// the `std::system_error` `std::mutex::lock()` is permitted to throw on an
    /// unrecoverable lock failure -- i.e. the OS failing to honour its
    /// `pthread_mutex_lock` contract for an initialised normal mutex. That is
    /// not recoverable: the worker's sole mutex is gone and, crucially, we are
    /// no longer holding it, so letting it escape would hand a lock-free state
    /// to the worker's catch handler (which assumes the lock is held). The
    /// destructor catches it, logs, and `std::abort()`s instead -- a clean stop
    /// at the point of failure rather than UB downstream.
    ~StepUnlockGuard() noexcept;
    StepUnlockGuard(const StepUnlockGuard&) = delete;
    StepUnlockGuard& operator=(const StepUnlockGuard&) = delete;
    StepUnlockGuard(StepUnlockGuard&&) = delete;
    StepUnlockGuard& operator=(StepUnlockGuard&&) = delete;

  private:
    ContinuousBatchScheduler& scheduler_;
    std::unique_lock<std::mutex>* lock_;
  };

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
  /// Evaluate the head media barrier of one awaiting slot (lowest seqId)
  /// via its driver, unlocking around the embedded `llama_decode`. A
  /// media failure only fails that slot's request, never the whole
  /// scheduler.
  void serviceNextMediaSegmentLocked(std::unique_lock<std::mutex>* lock);
  void failSlotLocked(uint32_t seqId, std::exception_ptr error);
  [[nodiscard]] MultiRequestBatcher::PrefillCompleteFn prefillCompleteFn();
  /// Extract finished requests and run the full per-slot drain (terminal
  /// driver hook with output flushing, stats, cache save, KV clear).
  void drainFinishedLocked();
  [[nodiscard]] bool hasWorkLocked() const noexcept;
  [[nodiscard]] unsigned numActiveLocked() const noexcept;
  void
  completeGroupRequestLocked(const std::shared_ptr<BatchGroup>& group) noexcept;
  void failGroupLocked(
      const std::shared_ptr<BatchGroup>& group,
      std::exception_ptr error) noexcept;
  void cancelPendingLocked();
  void clearLocked() noexcept;
  /// Tear down a single slot (cancel path). `noexcept`: callers run it from
  /// the StepUnlockGuard destructor and the worker loop, so the teardown itself
  /// must never throw. Every throwing step (driver finalize + cache save, and
  /// the onDone callback inside notifyDone) is contained; the cleanup tail
  /// (notifyDone/batcher cancel/freeSlot) always runs.
  void cancelSlotLocked(uint32_t seqId) noexcept;
  /// Apply teardown requests recorded by cancel()/clear() while the
  /// worker was mid-step. Must run before admitting pending requests so
  /// a deferred cancel can never hit a freed-and-reused slot. `noexcept` so the
  /// StepUnlockGuard destructor's teardown step cannot throw -- the only thing
  /// that destructor can throw is the mutex re-acquire (see its declaration).
  void applyDeferredTeardownLocked() noexcept;
  /// Fire the slot's onDone stream callback, then complete its group. Throwing
  /// variant for the normal-completion path: a throwing onDone propagates so
  /// the worker loop surfaces it as a batch error rather than silently
  /// completing the group as a success.
  void notifyDone(uint32_t seqId);
  /// `noexcept` teardown variant (cancel/clear/fail paths). Contains the
  /// caller-provided onDone internally so a throwing callback can neither
  /// escape a noexcept path nor skip the group-completion below.
  void notifyDoneNoexcept(uint32_t seqId) noexcept;
  void freeSlot(uint32_t seqId) noexcept;
  /// Remove every KV-cache cell owned by `seqId` from the shared context.
  /// Single home for the cleanup repeated across all slot-teardown paths.
  void clearSeqKv(uint32_t seqId) noexcept;
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
  DriverFactory driverFactory_;

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

  /// Decode function used in stepLocked(). Defaults to llama_decode; a test
  /// stub can be injected via
  /// ContinuousBatchSchedulerTestPeer::setDecodeFunc().
  DecodeFunc decodeFunc_;

  /// Media-segment eval used in serviceNextMediaSegmentLocked(). Defaults to
  /// driver.evalMediaSegment(); a test stub can be injected via
  /// ContinuousBatchSchedulerTestPeer::setEvalMediaFunc().
  EvalMediaFunc evalMediaFunc_;
};

} // namespace qvac_lib_inference_addon_llama::batching
