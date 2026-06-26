#include "ContextSlider.hpp"

#include "ToolsCompactController.hpp"
#include "common/common.h"
#include "inference-addon-cpp/Logger.hpp"
#include "utils/LoggingMacros.hpp"

using namespace qvac_lib_inference_addon_cpp::logger;

namespace {
class ContextSliderOps final : public IContextSliderOps {
public:
  llama_pos nCtx(llama_context* lctx) const override {
    return static_cast<llama_pos>(llama_n_ctx(lctx));
  }

  ContextSliderMemoryHandle memory(llama_context* lctx) const override {
    return llama_get_memory(lctx);
  }

  bool seqRm(
      ContextSliderMemoryHandle mem, llama_seq_id seqId, llama_pos startPos,
      llama_pos endPos) const override {
    return llama_memory_seq_rm(mem, seqId, startPos, endPos);
  }

  void seqAdd(
      ContextSliderMemoryHandle mem, llama_seq_id seqId, llama_pos startPos,
      llama_pos endPos, llama_pos delta) const override {
    llama_memory_seq_add(mem, seqId, startPos, endPos, delta);
  }
};

ContextSlideOutcome trySlidePrefillImpl(
    llama_context* lctx, llama_seq_id seqId, ContextUsage current,
    ContextUsage protectedPrefix, ContextUsage append, llama_pos nDiscarded,
    ToolsCompactController& tools, const IContextSliderOps& ops,
    llama_pos effectiveCtx) {

  // In batch mode the slot's usable window is the per-sequence cap, smaller
  // than the whole context; <= 0 means single-sequence, use the full context.
  const auto nCtx = effectiveCtx > 0 ? effectiveCtx : ops.nCtx(lctx);
  const llama_pos currentPos = current.pos;
  const llama_pos protectedPrefixPos = protectedPrefix.pos;
  const llama_pos appendPos = append.pos;
  const llama_pos currentCacheTokens = current.cacheTokens;
  const llama_pos appendCacheTokens = append.cacheTokens;

  // Check if sliding is needed
  if (currentPos + appendPos < nCtx &&
      currentCacheTokens + appendCacheTokens < nCtx) {
    return {ContextSlideOutcome::Kind::NotNeeded, currentPos, 0};
  }

  // Clamp discard so it never eats into tool tokens
  llama_pos discard = tools.clampDiscard(nDiscarded, protectedPrefixPos);
  llama_pos leftTokens = currentPos - protectedPrefixPos - discard;

  // Try partial slide
  if (leftTokens >= 0 && discard > 0 &&
      currentPos + appendPos - discard < nCtx &&
      currentCacheTokens + appendCacheTokens - discard < nCtx) {
    auto mem = ops.memory(lctx);
    if (!ops.seqRm(
            mem, seqId, protectedPrefixPos, protectedPrefixPos + discard)) {
      return {ContextSlideOutcome::Kind::MemoryOperationFailed, currentPos, 0};
    }
    ops.seqAdd(mem, seqId, protectedPrefixPos + discard, currentPos, -discard);
    llama_pos newNPast = currentPos - discard;
    tools.onSlide(discard, protectedPrefixPos);
    return {ContextSlideOutcome::Kind::Slid, newNPast, discard};
  }

  return {ContextSlideOutcome::Kind::Overflow, currentPos, 0};
}
} // namespace

const IContextSliderOps& defaultContextSliderOps() {
  static const ContextSliderOps ops;
  return ops;
}

ContextSlideOutcome trySlidePrefill(
    llama_context* lctx, llama_seq_id seqId, llama_pos nPast,
    llama_pos firstMsgTokens, llama_pos nTokensToAppend, llama_pos nDiscarded,
    ToolsCompactController& tools, const IContextSliderOps& ops,
    llama_pos effectiveCtx) {
  return trySlidePrefillImpl(
      lctx,
      seqId,
      ContextUsage{nPast, nPast},
      ContextUsage{firstMsgTokens, firstMsgTokens},
      ContextUsage{nTokensToAppend, nTokensToAppend},
      nDiscarded,
      tools,
      ops,
      effectiveCtx);
}

