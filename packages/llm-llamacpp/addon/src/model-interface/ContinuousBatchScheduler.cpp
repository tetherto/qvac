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

#include "CacheCheckpointFile.hpp"
#include "CacheManager.hpp"
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
/// driver rolls back the current request.
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
  if (reason == StopReason::Cancelled) {
    return driver.onCancel(outputCallback);
  }
  if (reason == StopReason::DecodeError) {
    return driver.onFailure(outputCallback);
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
  // Built at its final size: `resize` may relocate elements by copy where the
  // standard library's deque move can throw (MSVC), and checkpoints are
  // move-only.
  parked_ = std::vector<std::optional<ParkedState>>(batchSize);
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
             clearRequested_ || pending_.size_approx() > 0 || hasWorkLocked() ||
             hasRunnableSaveJobLocked();
    });
    if (stopping_) {
      break;
    }
    applyDeferredTeardownLocked();
    // No decode is in flight here, and saves go before admission so a queued
    // request on the same key cannot get between the caller's request and its
    // save.
    serviceSaveJobsLocked();
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
          failGroupLocked(slot->group, error, SaveCachePolicy::Skip);
        }
      }
      QueuedRequest queued;
      while (pending_.try_dequeue(queued)) {
        if (queued.group) {
          failGroupLocked(queued.group, error, SaveCachePolicy::Skip);
        }
      }
      // Parked conversations of other keys took no part in the failed step,
      // so their state is what their last request committed: keep them the
      // way an eviction does instead of letting `clearLocked` drop them.
      for (uint32_t seqId = 0; seqId < parked_.size(); ++seqId) {
        evictParkedLocked(seqId);
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
      // A request that finished in the step above freed its key: a save or
      // discard waiting for it runs now, before the next request on that key
      // is admitted and adopts the state.
      serviceSaveJobsLocked();
      admitPendingIntoFreeSlotsLocked();
    }
  }
  cancelPendingLocked();
  clearLocked();
  failSaveJobsLocked();
}

