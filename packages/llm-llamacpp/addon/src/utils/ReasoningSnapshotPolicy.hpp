#pragma once

#include "model-interface/SequenceDriver.hpp"

namespace qvac_lib_inference_addon_llama {
namespace utils {

// Full-state snapshots are required by recurrent and hybrid models, and by
// DeepSeek V4 whose compressed cache has the same checkpoint/replay
// requirement despite not reporting either model predicate.
[[nodiscard]] inline bool needsFullStateSnapshot(
    bool isRecurrent, bool isHybrid, bool isDeepSeekV4) noexcept {
  return isRecurrent || isHybrid || isDeepSeekV4;
}

// Recurrent / hybrid compaction restores an end-of-prefill snapshot and
// replays the post-reasoning tail. `thinkingForcedOpen` is retained as an
// input for call-site symmetry only. Force-open templates already have the
// opener in the restored prefix; generated-opener templates seed every
// sampled token up to the open-detection flip into `postReasoningTokens_`
// alongside the close marker, so the restored prefix no longer has to
// contain `<think>`. The one remaining hard-requirement is:
//   * `closeMarkerSingleToken` — the reasoning close tag tokenises to a
//     single token. The replay path seeds `postReasoningTokens_` with the
//     single sampled token that triggers the close-detection flip in
//     `updateReasoningBuffer`; a multi-piece close would leave the SSM
//     with an unbalanced `<think>` opener followed by only the tail piece.
//
// When `remove_thinking_from_context` is enabled for recurrent / hybrid
// memory and reasoning is active, unsupported templates must hard-fail
// instead of silently preserving reasoning in cache. `Disabled` means the
// policy is irrelevant for this request (pure attention, feature off, or no
// active reasoning channel); the `Unsupported*` state means callers
// should surface a StatusError after any required rollback.
enum class RecurrentReasoningBoundaryDecision {
  Disabled,
  Capture,
};

[[nodiscard]] inline RecurrentReasoningBoundaryDecision
recurrentReasoningBoundaryDecision(
    bool /*needsRecurrentSnapshot*/, bool removeThinkingFromContext,
    bool reasoningEnabled, bool /*thinkingForcedOpen*/,
    bool closeMarkerSingleToken) noexcept {
  // Every model anchors a boundary now: compaction rewinds to it and replays
  // rather than shifting, so memory kind no longer decides whether one is
  // needed, only whether the anchor is a state payload or just a position.
  if (!removeThinkingFromContext || !reasoningEnabled) {
    return RecurrentReasoningBoundaryDecision::Disabled;
  }
  // A multi-piece close used to be unsupported because replay could only seed
  // the single token that tripped the close detector. It seeds the whole
  // `cached_close_tag_tokens` sequence now, so marker length no longer
  // decides whether compaction is possible.
  (void)closeMarkerSingleToken;
  return RecurrentReasoningBoundaryDecision::Capture;
}

[[nodiscard]] inline bool shouldCaptureRecurrentReasoningBoundary(
    bool needsRecurrentSnapshot, bool removeThinkingFromContext,
    bool reasoningEnabled, bool thinkingForcedOpen,
    bool closeMarkerSingleToken) noexcept {
  return recurrentReasoningBoundaryDecision(
             needsRecurrentSnapshot,
             removeThinkingFromContext,
             reasoningEnabled,
             thinkingForcedOpen,
             closeMarkerSingleToken) ==
         RecurrentReasoningBoundaryDecision::Capture;
}

// Any terminal generation reason that interrupts an open reasoning span must
// restore the pre-request checkpoint on the snapshot/replay path. Continuing
// to compaction without a close marker would wipe the whole sequence instead
// of preserving the preceding conversation.
[[nodiscard]] inline bool shouldRollbackInterruptedReasoning(
    GenerationStopReason terminalReason, bool needsRecurrentSnapshot,
    bool removeThinkingFromContext, bool reasoningEnabled, bool insideReasoning,
    bool hasOpenSpan, bool hasCapturedCloseSpan) noexcept {
  return terminalReason != GenerationStopReason::None &&
         needsRecurrentSnapshot && removeThinkingFromContext &&
         reasoningEnabled && insideReasoning && hasOpenSpan &&
         !hasCapturedCloseSpan;
}

} // namespace utils
} // namespace qvac_lib_inference_addon_llama
