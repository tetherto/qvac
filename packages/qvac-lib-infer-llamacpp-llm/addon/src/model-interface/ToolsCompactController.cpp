#include "ToolsCompactController.hpp"

#include <cassert>
#include <string>

#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "addon/LlmErrors.hpp"
#include "common/common.h"
#include "qvac-lib-inference-addon-cpp/Logger.hpp"
#include "utils/LoggingMacros.hpp"

using namespace qvac_lib_inference_addon_llama::errors;
using namespace qvac_lib_inference_addon_cpp::logger;

ToolsCompactController::ToolsCompactController(bool enabled)
    : enabled_(enabled) {}

bool ToolsCompactController::enabled() const noexcept { return enabled_; }

llama_pos ToolsCompactController::anchor() const noexcept {
  return nPastBeforeTools_;
}

void ToolsCompactController::validatePrompt(
    const std::vector<common_chat_msg>& chatMsgs,
    const std::vector<common_chat_tool>& tools,
    const PromptLayout& layout) const {
  if (!enabled_) {
    return;
  }

  // Original validation: when tools_compact is enabled and the last array item
  // is a user message, tools must be non-empty. This prevents accidental
  // misuse where tools_compact is enabled but no tools are provided.
  if (layout.lastItemIsUserMsg && tools.empty()) {
    std::string errorMsg = string_format(
        "tools_compact requires non-empty tools attached to the last "
        "user message");
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        errorMsg);
  }

  // When tools are empty (and last item is not a user message),
  // tools_compact is effectively a no-op for this prompt.
  if (tools.empty()) {
    return;
  }

  // Rule 2: at least one anchor message (user/tool) must exist
  if (!layout.lastAnchorIdx.has_value()) {
    std::string errorMsg = string_format(
        "tools_compact requires at least one user or tool message before "
        "tool definitions");
    throw qvac_errors::StatusError(
        ADDON_ID,
        qvac_errors::general_error::toString(
            qvac_errors::general_error::InvalidArgument),
        errorMsg);
  }

  // Rule 3 & 4: tool block must be contiguous and immediately after anchor
  if (layout.firstToolIdx.has_value() && layout.lastToolIdx.has_value()) {
    size_t firstTool = *layout.firstToolIdx;
    size_t lastTool = *layout.lastToolIdx;
    size_t lastAnchor = *layout.lastAnchorIdx;

    // Check contiguity: number of items between first and last tool should
    // equal toolCount - 1
    size_t expectedSpan = lastTool - firstTool + 1;
    if (expectedSpan != layout.toolCount) {
      std::string errorMsg = string_format(
          "tools_compact requires tool definitions to form a contiguous block; "
          "found %zu tools spanning %zu indices (expected contiguous span)",
          layout.toolCount,
          expectedSpan);
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          errorMsg);
    }

    // Check attachment: first tool must be immediately after last anchor
    if (firstTool != lastAnchor + 1) {
      std::string errorMsg = string_format(
          "tools_compact requires tool definitions to immediately follow the "
          "last user/tool message; last anchor at index %zu, first tool at "
          "index %zu",
          lastAnchor,
          firstTool);
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          errorMsg);
    }

    // Check that tools are at the end of the prompt array
    if (lastTool != layout.totalItems - 1) {
      std::string errorMsg = string_format(
          "tools_compact requires tool definitions to be at the end of the "
          "prompt; last tool at index %zu but total items is %zu",
          lastTool,
          layout.totalItems);
      throw qvac_errors::StatusError(
          ADDON_ID,
          qvac_errors::general_error::toString(
              qvac_errors::general_error::InvalidArgument),
          errorMsg);
    }
  }
}

