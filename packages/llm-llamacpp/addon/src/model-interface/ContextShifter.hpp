#pragma once

#include <cstdint>

#include <llama.h>

#include "../utils/ReasoningRollbackState.hpp"
#include "ReasoningBlockCompactor.hpp"

namespace qvac_lib_inference_addon_llama {

// Thin wrapper around `trySlideGeneration` that owns the slide budget
// (`nDiscarded`) and slide counter (`nSlides`), and invalidates post-slide
// reasoning state on the compactor and rollback owners.
//
// Position-specific bookkeeping (`nPast_` for text vs
// `current_.pos / .cacheTokens` for multimodal) stays on the caller,
// which applies the returned `Outcome`. Multimodal contexts also need
// to call their own `refreshCurrentCacheTokensFromMemory()` after a
// successful slide because image embeddings can occupy more KV cells
// than positions — the shifter cannot do that without a
// context-specific hook.
class ContextShifter {
public:
  ContextShifter(
      ReasoningBlockCompactor& compactor,
      utils::ReasoningRollbackState& rollback);

  // Generation-time slide budget. `0` disables sliding.
  void setDiscardBudget(llama_pos n) noexcept { nDiscarded_ = n; }
  [[nodiscard]] llama_pos discardBudget() const noexcept { return nDiscarded_; }

  // Per-inference slide counter, surfaced via `runtimeStats().contextSlides`.
  [[nodiscard]] int32_t slides() const noexcept { return nSlides_; }
  void resetSlides() noexcept { nSlides_ = 0; }
  // Increments the slide counter from external slide paths that don't
  // route through `applyGenerationDiscard` — currently just the inline
  // `trySlidePrefill` site in `preparePrefill`.
  void noteSlide() noexcept { ++nSlides_; }

  struct Outcome {
    enum class Kind { NotNeeded, Slid };
    Kind kind = Kind::NotNeeded;
    llama_pos newPos = 0;
    llama_pos discarded = 0;
  };

  // Attempts a generation-time slide. Returns an outcome that the
  // caller maps onto its own position fields (text: `nPast_`; mtmd:
  // `current_.pos` plus `refreshCurrentCacheTokensFromMemory()`).
  // Invalidates the compactor's span and clears the rollback state's reasoning
  // boundary + post-reasoning buffer on success — they all referenced pre-slide
  // positions that are no longer valid. If a reasoning span was active, final
  // compaction hard-fails instead of silently completing with unknown resident
  // reasoning tokens.
  //
  // Throws `qvac_errors::StatusError` on memory-op failure, matching
  // the original inline behaviour in both contexts.
  //
  // `effectiveCtx == -1` defers to `llama_n_ctx`. `cacheTokens == -1`
  // skips multimodal cache-cell tracking — text contexts pass `-1`.
  // `labelTag` is "[TextLlm]" / "[MtmdLlm]" for log messages.
  Outcome applyGenerationDiscard(
      ::llama_context* ctx, llama_seq_id seqId, llama_pos pos,
      llama_pos protectedPrefixPos, llama_pos effectiveCtx,
      llama_pos cacheTokens, const char* labelTag,
      const IContextSliderOps& ops = defaultContextSliderOps());

private:
  ReasoningBlockCompactor& compactor_;
  utils::ReasoningRollbackState& rollback_;
  llama_pos nDiscarded_ = 0;
  int32_t nSlides_ = 0;
};

} // namespace qvac_lib_inference_addon_llama