void ContinuousBatchScheduler::admitPendingIntoFreeSlotsLocked() {
  const auto admit = [this](QueuedRequest&& queued) {
    const std::shared_ptr<BatchGroup> group = queued.group;
    try {
      const uint32_t seqId = submitLocked(std::move(queued));
      (void)seqId;
    } catch (...) {
      failGroupLocked(
          group, std::current_exception(), SaveCachePolicy::KeepAdopted);
    }
  };
  const auto keyBusy = [this](const QueuedRequest& queued) {
    return !queued.request.cacheKey.empty() &&
           busyKeys_.contains(queued.request.cacheKey);
  };
  // Requests that waited for their key go first, in order.
  for (auto it = keyDeferred_.begin();
       it != keyDeferred_.end() && batcher_.firstFreeSeqId().has_value();) {
    if (it->group && it->group->done) {
      it = keyDeferred_.erase(it);
      continue;
    }
    if (keyBusy(*it)) {
      ++it;
      continue;
    }
    QueuedRequest queued = std::move(*it);
    it = keyDeferred_.erase(it);
    admit(std::move(queued));
  }
  QueuedRequest queued;
  while (batcher_.firstFreeSeqId().has_value() &&
         pending_.try_dequeue(queued)) {
    // already-failed/cancelled also skipped as group is `done`
    if (queued.group && queued.group->done) {
      continue;
    }
    // One request per cacheKey at a time: a second one waits for the first
    // to end, so a conversation's state is never forked.
    if (keyBusy(queued) ||
        std::ranges::any_of(keyDeferred_, [&](const QueuedRequest& waiting) {
          return waiting.request.cacheKey == queued.request.cacheKey &&
                 !queued.request.cacheKey.empty();
        })) {
      keyDeferred_.push_back(std::move(queued));
      continue;
    }
    admit(std::move(queued));
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
  //
  // Take the incoming conversation out of the RAM tier before choosing a
  // slot: evicting a parked one moves it into the tier, and with a tier that
  // fits one conversation that would push this one out. Put back on any exit
  // that did not use it.
  std::optional<SlotStateCacheEntry> kept;
  if (ramTier_ && ramTier_->enabled() && !request.cacheKey.empty() &&
      std::ranges::none_of(parked_, [&](const auto& parked) {
        return parked.has_value() && parked->cacheKey == request.cacheKey;
      })) {
    kept = ramTier_->take(request.cacheKey);
  }
  ScopeGuard keptGuard([this, &kept, &request]() noexcept {
    if (kept.has_value()) {
      try {
        (void)ramTier_->insert(request.cacheKey, std::move(*kept));
      } catch (...) {
        logTeardownFailureNoexcept(
            "returning an unused RAM-tier state failed", 0, nullptr);
      }
    }
  });
  const auto maybeSeqId = chooseSeqIdLocked(request.cacheKey);
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

  // Where the conversation comes from, fastest first: still resident in this
  // sequence, the RAM tier, then the cacheKey file. A source whose file was
  // loaded and has since been deleted is dropped, as on the single-prompt
  // path: the caller deleted the cache.
  const std::string& key = request.cacheKey;
  bool isCacheLoaded = false;
  bool activeCacheSavedToDisk = false;
  // A state with turns its file lacks must survive a failed admission.
  bool adoptedDirtyState = false;
  bool adoptedEphemeral = false;
  std::optional<cache::Checkpoints> adoptedCheckpoints;
  if (!key.empty() && parked_[seqId].has_value() &&
      parked_[seqId]->cacheKey == key) {
    ParkedState parked = std::move(*parked_[seqId]);
    parked_[seqId].reset();
    if (parked.activeCacheSavedToDisk &&
        persistedCacheBackingStoreMissing(key)) {
      clearSeqKv(seqId);
    } else if (driver->adoptResidentState(parked.ledgerWords)) {
      isCacheLoaded = true;
      activeCacheSavedToDisk = parked.activeCacheSavedToDisk;
      adoptedDirtyState = parked.dirty;
      adoptedEphemeral = parked.ephemeral;
      adoptedCheckpoints = std::move(parked.checkpoints);
      ++residentHits_;
    }
  }
  if (!isCacheLoaded && !key.empty()) {
    if (!kept.has_value() && ramTier_) {
      kept = ramTier_->take(key);
    }
    // From here the entry is either restored or dropped, never put back.
    keptGuard.dismiss();
    if (kept.has_value() && !(kept->activeCacheSavedToDisk &&
                              persistedCacheBackingStoreMissing(key))) {
      const bool applied = llama_state_seq_set_data_ext(
                               shared_.lctx,
                               kept->state.data(),
                               kept->state.size(),
                               static_cast<llama_seq_id>(seqId),
                               0) != 0;
      if (applied && driver->adoptResidentState(kept->ledgerWords)) {
        isCacheLoaded = true;
        activeCacheSavedToDisk = kept->activeCacheSavedToDisk;
        adoptedDirtyState = kept->dirty;
        adoptedEphemeral = kept->ephemeral;
        adoptedCheckpoints = std::move(kept->checkpoints);
        ++ramTierHits_;
      } else {
        clearSeqKv(seqId);
        SlotStateCache::saveUnrestored(key, *kept, applied);
      }
    } else if (kept.has_value()) {
      clearSeqKv(seqId);
    }
  }
  if (!isCacheLoaded) {
    isCacheLoaded = driver->loadCache(key);
    activeCacheSavedToDisk = isCacheLoaded;
  }
  driver->setCacheReconciliationEnabled(!key.empty());
  // Checkpoints travel with the state; a key whose state was only on disk
  // keeps them in `checkpointStore_`. They only describe prefixes, and the
  // driver checks each against the restored memory before use.
  if (adoptedCheckpoints.has_value()) {
    driver->adoptCheckpoints(std::move(*adoptedCheckpoints));
  } else if (
      const auto kept = checkpointStore_.find(key);
      kept != checkpointStore_.end()) {
    driver->adoptCheckpoints(std::move(kept->second.checkpoints));
    checkpointStore_.erase(kept);
  }
  // A throw before the driver begins its cache request rolls back to this
  // cursor, so it must describe the state just adopted. The call after
  // `preparePrefill` below re-anchors it once preparation has run.
  driver->snapshotPreRequestCursor();

  // A failed admission leaves the sequence as it found it: a conversation
  // adopted with unsaved turns is rolled back and parked again (its file
  // does not have them), anything else is cleared (it is still on disk, or
  // there was nothing).
  ScopeGuard cacheGuard([this,
                         seqId,
                         &driver,
                         &key,
                         adoptedDirtyState,
                         adoptedEphemeral,
                         activeCacheSavedToDisk]() noexcept {
    if (adoptedDirtyState && driver) {
      try {
        if (driver->onFailure({})) {
          std::vector<llama_token> words = driver->residentStateTokens();
          if (!words.empty()) {
            // Never park a ledger whose totals disagree with its header: a
            // later write would replace the file with one that cannot load.
            (void)cache::deserialize(words.data(), words.size());
            parked_[seqId] = ParkedState{
                .cacheKey = key,
                .ledgerWords = std::move(words),
                .checkpoints = driver->releaseCheckpoints(),
                .dirty = true,
                .activeCacheSavedToDisk = activeCacheSavedToDisk,
                .ephemeral = adoptedEphemeral,
                .lastUse = ++parkClock_};
            return;
          }
        }
      } catch (...) {
        logTeardownFailureNoexcept(
            "admission rollback of a resident state failed", seqId, nullptr);
      }
    }
    clearSeqKv(seqId);
  });

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
  // A prefill-only request whose prompt is already resident (cache reuse
  // covered all of it) has nothing to feed. It is admitted empty and finished
  // below, so the regular drain still runs its teardown and cache save.
  const bool alreadyPrefilled =
      request.prefill && plan.tokens.empty() && plan.mediaBarriers.empty();
  if (auto status = batcher_.addRequestAt(
          seqId,
          std::move(plan),
          driver->getNPast(),
          driver->getKvCellsUsed(),
          alreadyPrefilled);
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
          .ephemeral = request.ephemeral,
          .activeCacheSavedToDisk = activeCacheSavedToDisk,
          .prefillOnly = request.prefill,
          .adoptedState = isCacheLoaded,
          .adoptedDirty = adoptedDirtyState,
          .adoptedEphemeral = adoptedEphemeral,
          .enqueuedAt = request.enqueuedAt,
          .admissionId = admissionId});
  cacheGuard.dismiss();
  if (!slots_[seqId]->cacheKey.empty()) {
    busyKeys_.insert(slots_[seqId]->cacheKey);
  }
  if (alreadyPrefilled) {
    try {
      prefillCompleteFn()(seqId, slots_[seqId]->driver->getNPast(), 0);
    } catch (...) {
      failSlotLocked(seqId, std::current_exception());
      return seqId;
    }
  }
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
                  "group was cancelled)")),
          SaveCachePolicy::Save);
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
      // `req.currentPos` before finalize so `onCancel` / `onFailure` see
      // the partial prefill actually committed to live KV. Without this a
      // mid-prefill cancel / decode-error leaves the driver's `nPast_` at the
      // admission cursor while live KV holds the partial prefill, so `onCancel`
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
  // A throw from `onPrefillComplete` propagates through the batcher and is
  // caught by `workerLoop`, which routes the affected group through
  // `failGroupLocked` -> `cancelSlotLocked(Skip)`. The last known-good cache
  // remains untouched.
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
    failGroupLocked(slot->group, error, SaveCachePolicy::KeepAdopted);
    return;
  }
  cancelSlotLocked(seqId, SaveCachePolicy::KeepAdopted);
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
    // The re-acquire can throw: std::mutex::lock() may raise std::system_error
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
    applyDeferredTeardownLocked();
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
  // Only now does the slot's cursor include the segment, so a teardown
  // recorded during the eval sees the memory it actually has.
  applyDeferredTeardownLocked();
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
    // a later write of the kept state would serialise a KV span
    // wider than the persisted `nPast` metadata. Successful-completion
    // paths already sync via `sampleAndAppendIdle` and this call is a
    // no-op for them.
    slot.driver->syncPosition(req.currentPos);
    // Finalization can restore a full recurrent snapshot. Holding the lock for
    // that stalls every co-tenant slot and blocks a cross-thread `cancel()`.
    //
    // Unlike the decode window this one holds `slot` across the unlock, so
    // no teardown may run until the loop is done with it, see
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
    // Committed and coherent: keep the conversation in its sequence for the
    // next request on its key (`freeSlot` parks it). Nothing is written here;
    // the file is only written when the conversation leaves memory or the
    // caller asks (`saveConversation`). A failed rollback leaves live state
    // that may not match `getNPast()`, so it is not kept: the loop below
    // clears the sequence and the last known-good file stays as it was. A
    // coherent rollback lands back on the conversation the request started
    // from, which is kept as it was before the request.
    if (rollbackOk && slot.driver->shouldPersistAfterFinalize()) {
      slot.parkable = !slot.cacheKey.empty();
    } else if (rollbackOk && slot.adoptedState && slot.driver->getNPast() > 0) {
      slot.parkable = !slot.cacheKey.empty();
      slot.parkAsAdopted = true;
    }
  }
  for (const auto& req : finished) {
    const bool park =
        slots_[req.seqId].has_value() && slots_[req.seqId]->parkable;
    if (!park) {
      clearSeqKv(req.seqId);
    }
    notifyDone(req.seqId);
    freeSlot(req.seqId);
  }
}

