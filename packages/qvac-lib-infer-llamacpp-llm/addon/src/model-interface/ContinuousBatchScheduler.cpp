#include "ContinuousBatchScheduler.hpp"

#include <algorithm>
#include <chrono>
#include <exception>
#include <optional>
#include <stdexcept>
#include <thread>
#include <utility>

#include <common/common.h>
#include <llama.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "GenerationParamsApply.hpp"
#include "TextLlmContext.hpp"
#include "addon/LlmErrors.hpp"

namespace qvac_lib_inference_addon_llama::batching {

using qvac_lib_inference_addon_llama::errors::ADDON_ID;

namespace {

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

ContinuousBatchScheduler::ContinuousBatchScheduler(
    LlmModelContext shared, unsigned maxChunkSize, unsigned ctxTotalTokens,
    size_t batchSize, int32_t batchCapacity, const common_params& baseParams,
    llama_pos configuredNDiscarded,
    std::optional<ToolsCompactProfile> toolsCompactProfile)
    : shared_(shared),
      baseSampling_(baseParams.sampling),
      baseNPredict_(baseParams.n_predict),
      baseParams_(baseParams),
      configuredNDiscarded_(configuredNDiscarded),
      toolsCompactProfile_(std::move(toolsCompactProfile)),
      perSeqMaxTokens_(perSeqCeiling(ctxTotalTokens, batchSize)),
      batcher_(maxChunkSize, perSeqMaxTokens_, batchSize),
      batch_(batchCapacity, 0, static_cast<int32_t>(batchSize)),
      slots_(batchSize) {

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

BatchResult
ContinuousBatchScheduler::processBatch(std::vector<SubmitRequest>&& requests) {
  auto group = std::make_shared<BatchGroup>(requests.size());
  group->totalCount = requests.size();
  if (requests.empty()) {
    return {.outputs = {}, .stats = runtimeStats()};
  }

  std::unique_lock lock(mutex_);
  if (pending_.empty() && !hasWorkLocked()) {
    stats_.reset();
  }
  ensureWorkerStartedLocked();
  for (size_t i = 0; i < requests.size(); i++) {
    pending_.push_back(QueuedRequest{
        .request = std::move(requests[i]), .group = group, .outputIndex = i});
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
      return stopping_ || cancelRequested_.load() || !pending_.empty() ||
             hasWorkLocked();
    });
    if (stopping_) {
      break;
    }
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
      const std::exception_ptr error = std::current_exception();
      std::vector<std::shared_ptr<BatchGroup>> activeGroups;
      for (const auto& slot : slots_) {
        if (slot.has_value() && slot->group) {
          activeGroups.push_back(slot->group);
        }
      }
      for (const auto& group : activeGroups) {
        failGroupLocked(group, error);
      }
      std::vector<std::shared_ptr<BatchGroup>> pendingGroups;
      for (const auto& queued : pending_) {
        if (queued.group) {
          pendingGroups.push_back(queued.group);
        }
      }
      for (const auto& group : pendingGroups) {
        failGroupLocked(group, error);
      }
      pending_.clear();
      clearLocked();
      cancelRequested_.store(false);
    }
    admitPendingIntoFreeSlotsLocked();
  }
  cancelPendingLocked();
  clearLocked();
}

