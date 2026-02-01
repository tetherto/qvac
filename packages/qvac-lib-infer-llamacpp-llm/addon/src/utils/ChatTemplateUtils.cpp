#include "ChatTemplateUtils.hpp"

#include <algorithm>

#include <llama.h>

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
  char model_name[256] = {0};
  int32_t len = llama_model_meta_val_str(
      model, "general.name", model_name, sizeof(model_name));

  if (len > 0 && len < sizeof(model_name)) {
    model_name[len] = '\0';
    std::string name_str(model_name);
    std::transform(
        name_str.begin(),
        name_str.end(),
        name_str.begin(),
        [](unsigned char c) { return std::tolower(c); });

    if (name_str.find("qwen3") != std::string::npos ||
        name_str.find("qwen-3") != std::string::npos) {
      return true;
    }
  }

  // Check architecture metadata
  char arch[64] = {0};
  len = llama_model_meta_val_str(
      model, "general.architecture", arch, sizeof(arch));

  if (len > 0 && len < sizeof(arch)) {
    arch[len] = '\0';
    std::string arch_str(arch);
    std::transform(
        arch_str.begin(),
        arch_str.end(),
        arch_str.begin(),
        [](unsigned char c) { return std::tolower(c); });

    if (arch_str.find("qwen3") != std::string::npos) {
      return true;
    }
  }

  return false;
}

std::string getChatTemplateForModel(
    const ::llama_model* model, const std::string& manual_override) {
  // If manual override is provided, use it as-is
  if (!manual_override.empty()) {
    return manual_override;
  }

  // For Qwen3 models, use the fixed template
  if (isQwen3Model(model)) {
    return getFixedQwen3Template();
  }

  // For other models, no override needed
  return "";
}

std::string
getChatTemplate(const ::llama_model* model, const common_params& params) {
  // Use fixed Qwen3 template if model is Qwen3 and Jinja is enabled
  std::string chat_template = params.chat_template;
  if (params.use_jinja) {
    chat_template = getChatTemplateForModel(model, params.chat_template);
    if (!chat_template.empty() && chat_template != params.chat_template) {
      QLOG_IF(
          Priority::INFO, "[ChatTemplateUtils] Using fixed Qwen3 template\n");
    }
  }
  return chat_template;
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
