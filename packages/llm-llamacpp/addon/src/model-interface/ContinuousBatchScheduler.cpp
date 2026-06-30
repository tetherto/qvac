#include "ContinuousBatchScheduler.hpp"

#include <algorithm>
#include <cassert>
#include <chrono>
#include <cstdlib>
#include <exception>
#include <filesystem>
#include <optional>
#include <ranges>
#include <stdexcept>
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

} // namespace

void finalizeTerminalDriver(
    SequenceDriver& driver, StopReason reason, bool prefillOnly,
    const std::function<void(const std::string&)>& outputCallback) {
  if (reason == StopReason::Cancelled || reason == StopReason::DecodeError) {
    driver.onCancel(outputCallback);
  } else if (prefillOnly) {
    driver.onSequenceEnd(outputCallback);
  } else {
    driver.onGenerationFinished(outputCallback);
  }
}

bool computeSlideCapable(
    const SequenceDriver& driver, bool slideConfigured, bool isPrefill) {
  return slideConfigured && !isPrefill && driver.supportsSliding();
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

ContinuousBatchScheduler::ContinuousBatchScheduler(
    LlmModelContext shared, unsigned maxChunkSize, unsigned ctxTotalTokens,
    size_t batchSize, int32_t batchCapacity, const common_params& baseParams,
    llama_pos configuredNDiscarded,
    std::optional<ToolsCompactProfile> toolsCompactProfile,
    DriverFactory driverFactory)
    : shared_(shared), baseSampling_(baseParams.sampling),
      baseNPredict_(baseParams.n_predict), baseParams_(baseParams),
      configuredNDiscarded_(configuredNDiscarded),
      toolsCompactProfile_(std::move(toolsCompactProfile)),
      driverFactory_(std::move(driverFactory)),
      perSeqMaxTokens_(perSeqCeiling(ctxTotalTokens, batchSize)),
      batcher_(maxChunkSize, perSeqMaxTokens_, batchSize),
      batch_(batchCapacity, 0, static_cast<int32_t>(batchSize)),
      slots_(batchSize), decodeFunc_([](llama_context* ctx, llama_batch& b) {
        return llama_decode(ctx, b);
      }),
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
  if (configuredNDiscarded_ >= static_cast<llama_pos>(perSeqMaxTokens_)) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "[ContinuousBatchScheduler] n_discarded=%d >= per-sequence cap "
            "%u (ctxTotalTokens / n_parallel); it will be clamped below the "
            "per-slot window. Lower n_discarded or grow n_ctx / n_parallel.\n",
            configuredNDiscarded_,
            perSeqMaxTokens_));
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

BatchResult
ContinuousBatchScheduler::processBatch(std::vector<SubmitRequest>&& requests) {
  auto group = std::make_shared<BatchGroup>(requests.size());
  group->totalCount = requests.size();
  if (requests.empty()) {
    return {.outputs = {}, .stats = runtimeStats()};
  }

  std::unique_lock lock(mutex_);
  if (pending_.size_approx() == 0 && !hasWorkLocked()) {
    stats_.reset();
  }
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
  if (group->error) {
    std::rethrow_exception(group->error);
  }
  return {.outputs = std::move(group->outputs), .stats = group->stats};
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
  }
}

void ContinuousBatchScheduler::workerLoop() {
  std::unique_lock lock(mutex_);
  while (true) {
    workCv_.wait(lock, [this] {
      return stopping_ || cancelRequested_.load() ||
             !pendingSlotCancels_.empty() || clearRequested_ ||
             pending_.size_approx() > 0 || hasWorkLocked();
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
  auto tools = std::make_unique<ToolsCompactController>(toolsCompactProfile_);
  std::unique_ptr<SequenceDriver> driver = driverFactory_(
      tmpParams, *tools, seqId, static_cast<llama_pos>(perSeqMaxTokens_));

  // `applyGenerationParamsToContext` above resolves the sampling/n_predict/
  // reasoning_budget overrides into `tmpParams` (which the driver copies),
  // but `remove_thinking_from_context` is a TextLlmContext-level toggle that
  // sits outside `common_params`. Apply it directly to the slot driver here.
  // No restore needed: the driver is destroyed when the slot is freed.
  if (request.overrides.remove_thinking_from_context) {
    driver->setRemoveThinkingFromContext(
        *request.overrides.remove_thinking_from_context);
  }

  bool hasKvCacheContext = false;
  if (!request.cacheKey.empty()) {
    std::error_code ec;
    const auto size = std::filesystem::file_size(request.cacheKey, ec);
    if (!ec && size != 0) {
      hasKvCacheContext = true;
    }
  }

  driver->validatePromptPolicy(
      request.chatMsgs, request.tools, request.layout, hasKvCacheContext);

  const bool isCacheLoaded =
      driver->loadCache(request.cacheKey, configuredNDiscarded_);

  ScopeGuard cacheGuard([this, seqId] { clearSeqKv(seqId); });

  PrefillPlan plan = driver->preparePrefill(
      request.chatMsgs,
      request.tools,
      request.media,
      request.mediaPlan,
      isCacheLoaded,
      request.prefill);

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
  const bool slideCapable =
      computeSlideCapable(*driver, configuredNDiscarded_ > 0, request.prefill);
  if (auto status = batcher_.addRequestAt(
          seqId,
          std::move(plan),
          driver->getNPast(),
          slideCapable,
          driver->getKvCellsUsed());
      status != MultiRequestBatcher::AddStatus::Ok) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        "ContinuousBatchScheduler::submit: failed to add to batch "
        "(MultiRequestBatcher::AddStatus=" +
            std::to_string(static_cast<int>(status)) + ")");
  }
  slots_[seqId].emplace(
      SlotState{
          .streams = std::move(streamsLocal),
          .tools = std::move(tools),
          .driver = std::move(driver),
          .cacheKey = std::move(request.cacheKey),
          .group = std::move(queued.group),
          .outputIndex = queued.outputIndex,
          .saveCacheToDisk = request.saveCacheToDisk,
          .prefillOnly = request.prefill});
  cacheGuard.dismiss();
  return seqId;
}

bool ContinuousBatchScheduler::step() {
  std::unique_lock lock(mutex_);
  return stepLocked(&lock);
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
      finalizeTerminalDriver(
          *slot.driver, req.stopReason, slot.prefillOnly, {});
    }
    clearSeqKv(req.seqId);
    notifyDone(req.seqId);
    freeSlot(req.seqId);
  }
}

