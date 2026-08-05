#pragma once

#include <functional>
#include <string>
#include <utility>
#include <vector>

#include <inference-addon-cpp/JsInterface.hpp>
#include <inference-addon-cpp/JsUtils.hpp>

#include "model-interface/LlamaFinetuningParams.hpp"

namespace qvac_lib_inference_addon_llama {

namespace js = qvac_lib_inference_addon_cpp::js;

// Reads one optional finetuning key off the JS object into the params struct.
using FinetuneParamHandler =
    std::function<void(js_env_t*, js::Object&, LlamaFinetuningParams&)>;
using FinetuneParamHandlerList =
    std::vector<std::pair<std::string, FinetuneParamHandler>>;

extern const FinetuneParamHandlerList FINETUNE_PARAM_HANDLERS;

// Apply all handlers; absent keys keep the struct default. Required fields
// (outputParametersDir, trainDatasetDir) are read by the caller.
void applyFinetuneParamHandlers(
    js_env_t* env, js::Object& obj, LlamaFinetuningParams& params);

} // namespace qvac_lib_inference_addon_llama