void ContinuousBatchScheduler::serviceCheckpointStopsLocked() {
  // Partial snapshots are small and the context is not shared with anything
  // else while the worker holds the lock, so capture in place.
  while (const auto awaiting = batcher_.nextAwaitingCheckpoint()) {
    auto& slot = slots_[awaiting->seqId];
    if (slot.has_value() && slot->driver) {
      try {
        slot->driver->syncPosition(awaiting->currentPos);
        slot->driver->captureHistoryCheckpoint(awaiting->currentPos);
      } catch (...) {
        batcher_.completeCheckpointStop(awaiting->seqId);
        failSlotLocked(awaiting->seqId, std::current_exception());
        continue;
      }
    }
    batcher_.completeCheckpointStop(awaiting->seqId);
  }
}

bool ContinuousBatchScheduler::stepLocked(std::unique_lock<std::mutex>* lock) {
  serviceNextMediaSegmentLocked(lock);
  // A media segment can complete right at a checkpoint stop.
  serviceCheckpointStopsLocked();

  const auto fillResult = batcher_.fillBatch(batch_);
  if (fillResult.totalTokens == 0) {
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
      failGroupLocked(group, decodeError, SaveCachePolicy::KeepAdopted);
    }

    return false;
  }
  // Slots are budgeted individually, so the split comes back as exact sums
  // rather than one chunk size times a sequence count.
  stats_.recordDecodeStep(
      fillResult.numActiveSequences,
      fillResult.prefillTokens,
      fillResult.decodeTokens,
      std::chrono::duration_cast<std::chrono::nanoseconds>(decodeDuration));

  batcher_.advance(prefillCompleteFn());
  // A cancel or clear recorded during the decode is applied here, once
  // `advance()` has counted the chunk into `currentPos`, and before anything
  // is sampled or streamed for the slot. Applied earlier, a teardown would sync
  // the driver to a cursor one chunk behind live memory, and a cancel that
  // commits would save a cache whose metadata does not match its contents.
  applyDeferredTeardownLocked();
  // Slots whose chunk just reached their checkpoint stop, before any sampling
  // so the stop is serviced by the time the next batch is filled.
  serviceCheckpointStopsLocked();

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
  return numActiveLocked() > 0 || !keyDeferred_.empty();
}

