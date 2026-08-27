#include "ContinuousBatchScheduler.hpp"

#include <algorithm>
#include <cassert>
#include <chrono>
#include <cstdlib>
#include <exception>
#include <filesystem>
#include <limits>
#include <optional>
#include <ranges>
#include <stdexcept>
#include <system_error>
#include <thread>
#include <unordered_set>
#include <utility>

#include <common/common.h>
#include <inference-addon-cpp/Errors.hpp>
#include <llama.h>

#include "GenerationParamsApply.hpp"
#include "addon/LlmErrors.hpp"
#include "inference-addon-cpp/Logger.hpp"
#include "utils/LoggingMacros.hpp"
#include "utils/ScopeGuard.hpp"

namespace qvac_lib_inference_addon_llama::batching {

using qvac_lib_inference_addon_llama::errors::ADDON_ID;
using namespace qvac_lib_inference_addon_cpp::logger;

namespace {

// Emit a best-effort teardown-failure log that can never throw. Composing the
// message and invoking the logger both allocate (so they may throw, e.g.
// std::bad_alloc); doing that inside this swallowing try is what lets the
// noexcept teardown paths log without risking std::terminate when logging
// itself fails. `detail` may be null when no exception message is available.
void logTeardownFailureNoexcept(
    const char* what, uint32_t seqId, const char* detail) noexcept {
  try {
    std::string msg = std::string("[ContinuousBatch] ") + what + " for seqId " +
                      std::to_string(seqId);
    if (detail != nullptr) {
      msg += ": ";
      msg += detail;
    }
    QLOG_IF(Priority::WARNING, msg);
  } catch (...) {
    // Logging is best-effort; never let a logging failure abort teardown.
  }
}

void logTeardownFailureNoexcept(const char* what) noexcept {
  try {
    QLOG_IF(Priority::WARNING, std::string("[ContinuousBatch] ") + what);
  } catch (...) {
  }
}

bool isFileMissingOrEmpty(const std::filesystem::path& path) {
  std::error_code directoryErrorCode;
  if (std::filesystem::is_directory(path, directoryErrorCode)) {
    return false;
  }

  std::error_code errorCode;
  const auto size = std::filesystem::file_size(path, errorCode);
  if (!errorCode) {
    return size == 0;
  }
  return errorCode == std::errc::no_such_file_or_directory ||
         errorCode == std::errc::not_a_directory;
}

bool isParentDirectoryMissing(const std::filesystem::path& path) {
  const auto parent = path.parent_path();
  if (parent.empty()) {
    return false;
  }

  std::error_code errorCode;
  const bool exists = std::filesystem::exists(parent, errorCode);
  return !errorCode && !exists;
}

bool persistedCacheBackingStoreMissing(const std::string& cacheKey) {
  return isParentDirectoryMissing(cacheKey) || isFileMissingOrEmpty(cacheKey);
}

/// Partition the whole-context KV pool uniformly across slots. Mirrors
/// llama.cpp's `server` example which uses `n_ctx_slot = n_ctx /
/// n_parallel` as the per-sequence hard ceiling.
unsigned perSeqCeiling(unsigned ctxTotalTokens, size_t batchSize) {
  bool valid = ctxTotalTokens > 0 && batchSize > 0;
  if (!valid) {
    throw std::invalid_argument(
        "ContinuousBatchScheduler: ctxTotalTokens and batchSize must be "
        ">= 1");
  }
  return ctxTotalTokens / static_cast<unsigned>(batchSize);
}

/// Terminal reason a driver should record for a scheduler-imposed stop.
/// `ContextOverflow` survives `stopReasonAfterRequestRollback`, so a recurrent
/// driver rolls back its open reasoning span instead of attempting strict
/// compaction.
GenerationStopReason toGenerationStopReason(StopReason reason) {
  switch (reason) {
  case StopReason::ContextOverflow:
    return GenerationStopReason::ContextOverflow;
  default:
    return GenerationStopReason::None;
  }
}

} // namespace

bool finalizeTerminalDriver(
    SequenceDriver& driver, StopReason reason, bool prefillOnly,
    const std::function<void(const std::string&)>& outputCallback) {
  if (reason == StopReason::Cancelled || reason == StopReason::DecodeError) {
    return driver.onCancel(outputCallback);
  }
  if (prefillOnly) {
    driver.onSequenceEnd(outputCallback);
    return true;
  } else {
    return driver.onGenerationFinished(
        outputCallback, toGenerationStopReason(reason));
  }
}

bool generationBudgetExceeded(
    unsigned promptSize, unsigned promptKvSize, int nPredict,
    unsigned perSeqMaxTokens) {
  // promptKvSize >= promptSize always (KV cells >= positions), so the KV-cell
  // span is the binding budget and subsumes the position check.
  const auto budgetSize = std::max(promptSize, promptKvSize);
  return nPredict > 0 &&
         budgetSize + static_cast<unsigned>(nPredict) > perSeqMaxTokens;
}

TimedDecodeResult timeDecodeStep(
    llama_context* ctx, llama_batch& batch, const SchedulerDecodeFunc& decode,
    const SchedulerSynchronizeFunc& synchronize) {
  const auto decodeStart = std::chrono::steady_clock::now();
  const int rc = decode(ctx, batch);
  synchronize(ctx);

  TimedDecodeResult result;
  result.rc = rc;
  result.duration = std::chrono::duration_cast<std::chrono::nanoseconds>(
      std::chrono::steady_clock::now() - decodeStart);
  return result;
}

ContinuousBatchScheduler::ContinuousBatchScheduler(
    LlmModelContext shared, unsigned maxChunkSize, unsigned ctxTotalTokens,
    size_t batchSize, int32_t batchCapacity, const common_params& baseParams,
    DriverFactory driverFactory)
    : shared_(shared), baseSampling_(baseParams.sampling),
      baseNPredict_(baseParams.n_predict), baseParams_(baseParams),
      driverFactory_(std::move(driverFactory)),
      perSeqMaxTokens_(perSeqCeiling(ctxTotalTokens, batchSize)),
      batcher_(maxChunkSize, perSeqMaxTokens_, batchSize),
      batch_(batchCapacity, 0, static_cast<int32_t>(batchSize)),
      slots_(batchSize), decodeFunc_(llama_decode),
      synchronizeFunc_(llama_synchronize),
      evalMediaFunc_(
          [](SequenceDriver& driver, size_t mediaIndex, llama_pos pos) {
            return driver.evalMediaSegment(mediaIndex, pos);
          }) {
  if (!driverFactory_) {
    throw std::invalid_argument(
        "ContinuousBatchScheduler: a driver factory is required (the model "
        "layer owns text-vs-multimodal driver selection)");
  }

  const bool ctxValid = shared_.lctx != nullptr && shared_.model != nullptr &&
                        shared_.vocab != nullptr;
  if (!ctxValid) {
    throw std::invalid_argument(
        "ContinuousBatchScheduler: ctx, model, and vocab must be non-null");
  }
  if (batchCapacity < static_cast<int32_t>(batchSize)) {
    throw std::invalid_argument(
        "ContinuousBatchScheduler: batchCapacity must be >= batchSize so "
        "every active slot can feed at least one token per step");
  }
  const bool perSeqRoom = perSeqMaxTokens_ > 0;
  if (!perSeqRoom) {
    throw std::invalid_argument(
        "ContinuousBatchScheduler: ctxTotalTokens / batchSize underflowed "
        "to 0; reduce batchSize or grow n_ctx");
  }
}

ContinuousBatchScheduler::~ContinuousBatchScheduler() {
  {
    std::scoped_lock lock(mutex_);
    stopping_ = true;
    cancelRequested_.store(true);
  }
  workCv_.notify_all();
  if (worker_.joinable()) {
    worker_.join();
  }
  std::scoped_lock lock(mutex_);
  clearLocked();
}

BatchResult ContinuousBatchScheduler::processBatch(
    std::vector<SubmitRequest>&& requests, const uint64_t groupTag) {
  auto group = std::make_shared<BatchGroup>(requests.size());
  group->totalCount = requests.size();
  group->tag = groupTag;
  if (requests.empty()) {
    return {.outputs = {}, .stats = runtimeStats()};
  }

  std::unique_lock lock(mutex_);
  if (pending_.size_approx() == 0 && !hasWorkLocked()) {
    stats_.reset();
  }
  // Discoverable by tag only while this call is on the stack, so a cancel that
  // arrives before any admission can still settle the group.
  if (groupTag != 0) {
    taggedGroups_[groupTag] = group;
  }
  // Lock-aware so it is correct on every exit: the normal path releases the
  // lock below before unwinding, while a throw from submission (e.g. enqueue
  // running out of memory) unwinds with it still held — re-locking there would
  // self-deadlock.
  ScopeGuard tagGuard([this, groupTag, &lock] {
    if (groupTag == 0) {
      return;
    }
    if (lock.owns_lock()) {
      taggedGroups_.erase(groupTag);
      return;
    }
    std::scoped_lock tagLock(mutex_);
    taggedGroups_.erase(groupTag);
  });
  ensureWorkerStartedLocked();
  for (size_t i = 0; i < requests.size(); i++) {
    pending_.enqueue(
        QueuedRequest{
            .request = std::move(requests[i]),
            .group = group,
            .outputIndex = i});
  }
  workCv_.notify_all();
  workCv_.wait(lock, [&group] { return group->done; });
  // Released before the guard re-locks it to erase the tag.
  lock.unlock();
  if (group->error) {
    std::rethrow_exception(group->error);
  }
  return {
      .outputs = std::move(group->outputs),
      .stats = group->stats,
      .requestStats = std::move(group->requestStats)};
}

uint32_t ContinuousBatchScheduler::submit(SubmitRequest&& request) {
  std::scoped_lock lock(mutex_);
  return submitLocked(
      QueuedRequest{.request = std::move(request), .group = nullptr});
}

void ContinuousBatchScheduler::ensureWorkerStartedLocked() {
  if (!workerStarted_) {
    workerStarted_ = true;
    worker_ = std::thread([this] { workerLoop(); });
    // Published while still holding mutex_: the worker's first action is to
    // acquire that mutex, so every callback it later runs observes the id.
    workerThreadId_.store(worker_.get_id());
  }
}

void ContinuousBatchScheduler::workerLoop() {
  std::unique_lock lock(mutex_);
  while (true) {
    workCv_.wait(lock, [this] {
      return stopping_ || cancelRequested_.load() || hasPendingCancels() ||
             clearRequested_ || pending_.size_approx() > 0 || hasWorkLocked();
    });
    if (stopping_) {
      break;
    }
    applyDeferredTeardownLocked();
    if (cancelRequested_.load() && !hasWorkLocked()) {
      cancelPendingLocked();
      cancelRequested_.store(false);
      continue;
    }
    admitPendingIntoFreeSlotsLocked();
    if (!hasWorkLocked()) {
      continue;
    }
    try {
      const bool stepOk = stepLocked(&lock);
      (void)stepOk;
    } catch (...) {
      // Unexpected internal error: a throw mid-step can leave slot state
      // inconsistent, so the only safe recovery is to fail all and clear.
      const std::exception_ptr error = std::current_exception();
      for (const auto& slot : slots_) {
        if (slot.has_value() && slot->group) {
          failGroupLocked(slot->group, error);
        }
      }
      QueuedRequest queued;
      while (pending_.try_dequeue(queued)) {
        if (queued.group) {
          failGroupLocked(queued.group, error);
        }
      }
      clearLocked();
      cancelRequested_.store(false);
    }
    // A cancel-all observed during the step above already finished the
    // active slots (stepLocked marks them Cancelled). It must NOT be
    // followed by admitting `pending_`: those queued prompts belong to the
    // cancelled work and would otherwise start running post-cancel. Drain
    // them here instead so cancel-all atomically covers active + queued.
    applyDeferredTeardownLocked();
    if (cancelRequested_.exchange(false)) {
      cancelPendingLocked();
    } else {
      admitPendingIntoFreeSlotsLocked();
    }
  }
  cancelPendingLocked();
  clearLocked();
}

void ContinuousBatchScheduler::admitPendingIntoFreeSlotsLocked() {
  QueuedRequest queued;
  while (batcher_.firstFreeSeqId().has_value() &&
         pending_.try_dequeue(queued)) {
    const std::shared_ptr<BatchGroup> group = queued.group;
    // already-failed/cancelled also skipped as group is `done`
    if (group && group->done) {
      continue;
    }
    try {
      const uint32_t seqId = submitLocked(std::move(queued));
      (void)seqId;
    } catch (...) {
      failGroupLocked(group, std::current_exception());
    }
  }
}

uint32_t ContinuousBatchScheduler::submitLocked(QueuedRequest&& queued) {
  SubmitRequest& request = queued.request;
  // Resolve per-request sampling/cap on a *local* common_params, reusing
  // applyGenerationParamsToContext's validation without touching context
  // state. Its restore lambda is discarded: destroying a std::function only
  // drops captures (never runs the body), so this is safe — but the lambda
  // must NOT be called here, as its captured references would dangle.
  common_params tmpParams = baseParams_;
  tmpParams.sampling = baseSampling_;
  tmpParams.n_predict = baseNPredict_;
  CommonSamplerPtr overrideSampler;
  const bool hasOverrides = request.overrides.hasOverrides();
  if (hasOverrides) {
    // May throw `StatusError(InvalidArgument)` for malformed
    // json_schema or grammars rejected by `common_sampler_init`;
    // propagated to the caller, mirroring single-prompt behaviour.
    [[maybe_unused]] auto discardedRestore = applyGenerationParamsToContext(
        tmpParams, overrideSampler, shared_.model, request.overrides);
  }

  // n_predict is the per-request generation budget; `<=0` means "no
  // scheduler cap, batcher's maxTokensPerSequence ceiling wins". That
  // ceiling is a hard invariant of the partitioned KV pool: an overrun is
  // an admit-time error (below), never a silent clamp.
  const auto maybeSeqId = batcher_.firstFreeSeqId();
  if (!maybeSeqId.has_value()) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        "ContinuousBatchScheduler::submit: failed to add to batch "
        "(MultiRequestBatcher::AddStatus=" +
            std::to_string(
                static_cast<int>(
                    MultiRequestBatcher::AddStatus::ErrNoFreeSlot)) +
            ")");
  }
  const uint32_t seqId = *maybeSeqId;
  // The batcher frees its slot in `extractFinished`, which runs BEFORE
  // `drainFinishedLocked` finalizes that seqId, and that finalize holds a
  // reference into `slots_` across an unlock window. Re-admitting here would
  // `emplace` over the `SlotState` it is still using. Treat a scheduler slot
  // that has not been freed yet as occupied.
  if (slots_[seqId].has_value()) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        "ContinuousBatchScheduler::submit: failed to add to batch "
        "(MultiRequestBatcher::AddStatus=" +
            std::to_string(
                static_cast<int>(
                    MultiRequestBatcher::AddStatus::ErrNoFreeSlot)) +
            ")");
  }
  std::unique_ptr<SequenceDriver> driver = driverFactory_(
      tmpParams, seqId, static_cast<llama_pos>(perSeqMaxTokens_));

  // `applyGenerationParamsToContext` above resolves the sampling/n_predict/
  // reasoning_budget overrides into `tmpParams` (which the driver copies),
  // but `remove_thinking_from_context` is a TextLlmContext-level toggle that
  // sits outside `common_params`. Apply it directly to the slot driver here.
  // No restore needed: the driver is destroyed when the slot is freed.
  if (request.overrides.remove_thinking_from_context) {
    driver->setRemoveThinkingFromContext(
        *request.overrides.remove_thinking_from_context);
  }

  const bool isCacheLoaded = driver->loadCache(request.cacheKey);

  ScopeGuard cacheGuard([this, seqId] { clearSeqKv(seqId); });

  // `json_schema` / `tool_choice` shape the chat-template render, not the
  // sampler, so they travel separately from the `tmpParams` overrides above.
  driver->setRenderOverrides(renderOverridesFrom(request.overrides));

  PrefillPlan plan = driver->preparePrefill(
      request.chatMsgs,
      request.tools,
      request.media,
      request.mediaPlan,
      isCacheLoaded,
      request.prefill);

  // Anchored post-`preparePrefill` so the cursor reflects any position
  // change preparation made. `TextLlmContext::evalMessageWithTools`
  // takes the same anchor after its own `preparePrefill`.
  driver->snapshotPreRequestCursor();
  // Hybrid / recurrent full-state disk snapshot for cancel rollback
  // (their memory rejects partial `seq_rm`). No-op for pure-attention.
  driver->snapshotPreRequestRollbackAnchor();

  const auto promptSize = static_cast<unsigned>(driver->getNPast()) +
                          static_cast<unsigned>(plan.totalPositions());
  // M-RoPE media consumes more KV cells than positions; the cells must also
  // fit under the per-sequence cap or the slot's KV-cache overruns. Size this
  // from the physical KV-cell usage (getKvCellsUsed), which for a cache-loaded
  // M-RoPE sequence exceeds getNPast(); they coincide for text.
  const auto promptKvSize = static_cast<unsigned>(driver->getKvCellsUsed()) +
                            static_cast<unsigned>(plan.totalKvTokens());
  if (promptKvSize > perSeqMaxTokens_) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        "ContinuousBatchScheduler::submit: prompt of " +
            std::to_string(promptKvSize) +
            " KV cells exceeds per-sequence cap " +
            std::to_string(perSeqMaxTokens_) +
            " (ctxTotalTokens / n_parallel)");
  }
  if (!request.prefill && promptSize >= perSeqMaxTokens_) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        "ContinuousBatchScheduler::submit: prompt of " +
            std::to_string(promptSize) +
            " tokens leaves no room under "
            "per-sequence cap " +
            std::to_string(perSeqMaxTokens_) +
            " (ctxTotalTokens / n_parallel)");
  }
  if (request.prefill && promptSize > perSeqMaxTokens_) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        "ContinuousBatchScheduler::submit: prefill prompt of " +
            std::to_string(promptSize) + " tokens exceeds per-sequence cap " +
            std::to_string(perSeqMaxTokens_) +
            " (ctxTotalTokens / n_parallel)");
  }
  if (!request.prefill &&
      generationBudgetExceeded(
          promptSize, promptKvSize, tmpParams.n_predict, perSeqMaxTokens_)) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        "ContinuousBatchScheduler::submit: n_predict " +
            std::to_string(tmpParams.n_predict) + " + prompt " +
            std::to_string(promptKvSize) +
            " KV cells exceeds per-sequence cap " +
            std::to_string(perSeqMaxTokens_) +
            " (ctxTotalTokens / n_parallel)");
  }

  StreamCallbacks streamsLocal = std::move(request.streams);
  if (auto status = batcher_.addRequestAt(
          seqId, std::move(plan), driver->getNPast(), driver->getKvCellsUsed());
      status != MultiRequestBatcher::AddStatus::Ok) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        "ContinuousBatchScheduler::submit: failed to add to batch "
        "(MultiRequestBatcher::AddStatus=" +
            std::to_string(static_cast<int>(status)) + ")");
  }
  const uint64_t admissionId = nextAdmissionId_++;
  // Counted before the slot is installed so a group is never briefly seen as
  // "has queued requests" once its last one has a slot — that is the gate
  // cancelGroupQueued uses to decide between settling the group and leaving it
  // to graceful slot teardown.
  if (queued.group) {
    queued.group->admittedCount++;
  }
  slots_[seqId].emplace(
      SlotState{
          .streams = std::move(streamsLocal),
          .driver = std::move(driver),
          .cacheKey = std::move(request.cacheKey),
          .group = std::move(queued.group),
          .outputIndex = queued.outputIndex,
          .saveCacheToDisk = request.saveCacheToDisk,
          .activeCacheSavedToDisk = isCacheLoaded,
          .prefillOnly = request.prefill,
          .enqueuedAt = request.enqueuedAt,
          .admissionId = admissionId});
  cacheGuard.dismiss();
  // A true return means the caller already holds a cancel for this request:
  // tear the slot down before it ever decodes.
  if (slots_[seqId]->streams.onAdmitted &&
      slots_[seqId]->streams.onAdmitted(seqId, admissionId)) {
    // The request was cancelled while still queued, so it never produced
    // anything. A multi-prompt group settles as Cancelled — the terminal
    // cancelPendingLocked gives a queued drop, and what the README documents
    // for cancelling a batch that contained queued prompts — instead of
    // quietly completing the group as a success with empty outputs. A lone
    // request keeps the graceful empty-output cancel the single-job contract
    // pins: its caller cannot tell a refusal here from a cancel that landed
    // during prefill, and the latter must not throw.
    if (slots_[seqId]->group && slots_[seqId]->group->totalCount > 1) {
      failGroupLocked(
          slots_[seqId]->group,
          std::make_exception_ptr(
              qvac_errors::StatusError(
                  ADDON_ID,
                  qvac_lib_inference_addon_llama::errors::toString(
                      qvac_lib_inference_addon_llama::errors::Cancelled),
                  "ContinuousBatchScheduler: request cancelled before it "
                  "could run (queued behind the parallel limit when its "
                  "group was cancelled)")));
    }
    // Not covered by failGroupLocked when the group was already settled by
    // an earlier refusal (its early-out skips the teardown loop), so tear
    // this slot down explicitly; a double teardown is a no-op (slot freed).
    cancelSlotLocked(seqId);
  }
  return seqId;
}