ContextSlideOutcome trySlidePrefill(
    llama_context* lctx, llama_seq_id seqId, ContextUsage current,
    ContextUsage protectedPrefix, ContextUsage append, llama_pos nDiscarded,
    ToolsCompactController& tools, const IContextSliderOps& ops) {
  constexpr llama_pos effectiveCtx = -1;
  return trySlidePrefillImpl(
      lctx,
      seqId,
      current,
      protectedPrefix,
      append,
      nDiscarded,
      tools,
      ops,
      effectiveCtx);
}

CompactRangeOutcome compactKvRange(
    llama_context* lctx, llama_seq_id seqId, llama_pos startPos,
    llama_pos endPos, llama_pos nPast, const IContextSliderOps& ops) {
  if (endPos <= startPos || startPos < 0 || endPos > nPast) {
    return {CompactRangeOutcome::Kind::NoOp, nPast, 0};
  }

  const llama_pos discarded = endPos - startPos;
  auto mem = ops.memory(lctx);
  if (!ops.seqRm(mem, seqId, startPos, endPos)) {
    return {CompactRangeOutcome::Kind::MemoryOperationFailed, nPast, 0};
  }
  // llama_memory_seq_add is void / infallible by API contract.
  ops.seqAdd(mem, seqId, endPos, nPast, -discarded);
  return {CompactRangeOutcome::Kind::Compacted, nPast - discarded, discarded};
}

ContextSlideOutcome trySlideGeneration(
    llama_context* lctx, llama_seq_id seqId, llama_pos nPast,
    llama_pos firstMsgTokens, llama_pos nDiscarded,
    ToolsCompactController& tools, const IContextSliderOps& ops,
    llama_pos effectiveCtx, llama_pos nCacheTokens) {

  const auto nCtx = effectiveCtx > 0 ? effectiveCtx : ops.nCtx(lctx);
  const llama_pos cacheTokens = nCacheTokens >= 0 ? nCacheTokens : nPast;

  // Check if sliding is needed (need room for 1 more token)
  if ((nPast + 1 <= nCtx && cacheTokens + 1 <= nCtx) || nDiscarded == 0) {
    return {ContextSlideOutcome::Kind::NotNeeded, nPast, 0};
  }

  // Clamp discard so it never eats into tool tokens
  llama_pos discard = tools.clampDiscard(nDiscarded, firstMsgTokens);

  // Handle degenerate boundary case
  if (discard == 0 && tools.degenerateBoundary(firstMsgTokens)) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "[ContextSlider] tools_compact anchor equals first message "
            "boundary "
            "(nPastBeforeTools=%d, firstMsgTokens=%d) while context is full; "
            "resetting tool boundary before retry\n",
            tools.anchor(),
            firstMsgTokens));
    tools.reset();
    discard = tools.clampDiscard(nDiscarded, firstMsgTokens);
  }

  // If still cannot discard, return NotNeeded (caller handles overflow)
  if (discard == 0) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "[ContextSlider] context is full but cannot discard tokens "
            "(nPast=%d, nCtx=%d, nDiscarded=%d, firstMsgTokens=%d, "
            "nPastBeforeTools=%d, toolsCompact=%s)\n",
            nPast,
            nCtx,
            nDiscarded,
            firstMsgTokens,
            tools.anchor(),
            tools.enabled() ? "true" : "false"));
    return {ContextSlideOutcome::Kind::NotNeeded, nPast, 0};
  }

  // Perform the slide
  auto mem = ops.memory(lctx);
  if (!ops.seqRm(mem, seqId, firstMsgTokens, firstMsgTokens + discard)) {
    return {ContextSlideOutcome::Kind::MemoryOperationFailed, nPast, 0};
  }
  ops.seqAdd(mem, seqId, firstMsgTokens + discard, nPast, -discard);
  llama_pos newNPast = nPast - discard;
  tools.onSlide(discard, firstMsgTokens);
  return {ContextSlideOutcome::Kind::Slid, newNPast, discard};
}
