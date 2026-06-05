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
} // namespace

const IContextSliderOps& defaultContextSliderOps() {
  static const ContextSliderOps ops;
  return ops;
}

ContextSlideOutcome trySlidePrefill(
    llama_context* lctx, ContextUsage current, ContextUsage protectedPrefix,
    ContextUsage append, llama_pos nDiscarded, ToolsCompactController& tools,
    const IContextSliderOps& ops) {

  const auto nCtx = ops.nCtx(lctx);

  // Check if sliding is needed
  if (current.pos + append.pos < nCtx &&
      current.cacheTokens + append.cacheTokens < nCtx) {
    return {ContextSlideOutcome::Kind::NotNeeded, current.pos, 0};
  }

  // Clamp discard so it never eats into tool tokens
  llama_pos discard = tools.clampDiscard(nDiscarded, protectedPrefix.pos);
  llama_pos leftTokens = current.pos - protectedPrefix.pos - discard;

  // Try partial slide
  if (leftTokens >= 0 && discard > 0 &&
      current.pos + append.pos - discard < nCtx &&
      current.cacheTokens + append.cacheTokens - discard < nCtx) {
    auto mem = ops.memory(lctx);
    if (!ops.seqRm(
            mem, 0, protectedPrefix.pos, protectedPrefix.pos + discard)) {
      return {
          ContextSlideOutcome::Kind::MemoryOperationFailed, current.pos, 0};
    }
    ops.seqAdd(mem, 0, protectedPrefix.pos + discard, current.pos, -discard);
    llama_pos newNPast = current.pos - discard;
    tools.onSlide(discard, protectedPrefix.pos);
    return {ContextSlideOutcome::Kind::Slid, newNPast, discard};
  }

  // Fallback: wipe everything after the first message.
  // Some hybrid recurrent memories cannot roll their tail state backwards. In
  // that case, preserve the tail token and move it next to the protected prefix
  // so decoding can continue with a best-effort contaminated state.
  if (nDiscarded > 0) {
    const llama_pos tail = current.pos - 1;
    const llama_pos exactWipe = current.pos - protectedPrefix.pos;
    const llama_pos tailPreservingWipe = tail - protectedPrefix.pos;
    const bool exactWipeFits = exactWipe <= nDiscarded &&
        protectedPrefix.pos + append.pos < nCtx &&
        protectedPrefix.cacheTokens + append.cacheTokens < nCtx;
    const bool tailPreservingWipeFits =
        tail > protectedPrefix.pos && tailPreservingWipe <= nDiscarded &&
        protectedPrefix.pos + 1 + append.pos < nCtx &&
        protectedPrefix.cacheTokens + 1 + append.cacheTokens < nCtx;

    if (!exactWipeFits && !tailPreservingWipeFits) {
      return {ContextSlideOutcome::Kind::Overflow, current.pos, 0};
    }

    auto mem = ops.memory(lctx);
    bool memoryOperationFailed = false;

    if (exactWipeFits) {
      if (ops.seqRm(mem, 0, protectedPrefix.pos, current.pos)) {
        if (tools.enabled()) {
          tools.reset();
        }
        return {
            ContextSlideOutcome::Kind::FullWipe,
            protectedPrefix.pos,
            exactWipe};
      }
      memoryOperationFailed = true;
    }

    if (tailPreservingWipeFits) {
      if (ops.seqRm(mem, 0, protectedPrefix.pos, tail)) {
        ops.seqAdd(mem, 0, tail, current.pos, protectedPrefix.pos - tail);
        if (tools.enabled()) {
          tools.reset();
        }
        return {
            ContextSlideOutcome::Kind::FullWipe,
            protectedPrefix.pos + 1,
            tailPreservingWipe};
      }
      memoryOperationFailed = true;
    }

    if (memoryOperationFailed) {
      return {
          ContextSlideOutcome::Kind::MemoryOperationFailed, current.pos, 0};
    }
  }

  // Cannot free enough space
  return {ContextSlideOutcome::Kind::Overflow, current.pos, 0};
}

ContextSlideOutcome trySlideGeneration(
    llama_context* lctx, llama_pos nPast, llama_pos firstMsgTokens,
    llama_pos nDiscarded, ToolsCompactController& tools,
    const IContextSliderOps& ops, llama_pos nCacheTokens) {

  const auto nCtx = ops.nCtx(lctx);
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
  if (!ops.seqRm(mem, 0, firstMsgTokens, firstMsgTokens + discard)) {
    return {ContextSlideOutcome::Kind::MemoryOperationFailed, nPast, 0};
  }
  ops.seqAdd(mem, 0, firstMsgTokens + discard, nPast, -discard);
  llama_pos newNPast = nPast - discard;
  tools.onSlide(discard, firstMsgTokens);
  return {ContextSlideOutcome::Kind::Slid, newNPast, discard};
}
