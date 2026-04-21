#pragma once

#include <algorithm>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include <llama.h>

#include "common/chat.h"

/// Layout information extracted during prompt parsing for tools_compact
/// validation. Populated by LlamaModel::formatPrompt and passed into
/// validatePrompt.
struct PromptLayout {
  std::optional<size_t> firstToolIdx;  // first `{type: function}` in JSON array
  std::optional<size_t> lastToolIdx;   // last  `{type: function}` in JSON array
  std::optional<size_t> lastAnchorIdx; // last user/tool role in JSON array
  size_t totalItems = 0;
  size_t toolCount = 0;
  bool lastItemIsUserMsg =
      false; // true if the very last array item is role=user
};

/// Model/template-specific markers used by tools_compact chain detection.
struct ToolsCompactProfile {
  std::string toolCallStartMarker;
};

/// Controller for the tools_compact feature.
///
/// Owns all state and decision logic for anchoring tool definitions in the KV
/// cache and compacting them after a tool chain completes. Replaces the
/// previous DynamicToolsState class that was scattered across LlmContext
/// subclasses.
///
/// Owned by LlamaModel; contexts hold a non-owning reference.
class ToolsCompactController {
public:
  explicit ToolsCompactController(std::optional<ToolsCompactProfile> profile);

  [[nodiscard]] bool enabled() const noexcept;
  [[nodiscard]] llama_pos anchor() const noexcept;

  // ── Prompt-level (called once per inference, before tokenization) ─────

  /// Validates that the prompt shape satisfies tools_compact requirements:
  /// 1. Tools must be non-empty
  /// 2. At least one anchor message (user/tool) must exist
  /// 3. Tool definitions must form a contiguous block
  /// 4. That block must be immediately after the last anchor message
  ///
  /// Throws InvalidArgument on validation failure. No-op when disabled.
  void validatePrompt(
      const std::vector<common_chat_msg>& chatMsgs,
      const std::vector<common_chat_tool>& tools, const PromptLayout& layout,
      bool hasKvCacheContext) const;

  // ── Tokenize/eval lifecycle (called by the concrete contexts) ────────

  /// Records the token count difference between with-tools and without-tools
  /// tokenization. Called after double-tokenization in tokenizeChat.
  void onTokenize(size_t tokensWithTools, size_t tokensWithoutTools);

  /// Records the tool boundary after eval completes. Sets the anchor position
  /// on the first round of a tool chain (when nPastBeforeTools_ is still -1).
  void onEvalComplete(llama_pos nPast, llama_pos totalTokensEvaled);

  // ── Sliding-window hooks (called during context sliding) ───────────────

  /// Clamps a discard amount so it never eats into the tool region.
  /// Returns the original value unchanged when tools_compact is off.
  [[nodiscard]] llama_pos
  clampDiscard(llama_pos requested, llama_pos firstMsgTokens) const noexcept;

  /// Adjusts the anchor position after a context slide. Called after
  /// successfully discarding tokens.
  void onSlide(llama_pos discarded, llama_pos firstMsgTokens) noexcept;

  /// Returns true if the anchor equals the first message boundary (degenerate
  /// case where tools_compact cannot preserve any window beyond first message).
  [[nodiscard]] bool
  degenerateBoundary(llama_pos firstMsgTokens) const noexcept;

  /// Returns true if the anchor is valid for post-generation trim (positive,
  /// and not degenerate).
  [[nodiscard]] bool usableBoundary(llama_pos firstMsgTokens) const noexcept;

  // ── Post-generation decision (called by LlamaModel::processPromptImpl) ─

  struct TrimDecision {
    bool trim = false;
    llama_pos tokensToRemoveFromTail = 0;
    bool clampFirstMsgTokensToNPast = false;
  };

  /// Determines whether to trim tool tokens after generation completes.
  /// Captures debug snapshot internally before making the decision.
  /// Resets state if trim occurs or boundary is degenerate.
  [[nodiscard]] TrimDecision onGenerationComplete(
      std::string_view assistantOutput, llama_pos nPast,
      llama_pos firstMsgTokens);

  // ── Lifecycle ────────────────────────────────────────────────────────

  /// Resets live inference state (conversation-token delta and current anchor).
  /// Does not clear debug snapshot fields, which are intentionally retained
  /// until the next onGenerationComplete capture.
  void reset() noexcept;

  // ── Debug stats (read by LlamaModel::runtimeDebugStats) ──────────────

  struct DebugSnapshot {
    // Anchor captured at the start of the most recent onGenerationComplete
    // call. This is not the live anchor value after subsequent sliding/reset.
    llama_pos nPastBeforeTools = -1;
    // Whether the most recent onGenerationComplete decided to trim tools.
    bool lastToolsTrimmed = false;
  };

  /// Returns the most recently captured generation-complete snapshot.
  /// Snapshot values remain stable across reset()/slide operations and are
  /// replaced only by a subsequent onGenerationComplete call.
  [[nodiscard]] DebugSnapshot debugSnapshot() const noexcept;

private:
  const bool enabled_;
  ToolsCompactProfile profile_;
  llama_pos nConversationOnlyTokens_ = 0;
  llama_pos nPastBeforeTools_ = -1;

  // Captured at the start of onGenerationComplete and surfaced via
  // debugSnapshot, so runtimeDebugStats reports chain-completion state
  // rather than mutable live anchor state.
  struct LastRunInfo {
    llama_pos anchorAtGenerationEnd = -1;
    bool trimmed = false;
  };
  LastRunInfo lastRunInfo_;
};
