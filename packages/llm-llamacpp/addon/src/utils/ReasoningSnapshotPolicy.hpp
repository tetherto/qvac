#pragma once

namespace qvac_lib_inference_addon_llama {
namespace utils {

// Reasoning compaction restores an end-of-prefill snapshot and
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
// When `remove_thinking_from_context` is enabled and reasoning is active,
// unsupported templates must hard-fail
// instead of silently preserving reasoning in cache. `Disabled` means the
// policy is irrelevant for this request (feature off or no active reasoning
// channel); the `Unsupported*` state means callers
// should surface a StatusError after any required rollback.
enum class ReasoningBoundaryDecision {
  Disabled,
  Capture,
  UnsupportedMultiTokenClose,
};

[[nodiscard]] inline ReasoningBoundaryDecision reasoningBoundaryDecision(
    bool removeThinkingFromContext, bool reasoningEnabled,
    bool /*thinkingForcedOpen*/, bool closeMarkerSingleToken) noexcept {
  if (!removeThinkingFromContext || !reasoningEnabled) {
    return ReasoningBoundaryDecision::Disabled;
  }
  if (!closeMarkerSingleToken) {
    return ReasoningBoundaryDecision::UnsupportedMultiTokenClose;
  }
  return ReasoningBoundaryDecision::Capture;
}

[[nodiscard]] inline const char*
reasoningBoundaryFailureReason(ReasoningBoundaryDecision decision) noexcept {
  switch (decision) {
  case ReasoningBoundaryDecision::UnsupportedMultiTokenClose:
    return "the reasoning close marker is not a single token";
  case ReasoningBoundaryDecision::Disabled:
  case ReasoningBoundaryDecision::Capture:
    return "";
  }
  return "";
}

[[nodiscard]] inline bool shouldCaptureReasoningBoundary(
    bool removeThinkingFromContext, bool reasoningEnabled,
    bool thinkingForcedOpen, bool closeMarkerSingleToken) noexcept {
  return reasoningBoundaryDecision(
             removeThinkingFromContext,
             reasoningEnabled,
             thinkingForcedOpen,
             closeMarkerSingleToken) == ReasoningBoundaryDecision::Capture;
}

} // namespace utils
} // namespace qvac_lib_inference_addon_llama
