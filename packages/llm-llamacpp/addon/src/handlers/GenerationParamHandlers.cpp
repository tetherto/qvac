#include "handlers/GenerationParamHandlers.hpp"

#include <optional>
#include <utility>

#include <inference-addon-cpp/Errors.hpp>

#include "handlers/LlmParsers.hpp"

namespace qvac_lib_inference_addon_llama {

template <typename Opt>
static void
readNumInto(const GenerationParamSource& src, const char* key, Opt& out) {
  auto value = src.number(key);
  if (value.has_value()) {
    out = static_cast<typename Opt::value_type>(*value);
  }
}

static void readNonEmptyStrInto(
    const GenerationParamSource& src, const char* key,
    std::optional<std::string>& out) {
  auto value = src.string(key);
  if (value.has_value() && !value->empty()) {
    out = std::move(*value);
  }
}

const GenerationParamHandlerList GENERATION_PARAM_HANDLERS = {
    {"temp",
     [](const GenerationParamSource& src, GenerationParams& p) {
       readNumInto(src, "temp", p.temp);
     }},
    {"top_p",
     [](const GenerationParamSource& src, GenerationParams& p) {
       readNumInto(src, "top_p", p.top_p);
     }},
    {"top_k",
     [](const GenerationParamSource& src, GenerationParams& p) {
       readNumInto(src, "top_k", p.top_k);
     }},
    {"predict",
     [](const GenerationParamSource& src, GenerationParams& p) {
       readNumInto(src, "predict", p.n_predict);
     }},
    {"seed",
     [](const GenerationParamSource& src, GenerationParams& p) {
       readNumInto(src, "seed", p.seed);
     }},
    {"frequency_penalty",
     [](const GenerationParamSource& src, GenerationParams& p) {
       readNumInto(src, "frequency_penalty", p.frequency_penalty);
     }},
    {"presence_penalty",
     [](const GenerationParamSource& src, GenerationParams& p) {
       readNumInto(src, "presence_penalty", p.presence_penalty);
     }},
    {"repeat_penalty",
     [](const GenerationParamSource& src, GenerationParams& p) {
       readNumInto(src, "repeat_penalty", p.repeat_penalty);
     }},
    {"grammar",
     [](const GenerationParamSource& src, GenerationParams& p) {
       readNonEmptyStrInto(src, "grammar", p.grammar);
     }},
    {"json_schema",
     [](const GenerationParamSource& src, GenerationParams& p) {
       readNonEmptyStrInto(src, "json_schema", p.json_schema);
     }},
    {"tool_choice",
     [](const GenerationParamSource& src, GenerationParams& p) {
       readNonEmptyStrInto(src, "tool_choice", p.tool_choice);
     }},
    {"parallel_tool_calls",
     [](const GenerationParamSource& src, GenerationParams& p) {
       auto value = src.boolean("parallel_tool_calls");
       if (value.has_value()) {
         p.parallel_tool_calls = *value;
       }
     }},
    {"reasoning_budget",
     [](const GenerationParamSource& src, GenerationParams& p) {
       auto value = src.number("reasoning_budget");
       if (value.has_value()) {
         p.reasoning_budget = parsers::validateReasoningBudgetOverride(*value);
       }
     }},
};

void applyGenerationParamHandlers(
    const GenerationParamSource& source, GenerationParams& params) {
  for (const auto& [key, handler] : GENERATION_PARAM_HANDLERS) {
    handler(source, params);
  }
  if (params.grammar && params.json_schema) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "generationParams.grammar and generationParams.json_schema are "
        "mutually exclusive");
  }
}

} // namespace qvac_lib_inference_addon_llama
