#pragma once

#include <optional>
#include <string>

#include "common/chat.h"
#include "common/common.h"

// Forward declaration from llama.h
struct llama_model;
struct llama_context;

namespace qvac_lib_inference_addon_llama {
namespace utils {

bool isQwen3Model(const ::llama_model* model);
bool isHarmonyModel(const ::llama_model* model);
llama_token getHarmonyCallToken(::llama_context* lctx);
std::optional<std::string> getModelArchitecture(const ::llama_model* model);
bool supportsToolsCompactForModelMetadata(
    const std::optional<std::string>& architecture,
    const std::optional<std::string>& modelName);

std::optional<std::string>
selectToolsCompactMarker(const std::string& architecture);
std::optional<std::string> selectToolsCompactMarkerForModelMetadata(
    const std::optional<std::string>& architecture,
    const std::optional<std::string>& modelName);

/**
 * @brief Gets the appropriate chat template for a model
 *
 * For Qwen3 models, returns the fixed template or tools-compact template
 * based on the toolsCompact flag.
 * For other models, returns the manual override or empty string.
 */
std::string getChatTemplateForModel(
    const ::llama_model* model, const std::string& manualOverride,
    bool toolsCompact);

/**
 * @brief Gets the chat template for a model, applying Qwen3 fixes if Jinja is
 * enabled.
 *
 * When @p useModelChatTemplate is true, the Qwen3 forced-template path is
 * bypassed and the user's manual override (`params.chat_template`) is returned
 * verbatim — including the empty string, in which case llama.cpp falls back
 * to the template embedded in the GGUF (`tokenizer.chat_template`).
 *
 * Note: the bundled fixed Qwen3 template patches around minja
 * incompatibilities in the upstream Qwen3 Jinja template (Python-only filters
 * such as `.strip()` etc.). Opting into the model's embedded template can
 * therefore produce broken prompts if that template relies on those
 * unsupported features.
 */
std::string getChatTemplate(
    const ::llama_model* model, const common_params& params, bool toolsCompact,
    bool useModelChatTemplate = false);

/**
 * @brief Applies chat templates to generate a prompt, with fallback handling
 * for models that don't support tools
 */
std::string getPrompt(
    const struct common_chat_templates* tmpls,
    struct common_chat_templates_inputs& inputs);

} // namespace utils
} // namespace qvac_lib_inference_addon_llama
