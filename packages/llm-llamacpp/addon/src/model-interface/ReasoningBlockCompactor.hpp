#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <llama.h>

#include "../utils/ReasoningRollbackState.hpp"

namespace qvac_lib_inference_addon_llama {

/// The two cache operations reasoning compaction performs, behind an
/// indirection so unit tests can drive `compact()` without a real
/// `llama_context`. Production forwards both straight to
/// `ReasoningRollbackState`.
struct IReasoningRewindOps {
  virtual ~IReasoningRewindOps() = default;
  /// Rewind the sequence to the end-of-prefill boundary. A tail trim on
  /// pure attention, a full-state reload on recurrent / hybrid.
  virtual bool restoreBoundary(
      utils::ReasoningRollbackState& rollback, ::llama_context* ctx,
      llama_seq_id seqId) const = 0;
  /// Re-decode the kept tokens after the restored boundary.
  virtual bool replayPostReasoning(
      utils::ReasoningRollbackState& rollback, ::llama_context* ctx,
      llama_seq_id seqId) const = 0;
};

/// Returns the default implementation, which forwards to `rollback`.
const IReasoningRewindOps& defaultReasoningRewindOps();

// Per-inference reasoning-block compaction lifecycle, shared between
// `TextLlmContext` and `MtmdLlmContext`. Owns:
//
//   * the open/close span (`<think>...</think>`) tracking,
//   * the end-of-prefill snapshot capture (delegated to
//     `ReasoningRollbackState` after a feature-gate check),
//   * the restore-boundary-then-replay compaction path,
//   * the `thinkingBlockDiscards` runtime stats counter.
//
// Failure contract: when `remove_thinking_from_context` is
// enabled/defaulted-on, ANY inability to remove the reasoning span from
// cache is a hard failure. `snapshotAtPrefillBoundary` throws on capture
// underflow. `compact()` reports every other failure as
// `Outcome::Kind::FailedKvWiped`: compaction rewinds the sequence before
// it replays, so by the time anything can fail the cache has already been
// written to and only a wipe leaves it coherent. Callers must reset
// positional accounting to zero before rethrowing
// `qvac_errors::StatusError`, so no saveCache path can persist a header
// that misrepresents live memory or leaves the reasoning span in cache.
//
// State is per-inference. Call `reset()` at the start of each
// `evalMessageWithTools`. Feature flags (`removeThinkingFromContext`,
// `reasoningEnabled`, `needsRecurrentSnapshot`) are set by the owning
// context — they are configured externally because their lifecycles
// (per-request, per-load, per-model) differ and the compactor stays
// agnostic to those.
//
// Position-specific bookkeeping (`nPast_` for text vs `current_.pos /
// .cacheTokens` for multimodal) is applied by
// the caller using the returned `Outcome`. The compactor handles only
// the cache-side operations, logging, and stats.
class ReasoningBlockCompactor {
public:
  explicit ReasoningBlockCompactor(utils::ReasoningRollbackState& rollback);

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

  // Seeds the replay buffer with a token that was sampled BEFORE the
  // reasoning open marker fired (either template preamble that the
  // model emits before `<think>`, or one of the tokens that make up
  // the opener itself). Called for every sampled token while reasoning
  // is not yet open, so the restored boundary can replay
  // `[pre-reasoning tokens..., captured tail...]` and land on the
  // preamble followed by the visible answer without ever advancing
  // through the discarded reasoning span.
  //
  // No structural `<think>` / `</think>` marker is ever replayed: the
  // boundary is anchored before the span on every model kind, so there
  // is no open block for a close marker to balance. The opener pieces
  // that reach this method on generated-opener templates are dropped by
  // `compact()`'s `clipSeededPrefix` before the replay runs.
  //
  // No-op on features-off requests and before the boundary has been
  // captured (nothing to restore against, so seeding would be pointless
  // bookkeeping).
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
  // `pos`. The returned `Outcome` carries the new position and the
  // dropped-token count. The compactor itself does not write to the
  // caller's position fields.
  //
  // RAII cleanup: per-inference state (`thinkSpan_`, reasoning boundary
  // snapshot, post-reasoning buffer, capture flag) is cleared on every
  // exit — including on failure outcomes — so a no-op or failure
  // can't leave stale state behind.
  //
  // Failure contract:
  //   * `restoreReasoningBoundary` / `replayPostReasoning`
  //     failure, a defensive missing-boundary hit, a recurrent
  //     partial-resident reasoning span left after a tail trim, or a
  //     recurrent open reasoning span with no captured close marker:
  //     `compact()` best-effort clears the sequence memory (attention
  //     KV cells + recurrent state) and returns
  //     `Outcome::Kind::FailedKvWiped`. The caller MUST reset its
  //     positional accounting to zero to match the cleared sequence
  //     before rethrowing, so no saveCache path can write a header
  //     that misrepresents live memory.
  //
  // Callers surface that failure to the outside world by throwing
  // `qvac_errors::StatusError(FailedToDecode, outcome.failureMessage)`
  // (or an equivalent) once the local rollback above has run.
  //
  // When `remove_thinking_from_context` is enabled, there is no soft-failure
  // return: any inability to remove the reasoning span from cache surfaces to
  // the caller as the `FailedKvWiped` outcome above, and the caller is
  // required to surface it as an exception.
  struct Outcome {
    enum class Kind {
      // Feature off, no span captured, degenerate span, or the live cursor is
      // already before the reasoning span when compaction runs.
      NoOp,
      // Reasoning span dropped: the sequence was rewound to the
      // end-of-prefill boundary and the answer replayed after it.
      Compacted,
      // Compaction failed and live KV was best-effort wiped; caller
      // must reset positional accounting to zero before rethrowing.
      FailedKvWiped,
    };
    Kind kind = Kind::NoOp;
    // New cache position the caller should adopt. Unset for `NoOp` and for
    // `FailedKvWiped`, whose recovery cursor is always zero: compaction
    // rewinds before it replays, so a failure leaves nothing to roll back to
    // but an empty sequence.
    llama_pos newPos = 0;
    // Tokens dropped from the cache. `pos - newPos` for the attention
    // path; `pos - newPos` minus the residue for the recurrent path
    // (caller doesn't need to compute this).
    llama_pos discarded = 0;
    // Original span boundaries (for logging or caller-side guards).
    llama_pos spanStart = 0;
    llama_pos spanEnd = 0;
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

  // Testing seam: install a non-owning `IReasoningRewindOps` override that
  // replaces the default forwarding implementation inside `compact()`. Set to
  // `nullptr` to restore the default.
  void setRewindOpsForTesting(const IReasoningRewindOps* ops) noexcept {
    rewindOpsOverride_ = ops;
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
  }

private:
  utils::ReasoningRollbackState& rollback_;
  // Null in production, where `defaultReasoningRewindOps()` is used.
  const IReasoningRewindOps* rewindOpsOverride_ = nullptr;

  std::optional<std::pair<llama_pos, llama_pos>> thinkSpan_;
  bool pendingThinkCloseCapture_ = false;

  // Default-off: mirrors the owning LlmContext's default. The owner syncs
  // this during initialization and whenever a request overrides it.
  bool removeThinkingFromContext_ = false;
  bool reasoningEnabled_ = false;
  bool needsRecurrentSnapshot_ = false;

  int32_t thinkingBlockDiscards_ = 0;
};

} // namespace qvac_lib_inference_addon_llama
