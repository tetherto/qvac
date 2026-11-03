#pragma once

#include <filesystem>
#include <memory>
#include <string>
#include <vector>

#include <ggml.h>
#include <gguf.h>
#include <inference-addon-cpp/Errors.hpp>
#include <tts-cpp/cosyvoice/engine.h>

namespace qvac::ttsggml::cosyvoice {

inline std::string resolveFlowModel(const std::string& directory) {
  for (const auto& entry : std::filesystem::directory_iterator(directory)) {
    const auto name = entry.path().filename().string();
    if (entry.is_regular_file() && name.starts_with("cosyvoice3-flow") &&
        entry.path().extension() == ".gguf") {
      return entry.path().string();
    }
  }
  return {};
}

inline void
requireSpeechTokenRange(const std::vector<int>& tokens, int64_t rows) {
  for (const int token : tokens) {
    if (token < 0 || token >= rows) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "forceSpeechTokens contains an ID outside the flow model vocabulary");
    }
  }
}

inline void
validateForcedSpeechTokens(tts_cpp::cosyvoice::EngineOptions& options) {
  if (options.force_speech_tokens.empty())
    return;
  if (options.flow_gguf_path.empty() && !options.model_dir.empty()) {
    options.flow_gguf_path = resolveFlowModel(options.model_dir);
  }
  ggml_context* tensors = nullptr;
  const gguf_init_params params{true, &tensors};
  std::unique_ptr<gguf_context, decltype(&gguf_free)> metadata(
      gguf_init_from_file(options.flow_gguf_path.c_str(), params), gguf_free);
  std::unique_ptr<ggml_context, decltype(&ggml_free)> context(
      tensors, ggml_free);
  const auto* embedding =
      context ? ggml_get_tensor(context.get(), "flow/input_embedding/weight")
              : nullptr;
  if (!metadata || !embedding || embedding->ne[1] <= 0) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "forceSpeechTokens requires readable flow embedding metadata");
  }
  requireSpeechTokenRange(options.force_speech_tokens, embedding->ne[1]);
}

} // namespace qvac::ttsggml::cosyvoice