std::function<bool(const Request&)>
ContinuousBatchScheduler::hasValidDriverF() const {
  return [this](const Request& req) {
    return slots_[req.seqId].has_value() && slots_[req.seqId]->driver;
  };
}

std::function<void(const std::string&)>
ContinuousBatchScheduler::getOutputCallback(SlotState& slot, uint32_t seqId) {
  return [&slot, seqId](const std::string& text) {
    if (slot.group) {
      slot.group->outputs[slot.outputIndex] += text;
    }
    if (slot.streams.onToken) {
      slot.streams.onToken(seqId, text);
    }
  };
}

void ContinuousBatchScheduler::finalizeFinishedSequences() {
  auto finished = batcher_.extractFinished();
  for (const auto& req : finished) {
    if (hasValidDriverF()(req)) {
      auto& slot = *slots_[req.seqId];
      // Sync the driver's live KV cursor to the batcher's authoritative
      // `req.currentPos` before finalize so `onCancel` (called for
      // Cancelled / DecodeError) computes the correct tail trim on
      // pure-attention drivers. Without this a mid-prefill cancel /
      // decode-error leaves the driver's `nPast_` at the admission
      // cursor while live KV holds the partial prefill, so `onCancel`
      // under-trims by `req.currentPos - preRequestNPast` cells and
      // any subsequent save serialises a KV span wider than the
      // metadata's `nPast`.
      slot.driver->syncPosition(req.currentPos);
      // Rollback-ok signal is intentionally discarded here: this path
      // is the scheduler-teardown drain and does not persist cache.
      (void)finalizeTerminalDriver(
          *slot.driver, req.stopReason, slot.prefillOnly, {});
    }
    clearSeqKv(req.seqId);
    notifyDone(req.seqId);
    freeSlot(req.seqId);
  }
}

