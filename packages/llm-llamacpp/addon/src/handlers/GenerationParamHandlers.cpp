#include "handlers/GenerationParamHandlers.hpp"

#include <optional>
#include <utility>

#include <inference-addon-cpp/Errors.hpp>

#include "handlers/LlmParsers.hpp"

namespace qvac_lib_inference_addon_llama {

template <typename Opt>
static void
readNumInto(js_env_t* env, js::Object& obj, const char* key, Opt& out) {
  auto value = obj.getOptionalPropertyAs<js::Number, double>(env, key);
  if (value.has_value()) {
    out = static_cast<typename Opt::value_type>(*value);
  }
}

static void readNonEmptyStrInto(
    js_env_t* env, js::Object& obj, const char* key,
    std::optional<std::string>& out) {
  auto value = obj.getOptionalPropertyAs<js::String, std::string>(env, key);
  if (value.has_value() && !value->empty()) {
    out = std::move(*value);
  }
}

const GenerationParamHandlerList GENERATION_PARAM_HANDLERS = {
    {"temp",
     [](js_env_t* env, js::Object& obj, GenerationParams& p) {
       readNumInto(env, obj, "temp", p.temp);
     }},
    {"top_p",
     [](js_env_t* env, js::Object& obj, GenerationParams& p) {
       readNumInto(env, obj, "top_p", p.top_p);
     }},
    {"top_k",
     [](js_env_t* env, js::Object& obj, GenerationParams& p) {
       readNumInto(env, obj, "top_k", p.top_k);
     }},
    {"predict",
     [](js_env_t* env, js::Object& obj, GenerationParams& p) {
       readNumInto(env, obj, "predict", p.n_predict);
     }},
    {"seed",
     [](js_env_t* env, js::Object& obj, GenerationParams& p) {
       readNumInto(env, obj, "seed", p.seed);
     }},
    {"frequency_penalty",
     [](js_env_t* env, js::Object& obj, GenerationParams& p) {
       readNumInto(env, obj, "frequency_penalty", p.frequency_penalty);
     }},
    {"presence_penalty",
     [](js_env_t* env, js::Object& obj, GenerationParams& p) {
       readNumInto(env, obj, "presence_penalty", p.presence_penalty);
     }},
    {"repeat_penalty",
     [](js_env_t* env, js::Object& obj, GenerationParams& p) {
       readNumInto(env, obj, "repeat_penalty", p.repeat_penalty);
     }},
    {"grammar",
     [](js_env_t* env, js::Object& obj, GenerationParams& p) {
       readNonEmptyStrInto(env, obj, "grammar", p.grammar);
     }},
    {"json_schema",
     [](js_env_t* env, js::Object& obj, GenerationParams& p) {
       readNonEmptyStrInto(env, obj, "json_schema", p.json_schema);
     }},
    {"reasoning_budget",
     [](js_env_t* env, js::Object& obj, GenerationParams& p) {
       auto value = obj.getOptionalPropertyAs<js::Number, double>(
           env, "reasoning_budget");
       if (value.has_value()) {
         p.reasoning_budget = parsers::validateReasoningBudgetOverride(*value);
       }
     }},
    {"remove_thinking_from_context",
     [](js_env_t* env, js::Object& obj, GenerationParams& p) {
       auto value = obj.getOptionalPropertyAs<js::Boolean, bool>(
           env, "remove_thinking_from_context");
       if (value.has_value()) {
         p.remove_thinking_from_context = *value;
       }
     }},
};

void applyGenerationParamHandlers(
    js_env_t* env, js::Object& obj, GenerationParams& params) {
  for (const auto& [key, handler] : GENERATION_PARAM_HANDLERS) {
    handler(env, obj, params);
  }
  if (params.grammar && params.json_schema) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "generationParams.grammar and generationParams.json_schema are "
        "mutually exclusive");
  }
}

} // namespace qvac_lib_inference_addon_llama
