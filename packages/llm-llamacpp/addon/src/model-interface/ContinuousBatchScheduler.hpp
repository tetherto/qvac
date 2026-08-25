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
#include <unordered_map>
#include <vector>

#include <common/sampling.h>
#include <concurrentqueue/concurrentqueue.h>
#include <llama.h>

#include "LlmContext.hpp"
#include "MediaLoadOrder.hpp"
#include "MultiRequestBatcher.hpp"
#include "SequenceDriver.hpp"

/// Defined in test/unit/test_internal_peers.hpp (tests only); befriended below
/// so unit tests can inject decode/media-eval stubs. Never defined in
/// production builds, where it is only ever named as a friend.
class ContinuousBatchSchedulerTestPeer;

namespace qvac_lib_inference_addon_llama::batching {

/// Fire the terminal lifecycle hook for a finished sequence. A sequence that
/// ran generation goes through onCancel (cancel/error) or onGenerationFinished
/// (natural stop, which flushes output and runs end-of-generation reasoning
/// compaction); a prefill-only slot only flushes via onSequenceEnd. One place
/// for the mapping every terminal path shares (normal drain, cancel-all,
/// decode-error finalization).
///
/// Returns `true` when the terminal hook left the driver in a state safe
/// to persist via `saveCache`. Cancel/DecodeError paths forward
/// `onCancel`'s rollback-ok signal; natural generation forwards
/// `onGenerationFinished` so a prediction-limit rollback can also veto
/// persistence. Prefill-only paths always return `true`. Callers that
/// persist cache MUST skip `saveCache` when this returns `false` so a
/// failed recurrent rollback cannot leak the request into the on-disk cache.
[[nodiscard]] bool finalizeTerminalDriver(
    SequenceDriver& driver, StopReason reason, bool prefillOnly,
    const std::function<void(const std::string&)>& outputCallback);

/// Whether prompt + generation budget overruns the per-sequence cap at
/// admission. `promptSize` is the position span and `promptKvSize` the KV-cell
/// span of the prompt; for M-RoPE media `promptKvSize >= promptSize`, so the
/// KV-cell span is the binding quantity that must also leave room for
/// `nPredict`. `nPredict <= 0` means "no scheduler cap" (the batcher's ceiling
/// governs), so the budget is never exceeded in that case.
[[nodiscard]] bool generationBudgetExceeded(
    unsigned promptSize, unsigned promptKvSize, int nPredict,
    unsigned perSeqMaxTokens);

/// Observed end-to-end figures for one finished request, computed from its
/// wall-clock stamps at drain. This is what the submitting caller experienced
/// (queue wait + shared-GPU decode) — NOT the request's isolated compute
/// speed, which is unmeasurable under fused batch decode.
struct ObservedRequestStats {
  /// Enqueue -> first sampled token, ms. 0 when no token was ever sampled.
  double ttftMs = 0.0;
  /// Observed generation rate: (generatedTokens - 1) inter-token gaps over
  /// firstTokenAt -> lastTokenAt, tok/s. 0 with fewer than two tokens.
  double genTps = 0.0;
  int64_t generatedTokens = 0;
  int64_t promptTokens = 0;
  /// Why this request's generation stopped. Per-sequence, so it is honest for
  /// a single request; `nullopt` when unknown (never finalized) or when a
  /// group's requests disagree, since one reason cannot describe many.
  std::optional<GenerationStopReason> stopReason;
};

/// Compute a request's observed stats from its stamps. @p enqueuedAt is when
/// the caller handed the request to the scheduler (queue wait included).
/// @p stopReason is the finalized driver's reason, when it is known.
[[nodiscard]] ObservedRequestStats computeObservedStats(
    std::chrono::steady_clock::time_point enqueuedAt, const Request& req,
    std::optional<GenerationStopReason> stopReason = std::nullopt);

/// Group-level view of one submitted batch: TTFT and rate average across the
/// requests that actually produced them (a request that never sampled a token
/// does not drag the averages down), token counts sum over all. `stopReason`
/// survives only when every request agrees (so a one-item group keeps its
/// reason); a mixed group reports none rather than picking a winner.
[[nodiscard]] ObservedRequestStats
aggregateObservedStats(const std::vector<ObservedRequestStats>& all);

/// The never-matching admission id: no slot is ever stamped with it, so a
/// cancel carrying it is always a no-op. Real admission ids start at 1.
inline constexpr uint64_t K_UNKNOWN_ADMISSION_ID = 0;

/// Per-request streaming sinks. All are optional; missing callbacks
/// are no-ops.
struct StreamCallbacks {
  std::function<void(uint32_t seqId, const std::string& text)> onToken;
  std::function<void(uint32_t seqId)> onDone;
  /// Fired once when the request is admitted into a slot, before that slot
  /// decodes anything. Runs with the scheduler lock held (on the worker
  /// thread once it is driving), so it must not call back into the
  /// scheduler. `admissionId` is the slot's ownership token for this
  /// admission — the only handle `cancel()` accepts, because the seqId
  /// alone is a recyclable slot index that may already name a successor by
  /// the time a cancel fires. Returning true means the caller already holds
  /// a cancel for this request — the scheduler tears the slot down before
  /// it ever decodes.
  std::function<bool(uint32_t seqId, uint64_t admissionId)> onAdmitted;
};

struct SubmitRequest {
  std::vector<common_chat_msg> chatMsgs;
  std::vector<common_chat_tool> tools;
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
  /// When the caller built this request — the start of the observed timeline
  /// (ObservedRequestStats.ttftMs counts queue wait from here).
  std::chrono::steady_clock::time_point enqueuedAt =
      std::chrono::steady_clock::now();
};

using SchedulerDecodeFunc = std::function<int(llama_context*, llama_batch&)>;
using SchedulerSynchronizeFunc = std::function<void(llama_context*)>;

struct TimedDecodeResult {
  int rc = 0;
  std::chrono::nanoseconds duration{};
};

/// Time one scheduler decode step through backend completion: llama_decode can
/// run asynchronously, so synchronize before recording time or mutating state.
[[nodiscard]] TimedDecodeResult timeDecodeStep(
    llama_context* ctx, llama_batch& batch, const SchedulerDecodeFunc& decode,
    const SchedulerSynchronizeFunc& synchronize);

/// Aggregated per-scheduler runtime stats. `avgConcurrentSeq`/`elapsedMs`
/// are derived getters computed from live state, not stored.
struct RuntimeStatsSnapshot {
  int64_t cacheTokens = 0;
  int64_t thinkingBlockDiscards = 0;
  int64_t generatedTokens = 0;
  int64_t promptTokens = 0;