unsigned ContinuousBatchScheduler::numActive() const {
  std::scoped_lock lock(mutex_);
  return numActiveLocked();
}

unsigned ContinuousBatchScheduler::occupancy() const {
  std::scoped_lock lock(mutex_);
  const size_t total = static_cast<size_t>(numActiveLocked()) +
                       pending_.size_approx() + keyDeferred_.size();
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
  // Weight co-residency by the work the step actually carried, not by the
  // step itself. Slots are budgeted individually, so one step can feed a
  // whole prefill chunk to one sequence and a single sampled token to
  // another; counting both steps equally would make the mean a function of
  // how finely prefill happens to be sliced rather than of how much traffic
  // shared the backend. Concretely, throttling a co-resident prefill to one
  // token per step stretches the same sharing across many more steps and so
  // *raises* a step-weighted mean — which is why speeding prefill up used to
  // read as a concurrency regression.
  concurrentSeqTokenSum_ += numActiveSequences * totalTokens;
  weightedTokenTotal_ += totalTokens;
  // Split step time between prefill and decode by token count. On a mixed
  // prefill+decode step (common in continuous batching when a new request
  // starts prefilling while another is generating) the previous
  // "all-or-nothing" rule dropped the piggybacked prefill tokens and their
  // wall-clock time, under-reporting batch TTFT and ppTPS.
  const double prefillFraction =
      static_cast<double>(prefillTokens) / static_cast<double>(totalTokens);
  prefillTimeMs_ += stepMs * prefillFraction;
  decodeTimeMs_ += stepMs * (1.0 - prefillFraction);
  prefillTokenCount_ += prefillTokens;
  decodeTokenCount_ += decodeTokens;
}

void RuntimeStatsSnapshot::accumulateSlot(
    int64_t nPast, int64_t toolsDropped, const Request& req) {
  cacheTokens += nPast;
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
  if (weightedTokenTotal_ > 0) {
    return static_cast<double>(concurrentSeqTokenSum_) /
           static_cast<double>(weightedTokenTotal_);
  }
  // Every recorded step carried zero tokens (nothing was ever fed), so there
  // is no token weight to average over. Fall back to the step-weighted mean
  // rather than reporting 0.0 for an epoch that did have live sequences.
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
    // check, no notify. The worker is awake by definition and applies
    // deferred teardown at its loop top, after each step's bookkeeping and
    // after the step, before it can sleep or admit new work; the apply side
    // validates the admission id, so a stale record no-ops there.
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
              "group was cancelled)")),
      SaveCachePolicy::Save);
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
    // Best-effort driver teardown on a cancelled slot. onCancel restores the
    // slot's pre-request KV state; the state is kept only when the driver
    // says finalization committed a coherent result. Contained in one try: a
    // throw here would otherwise escape this noexcept function (it runs from
    // the noexcept StepUnlockGuard destructor) and std::terminate the process.
    // The cleanup tail below (notifyDone/freeSlot) runs regardless, so the
    // slot is always freed.
    //
    // `Skip` never keeps the state; `KeepAdopted` rolls the request back and
    // keeps only the conversation the slot was admitted with. See
    // `SaveCachePolicy` in the header.
    try {
      // Align the driver's KV cursor with the batcher's authoritative
      // `req->currentPos` before onCancel so the tail trim matches the
      // partial prefill actually committed to live KV. See the matching
      // note in drainFinishedLocked / finalizeFinishedSequences: without
      // this a mid-prefill cancel on a pure-attention driver under-trims
      // and a later write of the kept state records an `nPast` narrower
      // than the KV span serialised to disk. `req == nullptr` (slot was
      // never admitted into the batcher, e.g. failed admit) falls back
      // to the driver's own cursor which is authoritative in that case.
      if (req != nullptr) {
        slots_[seqId]->driver->syncPosition(req->currentPos);
      }
      const bool failed = savePolicy != SaveCachePolicy::Save;
      const bool rollbackOk = failed ? slots_[seqId]->driver->onFailure({})
                                     : slots_[seqId]->driver->onCancel({});
      if (req != nullptr) {
        accumulateSlotRuntimeStats(*slots_[seqId], *req);
      }
      // A user cancel during generation commits the cached request, so the
      // slot keeps that progress. It is not kept when the driver could not
      // leave live memory coherent (`rollbackOk == false`). A cancel that
      // ended in a rollback (`shouldPersistAfterFinalize()` false), and a
      // failed request, keep the conversation the request started from.
      if (savePolicy != SaveCachePolicy::Skip && rollbackOk) {
        auto& cancelled = *slots_[seqId];
        if (!failed && cancelled.driver->shouldPersistAfterFinalize()) {
          cancelled.parkable = !cancelled.cacheKey.empty();
        } else if (cancelled.adoptedState && cancelled.driver->getNPast() > 0) {
          cancelled.parkable = !cancelled.cacheKey.empty();
          cancelled.parkAsAdopted = true;
        }
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
  // A committed cancel keeps its sequence for `freeSlot` to park.
  const bool park = slots_[seqId].has_value() && slots_[seqId]->parkable;
  try {
    batcher_.cancel(seqId, [this, park](uint32_t s) {
      if (!park) {
        clearSeqKv(s);
      }
    });
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
  // Clearing drops what is kept between requests too, without writing it,
  // like a single-prompt reset.
  for (uint32_t seqId = 0; seqId < parked_.size(); ++seqId) {
    if (parked_[seqId].has_value()) {
      parked_[seqId].reset();
      clearSeqKv(seqId);
    }
  }
  cancelKeyDeferredLocked();
  busyKeys_.clear();
  checkpointStore_.clear();
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
    const std::shared_ptr<BatchGroup>& group, std::exception_ptr error,
    SaveCachePolicy savePolicy) noexcept {
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
  // A slot can hold the only copy of turns its `cacheKey` file lacks, so only
  // state of unknown health (`Skip`) is cleared; see `SaveCachePolicy`.
  for (uint32_t seqId = 0; seqId < slots_.size(); seqId++) {
    if (slots_[seqId].has_value() && slots_[seqId]->group == group) {
      cancelSlotLocked(seqId, savePolicy);
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
                  "was requested)")),
          SaveCachePolicy::Save);
    }
  }
  cancelKeyDeferredLocked();
}