MultiRequestBatcher::PrefillCompleteFn
ContinuousBatchScheduler::prefillCompleteFn() {
  // A throw from `onPrefillComplete` (e.g. from the recurrent
  // boundary-snapshot capture site inside `snapshotForRecurrentRollback`
  // under the uniform hard-fail contract for
  // `remove_thinking_from_context`) propagates through
  // `batcher_.advance` / `batcher_.completeMediaBarrier` and is caught
  // by the `try` block in `workerLoop`, which then routes the affected
  // group through `failGroupLocked` -> `cancelSlotLocked(Skip)`. That
  // keeps saveCache off (last known-good on-disk cache preserved) and
  // clears the seq KV before the slot is freed. No scheduler code
  // change is needed here; this comment pins the invariant so a future
  // refactor doesn't accidentally introduce a swallow-and-continue
  // path.
  return
      [this](uint32_t seqId, llama_pos currentPos, size_t prefillTokenCount) {
        auto& slot = slots_[seqId];
        if (!slot.has_value() || !slot->driver) {
          throw qvac_errors::StatusError(
              ADDON_ID,
              qvac_errors::general_error::toString(
                  qvac_errors::general_error::InternalError),
              "ContinuousBatchScheduler::step: missing sequence driver for "
              "prefill-complete seqId " +
                  std::to_string(seqId));
        }
        slot->driver->onPrefillComplete(currentPos, prefillTokenCount);
        if (slot->prefillOnly) {
          batcher_.markFinished(seqId);
        }
      };
}