MultiRequestBatcher::PrefillCompleteFn
ContinuousBatchScheduler::prefillCompleteFn() {
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
    slot->driver->onCancel({});
    if (const Request* req = batcher_.requestAt(seqId); req != nullptr) {
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
    } catch (...) {
      error = std::current_exception();
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

void ContinuousBatchScheduler::drainFinishedLocked() {
  auto finished = batcher_.extractFinished();
  for (const auto& req : finished | std::views::filter(hasValidDriverF())) {
    auto& slot = *slots_[req.seqId];
    auto outputCallback = getOutputCallback(slot, req.seqId);
    finalizeTerminalDriver(
        *slot.driver, req.stopReason, slot.prefillOnly, outputCallback);
    accumulateSlotRuntimeStats(slot, req);
    saveCacheForSlot(req.seqId, *slots_[req.seqId]);
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
    drainFinishedLocked();
    return true;
  }

  int decodeRc = 0;
  std::chrono::steady_clock::duration decodeDuration{};
  {
    StepUnlockGuard unlockGuard(*this, lock);
    const auto decodeStart = std::chrono::steady_clock::now();
    decodeRc = decodeFunc_(shared_.lctx, *batch_);
    decodeDuration = std::chrono::steady_clock::now() - decodeStart;
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
      if (result.discarded > 0) {
        batcher_.applySlide(seqId, result.discarded);
      }
      if (result.contextOverflow) {
        // The slot's window is full and the driver could not slide; stop
        // this one sequence at its cap like a LimitReached truncation
        // instead of failing the whole batch.
        batcher_.markFinished(seqId, StopReason::LimitReached);
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

  drainFinishedLocked();

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
  if (decodeTokens > 0) {
    decodeTimeMs_ += stepMs;
    decodeTokenCount_ += decodeTokens;
  } else {
    prefillTimeMs_ += stepMs;
    prefillTokenCount_ += prefillTokens;
  }
}

void RuntimeStatsSnapshot::accumulateSlot(
    int64_t nPast, int64_t nSlides, int64_t thinkingDiscards,
    const Request& req) {
  cacheTokens += nPast;
  contextSlides += nSlides;
  thinkingBlockDiscards += thinkingDiscards;
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

bool ContinuousBatchScheduler::cancel(uint32_t seqId) {
  std::scoped_lock lock(mutex_);
  const bool occupied = seqId < slots_.size() && slots_[seqId].has_value();
  if (occupied) {
    if (workerStarted_ && !stopping_) {
      pendingSlotCancels_.push_back(seqId);
      workCv_.notify_all();
    } else {
      cancelSlotLocked(seqId);
    }
  }
  return occupied;
}

void ContinuousBatchScheduler::cancelSlotLocked(uint32_t seqId) noexcept {
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
    try {
      slots_[seqId]->driver->onCancel({});
      if (req != nullptr) {
        accumulateSlotRuntimeStats(*slots_[seqId], *req);
      }
      saveCacheForSlot(seqId, *slots_[seqId]);
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
  for (const uint32_t seqId : pendingSlotCancels_) {
    cancelSlotLocked(seqId);
  }
  pendingSlotCancels_.clear();
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
  if (workerStarted_ && !stopping_) {
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
  for (uint32_t seqId = 0; seqId < slots_.size(); seqId++) {
    if (slots_[seqId].has_value() && slots_[seqId]->group == group) {
      cancelSlotLocked(seqId);
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
  // is benign and only happens when onDone itself threw: onGenerationFinished's
  // generationStarted_ guard makes the re-run a no-op, recovery's onCancel({})
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
    uint32_t seqId, const SlotState& slot) {
  if (!slot.saveCacheToDisk || slot.cacheKey.empty() || !slot.driver) {
    return;
  }
  (void)seqId;
  slot.driver->saveCache(slot.cacheKey);
}

void ContinuousBatchScheduler::accumulateSlotRuntimeStats(
    const SlotState& slot, const Request& req) {
  int64_t nPast = 0;
  int64_t nSlides = 0;
  int64_t thinkingDiscards = 0;
  if (slot.driver) {
    nPast = static_cast<int64_t>(slot.driver->getNPast());
    nSlides = static_cast<int64_t>(slot.driver->getNSlides());
    thinkingDiscards =
        static_cast<int64_t>(slot.driver->getThinkingBlockDiscards());
  }
  stats_.accumulateSlot(nPast, nSlides, thinkingDiscards, req);
}

} // namespace qvac_lib_inference_addon_llama::batching
