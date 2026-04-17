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

  if (auto arch = getModelArchitecture(model); arch.has_value()) {
    if (arch.value() == "qwen3") {
      return true;
    }
  }

  // Check model name metadata
  char modelName[256] = {0};
  int32_t len = llama_model_meta_val_str(
      model, "general.name", modelName, sizeof(modelName));

  if (len > 0 && len < sizeof(modelName)) {
    modelName[len] = '\0';
    std::string nameStr(modelName);
    std::transform(
        nameStr.begin(), nameStr.end(), nameStr.begin(), [](unsigned char c) {
          return std::tolower(c);
        });

    if (nameStr.find("qwen3") != std::string::npos ||
        nameStr.find("qwen-3") != std::string::npos) {
      return true;
    }
  }

  return false;
}

std::optional<std::string>
selectToolsCompactMarker(const std::string& architecture) {
  const std::string archStr = normalizeArchitecture(architecture);
  if (archStr == "qwen3") {
    return std::string("<tool_call>");
  }
  return std::nullopt;
}

std::string getChatTemplateForModel(
    const ::llama_model* model, const std::string& manualOverride,
    bool toolsCompact) {
  if (!manualOverride.empty()) {
    return manualOverride;
  }

  const std::optional<std::string> architecture = getModelArchitecture(model);
  if (architecture.has_value() && architecture.value() == "qwen3") {
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
