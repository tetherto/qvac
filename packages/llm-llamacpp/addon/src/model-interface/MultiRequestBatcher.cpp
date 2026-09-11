#include "MultiRequestBatcher.hpp"

#include <algorithm>
#include <ranges>

namespace qvac_lib_inference_addon_llama::batching {

namespace views = std::views;

Request::Request(
    uint32_t rid, PrefillPlan&& plan, unsigned maxTokens, llama_pos initialPos)
    : seqId(rid), pendingPrefillTokens(std::move(plan.tokens)),
      pendingMediaBarriers(std::move(plan.mediaBarriers)),
      currentPos(initialPos), maxTokensPerSequence(maxTokens) {
  prefillTokenCount = pendingPrefillTokens.size();
  for (const auto& barrier : pendingMediaBarriers) {
    prefillTokenCount += static_cast<size_t>(barrier.nPos);
  }
}

Request::Request(
    uint32_t rid, std::vector<llama_token>&& toks, unsigned maxTokens,
    llama_pos initialPos)
    : Request(
          rid, PrefillPlan{.tokens = std::move(toks)}, maxTokens, initialPos) {}

bool Request::isPrefillComplete() const {
  return prefillFedCount >= pendingPrefillTokens.size() &&
         pendingMediaBarriers.empty();
}

bool Request::exceededLimit() const {
  return currentPos >= static_cast<llama_pos>(maxTokensPerSequence);
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
    llama_pos initialKvCells) {
  return addRequestAt(
      seqId,
      PrefillPlan{.tokens = std::move(tokens)},
      initialPos,
      initialKvCells);
}

MultiRequestBatcher::AddStatus MultiRequestBatcher::addRequestAt(
    uint32_t seqId, PrefillPlan&& plan, llama_pos initialPos,
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
  // Belt and braces: every release path already zeroes this, so a fresh
  // occupant can never inherit one. Zeroing on admission too means the
  // invariant holds even if a future release path forgets.
  releaseBudget(seqId);
  slots_[seqId].emplace(
      seqId, std::move(plan), maxTokensPerSequence_, initialPos);
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
MultiRequestBatcher::planChunksForActiveSeqs(const LlamaBatch& batch) {
  std::ranges::fill(chunkSizes_, 0u);

  // Reused across steps (capacity reserved once in the ctor) so the planner
  // does not allocate on the per-decode-step hot path.
  unbudgeted_.clear();
  unsigned numActive = 0;
  unsigned numPrefilling = 0;
  for (const auto& slot :
       slots_ | views::filter(Request::isOptHasTokensToFeed)) {
    numActive++;
    if (slot->isPrefillPending()) {
      numPrefilling++;
    }
    unbudgeted_.push_back(slot->seqId);
  }
  if (numActive == 0) {
    return {};
  }

  // LlamaBatch has a total capacity (for all sequences), make sure we do not
  // exceed it and cause a crash. Every active slot must get at least one
  // token or none does: a partial step would starve an arbitrary subset.
  const auto capacity = static_cast<unsigned>(batch.capacity());
  if (capacity < numActive) {
    return {
        .numActiveSequences = numActive,
        .numPrefillingSequences = numPrefilling};
  }

  // Per-slot budgets, water-filled. Each slot wants
  // min(maxChunkSize_, remainingToFeed()) — exactly 1 for a generating slot,
  // up to a full micro-batch for one still feeding its prompt. Slots whose
  // want fits the current equal share are granted it outright and their
  // surplus is redistributed; once every survivor wants more than the share,
  // the rest is split evenly. Budgeting per slot rather than taking a global
  // min is what keeps a generating slot (want == 1) from throttling a
  // concurrent prefill to one token per decode step.
  //
  // The tradeoff this replaces the old global-min clamp with: a step's token
  // count is no longer bounded by (smallest remaining x numActive) but by
  // batch capacity, so a step taken while a large prefill is co-resident can
  // carry far more tokens than one taken between generating slots alone. A
  // generating slot is served first in the *budget* (want == 1 always fits),
  // but its token still rides the same llama_decode() call as that prefill,
  // so its inter-token latency rises with the step. That is the intended
  // exchange - much lower TTFT and higher aggregate throughput for a larger
  // spread in per-token latency while prefill and generation overlap - but
  // it is a real behaviour change, not a free win.
  unsigned remaining = capacity;
  while (!unbudgeted_.empty()) {
    // `remaining >= unbudgeted_.size()` is an invariant of this loop, so the
    // share is always at least one token and every slot makes progress.
    const unsigned share =
        remaining / static_cast<unsigned>(unbudgeted_.size());
    bool grantedAny = false;
    // Order within `unbudgeted_` is irrelevant, so a granted slot is removed
    // by swapping the back element into its place - O(1) instead of the O(n)
    // shift a vector::erase() from the middle would cost. Every element is
    // still examined exactly once per round: the swapped-in element lands at
    // the current index, which is not advanced.
    for (size_t i = 0; i < unbudgeted_.size();) {
      const uint32_t seqId = unbudgeted_[i];
      const unsigned want =
          std::min(maxChunkSize_, slots_[seqId]->remainingToFeed());
      if (want > share) {
        i++;
        continue;
      }
      chunkSizes_[seqId] = want;
      remaining -= want;
      unbudgeted_[i] = unbudgeted_.back();
      unbudgeted_.pop_back();
      grantedAny = true;
    }
    if (!grantedAny) {
      for (const uint32_t seqId : unbudgeted_) {
        chunkSizes_[seqId] = share;
        remaining -= share;
      }
      unbudgeted_.clear();
    }
  }

  FillResult result{
      .numActiveSequences = numActive, .numPrefillingSequences = numPrefilling};
  for (const auto& slot :
       slots_ | views::filter(Request::isOptHasTokensToFeed)) {
    const unsigned granted = chunkSizes_[slot->seqId];
    result.totalTokens += granted;
    if (slot->isPrefillPending()) {
      result.prefillTokens += granted;
    } else {
      result.decodeTokens += granted;
    }
  }
  return result;
}

MultiRequestBatcher::FillResult
MultiRequestBatcher::fillBatch(LlamaBatch& batch) {
  llama_batch& lBatch = *batch;
  lBatch.n_tokens = 0;

  std::ranges::fill(lastLogitIndices_, -1);

  const FillResult bState = planChunksForActiveSeqs(batch);
  // planChunksForActiveSeqs() zeroed every budget, so a fill that grants
  // nothing also clears any budget an earlier step left outstanding.
  budgetsPending_ = bState.totalTokens > 0;
  if (bState.totalTokens == 0) {
    return bState;
  }

  unsigned batchIdx = 0;

  for (auto& slot : slots_ | views::filter(Request::isOptHasTokensToFeed)) {
    Request& req = *slot;
    const unsigned granted = chunkSizes_[req.seqId];
    const auto chunk = static_cast<llama_pos>(granted);
    const bool wantLogitsOnLast = req.chunkConsumesAllUnfed(granted);

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

void MultiRequestBatcher::advance(const PrefillCompleteFn& onPrefillComplete) {
  // Committing is one-shot. Without this, a second advance() with no
  // fillBatch() between would re-apply the same budgets with nothing
  // decoded, running currentPos ahead of the KV cache — a desync that
  // reaches syncPosition() and any persisted session cache, silently.
  if (!budgetsPending_) {
    return;
  }
  budgetsPending_ = false;

  for (auto& slot : slots_ | views::filter(Request::isOptHasTokensToFeed)) {
    Request& req = *slot;
    // Exactly what the last fillBatch() fed this slot. A slot that was
    // granted nothing (batch too small for the active set) is skipped.
    const auto chunk = static_cast<llama_pos>(chunkSizes_[req.seqId]);
    if (chunk == 0) {
      continue;
    }
    req.currentPos += chunk;
    if (req.exceededLimit() && req.stopReason == StopReason::None) {
      req.stopReason = StopReason::ContextOverflow;
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
      req.stopReason = StopReason::ContextOverflow;
    }
    finishPrefillIfComplete(req, onPrefillComplete);
  }
  return hasBarrier;
}

void MultiRequestBatcher::sampleAndAppendIdle(const SamplerFn& samplerFn) {
  for (auto& slot : slots_ | views::filter(Request::isOptGenerationIdle)) {
    const int logitIdx = lastLogitIndices_[slot->seqId];
    const llama_token sampled = samplerFn(slot->seqId, logitIdx);
    // `generatedTokens` is both the feed queue and the runtime-stats count,
    // so it must hold exactly the tokens the caller received as content.
    // `hasUnfedSample` keeps the two roles apart for the one entry that is
    // counted but never fed.
    //
    // A sample that ends the sequence usually does not. `samplerFn` marks the
    // slot finished for a terminal EOG, an antiprompt hit, a prediction limit
    // or a context overflow, and `fillBatch` then filters the slot out, so the
    // token is dropped without ever being decoded. Recording an EOG would
    // report one token more than the caller ever saw, which is also the
    // single-prompt path's rule: its loop breaks before the decode, so
    // `lastGeneratedTokenCount_` never counts the token that stopped
    // generation.
    //
    // A prediction-limit stop is the exception. That sample is ordinary
    // content, already streamed, and the single-prompt loop decodes and counts
    // it before its own `n_predict` cap fires (`reachedBudget` is gated on the
    // batch path). Dropping it here made an identical `predict: N` request
    // report N on one path and N-1 on the other, and `predict: 1` report 0
    // next to non-empty output.
    //
    // A driver can also stop without producing a token at all and return
    // `LLAMA_TOKEN_NULL` (see `SequenceStepResult::token`); the MTMD
    // context-overflow return does. That id must never enter the feed queue.
    if (sampled == LLAMA_TOKEN_NULL) {
      continue;
    }
    // TTFT measures the token the caller SEES, and `samplerFn` has already
    // streamed this one out of `onLogitsReady` even when it also ended the
    // sequence. So the stamp goes before the terminal filter below: a
    // `predict: 1` request produces exactly one token, and stamping after
    // would return that output while reporting TTFT 0.
    const auto now = std::chrono::steady_clock::now();
    if (!slot->firstTokenAt.has_value()) {
      slot->firstTokenAt = now;
    }
    if (slot->isFinished() && slot->stopReason != StopReason::PredictionLimit) {
      continue;
    }
    slot->generatedTokens.push_back(sampled);
    // Counted, never fed: a finished slot is filtered out of `fillBatch`, and
    // leaving this false keeps `remainingToFeed` honest for the one step
    // between the sample and the slot being drained.
    slot->hasUnfedSample = !slot->isFinished();
    // Closes the observed-TPS window, so it advances only for tokens that
    // are counted. A sample dropped above is not one of them, and ending the
    // window on it would stretch the window over one more gap than the count
    // has.
    slot->lastTokenAt = now;
  }
}

unsigned MultiRequestBatcher::chunkSizeFor(uint32_t seqId) const noexcept {
  return seqId < chunkSizes_.size() ? chunkSizes_[seqId] : 0u;
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

void MultiRequestBatcher::markAllFinished(StopReason reason) {
  for (auto& slot : slots_ | views::filter(Request::isOptActive)) {
    slot->stopReason = reason;
  }
}

void MultiRequestBatcher::releaseBudget(uint32_t seqId) noexcept {
  if (seqId < chunkSizes_.size()) {
    chunkSizes_[seqId] = 0u;
  }
}

std::vector<Request> MultiRequestBatcher::extractFinished() {
  std::vector<Request> finished;
  for (auto& slot : slots_ | views::filter(Request::isOptFinished)) {
    releaseBudget(slot->seqId);
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
    releaseBudget(seqId);
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
      releaseBudget(static_cast<uint32_t>(i));
      slots_[i].reset();
    }
  }
}

} // namespace qvac_lib_inference_addon_llama::batching