void ContinuousBatchScheduler::admitPendingIntoFreeSlotsLocked() {
  while (!pending_.empty() && batcher_.firstFreeSeqId().has_value()) {
    QueuedRequest queued = std::move(pending_.front());
    const std::shared_ptr<BatchGroup> group = queued.group;
    pending_.pop_front();
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
  // Resolve per-request sampling/cap from base + overrides without
  // touching context state. Drive a *local* `common_params` and an
  // empty `CommonSamplerPtr` through `applyGenerationParamsToContext`
  // to reuse its atomic-commit + validation logic as-is.
  //
  // The returned restore lambda is intentionally discarded: it only
  // captures `&tmpParams` and `&overrideSampler` (both about to go out
  // of scope) plus by-value snapshots of the baseline. `std::function`
  // destruction *does not* invoke the body, only destroys captures —
  // so dropping the lambda is safe. It must NOT be called outside this
  // block: the references it captures would dangle.
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

  // `n_predict` is a per-request *generation budget* (max tokens to
  // emit, llama.cpp's common_params semantics) — it lives entirely in
  // the scheduler's per-slot state. The batcher only knows about its
  // ctor-level `maxTokensPerSequence` ceiling, which still guards the
  // KV pool. `<=0` means "no scheduler-level cap, batcher ceiling wins".
  //
  // The per-seq cap is a hard invariant of the partitioned KV pool, not
  // a hint: silently clamping would let callers ask for 10k tokens and
  // get 50, which is a footgun. Same policy as the prompt-size check
  // below — overrun is an admit-time error, not a soft truncation.
  const auto maybeSeqId = batcher_.firstFreeSeqId();
  if (!maybeSeqId.has_value()) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        "ContinuousBatchScheduler::submit: failed to add to batch "
        "(MultiRequestBatcher::AddStatus=" +
            std::to_string(
                static_cast<int>(MultiRequestBatcher::AddStatus::ErrNoFreeSlot)) +
            ")");
  }
  const uint32_t seqId = *maybeSeqId;
  auto tools = std::make_unique<ToolsCompactController>(toolsCompactProfile_);
  std::unique_ptr<SequenceDriver> driver =
      std::make_unique<TextLlmContext>(tmpParams, shared_, *tools, seqId);
  const bool isCacheLoaded =
      driver->loadCache(request.cacheKey, configuredNDiscarded_);
  const bool hasKvCacheContext = isCacheLoaded || driver->getNPast() > 0;
  driver->validatePromptPolicy(
      request.chatMsgs, request.tools, request.layout, hasKvCacheContext);
  auto tokens = driver->preparePrefill(
      request.chatMsgs, request.tools, isCacheLoaded, request.prefill);

  const auto promptSize =
      static_cast<unsigned>(driver->getNPast()) +
      static_cast<unsigned>(tokens.size());
  if (!request.prefill && promptSize >= perSeqMaxTokens_) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        "ContinuousBatchScheduler::submit: prompt of " +
            std::to_string(promptSize) + " tokens leaves no room under "
            "per-sequence cap " + std::to_string(perSeqMaxTokens_) +
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
  if (!request.prefill && tmpParams.n_predict > 0 &&
      promptSize + static_cast<unsigned>(tmpParams.n_predict) >
          perSeqMaxTokens_) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        "ContinuousBatchScheduler::submit: n_predict " +
            std::to_string(tmpParams.n_predict) + " + prompt " +
            std::to_string(promptSize) +
            " exceeds per-sequence cap " +
            std::to_string(perSeqMaxTokens_) +
            " (ctxTotalTokens / n_parallel)");
  }

  StreamCallbacks streamsLocal = std::move(request.streams);
  if (auto status =
          batcher_.addRequestAt(seqId, std::move(tokens), driver->getNPast());
      status != MultiRequestBatcher::AddStatus::Ok) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        "ContinuousBatchScheduler::submit: failed to add to batch "
        "(MultiRequestBatcher::AddStatus=" +
            std::to_string(static_cast<int>(status)) + ")");
  }
  slots_[seqId].emplace(SlotState{
      .streams = std::move(streamsLocal),
      .tools = std::move(tools),
      .driver = std::move(driver),
      .cacheKey = std::move(request.cacheKey),
      .group = std::move(queued.group),
      .outputIndex = queued.outputIndex,
      .saveCacheToDisk = request.saveCacheToDisk,
      .prefillOnly = request.prefill});
  return seqId;
}

bool ContinuousBatchScheduler::step() {
  std::unique_lock lock(mutex_);
  return stepLocked(&lock);
}

