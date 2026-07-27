#pragma once

#include <functional>
#include <string>
#include <unordered_map>

#include <inference-addon-cpp/JsInterface.hpp>
#include <inference-addon-cpp/JsUtils.hpp>

#include "model-interface/LlamaFinetuningParams.hpp"

namespace qvac_lib_inference_addon_llama {

namespace js = qvac_lib_inference_addon_cpp::js;

// Reads one optional finetuning key off the JS object into the params struct.
using FinetuneParamHandler =
    std::function<void(js_env_t*, js::Object&, LlamaFinetuningParams&)>;
using FinetuneParamHandlersMap =
    std::unordered_map<std::string, FinetuneParamHandler>;

extern const FinetuneParamHandlersMap FINETUNE_PARAM_HANDLERS;

// Apply all handlers; absent keys keep the struct default. Required fields
// (outputParametersDir, trainDatasetDir) are read by the caller.
void applyFinetuneParamHandlers(
    js_env_t* env, js::Object& obj, LlamaFinetuningParams& params);

} // namespace qvac_lib_inference_addon_llama
