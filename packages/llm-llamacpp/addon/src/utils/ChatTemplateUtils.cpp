#include "ChatTemplateUtils.hpp"

#include <algorithm>
#include <cctype>

#include <llama.h>

#include "Qwen3ToolsDynamicTemplate.hpp"
#include "QwenTemplate.hpp"
#include "utils/LoggingMacros.hpp"

using namespace qvac_lib_inference_addon_cpp::logger;

namespace qvac_lib_inference_addon_llama {
namespace utils {

namespace {

std::string normalizeArchitecture(const std::string& architecture) {
  std::string normalized = architecture;
  std::transform(
      normalized.begin(),
      normalized.end(),
      normalized.begin(),
      [](unsigned char c) { return std::tolower(c); });
  return normalized;
}

bool isQwen3Architecture(const std::string& architecture) {
  const std::string archStr = normalizeArchitecture(architecture);
  return archStr == "qwen3";
}

bool isHarmonyArchitecture(const std::string& architecture) {
  const std::string archStr = normalizeArchitecture(architecture);
  return archStr == "gpt-oss";
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
  if (len > 0 && len < sizeof(arch)) {
    arch[len] = '\0';
    return normalizeArchitecture(std::string(arch));
  }
  return std::nullopt;
}

bool isQwen3Model(const ::llama_model* model) {
  if (model == nullptr) {
    return false;
  }

  return supportsToolsCompactForModelMetadata(getModelArchitecture(model));
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
    struct common_chat_templates_inputs& inputs,
    bool* outThinkingForcedOpen) {
  auto exportParams = [&](const common_chat_params& params) {
    if (outThinkingForcedOpen) {
      *outThinkingForcedOpen = params.thinking_forced_open;
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

} // namespace utils
} // namespace qvac_lib_inference_addon_llama