void ContinuousBatchScheduler::clearSeqKv(uint32_t seqId) noexcept {
  auto* mem = llama_get_memory(shared_.lctx);
  if (mem != nullptr) {
    llama_memory_seq_rm(mem, static_cast<llama_seq_id>(seqId), -1, -1);
  }
}

void ContinuousBatchScheduler::failSlotLocked(
    uint32_t seqId, std::exception_ptr error) {
  auto& slot = slots_[seqId];
  if (!slot.has_value()) {
    return;
  }
  if (slot->group) {
    failGroupLocked(slot->group, error);
    return;
  }
  if (slot->driver) {
    // Same rationale as cancelSlotLocked/drainFinishedLocked: sync the
    // driver cursor to the batcher's `currentPos` before onCancel so a
    // mid-prefill failure trims the exact partial-prefill KV span. When
    // there is no admitted request (`req == nullptr`) the driver's own
    // cursor is authoritative and we leave it untouched.
    const Request* req = batcher_.requestAt(seqId);
    if (req != nullptr) {
      slot->driver->syncPosition(req->currentPos);
    }
    // Rollback-ok signal is intentionally discarded: this failure path
    // never persists cache (no `saveCacheForSlot` below) — a subsequent
    // `batcher_.cancel` wipes the sequence via `clearSeqKv`.
    (void)slot->driver->onCancel({});
    if (req != nullptr) {
      accumulateSlotRuntimeStats(*slot, *req);
    }
  }
  notifyDoneNoexcept(seqId);
  batcher_.cancel(seqId, [this](uint32_t sid) { clearSeqKv(sid); });
  freeSlot(seqId);
}

ContinuousBatchScheduler::StepUnlockGuard::StepUnlockGuard(
    ContinuousBatchScheduler& scheduler, std::unique_lock<std::mutex>* lock)
    : scheduler_(scheduler), lock_(lock) {
  if (lock_ != nullptr) {
    lock_->unlock();
  }
}

ContinuousBatchScheduler::StepUnlockGuard::~StepUnlockGuard() noexcept {
  if (lock_ != nullptr) {
    // applyDeferredTeardownLocked() is noexcept, so the teardown below cannot
    // throw. The re-acquire can: std::mutex::lock() may raise std::system_error
    // on an unrecoverable lock failure (the OS failing to meet its
    // pthread_mutex_lock specification for an initialised normal mutex). If it
    // does, the scheduler's only mutex is gone and we are NOT holding it, so
    // letting it propagate would hand a lock-free, mid-teardown state to the
    // worker's catch handler -- which assumes the lock is held and would race
    // concurrent cancel()/submit() before hitting a UB wait() on an unowned
    // lock. Stop cleanly at the point of failure instead: log and abort.
    try {
      lock_->lock();
    } catch (const std::system_error& e) {
      // Composing/emitting the message can itself throw (allocation); swallow
      // that so abort() always runs.
      try {
        QLOG_IF(
            Priority::ERROR,
            std::string(
                "[ContinuousBatch] fatal: unrecoverable failure "
                "reacquiring scheduler mutex, aborting: ") +
                e.what());
      } catch (...) {
      }
      std::abort();
    }
    scheduler_.applyDeferredTeardownLocked();
  }
}

void ContinuousBatchScheduler::serviceNextMediaSegmentLocked(
    std::unique_lock<std::mutex>* lock) {
  const auto awaiting = batcher_.nextAwaitingMedia();
  if (!awaiting.has_value()) {
    return;
  }
  auto& slot = slots_[awaiting->seqId];
  if (!slot.has_value() || !slot->driver) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InternalError),
        "ContinuousBatchScheduler::step: missing sequence driver for "
        "media-awaiting seqId " +
            std::to_string(awaiting->seqId));
  }

  SequenceDriver& driver = *slot->driver;
  llama_pos newPos = awaiting->currentPos;
  std::exception_ptr error;
  std::chrono::steady_clock::duration evalDuration{};
  {
    StepUnlockGuard unlockGuard(*this, lock);
    const auto evalStart = std::chrono::steady_clock::now();
    try {
      newPos =
          evalMediaFunc_(driver, awaiting->mediaIndex, awaiting->currentPos);
      // Media eval can run embedded llama_decode work without a logits read.
      // Synchronize before stopping the timer and before deferred teardown can
      // reacquire the context, matching the main decode-step boundary.
      synchronizeFunc_(shared_.lctx);
    } catch (...) {
      error = std::current_exception();
      try {
        synchronizeFunc_(shared_.lctx);
      } catch (const std::exception& e) {
        logTeardownFailureNoexcept(
            "media eval error-path synchronize failed",
            awaiting->seqId,
            e.what());
      } catch (...) {
        logTeardownFailureNoexcept(
            "media eval error-path synchronize failed",
            awaiting->seqId,
            nullptr);
      }
    }
    evalDuration = std::chrono::steady_clock::now() - evalStart;
  }

  if (error) {
    failSlotLocked(awaiting->seqId, error);
    return;
  }
  assert(
      newPos >= awaiting->currentPos &&
      "media segment must not move the sequence position backwards");
  const auto mediaPositions =
      static_cast<uint64_t>(newPos - awaiting->currentPos);
  stats_.recordDecodeStep(
      numActiveLocked(),
      mediaPositions,
      0,
      std::chrono::duration_cast<std::chrono::nanoseconds>(evalDuration));
  batcher_.completeMediaBarrier(awaiting->seqId, newPos, prefillCompleteFn());
}

void ContinuousBatchScheduler::drainFinishedLocked(
    std::unique_lock<std::mutex>* lock) {
  auto finished = batcher_.extractFinished();
  for (const auto& req : finished | std::views::filter(hasValidDriverF())) {
    auto& slot = *slots_[req.seqId];
    auto outputCallback = getOutputCallback(slot, req.seqId);
    // Align the driver's KV cursor with the batcher's authoritative
    // `req.currentPos` before finalize. On pure-attention drivers a
    // mid-prefill cancel or decode-error otherwise leaves `nPast_` at
    // the admission cursor while live KV holds the partial prefill;
    // `onCancel` would then under-trim (delta collapses to zero) and
    // the subsequent `saveCacheForSlot` would serialise a KV span
    // wider than the persisted `nPast` metadata. Successful-completion
    // paths already sync via `sampleAndAppendIdle` and this call is a
    // no-op for them.
    slot.driver->syncPosition(req.currentPos);
    // `finalizeTerminalDriver` can run a real `llama_decode`: a reasoning
    // turn rewinds and replays through `compactThinkSpan()`. Holding the lock
    // for that stalls every co-tenant slot and blocks a cross-thread
    // `cancel()`.
    //
    // Unlike the decode window this one holds `slot` across the unlock, so
    // deferred teardown must not reconcile inside it, see
    // `TeardownDeferGuard`. Declaration order matters: the unlock guard is
    // destroyed first, so it reacquires while the defer guard is still live.
    bool rollbackOk = false;
    {
      TeardownDeferGuard deferTeardown(*this);
      StepUnlockGuard unlockGuard(*this, lock);
      rollbackOk = finalizeTerminalDriver(
          *slot.driver, req.stopReason, slot.prefillOnly, outputCallback);
    }
    accumulateSlotRuntimeStats(slot, req);
    // Skip save when the driver reports a failed cancel rollback: live
    // state may not match `getNPast()` and persisting it would leak the
    // cancelled request into the on-disk cache. The last known-good
    // cache from a prior turn is preserved. The subsequent
    // `clearSeqKv` still wipes the sequence in memory.
    //
    // A failed disk save (e.g. unwritable cacheKey) is the finishing
    // request's own error, not the scheduler's: nothing shared is corrupted
    // by a failed file write, so it must fail only this slot's group.
    // Letting it escape to workerLoop's catch would tear down every
    // in-flight slot and drain the whole queue with an error naming this
    // request's cacheKey. failSlotLocked routes a grouped slot through
    // failGroupLocked (settling the whole group -- one job -- with this
    // error, `SaveCachePolicy::Skip` on its remaining slots) and frees the
    // slot either way; the loop below still clears this seqId's KV.
    if (rollbackOk) {
      try {
        saveCacheForSlot(req.seqId, *slots_[req.seqId]);
      } catch (...) {
        failSlotLocked(req.seqId, std::current_exception());
      }
    }
  }
  for (const auto& req : finished) {
    clearSeqKv(req.seqId);
    notifyDone(req.seqId);
    freeSlot(req.seqId);
  }
}

