#pragma once

#include <functional>
#include <string>
#include <utility>
#include <vector>

#include <inference-addon-cpp/JsInterface.hpp>
#include <inference-addon-cpp/JsUtils.hpp>

#include "model-interface/LlmContext.hpp"

namespace qvac_lib_inference_addon_llama {

namespace js = qvac_lib_inference_addon_cpp::js;

// Reads one `generationParams` key off the JS object into the override struct.
using GenerationParamHandler =
    std::function<void(js_env_t*, js::Object&, GenerationParams&)>;
using GenerationParamHandlerList =
    std::vector<std::pair<std::string, GenerationParamHandler>>;

// Order is significant: handlers run in listed order (deterministic error
// precedence when multiple fields are invalid).
extern const GenerationParamHandlerList GENERATION_PARAM_HANDLERS;

// Apply all handlers, then enforce grammar/json_schema mutual exclusion.
// Absent and unknown keys are ignored.
void applyGenerationParamHandlers(
    js_env_t* env, js::Object& obj, GenerationParams& params);

} // namespace qvac_lib_inference_addon_llama
