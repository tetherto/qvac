#include "ReasoningUtils.hpp"

#include <string>
#include <vector>

#include <llama.h>

namespace qvac_lib_inference_addon_llama {
namespace utils {

namespace {

// Returns true iff the first piece in `tokens` has a CONTROL or
// USER_DEFINED attribute. That attribute is a BPE-merge barrier under
// `parse_special=true`, so a prior context token cannot absorb the start
// of the marker — which is what the span-start math
// `nPast_ - (openTokenCount - 1)` in TextLlmContext relies on. The
// remaining pieces don't need to be special: BPE only merges across a
// barrier when both sides are non-special, so once the first piece is a
// barrier the rest of the marker tokenises identically standalone and
// in-context (e.g. Gemma 4's `<|channel>thought` → [special, "thought"]).
// Empty `tokens` returns false.
bool firstTokenIsSpecial(
    const ::llama_vocab* vocab, const std::vector<llama_token>& tokens) {
  if (tokens.empty() || vocab == nullptr) {
    return false;
  }
  constexpr int specialMask =
      LLAMA_TOKEN_ATTR_CONTROL | LLAMA_TOKEN_ATTR_USER_DEFINED;
  const llama_token_attr attr = llama_vocab_get_attr(vocab, tokens.front());
  return (static_cast<int>(attr) & specialMask) != 0;
}

} // namespace

bool initializeReasoningState(
    ::llama_context* lctx, ReasoningState& state, ReasoningTags tags,
    const std::string& forcedOpenText, const std::string& eosRecoveryCloseTag) {
  state.tags = tags;
  state.openTokenCount = 0;
  state.forcedOpenTokenCount = 0;
  state.cached_close_tag_token = LLAMA_TOKEN_NULL;
  state.cached_newline_token = LLAMA_TOKEN_NULL;

  if (lctx == nullptr || tags.open.empty() || tags.close.empty()) {
    return false;
  }

  // Span-start math `nPast_ - (openTokenCount - 1)` in TextLlmContext
  // assumes the standalone tokenisation of the open marker matches its
  // in-context emission piece-for-piece. The first piece being a
  // CONTROL / USER_DEFINED special token is the load-bearing invariant:
  // it acts as a BPE-merge barrier under `parse_special=true`, so the
  // preceding context cannot absorb the start of the marker. Subsequent
  // pieces don't need to be special — once the barrier is in place, the
  // remaining bytes tokenise the same way standalone and in-context
  // (Gemma 4's `<|channel>thought` is the canonical mixed case).
  std::vector<llama_token> openTokens =
      common_tokenize(lctx, tags.open, false, true);
  const ::llama_vocab* vocab = llama_model_get_vocab(llama_get_model(lctx));
  if (!firstTokenIsSpecial(vocab, openTokens)) {
    state.tags = ReasoningTags{};
    return false;
  }
  state.openTokenCount = static_cast<int>(openTokens.size());

  const std::string forcedOpenMarker =
      forcedOpenText.empty() ? tags.open + "\n" : forcedOpenText;
  std::vector<llama_token> forcedOpenTokens =
      common_tokenize(lctx, forcedOpenMarker, false, true);
  state.forcedOpenTokenCount = static_cast<int>(forcedOpenTokens.size());

  const std::string closeTagForEosRecovery =
      eosRecoveryCloseTag.empty() ? tags.close : eosRecoveryCloseTag;
  std::vector<llama_token> closeTokens =
      common_tokenize(lctx, closeTagForEosRecovery, false, true);
  if (closeTokens.size() == 1) {
    state.cached_close_tag_token = closeTokens[0];
  }

  std::vector<llama_token> newlineTokens =
      common_tokenize(lctx, "\n", false, true);
  if (!newlineTokens.empty()) {
    state.cached_newline_token = newlineTokens[0];
  }
  return true;
}

void updateReasoningBuffer(const std::string& tokenStr, ReasoningState& state) {
  if (tokenStr.empty()) {
    return;
  }
  state.recent_output_buffer += tokenStr;
  if (state.recent_output_buffer.length() > ReasoningState::BUFFER_SIZE) {
    state.recent_output_buffer = state.recent_output_buffer.substr(
        state.recent_output_buffer.length() - ReasoningState::BUFFER_SIZE);
  }

  if (state.tags.open.empty() || state.tags.close.empty()) {
    return;
  }

  // Single-block policy in `TextLlmContext::setOpenThinkSpan`: only the
  // first `<think>...</think>` per inference is tracked. A simple
  // independent `find` for each marker is sufficient — the second-block
  // edge case (stale close in buffer when a new open arrives) would
  // matter only if we acted on a second open, which we don't.
  if (state.recent_output_buffer.find(state.tags.open) != std::string::npos) {
    state.inside_reasoning = true;
  }
  if (state.recent_output_buffer.find(state.tags.close) != std::string::npos) {
    state.inside_reasoning = false;
  }
}

} // namespace utils
} // namespace qvac_lib_inference_addon_llama
