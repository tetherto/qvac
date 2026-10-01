#include "ReasoningUtils.hpp"

#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <llama.h>

namespace qvac_lib_inference_addon_llama {
namespace utils {

bool initializeReasoningState(
    ::llama_context* lctx, ReasoningState& state, ReasoningTags tags) {
  state.tags = std::move(tags);
  return lctx != nullptr && !state.tags.open.empty() &&
         !state.tags.close.empty();
}

namespace {

std::string trimmed(const std::string& text) {
  constexpr const char* WHITESPACE = " \t\r\n";
  const size_t first = text.find_first_not_of(WHITESPACE);
  if (first == std::string::npos) {
    return "";
  }
  const size_t last = text.find_last_not_of(WHITESPACE);
  return text.substr(first, last - first + 1);
}

} // namespace

std::optional<SplitReasoning> splitReasoningFromContent(
    const std::string& content, const ReasoningTags& tags) {
  if (tags.open.empty() || tags.close.empty()) {
    return std::nullopt;
  }
  const size_t firstClose = content.find(tags.close);
  if (firstClose == std::string::npos) {
    return std::nullopt;
  }
  std::string reasoning = content.substr(0, firstClose);
  if (const size_t open = reasoning.rfind(tags.open);
      open != std::string::npos) {
    reasoning = reasoning.substr(open + tags.open.size());
  }
  std::string answer =
      content.substr(content.rfind(tags.close) + tags.close.size());
  answer.erase(0, answer.find_first_not_of('\n'));
  return SplitReasoning{
      .reasoning = trimmed(reasoning), .content = std::move(answer)};
}

void moveReasoningOutOfContent(
    std::vector<common_chat_msg>& messages, const ReasoningTags& tags) {
  for (common_chat_msg& message : messages) {
    if (message.role != "assistant" || !message.reasoning_content.empty()) {
      continue;
    }
    if (auto split = splitReasoningFromContent(message.content, tags)) {
      message.reasoning_content = std::move(split->reasoning);
      message.content = std::move(split->content);
    }
  }
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
