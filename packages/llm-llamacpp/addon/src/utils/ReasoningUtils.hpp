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
// Two invariants when adding a new family in `selectReasoningTagsForModel`:
//   - Both markers must fit comfortably within `ReasoningState::BUFFER_SIZE`
//     (substring detection runs over the last BUFFER_SIZE chars).
//   - `tags.open` must be a registered special token so the cached
//     `openTokenCount` matches the model's in-context emission — the
//     span start-position arithmetic relies on this alignment.
struct ReasoningTags {
  std::string open;
  std::string close;
};

struct ReasoningState {
  ReasoningTags tags;
  // Number of tokens the open marker tokenises to under the active
  // tokenizer. Cached at init for span start-position arithmetic.
  int openTokenCount = 0;
  // Token count for the template-forced reasoning prefix some chat
  // templates append to the assistant turn. Defaults to
  // `tags.open + "\n"` when the caller does not provide the exact
  // prompt suffix. 0 when not applicable.
  int forcedOpenTokenCount = 0;
  // Cached close-marker id when the marker tokenises to a single
  // token (enables EOS-inside-reasoning replacement).
  llama_token cached_close_tag_token = LLAMA_TOKEN_NULL;
  llama_token cached_newline_token = LLAMA_TOKEN_NULL;
  bool inside_reasoning = false;
  std::string recent_output_buffer;

  // Rolling-window size for substring matching. Must exceed the longest
  // configured marker plus the worst-case partial-token tail.
  static constexpr size_t BUFFER_SIZE = 50;
};

// Initialise `state` with `tags`. Tokenises both markers under
// `lctx`'s vocab to populate the cached counts and ids. Empty
// `tags.open`/`tags.close` leave the state in a disabled mode.
// `forcedOpenText`, when non-empty, must be the exact template suffix
// already present in the prompt when `thinking_forced_open` is true.
// `eosRecoveryCloseTag`, when non-empty, is tokenised separately for
// the Qwen-family EOS-inside-reasoning recovery path; detection still
// uses `tags.close`.
//
// Returns `true` iff the open marker satisfies the BPE-merge-barrier
// invariant required by the span-start arithmetic in
// `TextLlmContext::onLogitsReady` (`nPast_ - (openTokenCount - 1)`):
//   - openTokenCount >= 1, AND
//   - every piece tokenises to a CONTROL or USER_DEFINED token, so the
//     standalone tokenisation matches the in-context emission piece-for-
//     piece (no BPE merges across surrounding text bytes).
// Returns `false` (and clears markers / token counts) if the invariant is
// violated — callers should disable reasoning detection in that case to
// avoid corrupting the KV cache with an off-by-one span start.
[[nodiscard]] bool initializeReasoningState(
    ::llama_context* lctx, ReasoningState& state, ReasoningTags tags,
    const std::string& forcedOpenText = {},
    const std::string& eosRecoveryCloseTag = {});

// Append `tokenStr` to the rolling buffer and flip
// `state.inside_reasoning` when the buffer first contains the
// configured open / close markers. No-op when tags are unset.
void updateReasoningBuffer(const std::string& tokenStr, ReasoningState& state);

} // namespace utils
} // namespace qvac_lib_inference_addon_llama
