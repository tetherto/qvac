#pragma once

#include <memory>
#include <string>

#include "model-interface/LlamaModel.hpp"

namespace test_common {

inline std::string processPromptString(
    const std::unique_ptr<LlamaModel>& model, const std::string& input) {
  LlamaModel::Prompt prompt;
  prompt.input = input;
  return model->processPrompt(prompt);
}

/// Runs a keyed prompt; @p saveAfter then writes the conversation to its
/// file with an explicit `saveCache`.
inline std::string processPromptWithCacheOptions(
    const std::unique_ptr<LlamaModel>& model, const std::string& input,
    const std::string& cacheKey, bool saveAfter = false) {
  LlamaModel::Prompt prompt;
  prompt.input = input;
  prompt.cacheKey = cacheKey;
  std::string out = model->processPrompt(prompt);
  if (saveAfter) {
    model->saveCache(cacheKey);
  }
  return out;
}

} // namespace test_common
