#include "ChatTemplateUtils.hpp"

#include <algorithm>
#include <cctype>
#include <ranges>
#include <string_view>
#include <utility>

#include <llama.h>

#include "Qwen3ToolsDynamicTemplate.hpp"
#include "QwenTemplate.hpp"
#include "utils/LoggingMacros.hpp"

using namespace qvac_lib_inference_addon_cpp::logger;

namespace qvac_lib_inference_addon_llama {
namespace utils {

namespace {

// Lowercased literal used for case-insensitive equality against
// `general.basename` GGUF metadata to identify MedPsy models.
inline constexpr std::string_view MEDPSY_BASENAME_LOWER{"medpsy"};

std::string toLower(std::string_view value) {
  std::string lowered(value.size(), '\0');
  std::ranges::transform(value, lowered.begin(), [](unsigned char ch) {
    return std::tolower(ch);
  });
  return lowered;
}

std::string normalizeArchitecture(std::string_view architecture) {
  return toLower(architecture);
}

bool isQwen3Architecture(std::string_view architecture) {
  return normalizeArchitecture(architecture) == "qwen3";
}

bool isHarmonyArchitecture(std::string_view architecture) {
  return normalizeArchitecture(architecture) == "gpt-oss";
}

std::optional<std::string>
readMetadataString(const ::llama_model* model, const char* key) {
  if (model == nullptr || key == nullptr) {
    return std::nullopt;
  }

  char buffer[256] = {0};
  int32_t len = llama_model_meta_val_str(model, key, buffer, sizeof(buffer));
  if (len > 0 && static_cast<size_t>(len) < sizeof(buffer)) {
    buffer[len] = '\0';
    return std::string(buffer);
  }
  return std::nullopt;
}

std::optional<std::string> getModelBasename(const ::llama_model* model) {
  return readMetadataString(model, "general.basename");
}

} // namespace

std::optional<std::string> getModelArchitecture(const ::llama_model* model) {
  if (model == nullptr) {
    return std::nullopt;
  }

  // Check architecture metadata first; this drives family-specific template and
  // tools_compact profile selection.
  char arch[64] = {0};
  int32_t len = llama_model_meta_val_str(
      model, "general.architecture", arch, sizeof(arch));
  if (len > 0 && static_cast<size_t>(len) < sizeof(arch)) {
    arch[len] = '\0';
    return normalizeArchitecture(arch);
  }
  return std::nullopt;
}

bool isQwen3Model(const ::llama_model* model) {
  if (model == nullptr) {
    return false;
  }

  return supportsToolsCompactForModelMetadata(getModelArchitecture(model));
}

bool isMedPsyBasename(std::string_view basename) {
  return !basename.empty() && toLower(basename) == MEDPSY_BASENAME_LOWER;
}

bool isMedPsyModel(const ::llama_model* model) {
  // No explicit nullptr guard needed: getModelBasename() ->
  // readMetadataString() returns std::nullopt for a null model, and
  // value_or("") below feeds isMedPsyBasename an empty string view which it
  // rejects.
  return isMedPsyBasename(getModelBasename(model).value_or(""));
}

bool isHarmonyModel(const ::llama_model* model) {
  if (model == nullptr) {
    return false;
  }
  std::optional<std::string> arch = getModelArchitecture(model);
  return arch.has_value() && isHarmonyArchitecture(arch.value());
}

llama_token getHarmonyCallToken(::llama_context* lctx) {
  std::vector<llama_token> tokens =
      common_tokenize(lctx, "<|call|>", false, true);
  if (tokens.size() == 1) {
    return tokens[0];
  }
  return LLAMA_TOKEN_NULL;
}

bool supportsToolsCompactForModelMetadata(
    const std::optional<std::string>& architecture) {
  return architecture.has_value() && isQwen3Architecture(architecture.value());
}

std::optional<std::string> selectToolsCompactMarkerForModelMetadata(
    const std::optional<std::string>& architecture) {
  if (!supportsToolsCompactForModelMetadata(architecture)) {
    return std::nullopt;
  }
  return std::string("<tool_call>");
}

std::string getChatTemplateForModel(
    const ::llama_model* model, const std::string& manualOverride,
    bool toolsCompact) {
  if (!manualOverride.empty()) {
    return manualOverride;
  }

  // MedPsy ships its own chat template embedded in GGUF metadata. Returning an
  // empty string makes common_chat_templates_init() defer to that embedded
  // template instead of substituting the hardcoded Qwen3 templates below, even
  // when the model's architecture is reported as qwen3.
  if (isMedPsyModel(model)) {
    QLOG_IF(
        Priority::INFO,
        "[ChatTemplateUtils] MedPsy basename detected; using embedded chat "
        "template\n");
    return "";
  }

  if (isQwen3Model(model)) {
    return toolsCompact ? getToolsDynamicQwen3Template()
                        : getFixedQwen3Template();
  }

  return "";
}

std::string getChatTemplate(
    const ::llama_model* model, const common_params& params,
    bool toolsCompact) {
  std::string chatTemplate = params.chat_template;
  if (params.use_jinja) {
    chatTemplate =
        getChatTemplateForModel(model, params.chat_template, toolsCompact);
    if (!chatTemplate.empty() && chatTemplate != params.chat_template) {
      QLOG_IF(
          Priority::INFO, "[ChatTemplateUtils] Using fixed Qwen3 template\n");
    }
  }
  return chatTemplate;
}

std::string getPrompt(
    const struct common_chat_templates* tmpls,
    struct common_chat_templates_inputs& inputs, bool* outThinkingForcedOpen,
    std::string* outThinkingStartTag, std::string* outThinkingEndTag,
    std::string* outGenerationPrompt) {
  auto exportParams = [&](const common_chat_params& params) {
    if (outThinkingForcedOpen) {
      *outThinkingForcedOpen = params.thinking_forced_open;
    }
    if (outThinkingStartTag) {
      *outThinkingStartTag = params.thinking_start_tag;
    }
    if (outThinkingEndTag) {
      *outThinkingEndTag = params.thinking_end_tag;
    }
    if (outGenerationPrompt) {
      *outGenerationPrompt = params.generation_prompt;
    }
  };
  try {
    auto params = common_chat_templates_apply(tmpls, inputs);
    exportParams(params);
    return params.prompt;
  } catch (const std::exception& e) {
    // Catching known issue when a model does not support tools
    QLOG_IF(
        Priority::ERROR,
        string_format(
            "[ChatTemplateUtils] model does not support tools. Error: %s. "
            "Tools will "
            "be ignored.\n",
            e.what()));
    inputs.use_jinja = false;
    auto params = common_chat_templates_apply(tmpls, inputs);
    exportParams(params);
    return params.prompt;
  } catch (...) {
    // Catching any other exception type
    QLOG_IF(
        Priority::ERROR,
        "[ChatTemplateUtils] model does not support tools (unknown exception). "
        "Tools "
        "will be ignored.\n");
    inputs.use_jinja = false;
    auto params = common_chat_templates_apply(tmpls, inputs);
    exportParams(params);
    return params.prompt;
  }
}

bool configureReasoningBudgetSampling(
    common_params& params, ::llama_context* lctx,
    const std::string& thinkingStartTag, const std::string& thinkingEndTag,
    const std::string& generationPrompt) {
  common_params_sampling next = params.sampling;
  next.reasoning_budget_tokens =
      params.reasoning_budget > 0 ? params.reasoning_budget : -1;
  next.reasoning_budget_start.clear();
  next.reasoning_budget_end.clear();
  next.reasoning_budget_forced.clear();
  next.generation_prompt.clear();

  if (params.reasoning_budget > 0 && lctx != nullptr &&
      !thinkingEndTag.empty()) {
    next.generation_prompt = generationPrompt;
    if (!thinkingStartTag.empty()) {
      next.reasoning_budget_start =
          common_tokenize(lctx, thinkingStartTag, false, true);
    }
    next.reasoning_budget_end =
        common_tokenize(lctx, thinkingEndTag, false, true);
    next.reasoning_budget_forced = common_tokenize(
        lctx,
        params.sampling.reasoning_budget_message + thinkingEndTag,
        false,
        true);
  }

  const bool changed =
      params.sampling.reasoning_budget_tokens != next.reasoning_budget_tokens ||
      params.sampling.reasoning_budget_start != next.reasoning_budget_start ||
      params.sampling.reasoning_budget_end != next.reasoning_budget_end ||
      params.sampling.reasoning_budget_forced != next.reasoning_budget_forced ||
      params.sampling.generation_prompt != next.generation_prompt;
  if (changed) {
    params.sampling = std::move(next);
  }
  return changed;
}

std::string getThinkingForcedOpenText(
    const std::string& generationPrompt, const std::string& thinkingStartTag) {
  if (thinkingStartTag.empty()) {
    return {};
  }
  const auto start = generationPrompt.rfind(thinkingStartTag);
  if (start == std::string::npos) {
    return thinkingStartTag;
  }
  return generationPrompt.substr(start);
}

} // namespace utils
} // namespace qvac_lib_inference_addon_llama