  void reset();

  /// Account for one `llama_decode` step of `stepDuration`. Mixed
  /// prefill+decode steps are split proportionally by token count between
  /// the prefill and decode buckets, so batch TTFT / ppTPS reflect the
  /// prompt work that piggybacks a decode step during continuous batching.
  /// Compactor replay decode is excluded because `onGenerationFinished`
  /// runs outside this timer, not by any special-casing here.
  void recordDecodeStep(
      uint64_t numActiveSequences, uint64_t prefillTokens,
      uint64_t decodeTokens, std::chrono::nanoseconds stepDuration);

  /// Fold one completed slot's contribution into the running totals.
  void
  accumulateSlot(int64_t nPast, int64_t thinkingDiscards, const Request& req);

  /// How busy the shared backend was, NOT a property of any one request: the
  /// mean number of sequences decoded together, averaged over every
  /// `llama_decode` step of the epoch (`concurrentSeqSum_ / decodeStepCount_`).
  /// A request contributes at most 1; the rest is other traffic on the same
  /// backend, capped by its configuration (`parallel`). 1.0 = the model was
  /// effectively yours alone; ~N = your tokens shared compute with N-1 others,
  /// so a request's observed `TPS` is roughly the aggregate rate divided by N
  /// (`observed TPS * avgConcurrentSeq ~= aggregate TPS`). Useful even on a
  /// single request: it tells apart "slow model" from "busy backend". Always
  /// reported model-level, never overridden per job. See
  /// docs/continuous-batching.md ("Stats").
  [[nodiscard]] double avgConcurrentSeq() const;
  [[nodiscard]] double elapsedMs() const;

