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

inline std::string processPromptWithCacheOptions(
    const std::unique_ptr<LlamaModel>& model, const std::string& input,
    const std::string& cacheKey, bool saveCacheToDisk = false) {
  LlamaModel::Prompt prompt;
  prompt.input = input;
  // Cache-management tests exercise committed prompt state, not generation.
  // A prediction-limit generation rolls back by contract, whereas a completed
  // prefill commits deterministically and keeps these lifecycle tests fast.
  prompt.prefill = true;
  prompt.cacheKey = cacheKey;
  prompt.saveCacheToDisk = saveCacheToDisk;
  return model->processPrompt(prompt);
}

} // namespace test_common
