#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <utility>

#include <llama.h>

#include "../utils/ReasoningRollbackState.hpp"
#include "ContextSlider.hpp"
#include "ToolsCompactController.hpp"

namespace qvac_lib_inference_addon_llama {

// Per-inference reasoning-block compaction lifecycle, shared between
// `TextLlmContext` and `MtmdLlmContext`. Owns:
//
//   * the open/close span (`<think>...</think>`) tracking,
//   * the end-of-prefill snapshot capture (delegated to
//     `ReasoningRollbackState` after a feature-gate check),
//   * the pure-attention `seq_rm + seq_add` compaction path and the
//     recurrent / hybrid full-state restore + replay path,
//   * the `thinkingBlockDiscards` runtime stats counter.
//
// Failure contract (uniform across paths, per PR #2813 review):
// when `remove_thinking_from_context` is enabled/defaulted-on,
// ANY inability to remove the reasoning span from cache is a hard
// failure. `snapshotAtPrefillBoundary` throws on capture underflow;
// `compact()` returns `Outcome::Kind::FailedKvIntact` on pure-
// attention `seq_rm + seq_add` rejection (live KV was left untouched)
// and `Outcome::Kind::FailedKvWiped` on hybrid restore underflow,
// hybrid replay rejection, recurrent partial-resident spans, recurrent
// open spans without a captured close marker, generation slides that
// invalidate tracked reasoning state, or the defensive no-boundary branch
// (sequence memory was best-effort cleared).
// Callers must run the live-KV recovery documented on the outcome kind
// (roll back `[preRequestCursor, currentCursor)` or reset positional
// accounting to zero) before rethrowing `qvac_errors::StatusError` so
// no saveCache path can persist a header that misrepresents live memory
// or leaves the reasoning span in cache.
//
// State is per-inference. Call `reset()` at the start of each
// `evalMessageWithTools`. Feature flags (`removeThinkingFromContext`,
// `reasoningEnabled`, `needsRecurrentSnapshot`) are set by the owning
// context — they are configured externally because their lifecycles
// (per-request, per-load, per-model) differ and the compactor stays
// agnostic to those.
//
// Position-specific bookkeeping (`nPast_` for text vs `current_.pos /
// .cacheTokens` and `protectedPrefix_` for multimodal) is applied by
// the caller using the returned `Outcome`. The compactor handles only
// the cache-side operations, logging, stats, and tools-compact slide
// notification.
class ReasoningBlockCompactor {
public:
  ReasoningBlockCompactor(
      utils::ReasoningRollbackState& rollback, ToolsCompactController& tools);

  // ---- Feature gates ----
  void setRemoveThinkingFromContext(bool v) noexcept {
    removeThinkingFromContext_ = v;
  }
  [[nodiscard]] bool removeThinkingFromContext() const noexcept {
    return removeThinkingFromContext_;
  }
  void setReasoningEnabled(bool v) noexcept { reasoningEnabled_ = v; }
  void setNeedsRecurrentSnapshot(bool v) noexcept {
    needsRecurrentSnapshot_ = v;
  }
  [[nodiscard]] bool needsRecurrentSnapshot() const noexcept {
    return needsRecurrentSnapshot_;
  }

  // ---- Span tracking ----
  //
  // Single-block policy: only the first `<think>...</think>` of an
  // inference is tracked. Later open markers (no model currently emits
  // them) are ignored.
  void setOpenSpan(llama_pos start);
  [[nodiscard]] bool hasOpenSpan() const noexcept {
    return thinkSpan_.has_value();
  }
  [[nodiscard]] bool hasCapturedCloseSpan() const noexcept {
    return thinkSpan_.has_value() && thinkSpan_->second >= 0;
  }
  // Test accessor: true when a span has been opened AND its close
  // position has been committed (i.e. the `requestCloseCapture()` →
  // `onCloseCommitted()` handshake completed). Kept for compatibility
  // with unit tests; production code should use `hasCapturedCloseSpan()`.
  [[nodiscard]] bool hasCapturedCloseSpanForTesting() const noexcept {
    return hasCapturedCloseSpan();
  }
  void clearSpan() noexcept {
    thinkSpan_.reset();
    pendingThinkCloseCapture_ = false;
  }
  void markSpanInvalidatedByGenerationSlide(
      llama_pos pos, llama_pos discarded) noexcept {
    slideInvalidatedSpan_ = thinkSpan_.has_value();
    slideInvalidatedPos_ = pos;
    slideInvalidatedDiscarded_ = discarded;
    clearSpan();
  }
  void markBoundaryInvalidatedByGenerationSlide(
      llama_pos pos, llama_pos discarded) noexcept {
    slideInvalidatedBoundary_ = true;
    slideInvalidatedPos_ = pos;
    slideInvalidatedDiscarded_ = discarded;
  }