  /// Generation throughput (tok/s) from decode-step timing, 0 if none. Batch
  /// analogue of single-prompt `TPS`. Mixed-step time is split
  /// proportionally with the prefill bucket (see `recordDecodeStep`).
  [[nodiscard]] double decodeTokensPerSecond() const;
  /// Prompt-processing throughput (tok/s) from prefill-step timing, 0 if
  /// none. Batch analogue of `ppTPS`. Mixed steps contribute their prefill
  /// share of both tokens and time (see `recordDecodeStep`).
  [[nodiscard]] double prefillTokensPerSecond() const;
  /// Wall-clock time (ms) attributed to prefill across batch steps
  /// (pure-prefill steps plus the prefill share of mixed steps). Batch
  /// analogue of single-prompt `TTFT`; excludes compactor replay decode
  /// because that runs outside this timer, not by mixed-step gating.
  [[nodiscard]] double prefillTimeMs() const noexcept { return prefillTimeMs_; }

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
  /// Per-request observed figures, in input order (parallel to `outputs`).
  std::vector<ObservedRequestStats> requestStats;
};

/// Builds the per-slot `SequenceDriver` at admission time. The model layer
/// owns the concrete context selection (text vs multimodal) and supplies this
/// factory, so the scheduler depends on no concrete driver type. `params`
/// already carries the merged per-request sampling overrides.
using DriverFactory = std::function<std::unique_ptr<SequenceDriver>(
    const common_params& params, uint32_t seqId, llama_pos perSeqCtxCeiling)>;

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
      DriverFactory driverFactory);

  ContinuousBatchScheduler(const ContinuousBatchScheduler&) = delete;
  ContinuousBatchScheduler& operator=(const ContinuousBatchScheduler&) = delete;
  ContinuousBatchScheduler(ContinuousBatchScheduler&&) = delete;
  ContinuousBatchScheduler& operator=(ContinuousBatchScheduler&&) = delete;

  ~ContinuousBatchScheduler();

  /// Queue a group of requests and block until every request in the group has
  /// completed, failed, or been cancelled. Outputs are returned in input order.
  /// @p groupTag (non-zero) lets the submitter target this group through
  /// `cancelGroupQueued` for as long as this call is on the stack; the tag must
  /// be unique among live groups and is forgotten when the call returns. Pass 0
  /// for an untargetable group.
  [[nodiscard]] BatchResult
  processBatch(std::vector<SubmitRequest>&& requests, uint64_t groupTag = 0);

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

  [[nodiscard]] bool hasWork() const;

  [[nodiscard]] unsigned numActive() const;

  /// Requests occupying or waiting for a slot: active slots plus the pending
  /// backlog. This is the resource that actually runs out, so it — not a job
  /// count — is what an at-capacity admission check must compare against
  /// `parallel` (one batch job of N prompts consumes up to N of these).
  /// The pending part is `size_approx()`, so the total may momentarily be off
  /// by a request in either direction; callers use it as a fast-fail hint,
  /// never as an invariant.
  [[nodiscard]] unsigned occupancy() const;

  void resetRuntimeStats();
  [[nodiscard]] RuntimeStatsSnapshot runtimeStats() const;

  /// Cancel the admission identified by (`seqId`, `admissionId`): frees the
  /// per-slot sampler and KV-cache entries and fires onDone with
  /// `Cancelled`. `admissionId` is the ownership token onAdmitted handed
  /// out for this admission; a slot whose current admission id differs
  /// (the targeted request already finished and the seqId was recycled)
  /// is left untouched -- the cancel quietly no-ops. Ownership is checked
  /// when the cancel is requested (cross-thread calls) and re-checked when
  /// a deferred cancel is applied, so a stale cancel can never land on the
  /// slot's next occupant. While the worker thread is running, the
  /// cancellation is only recorded and applied by the worker between
  /// decode steps -- the worker releases `mutex_` across `llama_decode`,
  /// so mutating the shared `llama_context` from the calling thread would
  /// race the in-flight decode. Applied synchronously when no worker has
  /// been started.
  ///
  /// Safe to call from the scheduler's own streaming callbacks
  /// (onToken/onAdmitted/onDone run on the worker thread with `mutex_`
  /// held): a call on the worker thread never takes `mutex_`, it only
  /// records the cancel for the worker's next teardown reconciliation.
  /// @return whether the targeted admission was still live when the cancel
  /// was issued; a worker-thread call cannot check that (no lock) and
  /// always returns true -- the recorded cancel no-ops later if the
  /// admission is already gone.
  bool cancel(uint32_t seqId, uint64_t admissionId);

  /// Settle the group tagged @p groupTag when it still has requests waiting in
  /// `pending_`, so cancelling it does not have to wait for a *foreign* group
  /// to release the slots those requests need. `cancel(seqId, admissionId)`
  /// only reaches admitted requests, and `pending_` is FIFO across groups with
  /// no selective removal, so without this a fully-queued group is settled only
  /// when it is eventually admitted and refused — arbitrarily far in the
  /// future, with its caller's cancel blocked for the whole wait.
  ///
  /// A group whose every request already holds a slot is left alone: slot
  /// teardown reaches all of it, and that path keeps the documented graceful
  /// partial-output cancel. Stale `pending_` entries are not removed; the
  /// group is marked done and `admitPendingIntoFreeSlotsLocked` discards them
  /// when it next dequeues, so no request can run after this.
  ///
  /// Same threading contract as `cancel(seqId, admissionId)`: safe from the
  /// worker's own streaming callbacks (records only, no lock), applied by the
  /// worker between decode steps otherwise, synchronous when no worker runs.
  /// @return whether the tag named a live group when the cancel was issued; a
  /// worker-thread call cannot check that (no lock) and always returns true --
  /// the recorded cancel no-ops later if the group is already gone. Always
  /// false for tag 0, which is the untagged sentinel.
  bool cancelGroupQueued(uint64_t groupTag);

  void requestCancelAll();

  /// Cancel every active request. Deferred to the worker thread when it
  /// is running, for the same reason as `cancel(seqId)`.
  void clear();

  /// Decode function used by stepLocked() (defaults to llama_decode), context
  /// synchronization used before recording decode/media step time (defaults to
  /// llama_synchronize), and media-segment eval used by
  /// serviceNextMediaSegmentLocked() (defaults to driver.evalMediaSegment()).
  /// Unit tests override decode/media through ContinuousBatchSchedulerTestPeer.
  using DecodeFunc = SchedulerDecodeFunc;
  using SynchronizeFunc = SchedulerSynchronizeFunc;
  using EvalMediaFunc =
      std::function<llama_pos(SequenceDriver&, size_t, llama_pos)>;

