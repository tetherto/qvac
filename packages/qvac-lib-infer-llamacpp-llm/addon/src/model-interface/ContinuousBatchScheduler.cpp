#include "ContinuousBatchScheduler.hpp"

#include <algorithm>
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
    bool renderSpecialTokens,
    const common_params_sampling& baseSampling, int baseNPredict)
    : ctx_(ctx), model_(model),
      vocab_(model != nullptr ? llama_model_get_vocab(model) : nullptr),
      renderSpecialTokens_(renderSpecialTokens),
      baseSampling_(baseSampling),
      baseNPredict_(baseNPredict),
      perSeqMaxTokens_(perSeqCeiling(ctxTotalTokens, batchSize)),
      batcher_(maxChunkSize, perSeqMaxTokens_, batchSize),
      batch_(batchCapacity, 0, static_cast<int32_t>(batchSize)),
      slots_(batchSize) {

  const bool ctxValid =
      ctx_ != nullptr && model_ != nullptr && vocab_ != nullptr;
  if (!ctxValid) {
    throw std::invalid_argument(
        "ContinuousBatchScheduler: ctx, model, and vocab must be non-null");
  }
  if (!batchCapacity >= static_cast<int32_t>(batchSize)) {
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

  // Pre-build one base sampler per slot. Validates `baseSampling_` once
  // up-front; override-free requests later just `common_sampler_reset`
  // their slot's sampler instead of allocating a new one per request.
  baseSamplers_.reserve(batchSize);
  for (size_t i = 0; i < batchSize; ++i) {
    CommonSamplerPtr sampler(common_sampler_init(model_, baseSampling_));
    if (!sampler) {
      throw std::invalid_argument(
          "ContinuousBatchScheduler: failed to initialise base sampler "
          "from baseline sampling (invalid grammar or json_schema?)");
    }
    baseSamplers_.push_back(std::move(sampler));
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
  common_params tmpParams;
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
  const unsigned promptSize =
      static_cast<unsigned>(request.tokens.size());
  if (promptSize >= perSeqMaxTokens_) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        "ContinuousBatchScheduler::submit: prompt of " +
            std::to_string(promptSize) + " tokens leaves no room under "
            "per-sequence cap " + std::to_string(perSeqMaxTokens_) +
            " (ctxTotalTokens / n_parallel)");
  }
  if (tmpParams.n_predict > 0 &&
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
  uint32_t seqId = 0;
  // TODO, the scheduler should take care of doing multiple passes
  // if there are not enough slots...
  if (auto status = batcher_.addRequest(std::move(request.tokens), seqId);
      status != MultiRequestBatcher::AddStatus::Ok) {
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        "ContinuousBatchScheduler::submit: failed to add to batch "
        "(MultiRequestBatcher::AddStatus=" +
            std::to_string(static_cast<int>(status)) + ")");
  }
  if (!hasOverrides) {
    // Reusing the slot's pre-built base sampler — wipe per-sequence
    // state (rep penalty window, RNG, grammar parse position) so it
    // never leaks from the previous request that occupied this slot.
    common_sampler_reset(baseSamplers_[seqId].get());
  }
  slots_[seqId].emplace(SlotState{
      .streams = std::move(streamsLocal),
      .utf8 = {},
      .overrideSampler = std::move(overrideSampler),
      .nPredict = tmpParams.n_predict});
  return seqId;
}

common_sampler* ContinuousBatchScheduler::activeSampler(uint32_t seqId) const {
  const auto& slot = slots_[seqId];
  if (slot.has_value() && slot->overrideSampler) {
    return slot->overrideSampler.get();
  }
  return baseSamplers_[seqId].get();
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
      flushUtf8(req.seqId);
      notifyDone(req.seqId);
      freeSlot(req.seqId);
    }
    return false;
  }

  batcher_.advance(fillResult.chunkSize);

  batcher_.sampleAndAppendIdle([this](uint32_t seqId, int logitIdx) {
    common_sampler* sampler = activeSampler(seqId);
    const llama_token tok = common_sampler_sample(sampler, ctx_, logitIdx);
    common_sampler_accept(sampler, tok, true);
    emitToken(seqId, tok);
    // The batcher only invokes this callback for active slots, so by
    // construction both the slot and the underlying `Request` are
    // populated here. Treat anything else as a class invariant break.
    const auto& slot = slots_[seqId];
    const Request* req = batcher_.requestAt(seqId);
    if (!slot.has_value() || req == nullptr) {
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InternalError),
          "ContinuousBatchScheduler::step: missing slot or request "
          "state for active seqId " +
              std::to_string(seqId));
    }
    // `Request::generatedTokens` is the batcher's own counter; the
    // batcher pushes `tok` onto it *after* this callback returns, so
    // the post-accept count is `size() + 1`.
    const unsigned generatedAfterAccept =
        static_cast<unsigned>(req->generatedTokens.size()) + 1u;
    const bool reachedBudget = slot->nPredict > 0 &&
        generatedAfterAccept >= static_cast<unsigned>(slot->nPredict);
    if (reachedBudget || llama_vocab_is_eog(vocab_, tok)) {
      batcher_.markFinished(seqId);
    }
    return tok;
  });

  auto kvClear = [this](uint32_t seqId) {
    auto* mem = llama_get_memory(ctx_);
    if (mem != nullptr) {
      llama_memory_seq_rm(mem, static_cast<llama_seq_id>(seqId), -1, -1);
    }
  };
  auto finished = batcher_.extractFinished(kvClear);
  for (const auto& req : finished) {
    flushUtf8(req.seqId);
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

bool ContinuousBatchScheduler::cancel(uint32_t seqId) {
  bool occupied = seqId < slots_.size() && slots_[seqId].has_value();
  if (occupied) {
    flushUtf8(seqId);
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

void ContinuousBatchScheduler::clear() {
  for (uint32_t seqId = 0; seqId < slots_.size(); seqId++) {
    if (slots_[seqId].has_value()) {
      flushUtf8(seqId);
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

void ContinuousBatchScheduler::emitToken(uint32_t seqId, llama_token tok) {
  auto& slot = slots_[seqId];
  bool hasSink = slot.has_value() && slot->streams.onToken;
  if (!hasSink) {
    return;
  }
  std::string piece = common_token_to_piece(ctx_, tok, renderSpecialTokens_);
  std::string complete = slot->utf8.addToken(piece);
  if (!complete.empty()) {
    slot->streams.onToken(seqId, complete);
  }
}

void ContinuousBatchScheduler::flushUtf8(uint32_t seqId) {
  auto& slot = slots_[seqId];
  bool hasSink = slot.has_value() && slot->streams.onToken;
  if (!hasSink) {
    return;
  }
  if (slot->utf8.hasPendingBytes()) {
    std::string remaining = slot->utf8.flush();
    if (!remaining.empty()) {
      slot->streams.onToken(seqId, remaining);
    }
  }
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

} // namespace qvac_lib_inference_addon_llama::batching
