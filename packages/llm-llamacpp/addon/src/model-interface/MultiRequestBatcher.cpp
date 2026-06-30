#include "MultiRequestBatcher.hpp"

#include <algorithm>
#include <ranges>

namespace qvac_lib_inference_addon_llama::batching {

namespace views = std::views;

Request::Request(
    uint32_t rid, PrefillPlan&& plan, unsigned maxTokens, llama_pos initialPos,
    bool canSlide)
    : seqId(rid), pendingPrefillTokens(std::move(plan.tokens)),
      pendingMediaBarriers(std::move(plan.mediaBarriers)),
      currentPos(initialPos), slideCapable(canSlide),
      maxTokensPerSequence(maxTokens) {
  prefillTokenCount = pendingPrefillTokens.size();
  for (const auto& barrier : pendingMediaBarriers) {
    prefillTokenCount += static_cast<size_t>(barrier.nPos);
  }
}

Request::Request(
    uint32_t rid, std::vector<llama_token>&& toks, unsigned maxTokens,
    llama_pos initialPos, bool canSlide)
    : Request(
          rid, PrefillPlan{.tokens = std::move(toks)}, maxTokens, initialPos,
          canSlide) {}

bool Request::isPrefillComplete() const {
  return prefillFedCount >= pendingPrefillTokens.size() &&
         pendingMediaBarriers.empty();
}

bool Request::exceededLimit() const {
  // A slide-capable generating sequence may touch the cap: the driver's
  // next step slides it back below (or reports contextOverflow and the
  // scheduler truncates it explicitly).
  const bool slideMayRecover = slideCapable && isPrefillComplete();
  return currentPos >= static_cast<llama_pos>(maxTokensPerSequence) &&
         !slideMayRecover;
}

bool Request::isFinished() const {
  return stopReason != StopReason::None || exceededLimit();
}

bool Request::isOptFinished(const std::optional<Request>& slot) {
  return slot.has_value() && slot->isFinished();
}

bool Request::isOptActive(const std::optional<Request>& slot) {
  return slot.has_value() && !slot->isFinished();
}

bool Request::isPrefillPending() const {
  return !isFinished() && !isPrefillComplete();
}

bool Request::isOptPrefillPending(const std::optional<Request>& slot) {
  return slot.has_value() && slot->isPrefillPending();
}

bool Request::isAwaitingMedia() const {
  return isPrefillPending() && !pendingMediaBarriers.empty() &&
         prefillFedCount >= pendingMediaBarriers.front().afterTextTokens;
}

bool Request::isOptAwaitingMedia(const std::optional<Request>& slot) {
  return slot.has_value() && slot->isAwaitingMedia();
}

bool Request::isGenerationIdle() const {
  return !isFinished() && isPrefillComplete() && !hasUnfedSample;
}

bool Request::isOptGenerationIdle(const std::optional<Request>& slot) {
  return slot.has_value() && slot->isGenerationIdle();
}

bool Request::isGenerationPending() const {
  return !isFinished() && isPrefillComplete() && hasUnfedSample;
}

bool Request::isOptGenerationPending(const std::optional<Request>& slot) {
  return slot.has_value() && slot->isGenerationPending();
}

bool Request::hasTokensToFeed() const {
  return (isPrefillPending() && !isAwaitingMedia()) || isGenerationPending();
}

bool Request::isOptHasTokensToFeed(const std::optional<Request>& slot) {
  return slot.has_value() && slot->hasTokensToFeed();
}

unsigned Request::remainingToFeed() const {
  if (!isPrefillComplete()) {
    // Text feeding stops at the head media barrier; the segment past it
    // only unblocks once the scheduler completes the barrier.
    const size_t feedLimit =
        pendingMediaBarriers.empty()
            ? pendingPrefillTokens.size()
            : std::min(
                  pendingPrefillTokens.size(),
                  pendingMediaBarriers.front().afterTextTokens);
    return feedLimit > prefillFedCount
               ? static_cast<unsigned>(feedLimit - prefillFedCount)
               : 0u;
  }
  return hasUnfedSample ? 1u : 0u;
}

llama_token Request::tokenToFeedAt(llama_pos pos) const {
  if (!isPrefillComplete()) {
    return pendingPrefillTokens[prefillFedCount + static_cast<size_t>(pos)];
  }
  return generatedTokens.back();
}

bool Request::chunkConsumesAllUnfed(unsigned chunkSize) const {
  if (chunkSize != remainingToFeed()) {
    return false;
  }
  if (isPrefillComplete()) {
    return true;
  }
  // Mid-prefill a chunk can also drain `remainingToFeed` by hitting a
  // media barrier; logits belong only to the true end of the prompt.
  return pendingMediaBarriers.empty() &&
         prefillFedCount + chunkSize >= pendingPrefillTokens.size();
}

MultiRequestBatcher::AddStatus MultiRequestBatcher::addRequest(
    std::vector<llama_token>&& tokens, uint32_t& seqId) {
  for (size_t i = 0; i < slots_.size(); i++) {
    if (!slots_[i].has_value()) {
      seqId = static_cast<uint32_t>(i);
      return addRequestAt(seqId, std::move(tokens));
    }
  }
  return AddStatus::ErrNoFreeSlot;
}

MultiRequestBatcher::AddStatus MultiRequestBatcher::addRequestAt(
    uint32_t seqId, std::vector<llama_token>&& tokens, llama_pos initialPos,
    bool slideCapable, llama_pos initialKvCells) {
  return addRequestAt(
      seqId,
      PrefillPlan{.tokens = std::move(tokens)},
      initialPos,
      slideCapable,
      initialKvCells);
}

MultiRequestBatcher::AddStatus MultiRequestBatcher::addRequestAt(
    uint32_t seqId, PrefillPlan&& plan, llama_pos initialPos, bool slideCapable,
    llama_pos initialKvCells) {
  if (plan.tokens.empty() && plan.mediaBarriers.empty()) {
    return AddStatus::ErrEmptyTokens;
  }
  const bool barriersValid =
      std::ranges::is_sorted(
          plan.mediaBarriers, {}, &MediaBarrier::afterTextTokens) &&
      std::ranges::all_of(plan.mediaBarriers, [&](const MediaBarrier& b) {
        return b.afterTextTokens <= plan.tokens.size() && b.nPos > 0;
      });
  if (!barriersValid) {
    return AddStatus::ErrInvalidPlan;
  }
  // M-RoPE media occupies more KV cells than positions, so both the
  // position span and the KV-cell span must fit the per-sequence cap. The
  // KV-cell span is sized from the physical cell count already committed
  // (`initialKvCells`), which for a cache-loaded M-RoPE sequence exceeds the
  // logical position count (`initialPos`); a negative default means "same as
  // initialPos" (text, where cells and positions coincide).
  const llama_pos kvBase = initialKvCells < 0 ? initialPos : initialKvCells;
  const auto totalPositions = static_cast<size_t>(initialPos) +
                              static_cast<size_t>(plan.totalPositions());
  const auto totalKvTokens =
      static_cast<size_t>(kvBase) + static_cast<size_t>(plan.totalKvTokens());
  if (totalPositions > maxTokensPerSequence_ ||
      totalKvTokens > maxTokensPerSequence_) {
    return AddStatus::ErrTokensTooLarge;
  }
  if (seqId >= slots_.size() || slots_[seqId].has_value()) {
    return AddStatus::ErrNoFreeSlot;
  }
  slots_[seqId].emplace(
      seqId, std::move(plan), maxTokensPerSequence_, initialPos, slideCapable);
  return AddStatus::Ok;
}

std::optional<uint32_t> MultiRequestBatcher::firstFreeSeqId() const {
  for (size_t i = 0; i < slots_.size(); i++) {
    if (!slots_[i].has_value()) {
      return static_cast<uint32_t>(i);
    }
  }
  return std::nullopt;
}

MultiRequestBatcher::FillResult
MultiRequestBatcher::getChunkSizeForActiveSeqs(const LlamaBatch& batch) const {
  unsigned chunkSize = maxChunkSize_;
  unsigned numActive = 0;
  unsigned numPrefilling = 0;
  for (const auto& slot :
       slots_ | views::filter(Request::isOptHasTokensToFeed)) {
    numActive++;
    if (slot->isPrefillPending()) {
      numPrefilling++;
    }
    // Global min: a generating slot (remainingToFeed()==1) throttles
    // concurrent prefills to 1 token/step. Deliberate tradeoff: keeps the
    // chunk global and fillBatch/advance simple, while all active slots
    // still advance in parallel every step (continuous batching).
    chunkSize = std::min(chunkSize, slot->remainingToFeed());
  }
  if (numActive == 0) {
    return {.chunkSize = 0, .numActiveSequences = 0};
  }

  // LlamaBatch has a total capacity (for all sequences),
  // make sure we do not exceed it and cause a crash.
  const unsigned perSeqCap =
      static_cast<unsigned>(batch.capacity()) / numActive;
  chunkSize = std::min(chunkSize, perSeqCap);

  return {
      .chunkSize = chunkSize,
      .numActiveSequences = numActive,
      .numPrefillingSequences = numPrefilling};
}

MultiRequestBatcher::FillResult
MultiRequestBatcher::fillBatch(LlamaBatch& batch) {
  llama_batch& lBatch = *batch;
  lBatch.n_tokens = 0;

  std::ranges::fill(lastLogitIndices_, -1);

  const FillResult bState = getChunkSizeForActiveSeqs(batch);
  if (bState.chunkSize == 0) {
    return bState;
  }

  unsigned batchIdx = 0;
  const llama_pos chunk = static_cast<llama_pos>(bState.chunkSize);

  for (auto& slot : slots_ | views::filter(Request::isOptHasTokensToFeed)) {
    Request& req = *slot;
    const bool wantLogitsOnLast = req.chunkConsumesAllUnfed(bState.chunkSize);

    for (llama_pos i = 0; i < chunk; i++) {
      const int idx = static_cast<int>(batchIdx);
      const bool wantLogits = wantLogitsOnLast && i == chunk - 1;

      lBatch.token[idx] = req.tokenToFeedAt(i);
      lBatch.pos[idx] = req.currentPos + i;
      lBatch.n_seq_id[idx] = 1;
      lBatch.seq_id[idx][0] = req.seqId;

      if (wantLogits) {
        lBatch.logits[idx] = 1;
        lastLogitIndices_[req.seqId] = idx;
      } else {
        lBatch.logits[idx] = 0;
      }

      batchIdx++;
    }
  }

  lBatch.n_tokens = static_cast<int>(batchIdx);
  return bState;
}

namespace {
void finishPrefillIfComplete(
    Request& req,
    const MultiRequestBatcher::PrefillCompleteFn& onPrefillComplete) {
  if (!req.isPrefillComplete()) {
    return;
  }
  if (onPrefillComplete) {
    onPrefillComplete(req.seqId, req.currentPos, req.prefillTokenCount);
  }
  req.pendingPrefillTokens.clear();
  req.pendingPrefillTokens.shrink_to_fit();
  req.prefillFedCount = 0;
}

void advanceReqPrefill(
    Request& req, llama_pos chunk,
    const MultiRequestBatcher::PrefillCompleteFn& onPrefillComplete) {
  req.prefillFedCount += static_cast<size_t>(chunk);
  finishPrefillIfComplete(req, onPrefillComplete);
}
} // namespace

void MultiRequestBatcher::advance(
    unsigned chunkSize, const PrefillCompleteFn& onPrefillComplete) {
  const llama_pos chunk = static_cast<llama_pos>(chunkSize);
  for (auto& slot : slots_ | views::filter(Request::isOptHasTokensToFeed)) {
    Request& req = *slot;
    req.currentPos += chunk;
    if (req.exceededLimit() && req.stopReason == StopReason::None) {
      req.stopReason = StopReason::LimitReached;
    }
    if (!req.isPrefillComplete()) {
      advanceReqPrefill(req, chunk, onPrefillComplete);
    } else {
      req.hasUnfedSample = false;
    }
  }
}

std::optional<MultiRequestBatcher::AwaitingMedia>
MultiRequestBatcher::nextAwaitingMedia() const {
  for (const auto& slot : slots_ | views::filter(Request::isOptAwaitingMedia)) {
    return AwaitingMedia{
        .seqId = slot->seqId,
        .mediaIndex = slot->pendingMediaBarriers.front().mediaIndex,
        .currentPos = slot->currentPos};
  }
  return std::nullopt;
}

bool MultiRequestBatcher::completeMediaBarrier(
    uint32_t seqId, llama_pos newPos,
    const PrefillCompleteFn& onPrefillComplete) {
  const bool hasBarrier =
      isValid(seqId) && !slots_[seqId]->pendingMediaBarriers.empty();
  if (hasBarrier) {
    Request& req = *slots_[seqId];
    req.pendingMediaBarriers.erase(req.pendingMediaBarriers.begin());
    req.currentPos = newPos;
    if (req.exceededLimit() && req.stopReason == StopReason::None) {
      req.stopReason = StopReason::LimitReached;
    }
    finishPrefillIfComplete(req, onPrefillComplete);
  }
  return hasBarrier;
}

void MultiRequestBatcher::sampleAndAppendIdle(const SamplerFn& samplerFn) {
  for (auto& slot : slots_ | views::filter(Request::isOptGenerationIdle)) {
    const int logitIdx = lastLogitIndices_[slot->seqId];
    slot->generatedTokens.push_back(samplerFn(slot->seqId, logitIdx));
    slot->hasUnfedSample = true;
  }
}

bool MultiRequestBatcher::isValid(uint32_t seqId) const noexcept {
  return seqId < slots_.size() && slots_[seqId].has_value();
}

const Request* MultiRequestBatcher::requestAt(uint32_t seqId) const noexcept {
  if (!isValid(seqId)) {
    return nullptr;
  }
  return &*slots_[seqId];
}

bool MultiRequestBatcher::markFinished(uint32_t seqId, StopReason reason) {
  bool valid = isValid(seqId);
  if (valid) {
    slots_[seqId]->stopReason = reason;
  }
  return valid;
}

void MultiRequestBatcher::applySlide(uint32_t seqId, llama_pos discarded) {
  if (isValid(seqId) && discarded > 0) {
    Request& req = *slots_[seqId];
    req.currentPos = std::max<llama_pos>(0, req.currentPos - discarded);
  }
}

void MultiRequestBatcher::markAllFinished(StopReason reason) {
  for (auto& slot : slots_ | views::filter(Request::isOptActive)) {
    slot->stopReason = reason;
  }
}

std::vector<Request> MultiRequestBatcher::extractFinished() {
  std::vector<Request> finished;
  for (auto& slot : slots_ | views::filter(Request::isOptFinished)) {
    finished.push_back(std::move(*slot));
    slot.reset();
  }
  return finished;
}

bool MultiRequestBatcher::cancel(uint32_t seqId, const KvClearFn& kvClear) {
  bool valid = isValid(seqId);
  if (valid) {
    if (kvClear) {
      kvClear(seqId);
    }
    slots_[seqId].reset();
  }
  return valid;
}

void MultiRequestBatcher::clear(const KvClearFn& kvClear) {
  for (size_t i = 0; i < slots_.size(); i++) {
    if (slots_[i].has_value()) {
      if (kvClear) {
        kvClear(static_cast<uint32_t>(i));
      }
      slots_[i].reset();
    }
  }
}

} // namespace qvac_lib_inference_addon_llama::batching
