#pragma once

#include <string>

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

// Append `tokenStr` to the rolling buffer and flip
// `state.inside_reasoning` when the buffer first contains the
// configured open / close markers. No-op when tags are unset.
void updateReasoningBuffer(const std::string& tokenStr, ReasoningState& state);

} // namespace utils
} // namespace qvac_lib_inference_addon_llama