bool ContinuousBatchScheduler::stepLocked(std::unique_lock<std::mutex>* lock) {
  serviceNextMediaSegmentLocked(lock);

  const auto fillResult = batcher_.fillBatch(batch_);
  if (fillResult.chunkSize == 0) {
    // A media segment serviced above can finish a slot (prefill-only
    // request or per-sequence cap) without leaving tokens to feed; drain
    // here or the worker would spin on the occupied slot forever.
    drainFinishedLocked(lock);
    return true;
  }

  int decodeRc = 0;
  std::chrono::steady_clock::duration decodeDuration{};
  {
    StepUnlockGuard unlockGuard(*this, lock);
    const TimedDecodeResult decodeTiming =
        timeDecodeStep(shared_.lctx, *batch_, decodeFunc_, synchronizeFunc_);
    decodeRc = decodeTiming.rc;
    decodeDuration = decodeTiming.duration;
  }

  if (decodeRc != 0) {
    batcher_.markAllFinished(StopReason::DecodeError);

    std::unordered_set<std::shared_ptr<BatchGroup>> affectedGroups;
    for (uint32_t seqId = 0; seqId < slots_.size(); seqId++) {
      if (slots_[seqId].has_value() && slots_[seqId]->group) {
        affectedGroups.insert(slots_[seqId]->group);
      }
    }

    auto decodeError = std::make_exception_ptr(
        qvac_errors::StatusError(
            ADDON_ID,
            qvac_lib_inference_addon_llama::errors::toString(
                qvac_lib_inference_addon_llama::errors::FailedToDecode),
            "llama_decode returned non-zero: " + std::to_string(decodeRc)));

    for (const auto& group : affectedGroups) {
      failGroupLocked(group, decodeError);
    }

    return false;
  }
  const unsigned numGenerating =
      fillResult.numActiveSequences - fillResult.numPrefillingSequences;
  const unsigned prefillTokens =
      fillResult.chunkSize * fillResult.numPrefillingSequences;
  const unsigned decodeTokens = fillResult.chunkSize * numGenerating;
  stats_.recordDecodeStep(
      fillResult.numActiveSequences,
      prefillTokens,
      decodeTokens,
      std::chrono::duration_cast<std::chrono::nanoseconds>(decodeDuration));

  batcher_.advance(fillResult.chunkSize, prefillCompleteFn());

  if (!cancelRequested_.load()) {
    batcher_.sampleAndAppendIdle([this](uint32_t seqId, int logitIdx) {
      auto& slot = slots_[seqId];
      const Request* req = batcher_.requestAt(seqId);
      if (!slot.has_value() || !slot->driver || req == nullptr) {
        throw qvac_errors::StatusError(
            ADDON_ID,
            qvac_errors::general_error::toString(
                qvac_errors::general_error::InternalError),
            "ContinuousBatchScheduler::step: missing slot or request "
            "state for active seqId " +
                std::to_string(seqId));
      }
      const unsigned generatedAfterAccept =
          static_cast<unsigned>(req->generatedTokens.size()) + 1u;
      auto outputCallback = [&slot, seqId](const std::string& text) {
        if (slot->group) {
          slot->group->outputs[slot->outputIndex] += text;
        }
        if (slot->streams.onToken) {
          slot->streams.onToken(seqId, text);
        }
      };
      slot->driver->syncPosition(req->currentPos);
      const SequenceStepResult result = slot->driver->onLogitsReady(
          logitIdx, generatedAfterAccept, outputCallback);
      // The batch path passes no `inlineDecodeBatch` to `onLogitsReady`, so
      // the driver must not have advanced its KV position outside of the
      // tokens the scheduler tracks via `Request::currentPos`. Fail loudly
      // if a future driver change starts inline-decoding from this path,
      // since the next `syncPosition` would silently desync KV positions.
      if (result.decodedInline) {
        throw qvac_errors::StatusError(
            ADDON_ID,
            qvac_errors::general_error::toString(
                qvac_errors::general_error::InternalError),
            "ContinuousBatchScheduler::step: driver reported decodedInline "
            "on the batch path (seqId " +
                std::to_string(seqId) +
                "); inline decoding is not supported by the batcher's "
                "position tracking");
      }
      if (result.contextOverflow) {
        // The slot's window is full; stop this one sequence instead of
        // failing the whole batch. Carry the driver's own reason through so
        // the caller can tell a full context from a prediction-limit cutoff.
        batcher_.markFinished(seqId, StopReason::ContextOverflow);
      } else if (
          result.finished &&
          result.stopReason == GenerationStopReason::PredictionLimit) {
        // Carried through for the same reason `ContextOverflow` is: the
        // batcher cannot otherwise tell this sample from an EOG, and the two
        // are counted differently.
        batcher_.markFinished(seqId, StopReason::PredictionLimit);
      } else if (result.finished) {
        batcher_.markFinished(seqId);
      }
      return result.token;
    });
  }

  // Cancel the active slots in-step (so onCancel/saveCache run promptly) but
  // leave the flag set: workerLoop consumes it after the step to also drain
  // any queued prompts in `pending_`, keeping cancel-all atomic.
  if (cancelRequested_.load()) {
    batcher_.markAllFinished(StopReason::Cancelled);
  }

  drainFinishedLocked(lock);
  return true;
}

bool ContinuousBatchScheduler::hasWork() const {
  std::scoped_lock lock(mutex_);
  return hasWorkLocked();
}

bool ContinuousBatchScheduler::hasWorkLocked() const noexcept {
  return numActiveLocked() > 0;
}

unsigned ContinuousBatchScheduler::numActive() const {
  std::scoped_lock lock(mutex_);
  return numActiveLocked();
}

unsigned ContinuousBatchScheduler::occupancy() const {
  std::scoped_lock lock(mutex_);
  const size_t total =
      static_cast<size_t>(numActiveLocked()) + pending_.size_approx();
  return static_cast<unsigned>(
      std::min<size_t>(total, std::numeric_limits<unsigned>::max()));
}

unsigned ContinuousBatchScheduler::numActiveLocked() const noexcept {
  unsigned count = 0;
  for (const auto& s : slots_) {
    if (s.has_value()) {
      count++;
    }
  }
  return count;
}

void ContinuousBatchScheduler::resetRuntimeStats() {
  std::scoped_lock lock(mutex_);
  stats_.reset();
}

RuntimeStatsSnapshot ContinuousBatchScheduler::runtimeStats() const {
  std::scoped_lock lock(mutex_);
  return stats_;
}

void RuntimeStatsSnapshot::reset() { *this = RuntimeStatsSnapshot{}; }

void RuntimeStatsSnapshot::recordDecodeStep(
    uint64_t numActiveSequences, uint64_t prefillTokens, uint64_t decodeTokens,
    std::chrono::nanoseconds stepDuration) {
  decodeStepCount_++;
  concurrentSeqSum_ += numActiveSequences;
  const double stepMs =
      std::chrono::duration<double, std::milli>(stepDuration).count();
  const uint64_t totalTokens = prefillTokens + decodeTokens;
  if (totalTokens == 0) {
    return;
  }
  // Split step time between prefill and decode by token count. On a mixed
  // prefill+decode step (common in continuous batching when a new request
  // starts prefilling while another is generating) the previous
  // "all-or-nothing" rule dropped the piggybacked prefill tokens and their
  // wall-clock time, under-reporting batch TTFT and ppTPS. Compactor replay
  // decode is excluded at the call site — `onGenerationFinished` runs
  // outside the scheduler's timed `recordDecodeStep` block — so a
  // proportional split here cannot leak replay time into TTFT.
  const double prefillFraction =
      static_cast<double>(prefillTokens) / static_cast<double>(totalTokens);
  prefillTimeMs_ += stepMs * prefillFraction;
  decodeTimeMs_ += stepMs * (1.0 - prefillFraction);
  prefillTokenCount_ += prefillTokens;
  decodeTokenCount_ += decodeTokens;
}