void ContinuousBatchScheduler::cancelKeyDeferredLocked() noexcept {
  std::deque<QueuedRequest> waiting;
  waiting.swap(keyDeferred_);
  for (QueuedRequest& queued : waiting) {
    if (queued.group) {
      failGroupLocked(
          queued.group,
          std::make_exception_ptr(
              qvac_errors::StatusError(
                  ADDON_ID,
                  qvac_lib_inference_addon_llama::errors::toString(
                      qvac_lib_inference_addon_llama::errors::Cancelled),
                  "ContinuousBatchScheduler: request cancelled before it "
                  "could run (waiting for an earlier request on its "
                  "cacheKey when cancel was requested)")),
          SaveCachePolicy::Save);
    }
  }
}

void ContinuousBatchScheduler::setRamTier(
    std::shared_ptr<SlotStateCache> ramTier) {
  std::scoped_lock lock(mutex_);
  ramTier_ = std::move(ramTier);
}

void ContinuousBatchScheduler::flushForUnload() {
  std::scoped_lock lock(mutex_);
  if (numActiveLocked() > 0) {
    logTeardownFailureNoexcept(
        "unload flush skipped: a batch request is still running");
    return;
  }
  for (uint32_t seqId = 0; seqId < parked_.size(); ++seqId) {
    auto& parked = parked_[seqId];
    if (!parked.has_value() || !parked->dirty || parked->ephemeral) {
      continue;
    }
    if (parked->activeCacheSavedToDisk &&
        persistedCacheBackingStoreMissing(parked->cacheKey)) {
      continue;
    }
    if (writeStateToFileLocked(
            seqId,
            parked->cacheKey,
            parked->ledgerWords,
            parked->checkpoints)) {
      parked->dirty = false;
      parked->activeCacheSavedToDisk = true;
    }
  }
}

std::vector<uint32_t> ContinuousBatchScheduler::parkedSeqIds() const {
  std::scoped_lock lock(mutex_);
  std::vector<uint32_t> ids;
  for (uint32_t seqId = 0; seqId < parked_.size(); ++seqId) {
    if (parked_[seqId].has_value()) {
      ids.push_back(seqId);
    }
  }
  return ids;
}

void ContinuousBatchScheduler::clearUnparkedSequences() {
  std::scoped_lock lock(mutex_);
  if (llama_memory_t mem = llama_get_memory(shared_.lctx); mem != nullptr) {
    const auto nSeqMax = static_cast<uint32_t>(llama_n_seq_max(shared_.lctx));
    for (uint32_t seqId = 0; seqId < nSeqMax; ++seqId) {
      if (seqId < parked_.size() && parked_[seqId].has_value()) {
        continue;
      }
      llama_memory_seq_rm(mem, static_cast<llama_seq_id>(seqId), -1, -1);
    }
  }
  llama_perf_context_reset(shared_.lctx);
}

void ContinuousBatchScheduler::evictParked(uint32_t seqId) {
  std::scoped_lock lock(mutex_);
  // A running slot may be mid-decode with the lock released; the sequence
  // then cannot be touched safely (and is not parked anyway).
  if (numActiveLocked() > 0) {
    return;
  }
  evictParkedLocked(seqId);
}

uint64_t ContinuousBatchScheduler::residentHitsForTesting() const {
  std::scoped_lock lock(mutex_);
  return residentHits_;
}

