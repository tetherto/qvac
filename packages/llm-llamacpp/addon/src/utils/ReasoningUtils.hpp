#pragma once

#include <optional>
#include <string>
#include <vector>

#include "common/chat.h"
#include "common/common.h"

// Forward declarations from llama.h
struct llama_model;
struct llama_context;
struct llama_vocab;

namespace qvac_lib_inference_addon_llama {
namespace utils {

// Open / close substring markers used to detect a model's reasoning
// channel in the streamed output. Prefer the active chat template's
// thinking_start_tag / thinking_end_tag when available; model-family
// defaults are only a fallback. Owning strings so callers can safely
// construct from temporaries.
//
// Both markers must fit comfortably within `ReasoningState::BUFFER_SIZE`
// because substring detection runs over the last BUFFER_SIZE chars.
struct ReasoningTags {
  std::string open;
  std::string close;
};

struct ReasoningState {
  ReasoningTags tags;
  bool inside_reasoning = false;
  std::string recent_output_buffer;

  // Rolling-window size for substring matching. Must exceed the longest
  // configured marker plus the worst-case partial-token tail.
  static constexpr size_t BUFFER_SIZE = 50;
};

// Initialise `state` with `tags`. Empty `tags.open`/`tags.close` leave the
// state in a disabled mode.
//
// Returns false only when the context or markers are unavailable.
[[nodiscard]] bool initializeReasoningState(
    ::llama_context* lctx, ReasoningState& state, ReasoningTags tags);

// An assistant turn's text cut into its reasoning and its answer.
struct SplitReasoning {
  std::string reasoning;
  std::string content;
};

// Cuts a reasoning block out of `content` the way thinking templates (Qwen3,
// Qwen3.5) cut it out of an assistant message: the reasoning is the text
// before the first `tags.close`, after the last `tags.open` in it, trimmed;
// the answer is the text after the last `tags.close`, without its leading
// newlines. `std::nullopt` when `content` has no `tags.close`.
[[nodiscard]] std::optional<SplitReasoning> splitReasoningFromContent(
    const std::string& content, const ReasoningTags& tags);

// Moves the reasoning block of every assistant message's `content` into its
// `reasoning_content`, so a template that only reads `reasoning_content`
// (DeepSeek V4, Gemma 4) can drop or place it, instead of printing it as part
// of the answer. Messages that already carry `reasoning_content` are left
// alone, like the templates do.
void moveReasoningOutOfContent(
    std::vector<common_chat_msg>& messages, const ReasoningTags& tags);

// Append `tokenStr` to the rolling buffer and flip
// `state.inside_reasoning` when the buffer first contains the
// configured open / close markers. No-op when tags are unset.
void updateReasoningBuffer(const std::string& tokenStr, ReasoningState& state);

} // namespace utils
} // namespace qvac_lib_inference_addon_llama