void ToolsCompactController::onTokenize(
    size_t tokensWithTools, size_t tokensWithoutTools) {
  if (!enabled_) {
    nConversationOnlyTokens_ = 0;
    return;
  }

  if (tokensWithoutTools <= tokensWithTools) {
    nConversationOnlyTokens_ = static_cast<llama_pos>(tokensWithoutTools);
  } else {
    // Defensive: should never happen, but avoid negative counts
    nConversationOnlyTokens_ = 0;
  }

  assert(
      nConversationOnlyTokens_ <= static_cast<llama_pos>(tokensWithTools) &&
      "conversation-only tokens exceeds total tokens");
}

void ToolsCompactController::onEvalComplete(
    llama_pos nPast, llama_pos totalTokensEvaled) {
  if (!enabled_ || nConversationOnlyTokens_ == 0 || nPastBeforeTools_ != -1) {
    // Only set anchor on first round — preserve position during chain
    return;
  }

  nPastBeforeTools_ = nPast - (totalTokensEvaled - nConversationOnlyTokens_);
}

llama_pos ToolsCompactController::clampDiscard(
    llama_pos requested, llama_pos firstMsgTokens) const noexcept {
  if (enabled_ && nPastBeforeTools_ > firstMsgTokens) {
    llama_pos safeLimit = nPastBeforeTools_ - firstMsgTokens;
    return std::min(requested, safeLimit);
  }
  return requested;
}

void ToolsCompactController::onSlide(
    llama_pos discarded, llama_pos firstMsgTokens) noexcept {
  if (!enabled_ || nPastBeforeTools_ <= firstMsgTokens) {
    return;
  }
  // Clamp the slide to prevent anchor from going below firstMsgTokens
  llama_pos safeLimit = nPastBeforeTools_ - firstMsgTokens;
  llama_pos effectiveSlide = std::min(discarded, safeLimit);
  nPastBeforeTools_ -= effectiveSlide;
}

bool ToolsCompactController::degenerateBoundary(
    llama_pos firstMsgTokens) const noexcept {
  return enabled_ && nPastBeforeTools_ == firstMsgTokens;
}

bool ToolsCompactController::usableBoundary(
    llama_pos firstMsgTokens) const noexcept {
  return enabled_ && nPastBeforeTools_ > 0 &&
         nPastBeforeTools_ != firstMsgTokens;
}

ToolsCompactController::TrimDecision
ToolsCompactController::onGenerationComplete(
    std::string_view assistantOutput, llama_pos nPast,
    llama_pos firstMsgTokens) {
  // Capture debug state before any modifications
  lastRunInfo_.anchorAtGenerationEnd = nPastBeforeTools_;
  lastRunInfo_.trimmed = false;

  TrimDecision decision;

  if (!enabled_) {
    return decision;
  }

  // Handle degenerate boundary
  if (degenerateBoundary(firstMsgTokens)) {
    QLOG_IF(
        Priority::WARNING,
        string_format(
            "[ToolsCompactController] degenerate boundary at first message "
            "(nPastBeforeTools=%d, firstMsgTokens=%d); skipping "
            "post-generation tools trim\n",
            nPastBeforeTools_,
            firstMsgTokens));
    reset();
    return decision;
  }

  // Check for usable boundary and if we have tokens to trim
  if (!usableBoundary(firstMsgTokens) || nPast <= nPastBeforeTools_) {
    return decision;
  }

  // Check if output contains a tool call marker - if so, chain continues
  bool hasToolCall = assistantOutput.find("<tool_call>") != std::string_view::npos;
  if (hasToolCall) {
    return decision;
  }

  // Chain complete - prepare trim decision
  decision.trim = true;
  decision.tokensToRemoveFromTail = nPast - nPastBeforeTools_;
  decision.clampFirstMsgTokensToNPast = true;
  lastRunInfo_.trimmed = true;

  // Reset state after trim decision
  reset();

  return decision;
}

void ToolsCompactController::reset() noexcept {
  nConversationOnlyTokens_ = 0;
  nPastBeforeTools_ = -1;
}

ToolsCompactController::DebugSnapshot
ToolsCompactController::debugSnapshot() const noexcept {
  return {lastRunInfo_.anchorAtGenerationEnd, lastRunInfo_.trimmed};
}
