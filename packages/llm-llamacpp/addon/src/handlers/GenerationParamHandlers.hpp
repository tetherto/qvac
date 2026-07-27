#pragma once

#include <functional>
#include <string>
#include <unordered_map>

#include <inference-addon-cpp/JsInterface.hpp>
#include <inference-addon-cpp/JsUtils.hpp>

#include "model-interface/LlmContext.hpp"

namespace qvac_lib_inference_addon_llama {

namespace js = qvac_lib_inference_addon_cpp::js;

// Reads one `generationParams` key off the JS object into the override struct.
using GenerationParamHandler =
    std::function<void(js_env_t*, js::Object&, GenerationParams&)>;
using GenerationParamHandlersMap =
    std::unordered_map<std::string, GenerationParamHandler>;

extern const GenerationParamHandlersMap GENERATION_PARAM_HANDLERS;

// Apply all handlers, then enforce grammar/json_schema mutual exclusion.
// Absent and unknown keys are ignored.
void applyGenerationParamHandlers(
    js_env_t* env, js::Object& obj, GenerationParams& params);

} // namespace qvac_lib_inference_addon_llama
