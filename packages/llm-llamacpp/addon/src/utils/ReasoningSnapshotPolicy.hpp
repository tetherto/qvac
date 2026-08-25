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
// contain `<think>`. There is no hard requirement left: the replay seeds the
// whole `cached_close_tag_tokens` sequence, so a close marker that tokenises
// to several pieces still restores a balanced `<think>...</think>` span and
// marker length no longer decides whether compaction is possible.
//
// Every memory kind anchors a boundary now; only the anchor's form differs, a
// state payload for recurrent / hybrid and a bare position for pure
// attention. `Disabled` means the policy is irrelevant for this request
// (feature off, or no active reasoning channel) and `Capture` means take the
// boundary. There is no unsupported state to surface.
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
