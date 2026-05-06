#include "ContinuousBatchScheduler.hpp"

#include <algorithm>
#include <chrono>
#include <optional>
#include <stdexcept>
#include <utility>

#include <common/common.h>
#include <llama.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "GenerationParamsApply.hpp"
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
    llama_context* ctx, llama_model* model, unsigned maxChunkSize,
    unsigned ctxTotalTokens, size_t batchSize, int32_t batchCapacity,
    const common_params& baseParams, llama_pos configuredNDiscarded,
    std::optional<ToolsCompactProfile> toolsCompactProfile)
    : ctx_(ctx), model_(model),
      vocab_(model != nullptr ? llama_model_get_vocab(model) : nullptr),
      baseSampling_(baseParams.sampling),
      baseNPredict_(baseParams.n_predict),
      baseParams_(baseParams),
      configuredNDiscarded_(configuredNDiscarded),
      toolsCompactProfile_(std::move(toolsCompactProfile)),
      perSeqMaxTokens_(perSeqCeiling(ctxTotalTokens, batchSize)),
      batcher_(maxChunkSize, perSeqMaxTokens_, batchSize),
      batch_(batchCapacity, 0, static_cast<int32_t>(batchSize)),
      slots_(batchSize), statsStart_(std::chrono::steady_clock::now()) {

  const bool ctxValid =
      ctx_ != nullptr && model_ != nullptr && vocab_ != nullptr;
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
  // Drain in-flight slots so onDone fires and KV is cleared before any
  // per-slot override samplers (and the pre-built base samplers) are
  // destroyed by the vector teardowns.
  clear();
}

uint32_t ContinuousBatchScheduler::submit(SubmitRequest&& request) {
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
        tmpParams, overrideSampler, model_, request.overrides);
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
  LlmContextShared shared{
      .model = model_, .lctx = ctx_, .vocab = vocab_};
  auto tools = std::make_unique<ToolsCompactController>(toolsCompactProfile_);
  auto policy =
      std::make_unique<TextLlmContext>(tmpParams, shared, *tools, seqId);
  const bool isCacheLoaded =
      policy->loadSequenceCache(request.cacheKey, configuredNDiscarded_);
  const bool hasKvCacheContext = isCacheLoaded || policy->getNPast() > 0;
  policy->validatePromptPolicy(
      request.chatMsgs, request.tools, request.layout, hasKvCacheContext);
  auto tokens = policy->prepareBatchPrefill(
      request.chatMsgs, request.tools, isCacheLoaded, request.prefill);

  const auto promptSize =
      static_cast<unsigned>(policy->getNPast()) +
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
          batcher_.addRequestAt(seqId, std::move(tokens), policy->getNPast());
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
      .policy = std::move(policy),
      .cacheKey = std::move(request.cacheKey),
      .saveCacheToDisk = request.saveCacheToDisk,
      .prefillOnly = request.prefill});
  return seqId;
}