bool ContinuousBatchScheduler::stepLocked(std::unique_lock<std::mutex>* lock) {
  const auto fillResult = batcher_.fillBatch(batch_);
  if (fillResult.chunkSize == 0) {
    return true;
  }

  if (lock != nullptr) {
    lock->unlock();
  }
  const int decodeRc = llama_decode(shared_.lctx, *batch_);
  if (lock != nullptr) {
    lock->lock();
  }

  if (decodeRc != 0) {
    batcher_.markAllFinished(StopReason::DecodeError);
    auto kvClear = [this](uint32_t seqId) {
      llama_memory_t mem = llama_get_memory(shared_.lctx);
      if (mem != nullptr) {
        llama_memory_seq_rm(mem, static_cast<llama_seq_id>(seqId), -1, -1);
      }
    };
    auto finished = batcher_.extractFinished(kvClear);
    for (const auto& req : finished) {
      if (slots_[req.seqId].has_value() && slots_[req.seqId]->driver) {
        slots_[req.seqId]->driver->onSequenceEnd({});
      }
      notifyDone(req.seqId);
      freeSlot(req.seqId);
    }
    return false;
  }
  stats_.recordDecodeStep(fillResult.numActiveSequences);

  batcher_.advance(
      fillResult.chunkSize,
      [this](
          uint32_t seqId, llama_pos currentPos, size_t prefillTokenCount) {
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
      });

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
      const SequenceStepResult result =
          slot->driver->onLogitsReady(
              logitIdx, generatedAfterAccept, outputCallback);
      if (result.contextOverflow) {
        throw qvac_errors::StatusError(
            ADDON_ID,
            qvac_lib_inference_addon_llama::errors::toString(
                qvac_lib_inference_addon_llama::errors::ContextOverflow),
            "ContinuousBatchScheduler::step: context overflow for seqId " +
                std::to_string(seqId));
      }
      if (result.finished) {
        batcher_.markFinished(seqId);
      }
      return result.token;
    });
  }

  if (cancelRequested_.exchange(false)) {
    batcher_.markAllFinished(StopReason::Cancelled);
  }

  auto kvClear = [this](uint32_t seqId) {
    auto* mem = llama_get_memory(shared_.lctx);
    if (mem != nullptr) {
      llama_memory_seq_rm(mem, static_cast<llama_seq_id>(seqId), -1, -1);
    }
  };
  auto finished = batcher_.extractFinished();
  for (const auto& req : finished) {
    if (slots_[req.seqId].has_value() && slots_[req.seqId]->driver) {
      auto& slot = *slots_[req.seqId];
      auto outputCallback = [&slot, seqId = req.seqId](const std::string& text) {
        if (slot.group) {
          slot.group->outputs[slot.outputIndex] += text;
        }
        if (slot.streams.onToken) {
          slot.streams.onToken(seqId, text);
        }
      };
      if (req.stopReason == StopReason::Cancelled) {
        slot.driver->onCancel(outputCallback);
      } else if (slot.prefillOnly) {
        slot.driver->onSequenceEnd(outputCallback);
      } else {
        slot.driver->onGenerationFinished(outputCallback);
      }
      accumulateSlotRuntimeStats(slot, req);
      saveCacheForSlot(req.seqId, *slots_[req.seqId]);
    }
    kvClear(req.seqId);
    notifyDone(req.seqId);
    freeSlot(req.seqId);
  }

  return true;
}

bool ContinuousBatchScheduler::hasWork() const {
  std::scoped_lock lock(mutex_);
  return hasWorkLocked();
}

bool ContinuousBatchScheduler::hasWorkLocked() const {
  return numActiveLocked() > 0;
}

unsigned ContinuousBatchScheduler::numActive() const {
  std::scoped_lock lock(mutex_);
  return numActiveLocked();
}

