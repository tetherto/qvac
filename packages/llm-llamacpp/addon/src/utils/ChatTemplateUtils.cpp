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

bool modelNameLooksLikeQwen3(const std::string& modelName) {
  std::string normalizedName = modelName;
  std::transform(
      normalizedName.begin(),
      normalizedName.end(),
      normalizedName.begin(),
      [](unsigned char c) { return std::tolower(c); });
  return normalizedName.find("qwen3") != std::string::npos ||
         normalizedName.find("qwen-3") != std::string::npos;
}

std::optional<std::string> getModelName(const ::llama_model* model) {
  if (model == nullptr) {
    return std::nullopt;
  }

  char modelName[256] = {0};
  int32_t len = llama_model_meta_val_str(
      model, "general.name", modelName, sizeof(modelName));
  if (len > 0 && len < sizeof(modelName)) {
    modelName[len] = '\0';
    return std::string(modelName);
  }
  return std::nullopt;
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

  return supportsToolsCompactForModelMetadata(
      getModelArchitecture(model), getModelName(model));
}

bool supportsToolsCompactForModelMetadata(
    const std::optional<std::string>& architecture,
    const std::optional<std::string>& modelName) {
  if (architecture.has_value() && isQwen3Architecture(architecture.value())) {
    return true;
  }
  if (modelName.has_value() && modelNameLooksLikeQwen3(modelName.value())) {
    return true;
  }
  return false;
}

std::optional<std::string>
selectToolsCompactMarker(const std::string& architecture) {
  if (isQwen3Architecture(architecture)) {
    return std::string("<tool_call>");
  }
  return std::nullopt;
}

std::optional<std::string> selectToolsCompactMarkerForModelMetadata(
    const std::optional<std::string>& architecture,
    const std::optional<std::string>& modelName) {
  if (!supportsToolsCompactForModelMetadata(architecture, modelName)) {
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

  // Keep a single source of truth for Qwen3 detection so architecture-only and
  // metadata-name fallback behave consistently across marker/template paths.
  if (isQwen3Model(model)) {
    return toolsCompact ? getToolsDynamicQwen3Template()
                        : getFixedQwen3Template();
  }

  return "";
}

std::string getChatTemplate(
    const ::llama_model* model, const common_params& params,
    bool toolsCompact) {
  // Use fixed Qwen3 template if model is Qwen3 and Jinja is enabled
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
    struct common_chat_templates_inputs& inputs) {
  try {
    return common_chat_templates_apply(tmpls, inputs).prompt;
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
    return common_chat_templates_apply(tmpls, inputs).prompt;
  } catch (...) {
    // Catching any other exception type
    QLOG_IF(
        Priority::ERROR,
        "[ChatTemplateUtils] model does not support tools (unknown exception). "
        "Tools "
        "will be ignored.\n");
    inputs.use_jinja = false;
    return common_chat_templates_apply(tmpls, inputs).prompt;
  }
}

} // namespace utils
} // namespace qvac_lib_inference_addon_llama