uint64_t ContinuousBatchScheduler::ramTierHitsForTesting() const {
  std::scoped_lock lock(mutex_);
  return ramTierHits_;
}

std::optional<uint32_t>
ContinuousBatchScheduler::chooseSeqIdLocked(const std::string& cacheKey) {
  // Free means neither the batcher nor the scheduler holds a request there
  // (see the note in `submitLocked` on the drain window).
  const auto isFree = [this](uint32_t seqId) {
    return batcher_.requestAt(seqId) == nullptr && !slots_[seqId].has_value();
  };
  const auto nSeq = static_cast<uint32_t>(slots_.size());
  if (!cacheKey.empty()) {
    for (uint32_t seqId = 0; seqId < nSeq; ++seqId) {
      if (isFree(seqId) && parked_[seqId].has_value() &&
          parked_[seqId]->cacheKey == cacheKey) {
        return seqId;
      }
    }
  }
  for (uint32_t seqId = 0; seqId < nSeq; ++seqId) {
    if (isFree(seqId) && !parked_[seqId].has_value()) {
      return seqId;
    }
  }
  std::optional<uint32_t> oldest;
  for (uint32_t seqId = 0; seqId < nSeq; ++seqId) {
    if (isFree(seqId) && parked_[seqId].has_value() &&
        (!oldest.has_value() ||
         parked_[seqId]->lastUse < parked_[*oldest]->lastUse)) {
      oldest = seqId;
    }
  }
  if (oldest.has_value()) {
    evictParkedLocked(*oldest);
  }
  return oldest;
}

void ContinuousBatchScheduler::evictParkedLocked(uint32_t seqId) noexcept {
  if (seqId >= parked_.size() || !parked_[seqId].has_value()) {
    return;
  }
  ParkedState parked = std::move(*parked_[seqId]);
  parked_[seqId].reset();
  try {
    // A caller that deleted the file this state came from dropped the
    // conversation; do not bring it back.
    const bool dropped = parked.activeCacheSavedToDisk &&
                         persistedCacheBackingStoreMissing(parked.cacheKey);
    // With the RAM tier on, the state moves there with its unsaved turns and
    // reaches the file only when the tier lets it go or the model unloads.
    bool inRam = false;
    if (!dropped && ramTier_ && ramTier_->enabled()) {
      const auto seq = static_cast<llama_seq_id>(seqId);
      const size_t size = llama_state_seq_get_size_ext(shared_.lctx, seq, 0);
      SlotStateCacheEntry entry;
      try {
        entry.state.resize(size);
      } catch (const std::bad_alloc&) {
        entry.state.clear();
      }
      if (size > 0 && entry.state.size() == size &&
          llama_state_seq_get_data_ext(
              shared_.lctx, entry.state.data(), size, seq, 0) == size) {
        entry.ledgerWords = parked.ledgerWords;
        entry.checkpoints = std::move(parked.checkpoints);
        entry.dirty = parked.dirty;
        entry.activeCacheSavedToDisk = parked.activeCacheSavedToDisk;
        entry.ephemeral = parked.ephemeral;
        inRam = ramTier_->insert(parked.cacheKey, std::move(entry));
        if (!inRam) {
          parked.checkpoints = std::move(entry.checkpoints);
        }
      }
    }
    // Otherwise unsaved turns go to the file now, the same auto-save the
    // single-prompt path does when it switches keys, so nothing is lost. An
    // ephemeral conversation is dropped instead.
    if (!dropped && !inRam && parked.dirty && !parked.ephemeral) {
      writeStateToFileLocked(
          seqId, parked.cacheKey, parked.ledgerWords, parked.checkpoints);
    }
    if (!dropped && !inRam && !parked.checkpoints.empty()) {
      storeCheckpointsLocked(parked.cacheKey, std::move(parked.checkpoints));
    }
  } catch (...) {
    logTeardownFailureNoexcept(
        "evicting a parked cache state failed", seqId, nullptr);
  }
  clearSeqKv(seqId);
}

bool ContinuousBatchScheduler::writeStateToFileLocked(
    uint32_t seqId, const std::string& cacheKey,
    const std::vector<llama_token>& ledgerWords,
    const cache::Checkpoints& checkpoints) noexcept {
  try {
    const std::string tmp = cacheKey + ".tmp";
    const size_t written = llama_state_seq_save_file(
        shared_.lctx,
        tmp.c_str(),
        static_cast<llama_seq_id>(seqId),
        ledgerWords.data(),
        ledgerWords.size());
    if (!CacheManager::savedCompletely(tmp, written)) {
      std::error_code ec;
      std::filesystem::remove(tmp, ec);
      logTeardownFailureNoexcept(
          "writing an evicted cache state to its cacheKey failed",
          seqId,
          cacheKey.c_str());
      return false;
    }
    (void)cache::appendCheckpointSection(tmp, checkpoints);
    CacheManager::atomicPromoteFile(tmp, cacheKey);
    return true;
  } catch (const std::exception& e) {
    logTeardownFailureNoexcept(
        "writing an evicted cache state to its cacheKey failed",
        seqId,
        e.what());
    return false;
  }
}

