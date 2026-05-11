#pragma once

#include <llama.h>

class ToolsCompactController;

using ContextSliderMemoryHandle =
    decltype(llama_get_memory(static_cast<llama_context*>(nullptr)));

/// Small indirection layer around llama context/memory operations.
///
/// This makes ContextSlider testable without requiring a real llama_context.
struct IContextSliderOps {
  virtual ~IContextSliderOps() = default;
  virtual llama_pos nCtx(llama_context* lctx) const = 0;
  virtual ContextSliderMemoryHandle memory(llama_context* lctx) const = 0;
  virtual void seqRm(
      ContextSliderMemoryHandle mem, llama_seq_id seqId, llama_pos startPos,
      llama_pos endPos) const = 0;
  virtual void seqAdd(
      ContextSliderMemoryHandle mem, llama_seq_id seqId, llama_pos startPos,
      llama_pos endPos, llama_pos delta) const = 0;
};

/// Returns the default llama-backed ops implementation.
const IContextSliderOps& defaultContextSliderOps();

/// Outcome of a sliding-window operation on the KV cache.
struct ContextSlideOutcome {
  enum class Kind {
    NotNeeded, // Context had enough room; no slide performed
    Slid,      // Successfully discarded tokens via partial slide
    FullWipe,  // Fallback: wiped everything after firstMsgTokens (prefill only)
    Overflow,  // Could not free enough space; caller should throw
  };

  Kind kind = Kind::NotNeeded;
  llama_pos newNPast = 0;  // Updated nPast after the slide
  llama_pos discarded = 0; // Number of tokens actually discarded
};

/// Attempts to slide the context window during prefill (eval) phase.
///
/// This handles the case where adding nTokensToAppend would overflow the
/// context. It tries to discard tokens from the middle (after firstMsgTokens)
/// while respecting the tools_compact anchor via ToolsCompactController.
///
/// On success (Slid or FullWipe), the KV cache has been modified and newNPast
/// reflects the new position. On NotNeeded, no action was taken. On Overflow,
/// the caller should throw a context overflow error.
///
/// @param lctx           The llama context for KV cache operations
/// @param nPast          Current token position in the context
/// @param firstMsgTokens Number of tokens in the first message (protected)
/// @param nTokensToAppend Number of tokens about to be appended
/// @param nDiscarded     Maximum tokens the caller allows to discard
/// @param tools          Controller for tools_compact anchor management
/// @return ContextSlideOutcome describing what happened and the new state
ContextSlideOutcome trySlidePrefill(
    llama_context* lctx, llama_pos nPast, llama_pos firstMsgTokens,
    llama_pos nTokensToAppend, llama_pos nDiscarded,
    ToolsCompactController& tools,
    const IContextSliderOps& ops = defaultContextSliderOps());

/// Attempts to slide the context window during generation phase.
///
/// This handles the case where generating one more token would overflow the
/// context. Unlike prefill, there is no FullWipe fallback during generation.
/// If sliding cannot free space, returns NotNeeded with no action.
///
/// @param lctx           The llama context for KV cache operations
/// @param nPast          Current token position in the context
/// @param firstMsgTokens Number of tokens in the first message (protected)
/// @param nDiscarded     Maximum tokens the caller allows to discard
/// @param tools          Controller for tools_compact anchor management
/// @return ContextSlideOutcome describing what happened and the new state
ContextSlideOutcome trySlideGeneration(
    llama_context* lctx, llama_pos nPast, llama_pos firstMsgTokens,
    llama_pos nDiscarded, ToolsCompactController& tools,
    const IContextSliderOps& ops = defaultContextSliderOps());
