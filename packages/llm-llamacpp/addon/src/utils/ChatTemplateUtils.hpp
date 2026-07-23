#pragma once

#include <optional>
#include <string>
#include <string_view>

#include "ReasoningUtils.hpp"
#include "common/chat.h"
#include "common/common.h"

// Forward declaration from llama.h
struct llama_model;
struct llama_context;

namespace qvac_lib_inference_addon_llama {
namespace utils {

bool isQwen3Model(const ::llama_model* model);
bool isHarmonyModel(const ::llama_model* model);
bool isGemma4Model(const ::llama_model* model);
llama_token getHarmonyCallToken(::llama_context* lctx);
std::optional<std::string> getModelArchitecture(const ::llama_model* model);
bool supportsToolsCompactForModelMetadata(
    const std::optional<std::string>& architecture);

// Reasoning channel markers for the model family, or std::nullopt
// when the family has no recognised channel. Extend the table here
// to add support for new families.
std::optional<ReasoningTags>
selectReasoningTagsForModel(const ::llama_model* model);

// Architecture-only variant. Covers families identifiable from
// `general.architecture` alone (Qwen3-family: `qwen3`, `qwen35`,
// `qwen35moe`, ...). Gemma 4 needs basename and is resolved in
// `selectReasoningTagsForModel`.
std::optional<ReasoningTags> selectReasoningTagsForArchitecture(
    const std::optional<std::string>& architecture);

/**
 * @brief Selects reasoning detection tags by preferring chat-template-derived
 * values over the model-family fallback.
 *
 * Returns `{templateThinkingStartTag, templateThinkingEndTag}` when both
 * template tags are non-empty. Otherwise returns `fallbackTags`, which may
 * itself be `std::nullopt` when the model family has no recognised
 * reasoning channel.
 *
 * Single source of truth for the "template-first, family-fallback" policy
 * used by `remove_thinking_from_context` detection / compaction. Pure
 * function with no runtime dependencies, so it is unit-testable in
 * isolation.
 */
std::optional<ReasoningTags> selectReasoningTagSource(
    const std::string& templateThinkingStartTag,
    const std::string& templateThinkingEndTag,
    const std::optional<ReasoningTags>& fallbackTags);

/**
 * @brief Returns true when `architecture` is in the Qwen3 reasoning
 * family (`qwen3`, `qwen3moe`, `qwen35`, `qwen35moe`).
 *
 * Used to scope Qwen3-specific runtime behaviors (e.g. EOS-inside-
 * reasoning close-marker substitution) so they do not silently apply
 * to other families that also have a recognised reasoning channel
 * (e.g. Gemma 4). Empty / unknown architectures return false.
 */
bool isQwen3ReasoningFamilyArchitecture(std::string_view architecture);

/**
 * @brief Returns true when the GGUF metadata basename identifies a MedPsy
 * model. Exposed for unit testing without requiring a real ::llama_model.
 *
 * Comparison is case-insensitive against the literal "MedPsy"; an empty
 * basename returns false (callers should pass `value_or("")` from the
 * upstream `std::optional<std::string>` metadata accessor).
 */
bool isMedPsyBasename(std::string_view basename);

/**
 * @brief Returns true when the model's `general.basename` metadata identifies
 * it as a MedPsy model. MedPsy ships its own chat template embedded in the
 * GGUF, so callers should defer to it rather than substituting the hardcoded
 * Qwen3 templates.
 */
bool isMedPsyModel(const ::llama_model* model);

/**
 * @brief Returns true when `basename` (case-insensitive) contains a
 * Gemma 4 marker substring. Exposed for unit testing without requiring
 * a real ::llama_model.
 */
bool isGemma4Basename(std::string_view basename);

std::optional<std::string> selectToolsCompactMarkerForModelMetadata(
    const std::optional<std::string>& architecture);

/**
 * @brief Gets the appropriate chat template for a model
 *
 * Resolution order:
 *   1. A non-empty `manualOverride` always wins.
 *   2. Models whose GGUF `general.basename` is "MedPsy" return an empty
 *      string so callers fall through to the embedded chat template, even
 *      when the architecture is reported as qwen3.
 *   3. Qwen3 models return either the tools-compact dynamic template or the
 *      fixed Qwen3 template based on the `toolsCompact` flag.
 *   4. All other models return an empty string.
 */
std::string getChatTemplateForModel(
    const ::llama_model* model, const std::string& manualOverride,
    bool toolsCompact);

/**
 * @brief Gets the chat template for a model, applying Qwen3 fixes if Jinja is
 * enabled
 */
std::string getChatTemplate(
    const ::llama_model* model, const common_params& params, bool toolsCompact);

/**
 * @brief Applies chat templates to generate a prompt, with fallback handling
 * for models that don't support tools.
 *
 * @p outThinkingForcedOpen (optional) receives the flag indicating that the
 *    template force-opened the reasoning channel in the prompt suffix.
 * @p outThinkingStartTag (optional) receives the template-specific reasoning
 *    start tag, when the template exposes one.
 * @p outThinkingEndTag (optional) receives the template-specific reasoning
 *    end tag, when the template exposes one.
 * @p outGenerationPrompt (optional) receives the assistant generation prompt
 *    already appended to the formatted prompt.
 */
std::string getPrompt(
    const struct common_chat_templates* tmpls,
    struct common_chat_templates_inputs& inputs,
    bool* outThinkingForcedOpen = nullptr,
    std::string* outThinkingStartTag = nullptr,
    std::string* outThinkingEndTag = nullptr,
    std::string* outGenerationPrompt = nullptr);

/**
 * @brief Configures the common-sampling reasoning-budget fields from
 * template-derived thinking tags.
 *
 * Returns true when the sampling block changed and the caller should recreate
 * the common_sampler.
 */
bool configureReasoningBudgetSampling(
    common_params& params, ::llama_context* lctx,
    const std::string& thinkingStartTag, const std::string& thinkingEndTag,
    const std::string& generationPrompt);

std::string getThinkingForcedOpenText(
    const std::string& generationPrompt, const std::string& thinkingStartTag);

} // namespace utils
} // namespace qvac_lib_inference_addon_llama
