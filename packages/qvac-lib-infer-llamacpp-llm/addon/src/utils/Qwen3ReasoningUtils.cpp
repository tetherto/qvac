#include "Qwen3ReasoningUtils.hpp"

#include <llama.h>

#include "utils/LoggingMacros.hpp"

using namespace qvac_lib_inference_addon_cpp::logger;

namespace qvac_lib_inference_addon_llama {
namespace utils {

void initializeQwen3ReasoningState(
    ::llama_context* lctx, Qwen3ReasoningState& state) {
  std::vector<llama_token> closeTagTokens =
      common_tokenize(lctx, "</think>", false, true);
  state.cached_close_tag_token =
      closeTagTokens.empty() ? LLAMA_TOKEN_NULL : closeTagTokens[0];

  std::vector<llama_token> newlineTokens =
      common_tokenize(lctx, "\n", false, true);
  state.cached_newline_token =
      newlineTokens.empty() ? LLAMA_TOKEN_NULL : newlineTokens[0];
}

void updateQwen3ReasoningBuffer(
    const std::string& tokenStr, Qwen3ReasoningState& state) {
  if (!tokenStr.empty()) {
    state.recent_output_buffer += tokenStr;
    if (state.recent_output_buffer.length() >
        Qwen3ReasoningState::BUFFER_SIZE) {
      state.recent_output_buffer = state.recent_output_buffer.substr(
          state.recent_output_buffer.length() -
          Qwen3ReasoningState::BUFFER_SIZE);
    }

    if (state.recent_output_buffer.find("<think>") != std::string::npos) {
      state.inside_reasoning = true;
    }
    if (state.recent_output_buffer.find("</think>") != std::string::npos) {
      state.inside_reasoning = false;
    }
  }
}

} // namespace utils
} // namespace qvac_lib_inference_addon_llama