bool ContinuousBatchScheduler::step() {
  const auto fillResult = batcher_.fillBatch(batch_);
  if (fillResult.chunkSize == 0) {
    return true;
  }

  if (const int decodeRc = llama_decode(ctx_, *batch_); decodeRc != 0) {
    batcher_.markAllFinished(StopReason::DecodeError);
    auto kvClear = [this](uint32_t seqId) {
      llama_memory_t mem = llama_get_memory(ctx_);
      if (mem != nullptr) {
        llama_memory_seq_rm(mem, static_cast<llama_seq_id>(seqId), -1, -1);
      }
    };
    auto finished = batcher_.extractFinished(kvClear);
    for (const auto& req : finished) {
      if (slots_[req.seqId].has_value() && slots_[req.seqId]->policy) {
        slots_[req.seqId]->policy->onSlotEnd({});
      }
      notifyDone(req.seqId);
      freeSlot(req.seqId);
    }
    return false;
  }
  decodeStepCount_++;
  concurrentSeqSum_ += fillResult.numActiveSequences;

  batcher_.advance(
      fillResult.chunkSize,
      [this](
          uint32_t seqId, llama_pos currentPos, size_t prefillTokenCount) {
        auto& slot = slots_[seqId];
        if (!slot.has_value() || !slot->policy) {
          throw qvac_errors::StatusError(
              ADDON_ID,
              qvac_errors::general_error::toString(
                  qvac_errors::general_error::InternalError),
              "ContinuousBatchScheduler::step: missing slot policy for "
              "prefill-complete seqId " +
                  std::to_string(seqId));
        }
        slot->policy->onBatchPrefillComplete(
            currentPos, prefillTokenCount);
        if (slot->prefillOnly) {
          batcher_.markFinished(seqId);
        }
      });

  if (!cancelRequested_.load()) {
    batcher_.sampleAndAppendIdle([this](uint32_t seqId, int logitIdx) {
      auto& slot = slots_[seqId];
      const Request* req = batcher_.requestAt(seqId);
      if (!slot.has_value() || !slot->policy || req == nullptr) {
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
        if (slot->streams.onToken) {
          slot->streams.onToken(seqId, text);
        }
      };
      const SlotPolicyStepResult result =
          slot->policy->onLogitsReady(
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
    auto* mem = llama_get_memory(ctx_);
    if (mem != nullptr) {
      llama_memory_seq_rm(mem, static_cast<llama_seq_id>(seqId), -1, -1);
    }
  };
  auto finished = batcher_.extractFinished();
  for (const auto& req : finished) {
    if (slots_[req.seqId].has_value() && slots_[req.seqId]->policy) {
      auto& slot = *slots_[req.seqId];
      auto outputCallback = [&slot, seqId = req.seqId](const std::string& text) {
        if (slot.streams.onToken) {
          slot.streams.onToken(seqId, text);
        }
      };
      if (req.stopReason == StopReason::Cancelled) {
        slot.policy->onCancelPolicy(outputCallback);
      } else if (slot.prefillOnly) {
        slot.policy->onSlotEnd(outputCallback);
      } else {
        slot.policy->onGenerationFinished(outputCallback);
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

bool ContinuousBatchScheduler::hasWork() const { return numActive() > 0; }

unsigned ContinuousBatchScheduler::numActive() const {
  unsigned count = 0;
  for (const auto& s : slots_) {
    if (s.has_value()) {
      count++;
    }
  }
  return count;
}

void ContinuousBatchScheduler::resetRuntimeStats() {
  decodeStepCount_ = 0;
  concurrentSeqSum_ = 0;
  completedCacheTokens_ = 0;
  completedContextSlides_ = 0;
  completedGeneratedTokens_ = 0;
  completedPromptTokens_ = 0;
  statsStart_ = std::chrono::steady_clock::now();
}

RuntimeStatsSnapshot ContinuousBatchScheduler::runtimeStats() const {
  const double avgConcurrentSeq =
      decodeStepCount_ > 0
          ? static_cast<double>(concurrentSeqSum_) /
                static_cast<double>(decodeStepCount_)
          : 0.0;
  const auto elapsed = std::chrono::steady_clock::now() - statsStart_;
  const double elapsedMs =
      std::chrono::duration<double, std::milli>(elapsed).count();
  return {
      .avgConcurrentSeq = avgConcurrentSeq,
      .cacheTokens = completedCacheTokens_,
      .contextSlides = completedContextSlides_,
      .generatedTokens = completedGeneratedTokens_,
      .promptTokens = completedPromptTokens_,
      .elapsedMs = elapsedMs};
}

bool ContinuousBatchScheduler::cancel(uint32_t seqId) {
  bool occupied = seqId < slots_.size() && slots_[seqId].has_value();
  if (occupied) {
    const Request* req = batcher_.requestAt(seqId);
    if (slots_[seqId]->policy) {
      slots_[seqId]->policy->onCancelPolicy({});
      if (req != nullptr) {
        accumulateSlotRuntimeStats(*slots_[seqId], *req);
      }
      saveCacheForSlot(seqId, *slots_[seqId]);
    }
    notifyDone(seqId);
    auto kvClear = [this](uint32_t s) {
      auto* mem = llama_get_memory(ctx_);
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
}

void ContinuousBatchScheduler::clear() {
  for (uint32_t seqId = 0; seqId < slots_.size(); seqId++) {
    if (slots_[seqId].has_value()) {
      if (slots_[seqId]->policy) {
        slots_[seqId]->policy->onSlotEnd({});
      }
      notifyDone(seqId);
      freeSlot(seqId);
    }
  }
  auto kvClear = [this](uint32_t s) {
    auto* mem = llama_get_memory(ctx_);
    if (mem != nullptr) {
      llama_memory_seq_rm(mem, static_cast<llama_seq_id>(s), -1, -1);
    }
  };
  batcher_.clear(kvClear);
}

void ContinuousBatchScheduler::notifyDone(uint32_t seqId) {
  auto& slot = slots_[seqId];
  if (slot.has_value() && slot->streams.onDone) {
    slot->streams.onDone(seqId);
  }
}

void ContinuousBatchScheduler::freeSlot(uint32_t seqId) {
  if (seqId < slots_.size()) {
    slots_[seqId].reset();
  }
}

void ContinuousBatchScheduler::saveCacheForSlot(
    uint32_t seqId, const SlotState& slot) {
  if (!slot.saveCacheToDisk || slot.cacheKey.empty() || !slot.policy) {
    return;
  }
  (void)seqId;
  slot.policy->saveSequenceCache(slot.cacheKey);
}

void ContinuousBatchScheduler::accumulateSlotRuntimeStats(
    const SlotState& slot, const Request& req) {
  if (slot.policy) {
    completedCacheTokens_ += static_cast<int64_t>(slot.policy->getNPast());
    completedContextSlides_ +=
        static_cast<int64_t>(slot.policy->getNSlides());
  }
  completedGeneratedTokens_ +=
      static_cast<int64_t>(req.generatedTokens.size());
  completedPromptTokens_ += static_cast<int64_t>(req.prefillTokenCount);
}

} // namespace qvac_lib_inference_addon_llama::batching
