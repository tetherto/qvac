#include "ContextSlider.hpp"

#include "ToolsCompactController.hpp"
#include "common/common.h"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"
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

  void seqRm(
      ContextSliderMemoryHandle mem, llama_seq_id seqId, llama_pos startPos,
      llama_pos endPos) const override {
    llama_memory_seq_rm(mem, seqId, startPos, endPos);
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
    llama_context* lctx, llama_pos nPast, llama_pos firstMsgTokens,
    llama_pos nTokensToAppend, llama_pos nDiscarded,
    ToolsCompactController& tools, const IContextSliderOps& ops) {

  const auto nCtx = ops.nCtx(lctx);

  // Check if sliding is needed
  if (nPast + nTokensToAppend < nCtx) {
    return {ContextSlideOutcome::Kind::NotNeeded, nPast, 0};
  }

  // Clamp discard so it never eats into tool tokens
  llama_pos discard = tools.clampDiscard(nDiscarded, firstMsgTokens);
  llama_pos leftTokens = nPast - firstMsgTokens - discard;

  // Try partial slide
  if (leftTokens >= 0 && discard > 0 &&
      nPast + nTokensToAppend - discard < nCtx) {
    auto mem = ops.memory(lctx);
    ops.seqRm(mem, 0, firstMsgTokens, firstMsgTokens + discard);
    ops.seqAdd(mem, 0, firstMsgTokens + discard, nPast, -discard);
    llama_pos newNPast = nPast - discard;
    tools.onSlide(discard, firstMsgTokens);
    return {ContextSlideOutcome::Kind::Slid, newNPast, discard};
  }

  // Fallback: wipe everything after the first message
  if (leftTokens < 0 && firstMsgTokens + nTokensToAppend < nCtx &&
      nDiscarded > 0) {
    auto mem = ops.memory(lctx);
    ops.seqRm(mem, 0, firstMsgTokens, nPast);
    llama_pos wiped = nPast - firstMsgTokens;
    if (tools.enabled()) {
      tools.reset();
    }
    return {ContextSlideOutcome::Kind::FullWipe, firstMsgTokens, wiped};
  }

  // Cannot free enough space
  return {ContextSlideOutcome::Kind::Overflow, nPast, 0};
}

ContextSlideOutcome trySlideGeneration(
    llama_context* lctx, llama_pos nPast, llama_pos firstMsgTokens,
    llama_pos nDiscarded, ToolsCompactController& tools,
    const IContextSliderOps& ops) {

  const auto nCtx = ops.nCtx(lctx);

  // Check if sliding is needed (need room for 1 more token)
  if (nPast + 1 <= nCtx || nDiscarded == 0) {
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
  ops.seqRm(mem, 0, firstMsgTokens, firstMsgTokens + discard);
  ops.seqAdd(mem, 0, firstMsgTokens + discard, nPast, -discard);
  llama_pos newNPast = nPast - discard;
  tools.onSlide(discard, firstMsgTokens);
  return {ContextSlideOutcome::Kind::Slid, newNPast, discard};
}
