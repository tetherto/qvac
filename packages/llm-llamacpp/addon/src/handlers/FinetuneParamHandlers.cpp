#include "handlers/FinetuneParamHandlers.hpp"

#include <string>
#include <type_traits>
#include <utility>

namespace qvac_lib_inference_addon_llama {

template <typename JsT, typename ReadT, typename FieldT>
static void
readOpt(js_env_t* env, js::Object& obj, const char* key, FieldT& field) {
  auto value = obj.getOptionalPropertyAs<JsT, ReadT>(env, key);
  if (value.has_value()) {
    if constexpr (std::is_same_v<FieldT, std::string>) {
      field = std::move(*value);
    } else {
      field = static_cast<FieldT>(*value);
    }
  }
}

const FinetuneParamHandlerList FINETUNE_PARAM_HANDLERS = {
    {"numberOfEpochs",
     [](js_env_t* env, js::Object& obj, LlamaFinetuningParams& p) {
       readOpt<js::Number, int64_t>(
           env, obj, "numberOfEpochs", p.numberOfEpochs);
     }},
    {"learningRate",
     [](js_env_t* env, js::Object& obj, LlamaFinetuningParams& p) {
       readOpt<js::Number, double>(env, obj, "learningRate", p.learningRate);
     }},
    {"evalDatasetPath",
     [](js_env_t* env, js::Object& obj, LlamaFinetuningParams& p) {
       readOpt<js::String, std::string>(
           env, obj, "evalDatasetPath", p.evalDatasetPath);
     }},
    {"contextLength",
     [](js_env_t* env, js::Object& obj, LlamaFinetuningParams& p) {
       readOpt<js::Number, int64_t>(env, obj, "contextLength", p.contextLength);
     }},
    {"microBatchSize",
     [](js_env_t* env, js::Object& obj, LlamaFinetuningParams& p) {
       readOpt<js::Number, int64_t>(
           env, obj, "microBatchSize", p.microBatchSize);
     }},
    {"assistantLossOnly",
     [](js_env_t* env, js::Object& obj, LlamaFinetuningParams& p) {
       readOpt<js::Boolean, bool>(
           env, obj, "assistantLossOnly", p.assistantLossOnly);
     }},
    {"checkpointSaveDir",
     [](js_env_t* env, js::Object& obj, LlamaFinetuningParams& p) {
       readOpt<js::String, std::string>(
           env, obj, "checkpointSaveDir", p.checkpointSaveDir);
     }},
    {"loraModules",
     [](js_env_t* env, js::Object& obj, LlamaFinetuningParams& p) {
       readOpt<js::String, std::string>(env, obj, "loraModules", p.loraModules);
     }},
    {"loraRank",
     [](js_env_t* env, js::Object& obj, LlamaFinetuningParams& p) {
       readOpt<js::Number, int32_t>(env, obj, "loraRank", p.loraRank);
     }},
    {"loraAlpha",
     [](js_env_t* env, js::Object& obj, LlamaFinetuningParams& p) {
       readOpt<js::Number, double>(env, obj, "loraAlpha", p.loraAlpha);
     }},
    {"loraInitStd",
     [](js_env_t* env, js::Object& obj, LlamaFinetuningParams& p) {
       readOpt<js::Number, double>(env, obj, "loraInitStd", p.loraInitStd);
     }},
    {"loraSeed",
     [](js_env_t* env, js::Object& obj, LlamaFinetuningParams& p) {
       readOpt<js::Number, int64_t>(env, obj, "loraSeed", p.loraSeed);
     }},
    {"chatTemplatePath",
     [](js_env_t* env, js::Object& obj, LlamaFinetuningParams& p) {
       readOpt<js::String, std::string>(
           env, obj, "chatTemplatePath", p.chatTemplatePath);
     }},
    {"checkpointSaveSteps",
     [](js_env_t* env, js::Object& obj, LlamaFinetuningParams& p) {
       readOpt<js::Number, int64_t>(
           env, obj, "checkpointSaveSteps", p.checkpointSaveSteps);
     }},
    {"lrMin",
     [](js_env_t* env, js::Object& obj, LlamaFinetuningParams& p) {
       readOpt<js::Number, double>(env, obj, "lrMin", p.lrMin);
     }},
    {"lrScheduler",
     [](js_env_t* env, js::Object& obj, LlamaFinetuningParams& p) {
       readOpt<js::String, std::string>(env, obj, "lrScheduler", p.lrScheduler);
     }},
    {"warmupRatio",
     [](js_env_t* env, js::Object& obj, LlamaFinetuningParams& p) {
       readOpt<js::Number, double>(env, obj, "warmupRatio", p.warmupRatio);
     }},
    {"batchSize",
     [](js_env_t* env, js::Object& obj, LlamaFinetuningParams& p) {
       readOpt<js::Number, int64_t>(env, obj, "batchSize", p.batchSize);
     }},
    {"weightDecay",
     [](js_env_t* env, js::Object& obj, LlamaFinetuningParams& p) {
       readOpt<js::Number, double>(env, obj, "weightDecay", p.weightDecay);
     }},
    {"warmupStepsSet",
     [](js_env_t* env, js::Object& obj, LlamaFinetuningParams& p) {
       readOpt<js::Boolean, bool>(env, obj, "warmupStepsSet", p.warmupStepsSet);
     }},
    {"warmupSteps",
     [](js_env_t* env, js::Object& obj, LlamaFinetuningParams& p) {
       readOpt<js::Number, int64_t>(env, obj, "warmupSteps", p.warmupSteps);
     }},
    {"warmupRatioSet",
     [](js_env_t* env, js::Object& obj, LlamaFinetuningParams& p) {
       readOpt<js::Boolean, bool>(env, obj, "warmupRatioSet", p.warmupRatioSet);
     }},
    {"validationSplit",
     [](js_env_t* env, js::Object& obj, LlamaFinetuningParams& p) {
       readOpt<js::Number, double>(
           env, obj, "validationSplit", p.validationSplit);
     }},
    {"useEvalDatasetForValidation",
     [](js_env_t* env, js::Object& obj, LlamaFinetuningParams& p) {
       readOpt<js::Boolean, bool>(
           env,
           obj,
           "useEvalDatasetForValidation",
           p.useEvalDatasetForValidation);
     }},
};

void applyFinetuneParamHandlers(
    js_env_t* env, js::Object& obj, LlamaFinetuningParams& params) {
  for (const auto& [key, handler] : FINETUNE_PARAM_HANDLERS) {
    handler(env, obj, params);
  }
}

} // namespace qvac_lib_inference_addon_llama