void ContinuousBatchScheduler::writeStateToFileOrThrowLocked(
    uint32_t seqId, const std::string& cacheKey,
    const std::vector<llama_token>& ledgerWords,
    const cache::Checkpoints& checkpoints) {
  const std::string tmp = cacheKey + ".tmp";
  const size_t written = llama_state_seq_save_file(
      shared_.lctx,
      tmp.c_str(),
      static_cast<llama_seq_id>(seqId),
      ledgerWords.data(),
      ledgerWords.size());
  if (!CacheManager::savedCompletely(tmp, written)) {
    std::error_code ec;
    std::filesystem::remove(tmp, ec);
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_lib_inference_addon_llama::errors::toString(
            qvac_lib_inference_addon_llama::errors::UnableToSaveSessionFile),
        "failed to save session file to '" + cacheKey + "'");
  }
  (void)cache::appendCheckpointSection(tmp, checkpoints);
  CacheManager::atomicPromoteFile(tmp, cacheKey);
}

std::future<SlotStateCache::SaveOutcome>
ContinuousBatchScheduler::enqueueSaveJob(
    const std::string& cacheKey, bool discard) {
  auto job = std::make_shared<SaveJob>();
  job->cacheKey = cacheKey;
  job->discard = discard;
  std::future<SlotStateCache::SaveOutcome> done = job->done.get_future();
  {
    std::scoped_lock lock(mutex_);
    if (stopping_) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          std::string(discard ? "discardCache" : "saveCache") +
              ": the model is being unloaded");
    }
    ensureWorkerStartedLocked();
    saveJobs_.push_back(std::move(job));
  }
  workCv_.notify_all();
  return done;
}

SlotStateCache::SaveOutcome
ContinuousBatchScheduler::saveConversation(const std::string& cacheKey) {
  return enqueueSaveJob(cacheKey, /*discard=*/false).get();
}

void ContinuousBatchScheduler::discardConversation(
    const std::string& cacheKey) {
  (void)enqueueSaveJob(cacheKey, /*discard=*/true).get();
}

void ContinuousBatchScheduler::discardKeyLocked(
    const std::string& cacheKey) noexcept {
  for (uint32_t seqId = 0; seqId < parked_.size(); ++seqId) {
    if (parked_[seqId].has_value() && parked_[seqId]->cacheKey == cacheKey) {
      parked_[seqId].reset();
      clearSeqKv(seqId);
    }
  }
  checkpointStore_.erase(cacheKey);
  if (ramTier_) {
    (void)ramTier_->take(cacheKey);
  }
}

bool ContinuousBatchScheduler::hasRunnableSaveJobLocked() const noexcept {
  return std::ranges::any_of(saveJobs_, [this](const auto& job) {
    return !busyKeys_.contains(job->cacheKey);
  });
}

void ContinuousBatchScheduler::serviceSaveJobsLocked() noexcept {
  for (auto it = saveJobs_.begin(); it != saveJobs_.end();) {
    const std::shared_ptr<SaveJob> job = *it;
    // A request on this key is still in a slot: its state is not committed
    // yet. The save runs once that request has finished.
    if (busyKeys_.contains(job->cacheKey)) {
      ++it;
      continue;
    }
    it = saveJobs_.erase(it);
    try {
      if (job->discard) {
        discardKeyLocked(job->cacheKey);
        job->done.set_value(SlotStateCache::SaveOutcome::NotHere);
        continue;
      }
      SlotStateCache::SaveOutcome outcome =
          SlotStateCache::SaveOutcome::NotHere;
      for (uint32_t seqId = 0; seqId < parked_.size(); ++seqId) {
        auto& parked = parked_[seqId];
        if (!parked.has_value() || parked->cacheKey != job->cacheKey) {
          continue;
        }
        if (!parked->dirty && parked->activeCacheSavedToDisk &&
            !persistedCacheBackingStoreMissing(parked->cacheKey)) {
          outcome = SlotStateCache::SaveOutcome::Current;
        } else {
          writeStateToFileOrThrowLocked(
              seqId,
              parked->cacheKey,
              parked->ledgerWords,
              parked->checkpoints);
          parked->dirty = false;
          parked->activeCacheSavedToDisk = true;
          outcome = SlotStateCache::SaveOutcome::Written;
        }
        break;
      }
      if (outcome == SlotStateCache::SaveOutcome::NotHere && ramTier_) {
        outcome = ramTier_->save(job->cacheKey);
      }
      job->done.set_value(outcome);
    } catch (...) {
      try {
        job->done.set_exception(std::current_exception());
      } catch (...) {
      }
    }
  }
}

void ContinuousBatchScheduler::failSaveJobsLocked() noexcept {
  for (const auto& job : saveJobs_) {
    try {
      job->done.set_exception(
          std::make_exception_ptr(
              qvac_errors::StatusError(
                  ADDON_ID,
                  qvac_errors::general_error::toString(
                      qvac_errors::general_error::InvalidArgument),
                  std::string(job->discard ? "discardCache" : "saveCache") +
                      ": the model was unloaded before it ran")));
    } catch (...) {
    }
  }
  saveJobs_.clear();
}

