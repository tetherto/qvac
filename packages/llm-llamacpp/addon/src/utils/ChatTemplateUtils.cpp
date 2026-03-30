#include "ChatTemplateUtils.hpp"

#include <algorithm>

#include <llama.h>

#include "Qwen3ToolsDynamicTemplate.hpp"
#include "QwenTemplate.hpp"
#include "utils/LoggingMacros.hpp"

using namespace qvac_lib_inference_addon_cpp::logger;

namespace qvac_lib_inference_addon_llama {
namespace utils {

bool isQwen3Model(const ::llama_model* model) {
  if (model == nullptr) {
    return false;
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

  // Check architecture metadata
  char arch[64] = {0};
  len = llama_model_meta_val_str(
      model, "general.architecture", arch, sizeof(arch));

  if (len > 0 && len < sizeof(arch)) {
    arch[len] = '\0';
    std::string archStr(arch);
    std::transform(
        archStr.begin(), archStr.end(), archStr.begin(), [](unsigned char c) {
          return std::tolower(c);
        });

    if (archStr.find("qwen3") != std::string::npos) {
      return true;
    }
  }

  return false;
}

std::string getChatTemplateForModel(
    const ::llama_model* model, const std::string& manualOverride,
    bool toolsAtEnd) {
  if (!manualOverride.empty()) {
    return manualOverride;
  }

  if (isQwen3Model(model)) {
    return toolsAtEnd ? getToolsDynamicQwen3Template()
                      : getFixedQwen3Template();
  }

  return "";
}

std::string getChatTemplate(
    const ::llama_model* model, const common_params& params, bool toolsAtEnd) {
  // Use fixed Qwen3 template if model is Qwen3 and Jinja is enabled
  std::string chatTemplate = params.chat_template;
  if (params.use_jinja) {
    chatTemplate =
        getChatTemplateForModel(model, params.chat_template, toolsAtEnd);
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