unsigned ContinuousBatchScheduler::numActiveLocked() const {
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

void RuntimeStatsSnapshot::recordDecodeStep(uint64_t numActiveSequences) {
  decodeStepCount_++;
  concurrentSeqSum_ += numActiveSequences;
}

void RuntimeStatsSnapshot::accumulateSlot(
    int64_t nPast, int64_t nSlides, const Request& req) {
  cacheTokens += nPast;
  contextSlides += nSlides;
  generatedTokens += static_cast<int64_t>(req.generatedTokens.size());
  promptTokens += static_cast<int64_t>(req.prefillTokenCount);
}

double RuntimeStatsSnapshot::avgConcurrentSeq() const {
  return decodeStepCount_ > 0
             ? static_cast<double>(concurrentSeqSum_) /
                   static_cast<double>(decodeStepCount_)
             : 0.0;
}

double RuntimeStatsSnapshot::elapsedMs() const {
  const auto elapsed = std::chrono::steady_clock::now() - start_;
  return std::chrono::duration<double, std::milli>(elapsed).count();
}

bool ContinuousBatchScheduler::cancel(uint32_t seqId) {
  std::scoped_lock lock(mutex_);
  bool occupied = seqId < slots_.size() && slots_[seqId].has_value();
  if (occupied) {
    const Request* req = batcher_.requestAt(seqId);
    if (slots_[seqId]->driver) {
      slots_[seqId]->driver->onCancel({});
      if (req != nullptr) {
        accumulateSlotRuntimeStats(*slots_[seqId], *req);
      }
      saveCacheForSlot(seqId, *slots_[seqId]);
    }
    notifyDone(seqId);
    auto kvClear = [this](uint32_t s) {
      auto* mem = llama_get_memory(shared_.lctx);
      if (mem != nullptr) {
        llama_memory_seq_rm(mem, static_cast<llama_seq_id>(s), -1, -1);
      }
    };
    batcher_.cancel(seqId, kvClear);
    freeSlot(seqId);
  }
  return occupied;
}

void ContinuousBatchScheduler::requestCancelAll() {
  cancelRequested_.store(true);
  workCv_.notify_all();
}

void ContinuousBatchScheduler::clear() {
  std::scoped_lock lock(mutex_);
  clearLocked();
}

void ContinuousBatchScheduler::clearLocked() {
  for (uint32_t seqId = 0; seqId < slots_.size(); seqId++) {
    if (slots_[seqId].has_value()) {
      if (slots_[seqId]->driver) {
        slots_[seqId]->driver->onSequenceEnd({});
      }
      notifyDone(seqId);
      freeSlot(seqId);
    }
  }
  auto kvClear = [this](uint32_t s) {
    auto* mem = llama_get_memory(shared_.lctx);
    if (mem != nullptr) {
      llama_memory_seq_rm(mem, static_cast<llama_seq_id>(s), -1, -1);
    }
  };
  batcher_.clear(kvClear);
}

void ContinuousBatchScheduler::completeGroupRequestLocked(
    const std::shared_ptr<BatchGroup>& group) {
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
    const std::shared_ptr<BatchGroup>& group, std::exception_ptr error) {
  if (!group || group->done) {
    return;
  }
  group->error = error;
  group->stats = stats_;
  group->done = true;
  pending_.erase(
      std::remove_if(
          pending_.begin(),
          pending_.end(),
          [&group](const QueuedRequest& queued) {
            return queued.group == group;
          }),
      pending_.end());

  auto kvClear = [this](uint32_t seqId) {
    auto* mem = llama_get_memory(shared_.lctx);
    if (mem != nullptr) {
      llama_memory_seq_rm(mem, static_cast<llama_seq_id>(seqId), -1, -1);
    }
  };
  for (uint32_t seqId = 0; seqId < slots_.size(); seqId++) {
    if (slots_[seqId].has_value() && slots_[seqId]->group == group) {
      if (slots_[seqId]->driver) {
        slots_[seqId]->driver->onCancel({});
        if (const Request* req = batcher_.requestAt(seqId); req != nullptr) {
          accumulateSlotRuntimeStats(*slots_[seqId], *req);
        }
        saveCacheForSlot(seqId, *slots_[seqId]);
      }
      notifyDone(seqId);
      batcher_.cancel(seqId, kvClear);
      freeSlot(seqId);
    }
  }
  workCv_.notify_all();
}

void ContinuousBatchScheduler::cancelPendingLocked() {
  while (!pending_.empty()) {
    QueuedRequest queued = std::move(pending_.front());
    pending_.pop_front();
    completeGroupRequestLocked(queued.group);
  }
}

void ContinuousBatchScheduler::notifyDone(uint32_t seqId) {
  auto& slot = slots_[seqId];
  if (slot.has_value() && slot->streams.onDone) {
    slot->streams.onDone(seqId);
  }
  if (slot.has_value() && slot->group) {
    completeGroupRequestLocked(slot->group);
  }
}

void ContinuousBatchScheduler::freeSlot(uint32_t seqId) {
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
  if (slot.driver) {
    nPast = static_cast<int64_t>(slot.driver->getNPast());
    nSlides = static_cast<int64_t>(slot.driver->getNSlides());
  }
  stats_.accumulateSlot(nPast, nSlides, req);
}

} // namespace qvac_lib_inference_addon_llama::batching
