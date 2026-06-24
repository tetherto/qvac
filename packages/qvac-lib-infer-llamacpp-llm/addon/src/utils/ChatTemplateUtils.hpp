#pragma once

#include <string>

#include "common/chat.h"
#include "common/common.h"

// Forward declaration from llama.h
struct llama_model;
struct llama_context;

namespace qvac_lib_inference_addon_llama {
namespace utils {

bool isQwen3Model(const ::llama_model* model);

/**
 * @brief Gets the appropriate chat template for a model
 *
 * For Qwen3 models, returns the fixed template from QwenTemplate.hpp.
 * For other models, returns the manual override or empty string.
 */
std::string getChatTemplateForModel(
    const ::llama_model* model, const std::string& manualOverride);

/**
 * @brief Gets the chat template for a model, applying Qwen3 fixes if Jinja is
 * enabled
 */
std::string
getChatTemplate(const ::llama_model* model, const common_params& params);

/**
 * @brief Applies chat templates to generate a prompt, with fallback handling
 * for models that don't support tools
 */
std::string getPrompt(
    const struct common_chat_templates* tmpls,
    struct common_chat_templates_inputs& inputs);

} // namespace utils
} // namespace qvac_lib_inference_addon_llama