void ContinuousBatchScheduler::notifyDone(uint32_t seqId) {
  // Normal-completion path: a throwing onDone propagates so the worker loop
  // fails the batch (failGroupLocked) instead of completing it as a success;
  // teardown paths use notifyDoneNoexcept. The throw then skips freeSlot below,
  // so recovery re-runs teardown (onCancel/saveCache/onDone) on this slot. That
  // is benign and only happens when onDone itself threw: the re-run sees an
  // already-finalized request and an already-flushed UTF-8 buffer, recovery's
  // onCancel({}) re-emits nothing, and saveCache just rewrites the same file.
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

void ContinuousBatchScheduler::storeCheckpointsLocked(
    const std::string& cacheKey, cache::Checkpoints&& checkpoints) {
  checkpointStore_.erase(cacheKey);
  while (!checkpointStore_.empty() &&
         checkpointStore_.size() >= std::max<size_t>(1, slots_.size())) {
    auto oldest = checkpointStore_.begin();
    for (auto it = checkpointStore_.begin(); it != checkpointStore_.end();
         ++it) {
      if (it->second.storedAt < oldest->second.storedAt) {
        oldest = it;
      }
    }
    checkpointStore_.erase(oldest);
  }
  checkpointStore_.emplace(
      cacheKey,
      StoredCheckpoints{
          .checkpoints = std::move(checkpoints),
          .storedAt = ++checkpointClock_});
}

void ContinuousBatchScheduler::freeSlot(uint32_t seqId) noexcept {
  if (seqId < slots_.size()) {
    auto& slot = slots_[seqId];
    // Every teardown path frees here, after the driver finalized, so this is
    // where the request's state and checkpoints outlive its driver: parked
    // in the sequence when the request committed coherent keyed state,
    // otherwise the checkpoints alone are kept for the key.
    if (slot.has_value() && slot->driver && !slot->cacheKey.empty()) {
      busyKeys_.erase(slot->cacheKey);
      try {
        std::vector<llama_token> words;
        if (slot->parkable) {
          words = slot->driver->residentStateTokens();
        }
        cache::Checkpoints checkpoints = slot->driver->releaseCheckpoints();
        if (!words.empty()) {
          parked_[seqId] = ParkedState{
              .cacheKey = slot->cacheKey,
              .ledgerWords = std::move(words),
              .checkpoints = std::move(checkpoints),
              // A committed request added turns the file lacks; a rolled-back
              // one left the conversation as it was adopted.
              .dirty = slot->parkAsAdopted ? slot->adoptedDirty : true,
              .activeCacheSavedToDisk = slot->activeCacheSavedToDisk,
              .ephemeral = slot->parkAsAdopted ? slot->adoptedEphemeral
                                               : slot->ephemeral,
              .lastUse = ++parkClock_};
        } else {
          if (slot->parkable) {
            clearSeqKv(seqId);
          }
          if (!checkpoints.empty()) {
            storeCheckpointsLocked(slot->cacheKey, std::move(checkpoints));
          }
        }
      } catch (...) {
        logTeardownFailureNoexcept(
            "free: keeping the cache state failed", seqId, nullptr);
        parked_[seqId].reset();
        clearSeqKv(seqId);
      }
    }
    slot.reset();
  }
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
    // Summed like the token counts rather than averaged: a multi-item group's
    // caller asked one question, and "two of my renders dropped their tools"
    // is the honest answer to it.
    agg.toolDefinitionsDropped += stats.toolDefinitionsDropped;
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
  int64_t toolsDropped = 0;
  // Read after the caller has finalized the driver, so a finished sequence
  // reports its terminal reason; a cancelled/prefill-only slot reports None.
  std::optional<GenerationStopReason> stopReason;
  if (slot.driver) {
    // The terminal hook has already settled the driver: a cached request
    // cancelled during generation keeps its tokens (committed), one cancelled
    // during prefill or failed is rolled back to the admission cursor, so
    // `CacheTokens` matches the live driver cursor either way. Work performed
    // is still reported via `promptTokens` / `generatedTokens`.
    nPast = static_cast<int64_t>(slot.driver->getNPast());
    toolsDropped =
        static_cast<int64_t>(slot.driver->getToolDefinitionsDropped());
    stopReason = slot.driver->getGenerationStopReason();
  }
  stats_.accumulateSlot(nPast, toolsDropped, req);
  // Every terminal path that folds a slot into the aggregate also records the
  // request's observed end-to-end figures for its submitter, next to its
  // output.
  if (slot.group) {
    ObservedRequestStats observed =
        computeObservedStats(slot.enqueuedAt, req, stopReason);
    // Set here rather than inside `computeObservedStats`, which is a pure
    // function of the request's own stamps: these two come off the slot driver,
    // which only this function holds. The same two values also go into the
    // scheduler-wide accumulator above — that copy stays, for the whole-model
    // `runtimeStats()` read.
    observed.toolDefinitionsDropped = toolsDropped;
    slot.group->requestStats[slot.outputIndex] = std::move(observed);
  }
}

} // namespace qvac_lib_inference_addon_llama::batching