void RuntimeStatsSnapshot::accumulateSlot(
    int64_t nPast, int64_t thinkingDiscards, const Request& req,
    int64_t toolsDropped) {
  cacheTokens += nPast;
  thinkingBlockDiscards += thinkingDiscards;
  toolDefinitionsDropped += toolsDropped;
  generatedTokens += static_cast<int64_t>(req.generatedTokens.size());
  // Count tokens actually prefilled, not the prompt size planned at admission:
  // once prefill completes, prefillFedCount is reset to 0, so the full prompt
  // is read from prefillTokenCount; a request cancelled mid/pre-prefill instead
  // reports the partial prefillFedCount (0 if no step ever ran). This keeps the
  // `cacheTokens ~= promptTokens + generatedTokens` invariant honest on the
  // cancel path.
  promptTokens += req.isPrefillComplete()
                      ? static_cast<int64_t>(req.prefillTokenCount)
                      : static_cast<int64_t>(req.prefillFedCount);
}

double RuntimeStatsSnapshot::avgConcurrentSeq() const {
  return decodeStepCount_ > 0 ? static_cast<double>(concurrentSeqSum_) /
                                    static_cast<double>(decodeStepCount_)
                              : 0.0;
}

double RuntimeStatsSnapshot::elapsedMs() const {
  const auto elapsed = std::chrono::steady_clock::now() - start_;
  return std::chrono::duration<double, std::milli>(elapsed).count();
}

double RuntimeStatsSnapshot::decodeTokensPerSecond() const {
  constexpr double kMillisInSecond = 1000.0;
  return decodeTimeMs_ > 0.0
             ? kMillisInSecond * static_cast<double>(decodeTokenCount_) /
                   decodeTimeMs_
             : 0.0;
}

double RuntimeStatsSnapshot::prefillTokensPerSecond() const {
  constexpr double kMillisInSecond = 1000.0;
  return prefillTimeMs_ > 0.0
             ? kMillisInSecond * static_cast<double>(prefillTokenCount_) /
                   prefillTimeMs_
             : 0.0;
}

bool ContinuousBatchScheduler::cancel(uint32_t seqId, uint64_t admissionId) {
  if (std::this_thread::get_id() == workerThreadId_.load()) {
    // A streaming callback (onToken/onAdmitted/onDone) is cancelling from
    // the worker thread, which holds mutex_ while it streams: locking it
    // here would self-deadlock (the hazard whole-model cancel dodges via
    // the non-locking requestCancelAll flag). Record only -- no ownership
    // check, no notify. The worker is awake by definition and reconciles
    // deferred teardown at its loop top and on every lock reacquisition
    // before it can sleep or admit new work; the apply side validates the
    // admission id, so a stale record no-ops there.
    recordPendingSlotCancel(seqId, admissionId);
    return true;
  }
  std::scoped_lock lock(mutex_);
  // Request-time ownership check: a mismatch means the admission this
  // cancel was aimed at already finished (and the seqId may already name
  // an unrelated successor) -- do nothing rather than touch that slot.
  const bool owned = slotOwnedByLocked(seqId, admissionId);
  if (owned) {
    // `teardownDeferred_` means a step released `mutex_` while still holding a
    // slot reference (see `TeardownDeferGuard`). Freeing that slot here would
    // destroy the driver mid-finalize, so record instead, even during
    // shutdown, where `~ContinuousBatchScheduler` joins and then clears every
    // slot anyway.
    if ((workerStarted_ && !stopping_) || teardownDeferred_) {
      // Notified while mutex_ is held so the wakeup cannot slip between the
      // worker's predicate check and its wait.
      recordPendingSlotCancel(seqId, admissionId);
      workCv_.notify_all();
    } else {
      cancelSlotLocked(seqId);
    }
  }
  return owned;
}

bool ContinuousBatchScheduler::cancelGroupQueued(const uint64_t groupTag) {
  if (groupTag == 0) {
    return false;
  }
  if (std::this_thread::get_id() == workerThreadId_.load()) {
    // Worker thread (a streaming callback) holds mutex_ — record only, exactly
    // as cancel(seqId, admissionId) does. The worker reconciles deferred
    // teardown at its loop top before it can admit anything or sleep.
    recordPendingGroupCancel(groupTag);
    return true;
  }
  std::scoped_lock lock(mutex_);
  if (!taggedGroups_.contains(groupTag)) {
    return false;
  }
  // See the note in `cancel`: settling a group frees its slots, so it must
  // defer while a step owns one across an unlock window.
  if ((workerStarted_ && !stopping_) || teardownDeferred_) {
    // Notified while mutex_ is held so the wakeup cannot slip between the
    // worker's predicate check and its wait.
    recordPendingGroupCancel(groupTag);
    workCv_.notify_all();
  } else {
    applyGroupQueuedCancelLocked(groupTag);
  }
  return true;
}

void ContinuousBatchScheduler::applyGroupQueuedCancelLocked(
    const uint64_t groupTag) noexcept {
  const auto found = taggedGroups_.find(groupTag);
  if (found == taggedGroups_.end()) {
    return; // the group finished between record and apply
  }
  const std::shared_ptr<BatchGroup> group = found->second.lock();
  if (!group || group->done) {
    return;
  }
  // Fully admitted between record and apply: every request has a slot, so the
  // submitter's own slot teardown covers the group and keeps the graceful
  // partial-output cancel. Settling it here would downgrade that to a throw.
  if (group->admittedCount >= group->totalCount) {
    return;
  }
  // A lone request keeps the graceful empty-output cancel that the single-job
  // contract pins — the same choice submitLocked's refusal path makes: its
  // caller cannot tell a cancel that landed while the request was queued from
  // one that landed during prefill, and the latter must not throw. Settling it
  // done-without-error releases its blocked processBatch at once (the point of
  // this call) while keeping that terminal. `admittedCount == 0` here, so the
  // group holds no slot to tear down.
  if (group->totalCount <= 1) {
    group->stats = stats_;
    group->done = true;
    workCv_.notify_all();
    return;
  }
  // A multi-prompt group instead rejects: some of its prompts never ran, so
  // completing it as a success with empty strings would disguise the
  // cancellation. Same terminal as cancelPendingLocked and as a refusal at
  // admission. failGroupLocked marks the group done and notifies, which
  // releases its blocked processBatch immediately; the stale pending_ entries
  // are discarded by admitPendingIntoFreeSlotsLocked's done-check when a slot
  // next frees.
  failGroupLocked(
      group,
      std::make_exception_ptr(
          qvac_errors::StatusError(
              ADDON_ID,
              qvac_lib_inference_addon_llama::errors::toString(
                  qvac_lib_inference_addon_llama::errors::Cancelled),
              "ContinuousBatchScheduler: request cancelled before it "
              "could run (queued behind the parallel limit when its "
              "group was cancelled)")));
}

void ContinuousBatchScheduler::recordPendingGroupCancel(
    const uint64_t groupTag) {
  std::scoped_lock pendingLock(pendingCancelsMtx_);
  pendingGroupCancels_.push_back(groupTag);
}

void ContinuousBatchScheduler::recordPendingSlotCancel(
    uint32_t seqId, uint64_t admissionId) {
  std::scoped_lock pendingLock(pendingCancelsMtx_);
  pendingSlotCancels_.push_back(
      PendingSlotCancel{.seqId = seqId, .admissionId = admissionId});
}

bool ContinuousBatchScheduler::slotOwnedByLocked(
    uint32_t seqId, uint64_t admissionId) const noexcept {
  return seqId < slots_.size() && slots_[seqId].has_value() &&
         slots_[seqId]->admissionId == admissionId;
}

bool ContinuousBatchScheduler::hasPendingCancels() const {
  std::scoped_lock pendingLock(pendingCancelsMtx_);
  return !pendingSlotCancels_.empty() || !pendingGroupCancels_.empty();
}

