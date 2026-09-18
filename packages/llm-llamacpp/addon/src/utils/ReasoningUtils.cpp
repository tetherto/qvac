#include "ReasoningUtils.hpp"

#include <string>
#include <vector>

#include <llama.h>

namespace qvac_lib_inference_addon_llama {
namespace utils {

bool initializeReasoningState(
    ::llama_context* lctx, ReasoningState& state, ReasoningTags tags,
    const std::string& eosRecoveryCloseTag) {
  state.tags = tags;
  state.cached_close_tag_token = LLAMA_TOKEN_NULL;
  state.cached_newline_token = LLAMA_TOKEN_NULL;

  if (lctx == nullptr || tags.open.empty() || tags.close.empty()) {
    return false;
  }

  const std::string closeTagForEosRecovery =
      eosRecoveryCloseTag.empty() ? tags.close : eosRecoveryCloseTag;
  std::vector<llama_token> closeTokens =
      common_tokenize(lctx, closeTagForEosRecovery, false, true);
  if (closeTokens.size() == 1) {
    state.cached_close_tag_token = closeTokens[0];
  }

  // Gate EOS substitution on the tokenisation of the *canonical* close marker
  // (`closeTagForEosRecovery`, which strips the chat template's
  // surrounding whitespace for Qwen3-family) — tokenising the raw
  // `tags.close` here would misclassify Qwen3 templates like
  // `"\n</think>\n\n"` as multi-token even though `</think>` itself
  // is a single vocab token. The corollary — that the string-search
  // detector in `updateReasoningBuffer` flips on the padded
  // `tags.close` and so the sampled token at the flip site is often
  // a trailing padding piece, not the canonical close — is why
  // the sampled token id at the flip site may be trailing padding rather than
  // the canonical close token.

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

  if (state.recent_output_buffer.find(state.tags.open) != std::string::npos) {
    state.inside_reasoning = true;
  }
  if (state.recent_output_buffer.find(state.tags.close) != std::string::npos) {
    state.inside_reasoning = false;
  }
}

} // namespace utils
} // namespace qvac_lib_inference_addon_llama