  // ---- Close-marker capture lifecycle ----
  //
  // `requestCloseCapture()` is called when the reasoning detector
  // observes the close marker but the marker token has not yet been
  // committed to the cache. `onCloseCommitted(pos)` is called once the
  // marker has been committed (so `pos` is the cache position after
  // commit); it finalises `thinkSpan_->second` and, on recurrent /
  // hybrid memory, starts post-reasoning token capture for replay.
  void requestCloseCapture() noexcept { pendingThinkCloseCapture_ = true; }
  [[nodiscard]] bool hasPendingCloseCapture() const noexcept {
    return pendingThinkCloseCapture_;
  }
  void onCloseCommitted(llama_pos pos);

  // ---- Post-reasoning token capture (delegates to rollback state) ----
  //
  // No-op when capture is inactive or the token id is null.
  void recordPostReasoningToken(llama_token id) {
    rollback_.recordPostReasoningToken(id);
  }

  // Seeds the replay buffer with the reasoning close-marker token id.
  // Called from the close-detection sites BEFORE
  // `capturePendingThinkClose()` / `onCloseCommitted()` flip capture on,
  // so the close marker lands at the head of the replay sequence ahead
  // of any subsequent tokens recorded through `recordPostReasoningToken`.
  // Gated on the recurrent-snapshot feature and an existing boundary
  // snapshot — pure-attention models neither restore nor replay.
  // Without this, the restored SSM state would contain either the
  // force-opened opener or the replayed generated opener with no
  // matching close marker before the answer tail, which is an
  // unbalanced (out-of-distribution) recurrent state for hybrid models
  // on the next turn.
  //
  // Callers MUST pass the *canonical* single-vocab close token
  // (`reasoningState_.cached_close_tag_token`), not the sampled token
  // that tripped the string-search detector flip in
  // `updateReasoningBuffer`. Chat templates whose close carries
  // surrounding whitespace padding (e.g. Qwen3's `"\n</think>\n\n"`)
  // defer the flip onto a trailing padding piece — seeding that
  // padding token would drive the recurrent replay through a newline
  // with no matching `</think>`, defeating the balancing invariant
  // this method exists to preserve. `cached_close_tag_token` is
  // populated (non-null) whenever the recurrent-capture policy
  // admits us (both `close_is_single_token == true`); passing
  // `LLAMA_TOKEN_NULL` is silently dropped rather than seeded.
  void recordCloseMarkerForReplay(llama_token id);

  // Seeds the replay buffer with a token that was sampled BEFORE the
  // reasoning open marker fired (either template preamble that the
  // model emits before `<think>`, or one of the tokens that make up
  // the opener itself). Called for every sampled token while reasoning
  // is not yet open, so on the recurrent / hybrid path the restored
  // end-of-prefill snapshot can replay `[pre-reasoning tokens...,
  // close token, captured tail...]` and land in a balanced
  // `<think>...</think>` state without ever advancing the SSM through
  // the discarded reasoning span.
  //
  // Gated identically to `recordCloseMarkerForReplay`: no-op on pure-
  // attention paths, on features-off requests, and before the
  // end-of-prefill boundary snapshot has been captured (nothing to
  // restore against, so seeding would be pointless bookkeeping).
  // Additionally no-op once an open span has been recorded (i.e.
  // after the reasoning open flip) so callers can safely invoke this
  // for every token where `reasoningState_.inside_reasoning == false`
  // without duplicating post-close answer tokens that
  // `recordPostReasoningToken` is already capturing.
  //
  // Force-open templates do not exercise the pre-open branch of this
  // path because `reasoningState_.inside_reasoning` is set at the end
  // of prefill, so callers never see a "pre-reasoning" token in that
  // case.
  void recordPreReasoningToken(llama_token id);

