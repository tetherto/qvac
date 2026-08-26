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

// Compaction rewinds to a boundary anchored before the reasoning span and
// replays the tokens that sit outside it. `thinkingForcedOpen` is retained as
// an input for call-site symmetry only: it decides where the boundary lands
// (see `reasoningBoundaryTokenIndex`), not whether one is taken. Marker
// length does not decide anything either, because no structural marker is
// replayed at all.
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

// Where the compaction boundary belongs, given the end of prefill.
//
// A force-open template ends its rendered prompt with the reasoning opener
// (`<think>\n`), so those tokens are already decoded when prefill finishes.
// Anchoring at the end of prefill would keep them: the rewind restores a
// prefix that still opens a reasoning block, and the next cached turn resumes
// inside it with nothing to close it. Anchor before the opener instead, so
// every model kind rewinds to the same pre-reasoning cache.
//
// `prefillEnd` is a token index for the chunked text prefill and a position
// for the multimodal one; both measure the same distance from the start of
// the decode, so the same subtraction applies. Clamped at 0 for the
// degenerate template whose entire rendered prompt IS the opener.
[[nodiscard]] inline llama_pos reasoningBoundaryTokenIndex(
    llama_pos prefillEnd, bool thinkingForcedOpen,
    int forcedOpenTokenCount) noexcept {
  if (!thinkingForcedOpen || forcedOpenTokenCount <= 0) {
    return prefillEnd;
  }
  const llama_pos anchored =
      prefillEnd - static_cast<llama_pos>(forcedOpenTokenCount);
  return anchored > 0 ? anchored : 0;
}

// Only the feature gates decide now. Memory kind used to, back when pure
// attention shifted instead of rewinding, and close-marker length used to,
// back when replay had to seed the marker; neither is an input any more, so
// neither is a parameter.
[[nodiscard]] inline RecurrentReasoningBoundaryDecision
recurrentReasoningBoundaryDecision(
    bool removeThinkingFromContext, bool reasoningEnabled) noexcept {
  return (removeThinkingFromContext && reasoningEnabled)
             ? RecurrentReasoningBoundaryDecision::Capture
             : RecurrentReasoningBoundaryDecision::Disabled;
}

[[nodiscard]] inline bool shouldCaptureRecurrentReasoningBoundary(
    bool removeThinkingFromContext, bool reasoningEnabled) noexcept {
  return recurrentReasoningBoundaryDecision(
             removeThinkingFromContext, reasoningEnabled) ==
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
