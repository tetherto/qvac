#include "model/SglangModel.hpp"

#include <any>
#include <stdexcept>
#include <utility>

namespace qvac_llm_sglang {

SglangModel::SglangModel(std::string baseUrl, std::string apiKey)
    : endpoint_(parseHttpEndpoint(std::move(baseUrl))),
      apiKey_(std::move(apiKey)) {
  if (apiKey_.find_first_of("\r\n") != std::string::npos) {
    throw std::invalid_argument("apiKey must not contain CR or LF");
  }
}

std::string SglangModel::getName() const { return "sglang"; }

qvac_lib_inference_addon_cpp::RuntimeStats SglangModel::runtimeStats() const {
  return {};
}

void SglangModel::cancel() const { cancel_.request(); }

std::any SglangModel::process(const std::any& input) {
  const auto* prompt = std::any_cast<Prompt>(&input);
  if (prompt == nullptr) {
    throw std::invalid_argument("SGLang job input has the wrong type");
  }
  const std::uint64_t seen = cancel_.snapshot();
  if (cancel_.stopped(seen)) {
    return std::string{};
  }
  const std::string body = buildChatBody(prompt->messages, prompt->sampling);
  SseParser parser;
  const bool completed = httpPost(
      endpoint_, "/v1/chat/completions", body, cancel_, seen,
      [&](std::string_view chunk) {
        if (cancel_.stopped(seen)) {
          return;
        }
        for (const std::string& delta : parser.feed(chunk)) {
          if (prompt->outputCallback) {
            prompt->outputCallback(delta);
          }
        }
      }, apiKey_);
  if (completed && !cancel_.stopped(seen)) {
    for (const std::string& delta : parser.feed("\n")) {
      if (prompt->outputCallback) {
        prompt->outputCallback(delta);
      }
    }
    if (!parser.done()) {
      throw std::runtime_error("SGLang SSE stream ended without [DONE]");
    }
  }
  return std::string{};
}

} // namespace qvac_llm_sglang