void ContinuousBatchScheduler::cancelSlotLocked(
    uint32_t seqId, SaveCachePolicy savePolicy) noexcept {
  const bool occupied = seqId < slots_.size() && slots_[seqId].has_value();
  if (!occupied) {
    return;
  }
  const Request* req = batcher_.requestAt(seqId);
  if (slots_[seqId]->driver) {
    // Best-effort driver teardown on a cancelled slot. onCancel finalizes (and
    // mutates) the slot's KV and saveCacheForSlot persists it, so contain both
    // in one try: a throw here would otherwise escape this noexcept function
    // (it runs from the noexcept StepUnlockGuard destructor) and std::terminate
    // the process, and a failed finalize must skip the save rather than persist
    // inconsistent state. The cleanup tail below (notifyDone/freeSlot) runs
    // regardless, so the slot is always freed. The normal-completion save in
    // drainFinishedLocked() is left throwing so live requests still surface the
    // error.
    //
    // `savePolicy == Skip` short-circuits the save leg: error-recovery callers
    // (see `failGroupLocked`) arrive here after the driver has already thrown
    // from a state-mutating hook, so live memory and driver accounting are
    // unhealthy and a save would silently corrupt the user's on-disk cache.
    // See `SaveCachePolicy` in the header for the full rationale.
    try {
      // Align the driver's KV cursor with the batcher's authoritative
      // `req->currentPos` before onCancel so the tail trim matches the
      // partial prefill actually committed to live KV. See the matching
      // note in drainFinishedLocked / finalizeFinishedSequences: without
      // this a mid-prefill cancel on a pure-attention driver under-trims
      // and any subsequent saveCacheForSlot writes an `nPast` narrower
      // than the KV span serialised to disk. `req == nullptr` (slot was
      // never admitted into the batcher, e.g. failed admit) falls back
      // to the driver's own cursor which is authoritative in that case.
      if (req != nullptr) {
        slots_[seqId]->driver->syncPosition(req->currentPos);
      }
      const bool rollbackOk = slots_[seqId]->driver->onCancel({});
      if (req != nullptr) {
        accumulateSlotRuntimeStats(*slots_[seqId], *req);
      }
      // Skip save on rollback failure regardless of policy: persisting
      // driver state whose live memory may not match `getNPast()` would
      // let a cancelled request's peak state leak into the on-disk
      // cache and survive across reloads.
      if (savePolicy == SaveCachePolicy::Save && rollbackOk) {
        saveCacheForSlot(seqId, *slots_[seqId]);
      }
    } catch (const std::exception& e) {
      logTeardownFailureNoexcept("cancel teardown failed", seqId, e.what());
    } catch (...) {
      logTeardownFailureNoexcept("cancel teardown failed", seqId, nullptr);
    }
  }
  notifyDoneNoexcept(seqId);
  // batcher_.cancel takes a KvClearFn callback so it is not noexcept; the
  // clearSeqKv lambda cannot throw, but wrap defensively so this noexcept path
  // cannot terminate if that ever changes.
  try {
    batcher_.cancel(seqId, [this](uint32_t s) { clearSeqKv(s); });
  } catch (...) {
    logTeardownFailureNoexcept("cancel: batcher_.cancel threw", seqId, nullptr);
  }
  // freeSlot runs regardless of the defensive catch above. If batcher_.cancel
  // ever threw, its clear-KV-before-reset order leaves the batcher slot
  // occupied, so admission — gated on the batcher's free list — never re-admits
  // that seqId over un-cleared KV: the slot leaks but cannot corrupt. Freeing
  // the scheduler SlotState anyway is the lesser leak (releases driver+sampler)
  // and cannot make it worse, so free unconditionally rather than gate on the
  // cancel succeeding.
  freeSlot(seqId);
}

void ContinuousBatchScheduler::applyDeferredTeardownLocked() noexcept {
  // A step is inside an unlock window that owns a slot; reconciling now would
  // tear that slot down under the code holding it. Every record stays queued
  // (nothing is swapped out below, and `clearRequested_` stays set) and the
  // worker applies them once the step returns. See `TeardownDeferGuard`.
  if (teardownDeferred_) {
    return;
  }
  std::vector<PendingSlotCancel> pendingCancels;
  std::vector<uint64_t> pendingGroups;
  try {
    std::scoped_lock pendingLock(pendingCancelsMtx_);
    pendingCancels.swap(pendingSlotCancels_);
    pendingGroups.swap(pendingGroupCancels_);
  } catch (...) {
    // std::mutex::lock may throw std::system_error on an unrecoverable
    // failure; leave the recorded cancels in place for the next drain
    // rather than terminate from this noexcept teardown path.
    logTeardownFailureNoexcept("deferred-cancel drain failed to lock");
  }
  // Groups first: settling one frees the slots its admitted siblings hold, and
  // doing it before the per-slot pass keeps a same-group slot cancel from
  // racing that teardown.
  for (const uint64_t groupTag : pendingGroups) {
    applyGroupQueuedCancelLocked(groupTag);
  }
  for (const PendingSlotCancel& pending : pendingCancels) {
    // Apply-time ownership re-check: the slot may have drained (and been
    // re-admitted) between record and apply; a stale record must not tear
    // down the seqId's next occupant.
    if (slotOwnedByLocked(pending.seqId, pending.admissionId)) {
      cancelSlotLocked(pending.seqId);
    }
  }
  if (clearRequested_) {
    clearRequested_ = false;
    clearLocked();
  }
}

void ContinuousBatchScheduler::requestCancelAll() {
  cancelRequested_.store(true);
  workCv_.notify_all();
}

void ContinuousBatchScheduler::clear() {
  std::scoped_lock lock(mutex_);
  // See the note in `cancel`: `clearLocked` frees every slot, so it must defer
  // while a step owns one across an unlock window.
  if ((workerStarted_ && !stopping_) || teardownDeferred_) {
    clearRequested_ = true;
    workCv_.notify_all();
  } else {
    clearLocked();
  }
}

void ContinuousBatchScheduler::clearLocked() noexcept {
  for (uint32_t seqId = 0; seqId < slots_.size(); seqId++) {
    if (slots_[seqId].has_value()) {
      if (slots_[seqId]->driver) {
        // onSequenceEnd is a virtual driver call (flushes buffered output) and
        // may throw; contain it so this noexcept teardown cannot terminate.
        try {
          slots_[seqId]->driver->onSequenceEnd({});
        } catch (const std::exception& e) {
          logTeardownFailureNoexcept(
              "clear: onSequenceEnd threw", seqId, e.what());
        } catch (...) {
          logTeardownFailureNoexcept(
              "clear: onSequenceEnd threw", seqId, nullptr);
        }
      }
      notifyDoneNoexcept(seqId);
      freeSlot(seqId);
    }
  }
  // batcher_.clear takes a KvClearFn callback so it is not noexcept; the
  // clearSeqKv lambda cannot throw, but wrap defensively so this noexcept path
  // cannot terminate if that ever changes.
  try {
    batcher_.clear([this](uint32_t s) { clearSeqKv(s); });
  } catch (...) {
    logTeardownFailureNoexcept("clear: batcher_.clear threw unexpectedly");
  }
}

void ContinuousBatchScheduler::completeGroupRequestLocked(
    const std::shared_ptr<BatchGroup>& group) noexcept {
  if (!group || group->done) {
    return;
  }
  group->completedCount++;
  if (group->completedCount >= group->totalCount) {
    group->stats = stats_;
    group->done = true;
    workCv_.notify_all();
  }
}

void ContinuousBatchScheduler::failGroupLocked(
    const std::shared_ptr<BatchGroup>& group,
    std::exception_ptr error) noexcept {
  if (!group || group->done) {
    return;
  }
  group->error = error;
  group->stats = stats_;
  group->done = true;

  // Per-slot teardown is identical to a cancel, so delegate to cancelSlotLocked
  // rather than re-implement onCancel/save/notify/free here: it is noexcept and
  // already contains every throwing step, which keeps this function noexcept on
  // the worker error-recovery path (where a throw would escape the worker
  // thread and std::terminate). The group is marked done above, so the
  // completeGroupRequestLocked inside notifyDone no-ops rather than
  // double-counting.
  //
  // Pass `SaveCachePolicy::Skip`: this is the error-recovery path, so the
  // driver's live state may be inconsistent (e.g. a hybrid-recurrent
  // compaction failure clears the sequence and throws), and persisting that
  // state would silently overwrite the user's previous on-disk cache with an
  // empty/broken one. Graceful-cancel callers keep the default `Save`.
  for (uint32_t seqId = 0; seqId < slots_.size(); seqId++) {
    if (slots_[seqId].has_value() && slots_[seqId]->group == group) {
      cancelSlotLocked(seqId, SaveCachePolicy::Skip);
    }
  }
  workCv_.notify_all();
}