  // ---- End-of-prefill snapshot ----
  //
  // Captures the full sequence state at `pos` when the feature gates
  // pass (recurrent memory + remove-thinking on + reasoning channel
  // recognised). Throws `qvac_errors::StatusError` on capture
  // underflow (see the class-level "Failure contract" comment).
  // `labelTag` is "[TextLlm]" / "[MtmdLlm]" for logs.
  void snapshotAtPrefillBoundary(
      ::llama_context* ctx, llama_seq_id seqId, llama_pos pos,
      const char* labelTag);

  // ---- Compaction ----
  //
  // Performs end-of-generation compaction at the current cache cursor
  // `pos`. The returned `Outcome` carries the new position, the
  // dropped-token count, and the kept-prefix end (used by callers to
  // adjust `firstMsgTokens_` / `protectedPrefix_`). The compactor
  // itself does not write to the caller's position fields.
  //
  // RAII cleanup: per-inference state (`thinkSpan_`, reasoning boundary
  // snapshot, post-reasoning buffer, capture flag) is cleared on every
  // exit — including on failure outcomes — so a no-op or failure
  // can't leave stale state behind.
  //
  // Failure contract:
  //   * Pure-attention `seq_rm + seq_add` rejection: `compact()`
  //     returns `Outcome::Kind::FailedKvIntact`. The primitive is
  //     documented all-or-nothing on rejection, so live KV still
  //     matches the caller's cursor; no seq wipe is performed. The
  //     caller MUST roll back the live cache to its pre-request
  //     cursor (e.g. via `removeLastNTokens(nPast - preRequestNPast)`)
  //     before rethrowing so both driver metadata and live KV stay
  //     coherent for the next request on the same driver.
  //   * Hybrid `restoreReasoningBoundary` / `replayPostReasoning`
  //     failure, a defensive missing-boundary hit, a recurrent
  //     partial-resident reasoning span left after a tail trim, a recurrent
  //     open reasoning span with no captured close marker, or a generation
  //     slide that invalidated tracked reasoning state:
  //     `compact()` best-effort clears the sequence memory (attention
  //     KV cells + recurrent state) and returns
  //     `Outcome::Kind::FailedKvWiped`. The caller MUST reset its
  //     positional accounting to zero to match the cleared sequence
  //     before rethrowing, so no saveCache path can write a header
  //     that misrepresents live memory.
  //
  // Callers surface either failure to the outside world by throwing
  // `qvac_errors::StatusError(FailedToDecode, outcome.failureMessage)`
  // (or an equivalent) once the local rollback above has run.
  //
  // Under the default-on `remove_thinking_from_context` contract,
  // there is no soft-failure return: any inability to remove the
  // reasoning span from cache surfaces to the caller as one of the
  // two `Failed*` outcomes above, and the caller is required to
  // surface it as an exception.
  struct Outcome {
    enum class Kind {
      // Feature off, no span captured, degenerate span, or the live cursor is
      // already before the reasoning span when compaction runs.
      NoOp,
      CompactedAttention,
      CompactedRecurrent,
      // Compaction failed but live KV was left untouched; caller must
      // roll back `[preRequestCursor, currentCursor)` before rethrowing.
      FailedKvIntact,
      // Compaction failed and live KV was best-effort wiped; caller
      // must reset positional accounting to zero before rethrowing.
      FailedKvWiped,
    };
    Kind kind = Kind::NoOp;
    // New cache position the caller should adopt. Unset for `NoOp` and
    // for the two `Failed*` outcomes (the caller derives the recovery
    // cursor from its own `preRequestCursor` / zero, respectively).
    llama_pos newPos = 0;
    // Tokens dropped from the cache. `pos - newPos` for the attention
    // path; `pos - newPos` minus the residue for the recurrent path
    // (caller doesn't need to compute this).
    llama_pos discarded = 0;
    // Original span boundaries (for logging or caller-side guards).
    llama_pos spanStart = 0;
    llama_pos spanEnd = 0;
    // First cache position the caller should treat as the new
    // protected-prefix end. Equals `spanStart` for the attention path
    // (the slice is removed and the tail shifts left); equals the
    // restored boundary `nPast` for the recurrent path (the prefix
    // before the boundary is kept verbatim).
    llama_pos keptPrefixEnd = 0;
    // Post-reasoning tokens replayed (recurrent path only).
    size_t replayedTokens = 0;
    // Populated on the `Failed*` outcomes: the message the caller
    // should attach when rethrowing so operators see the same
    // context (span, seqId, snapshot state) the compactor logged.
    std::string failureMessage;
  };
  [[nodiscard]] Outcome compact(
      ::llama_context* ctx, llama_seq_id seqId, llama_pos pos,
      const char* labelTag);

