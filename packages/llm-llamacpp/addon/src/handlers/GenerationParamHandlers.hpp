#pragma once

#include <functional>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "model-interface/LlmContext.hpp"

namespace qvac_lib_inference_addon_llama {

// Typed lookups into one `generationParams` object, independent of where it
// came from (a JS object on Bare, JSON in the browser build). Each returns
// nullopt when the key is absent or null and throws InvalidArgument when it
// holds another type.
struct GenerationParamSource {
  std::function<std::optional<double>(const char*)> number;
  std::function<std::optional<std::string>(const char*)> string;
  std::function<std::optional<bool>(const char*)> boolean;
};

// Reads one `generationParams` key into the override struct.
using GenerationParamHandler =
    std::function<void(const GenerationParamSource&, GenerationParams&)>;
using GenerationParamHandlerList =
    std::vector<std::pair<std::string, GenerationParamHandler>>;

// Order is significant: handlers run in listed order (deterministic error
// precedence when multiple fields are invalid).
extern const GenerationParamHandlerList GENERATION_PARAM_HANDLERS;

// Apply all handlers, then enforce grammar/json_schema mutual exclusion.
// Absent and unknown keys are ignored.
void applyGenerationParamHandlers(
    const GenerationParamSource& source, GenerationParams& params);

} // namespace qvac_lib_inference_addon_llama