void ContinuousBatchScheduler::cancelPendingLocked() {
  // A queued request that is drained here never reached a slot, so it
  // produced no output at all. Unlike an in-flight slot (cancelled
  // gracefully with whatever it generated so far), this prompt had no
  // chance to run, so surface it as an explicit `Cancelled` error rather
  // than a silently-successful empty output.
  QueuedRequest queued;
  while (pending_.try_dequeue(queued)) {
    if (queued.group) {
      failGroupLocked(
          queued.group,
          std::make_exception_ptr(
              qvac_errors::StatusError(
                  ADDON_ID,
                  qvac_lib_inference_addon_llama::errors::toString(
                      qvac_lib_inference_addon_llama::errors::Cancelled),
                  "ContinuousBatchScheduler: request cancelled before it "
                  "could run (queued behind the parallel limit when cancel "
                  "was requested)")));
    }
  }
}

void ContinuousBatchScheduler::notifyDone(uint32_t seqId) {
  // Normal-completion path: a throwing onDone propagates so the worker loop
  // fails the batch (failGroupLocked) instead of completing it as a success;
  // teardown paths use notifyDoneNoexcept. The throw then skips freeSlot below,
  // so recovery re-runs teardown (onCancel/saveCache/onDone) on this slot. That
  // is benign and only happens when onDone itself threw: the re-run's
  // onGenerationFinished finds an already-consumed reasoning span (compaction
  // no-ops) and an already-flushed UTF-8 buffer, recovery's onCancel({})
  // re-emits nothing, and saveCache just rewrites the same file.
  auto& slot = slots_[seqId];
  if (slot.has_value() && slot->streams.onDone) {
    slot->streams.onDone(seqId);
  }
  if (slot.has_value() && slot->group) {
    completeGroupRequestLocked(slot->group);
  }
}

void ContinuousBatchScheduler::notifyDoneNoexcept(uint32_t seqId) noexcept {
  auto& slot = slots_[seqId];
  if (slot.has_value() && slot->streams.onDone) {
    // The onDone stream callback is caller/JS-provided and may throw. Contain
    // it here, not at the call site: this keeps the noexcept teardown contract
    // honest (cancel/clear/fail paths run it), and — crucially — still runs
    // completeGroupRequestLocked below, so a throwing callback can never leave
    // the submitting caller blocked forever on the group.
    try {
      slot->streams.onDone(seqId);
    } catch (const std::exception& e) {
      logTeardownFailureNoexcept("onDone callback threw", seqId, e.what());
    } catch (...) {
      logTeardownFailureNoexcept("onDone callback threw", seqId, nullptr);
    }
  }
  if (slot.has_value() && slot->group) {
    completeGroupRequestLocked(slot->group);
  }
}

void ContinuousBatchScheduler::freeSlot(uint32_t seqId) noexcept {
  if (seqId < slots_.size()) {
    slots_[seqId].reset();
  }
}

void ContinuousBatchScheduler::saveCacheForSlot(
    uint32_t seqId, SlotState& slot) {
  if (!slot.saveCacheToDisk || slot.cacheKey.empty() || !slot.driver) {
    return;
  }
  if (slot.activeCacheSavedToDisk &&
      persistedCacheBackingStoreMissing(slot.cacheKey)) {
    QLOG_IF(
        Priority::DEBUG,
        string_format(
            "ContinuousBatchScheduler::saveCacheForSlot: active cache backing "
            "store was removed, dropping stale cache '%s' for seqId %u\n",
            slot.cacheKey.c_str(),
            seqId));
    slot.activeCacheSavedToDisk = false;
    return;
  }
  slot.driver->saveCache(slot.cacheKey);
  slot.activeCacheSavedToDisk = true;
}

ObservedRequestStats computeObservedStats(
    const std::chrono::steady_clock::time_point enqueuedAt, const Request& req,
    const std::optional<GenerationStopReason> stopReason) {
  ObservedRequestStats observed;
  observed.stopReason = stopReason;
  observed.generatedTokens = static_cast<int64_t>(req.generatedTokens.size());
  // Mirror accumulateSlot: full prompt once prefill completed, the partial
  // fed count for a request cancelled mid/pre-prefill.
  observed.promptTokens = req.isPrefillComplete()
                              ? static_cast<int64_t>(req.prefillTokenCount)
                              : static_cast<int64_t>(req.prefillFedCount);
  if (!req.firstTokenAt.has_value()) {
    return observed; // never sampled a token: no timing figures exist
  }
  observed.ttftMs =
      std::chrono::duration<double, std::milli>(*req.firstTokenAt - enqueuedAt)
          .count();
  // A request whose only token also ended it has a TTFT but no rate window,
  // because `lastTokenAt` tracks counted tokens.
  if (!req.lastTokenAt.has_value()) {
    return observed;
  }
  const double genWindowMs = std::chrono::duration<double, std::milli>(
                                 *req.lastTokenAt - *req.firstTokenAt)
                                 .count();
  // N tokens span N-1 inter-token gaps; a single token has no honest rate.
  if (observed.generatedTokens > 1 && genWindowMs > 0.0) {
    constexpr double kMillisInSecond = 1000.0;
    observed.genTps = kMillisInSecond *
                      static_cast<double>(observed.generatedTokens - 1) /
                      genWindowMs;
  }
  return observed;
}

ObservedRequestStats
aggregateObservedStats(const std::vector<ObservedRequestStats>& all) {
  ObservedRequestStats agg;
  double ttftSum = 0.0;
  double tpsSum = 0.0;
  int64_t ttftCount = 0;
  int64_t tpsCount = 0;
  bool stopReasonAgrees = true;
  for (const ObservedRequestStats& stats : all) {
    agg.generatedTokens += stats.generatedTokens;
    agg.promptTokens += stats.promptTokens;
    // Kept only while every request reports the same reason: a one-item group
    // (the concurrent single-prompt path) keeps it, a mixed group drops it.
    if (&stats == &all.front()) {
      agg.stopReason = stats.stopReason;
    } else if (stats.stopReason != agg.stopReason) {
      stopReasonAgrees = false;
    }
    if (stats.ttftMs > 0.0) {
      ttftSum += stats.ttftMs;
      ++ttftCount;
    }
    if (stats.genTps > 0.0) {
      tpsSum += stats.genTps;
      ++tpsCount;
    }
  }
  if (ttftCount > 0) {
    agg.ttftMs = ttftSum / static_cast<double>(ttftCount);
  }
  if (tpsCount > 0) {
    agg.genTps = tpsSum / static_cast<double>(tpsCount);
  }
  if (!stopReasonAgrees) {
    agg.stopReason.reset();
  }
  return agg;
}

void ContinuousBatchScheduler::accumulateSlotRuntimeStats(
    const SlotState& slot, const Request& req) {
  int64_t nPast = 0;
  int64_t thinkingDiscards = 0;
  int64_t toolsDropped = 0;
  // Read after the caller has finalized the driver, so a finished sequence
  // reports its terminal reason; a cancelled/prefill-only slot reports None.
  std::optional<GenerationStopReason> stopReason;
  if (slot.driver) {
    // `onCancel` has already rolled `nPast` back to the admission cursor
    // and, on the graceful-cancel leg, `saveCacheForSlot` persists that
    // state — so `CacheTokens` matches the live driver cursor and what
    // is on disk. On the error-recovery leg (`SaveCachePolicy::Skip`,
    // driven from `failGroupLocked`) the save is intentionally skipped
    // to preserve the last known-good cache, but the live driver cursor
    // is still the honest report for that batch: the request is
    // logically rolled back to the admission cursor. Work performed is
    // reported via `promptTokens` / `generatedTokens`.
    nPast = static_cast<int64_t>(slot.driver->getNPast());
    thinkingDiscards =
        static_cast<int64_t>(slot.driver->getThinkingBlockDiscards());
    toolsDropped =
        static_cast<int64_t>(slot.driver->getToolDefinitionsDropped());
    stopReason = slot.driver->getGenerationStopReason();
  }
  stats_.accumulateSlot(nPast, thinkingDiscards, req, toolsDropped);
  // Every terminal path that folds a slot into the aggregate also records the
  // request's observed end-to-end figures for its submitter, next to its
  // output.
  if (slot.group) {
    slot.group->requestStats[slot.outputIndex] =
        computeObservedStats(slot.enqueuedAt, req, stopReason);
  }
}

} // namespace qvac_lib_inference_addon_llama::batching