private:
  // Test peer (global namespace) sets decodeFunc_ and evalMediaFunc_ directly.
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

  /// RAII that suspends deferred-teardown application while a step has
  /// dropped `mutex_` around work that owns a specific slot.
  ///
  /// `StepUnlockGuard` reconciles teardown on every reacquisition, which is
  /// exactly right for the decode and media-eval windows: they touch no slot
  /// the teardown could pull out from under them. It is wrong for the
  /// finalize window in `drainFinishedLocked`, which holds a reference into
  /// `slots_` across the unlock. A cancel recorded during that window still
  /// passes `slotOwnedByLocked` (the slot keeps its `admissionId` until
  /// `freeSlot`, and `extractFinished` only removed it from the batcher), so
  /// the reconcile would run `onCancel` on a driver mid-finalize and free the
  /// slot the loop is still using.
  ///
  /// Suspending leaves every record queued: `applyDeferredTeardownLocked`
  /// returns before it swaps the pending vectors out, and `clearRequested_`
  /// stays set. The worker applies them at its loop top once the step
  /// returns, where the apply-time ownership re-check drops the ones whose
  /// slot has since been freed.
  class TeardownDeferGuard {
  public:
    explicit TeardownDeferGuard(ContinuousBatchScheduler& scheduler) noexcept
        : scheduler_(scheduler) {
      scheduler_.teardownDeferred_ = true;
    }
    ~TeardownDeferGuard() noexcept { scheduler_.teardownDeferred_ = false; }
    TeardownDeferGuard(const TeardownDeferGuard&) = delete;
    TeardownDeferGuard& operator=(const TeardownDeferGuard&) = delete;
    TeardownDeferGuard(TeardownDeferGuard&&) = delete;
    TeardownDeferGuard& operator=(TeardownDeferGuard&&) = delete;

  private:
    ContinuousBatchScheduler& scheduler_;
  };

  struct BatchGroup {
    explicit BatchGroup(size_t requestCount)
        : outputs(requestCount), requestStats(requestCount) {}

    std::vector<std::string> outputs;
    std::vector<ObservedRequestStats> requestStats;
    RuntimeStatsSnapshot stats;
    size_t completedCount = 0;
    size_t totalCount = 0;
    /// Requests of this group that have reached a slot. `< totalCount` means
    /// some are still queued in `pending_`, i.e. a targeted cancel cannot
    /// reach them through slot teardown alone (see cancelGroupQueued).
    size_t admittedCount = 0;
    /// The submitter's opaque handle for this group, used to target it while
    /// it may still be entirely queued. 0 when untagged.
    uint64_t tag = 0;
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
    std::unique_ptr<SequenceDriver> driver;
    std::string cacheKey;
    std::shared_ptr<BatchGroup> group;
    size_t outputIndex = 0;
    bool saveCacheToDisk = false;
    bool activeCacheSavedToDisk = false;
    bool prefillOnly = false;
    /// Carried from SubmitRequest so the drain can compute observed stats.
    std::chrono::steady_clock::time_point enqueuedAt{};
    /// Ownership token for this admission, strictly incrementing across the
    /// scheduler's lifetime and never `K_UNKNOWN_ADMISSION_ID`. `cancel()`
    /// only tears the slot down when the caller presents this exact id, so
    /// a cancel aimed at a finished request cannot hit the recycled seqId's
    /// next occupant.
    uint64_t admissionId = K_UNKNOWN_ADMISSION_ID;
  };

  void ensureWorkerStartedLocked();
  void workerLoop();
  void admitPendingIntoFreeSlotsLocked();
  [[nodiscard]] uint32_t submitLocked(QueuedRequest&& queued);
  /// Drives one fillBatch + decode + advance + sample iteration.
  /// Returns `true` on a successful decode *or* a no-op (no slot had
  /// tokens to feed). Returns `false` if `llama_decode` reported a
  /// non-zero rc; in that case every still-active slot has already
  /// been finalised with `StopReason::DecodeError`, KV-cleared, and
  /// drained, so the caller's only obligation is to break out of its
  /// driving loop.
  [[nodiscard]] bool stepLocked(std::unique_lock<std::mutex>* lock = nullptr);
  /// Evaluate the head media barrier of one awaiting slot (lowest seqId)
  /// via its driver, unlocking around the embedded `llama_decode`. A
  /// media failure only fails that slot's request, never the whole
  /// scheduler.
  void serviceNextMediaSegmentLocked(std::unique_lock<std::mutex>* lock);
  void failSlotLocked(uint32_t seqId, std::exception_ptr error);
  [[nodiscard]] MultiRequestBatcher::PrefillCompleteFn prefillCompleteFn();
  /// Extract finished requests and run the full per-slot drain (terminal
  /// driver hook with output flushing, stats, cache save, KV clear). A
  /// cache-save throw is contained per slot: it fails only that slot's
  /// group (via failSlotLocked), never the sibling slots decoding for
  /// other groups.
  void drainFinishedLocked(std::unique_lock<std::mutex>* lock);
  [[nodiscard]] bool hasWorkLocked() const noexcept;
  [[nodiscard]] unsigned numActiveLocked() const noexcept;
  /// One deferred targeted cancel, kept as the full (seqId, admissionId)
  /// identity so the apply side can re-validate ownership: the slot may
  /// have drained and been re-admitted between record and apply.
  struct PendingSlotCancel {
    uint32_t seqId = 0;
    uint64_t admissionId = K_UNKNOWN_ADMISSION_ID;
  };

  /// Append one deferred per-slot cancel under `pendingCancelsMtx_` only.
  /// The single mutation path shared by worker-thread callers (which must
  /// not touch `mutex_`) and cross-thread callers (which already hold it).
  void recordPendingSlotCancel(uint32_t seqId, uint64_t admissionId);
  /// Same, for a deferred group cancel (see cancelGroupQueued).
  void recordPendingGroupCancel(uint64_t groupTag);
  /// Whether any deferred cancel (per-slot or per-group) is waiting to be
  /// applied by the worker.
  [[nodiscard]] bool hasPendingCancels() const;
  /// Settle a tagged group that still has queued requests. The apply half of
  /// `cancelGroupQueued`, re-resolving the tag because the group may have
  /// finished, or become fully admitted, between record and apply.
  void applyGroupQueuedCancelLocked(uint64_t groupTag) noexcept;
  /// Whether `seqId` currently holds the admission identified by
  /// `admissionId`. False for free slots, out-of-range ids, and slots whose
  /// admission id differs (the seqId was recycled to a newer request).
  [[nodiscard]] bool
  slotOwnedByLocked(uint32_t seqId, uint64_t admissionId) const noexcept;
  void
  completeGroupRequestLocked(const std::shared_ptr<BatchGroup>& group) noexcept;
  void failGroupLocked(
      const std::shared_ptr<BatchGroup>& group,
      std::exception_ptr error) noexcept;
  void cancelPendingLocked();
  void clearLocked() noexcept;
  /// Persistence policy for `cancelSlotLocked`. `Save` is the default and
  /// matches the graceful-cancel semantics that the drain path already
  /// runs: on cancel, `onCancel` rolls the driver back to its admission
  /// cursor and `saveCacheForSlot` persists that rolled-back state so
  /// the caller's `cacheKey` reflects the pre-request warm baseline.
  ///
  /// `Skip` is the error-recovery variant: after an unexpected driver
  /// throw the slot's live memory and logical accounting are already
  /// unhealthy (see e.g. `ReasoningBlockCompactor::compact()`'s hybrid
  /// restore/replay failure path, which wipes the sequence and throws).
  /// Saving in that state would silently overwrite the user's previous
  /// on-disk cache with an inconsistent/empty state, so error-recovery
  /// callers pass `Skip` to preserve the last known-good file.
  enum class SaveCachePolicy { Save, Skip };

  /// Tear down a single slot (cancel path). `noexcept`: callers run it from
  /// the StepUnlockGuard destructor and the worker loop, so the teardown itself
  /// must never throw. Every throwing step (driver finalize + cache save, and
  /// the onDone callback inside notifyDone) is contained; the cleanup tail
  /// (notifyDone/batcher cancel/freeSlot) always runs.
  void cancelSlotLocked(
      uint32_t seqId,
      SaveCachePolicy savePolicy = SaveCachePolicy::Save) noexcept;
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
  void saveCacheForSlot(uint32_t seqId, SlotState& slot);
  void accumulateSlotRuntimeStats(const SlotState& slot, const Request& req);

  LlmModelContext shared_;

  /// Baseline sampling block + n_predict, used when admitting requests
  /// to derive per-request sampling and cap.
  common_params_sampling baseSampling_;
  int baseNPredict_;
  common_params baseParams_;
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
  /// The worker's thread id, set once when it starts (under `mutex_`, so it
  /// is visible to every streaming callback the worker later runs). Lets
  /// cancel() detect a call from the worker's own callbacks -- which hold
  /// `mutex_` -- and record instead of self-deadlocking on it.
  std::atomic<std::thread::id> workerThreadId_{};
  /// Guarded by `pendingCancelsMtx_`, NOT `mutex_`: worker-thread callers
  /// of cancel() (streaming callbacks fired with `mutex_` held) must be able
  /// to record a cancel without touching the scheduler lock. Lock order is
  /// always `mutex_` -> `pendingCancelsMtx_`, never the reverse.
  mutable std::mutex pendingCancelsMtx_;
  std::vector<PendingSlotCancel> pendingSlotCancels_;
  /// Deferred group cancels, same threading rationale as pendingSlotCancels_.
  std::vector<uint64_t> pendingGroupCancels_;
  bool clearRequested_ = false;
  /// Set while a step has dropped `mutex_` around work that owns a slot; see
  /// `TeardownDeferGuard`. Worker-thread only, so it needs no atomicity: the
  /// only writer is the thread holding `mutex_` when the window opens.
  bool teardownDeferred_ = false;
  /// Live tagged groups, so a cancel can find a group that holds no slot yet.
  /// Guarded by `mutex_`; an entry lives exactly as long as its `processBatch`
  /// call. Weak, so a group settled and abandoned by its submitter cannot be
  /// kept alive here. Tags come from the submitter (never reused while live),
  /// so an entry can never be mistaken for a later group.
  std::unordered_map<uint64_t, std::weak_ptr<BatchGroup>> taggedGroups_;
  /// Source of the strictly-incrementing per-admission ownership tokens.
  /// Guarded by `mutex_` (minted inside submitLocked). Starts past
  /// `K_UNKNOWN_ADMISSION_ID` so the sentinel never matches a live slot.
  uint64_t nextAdmissionId_ = K_UNKNOWN_ADMISSION_ID + 1;
  RuntimeStatsSnapshot stats_;

  /// Decode function used in stepLocked(). Defaults to llama_decode; a test
  /// stub can be injected via
  /// ContinuousBatchSchedulerTestPeer::setDecodeFunc().
  DecodeFunc decodeFunc_;

  /// Context synchronization used after a successful decode/media eval and
  /// before recording step time. Defaults to llama_synchronize.
  SynchronizeFunc synchronizeFunc_;

  /// Media-segment eval used in serviceNextMediaSegmentLocked(). Defaults to
  /// driver.evalMediaSegment(); a test stub can be injected via
  /// ContinuousBatchSchedulerTestPeer::setEvalMediaFunc().
  EvalMediaFunc evalMediaFunc_;
};

} // namespace qvac_lib_inference_addon_llama::batching