  // Testing seam: install a non-owning `IContextSliderOps` override
  // that replaces the default singleton (real `llama_memory_seq_rm` /
  // `llama_memory_seq_add`) inside `compact()`. Set to `nullptr` to
  // clear. Persists across `reset()` because it is a test wiring
  // concern, not per-inference state. Production code MUST NOT call
  // this — the override lets unit and driver-level tests exercise
  // the `FailedKvIntact` branch without a real `llama_context`.
  void setContextSliderOpsForTesting(const IContextSliderOps* ops) noexcept {
    sliderOpsOverride_ = ops;
  }

  // Access to the underlying tools-compact controller. Exposed so
  // `ContextShifter` can route slide notifications to the same
  // controller without holding an independent reference.
  [[nodiscard]] ToolsCompactController& toolsController() noexcept {
    return tools_;
  }

  // ---- Stats ----
  [[nodiscard]] int32_t blockDiscards() const noexcept {
    return thinkingBlockDiscards_;
  }
  void resetBlockDiscards() noexcept { thinkingBlockDiscards_ = 0; }

  // Per-inference reset of span + close-capture state. Stats and
  // feature flags are NOT reset (stats are managed via dedicated
  // reset methods at the `LlamaModel` level, feature flags are
  // configured externally per request).
  void reset() noexcept {
    thinkSpan_.reset();
    pendingThinkCloseCapture_ = false;
    slideInvalidatedSpan_ = false;
    slideInvalidatedBoundary_ = false;
    slideInvalidatedPos_ = 0;
    slideInvalidatedDiscarded_ = 0;
  }

private:
  utils::ReasoningRollbackState& rollback_;
  ToolsCompactController& tools_;

  std::optional<std::pair<llama_pos, llama_pos>> thinkSpan_;
  bool pendingThinkCloseCapture_ = false;
  bool slideInvalidatedSpan_ = false;
  bool slideInvalidatedBoundary_ = false;
  llama_pos slideInvalidatedPos_ = 0;
  llama_pos slideInvalidatedDiscarded_ = 0;

  // Default-on: mirrors the owning LlmContext's default. The owner
  // syncs this via `setRemoveThinkingFromContext` whenever a request
  // explicitly opts out (or opts back in), so the class-member value
  // only matters at construction time before the first request.
  bool removeThinkingFromContext_ = true;
  bool reasoningEnabled_ = false;
  bool needsRecurrentSnapshot_ = false;

  int32_t thinkingBlockDiscards_ = 0;

  // Non-owning override for the KV primitives used by `compact()`.
  // Null in production (falls back to `defaultContextSliderOps()`);
  // tests install a fake via `setContextSliderOpsForTesting` so the
  // `FailedKvIntact` branch can be triggered without a real
  // `llama_context`.
  const IContextSliderOps* sliderOpsOverride_ = nullptr;
};

} // namespace qvac_lib_inference_addon_llama
