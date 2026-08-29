#pragma once

#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "ReasoningUtils.hpp"
#include "common/chat.h"
#include "common/common.h"

// Forward declaration from llama.h
struct llama_model;
struct llama_context;

namespace qvac_lib_inference_addon_llama {
namespace utils {

bool isQwen3Model(const ::llama_model* model);

/**
 * @brief Returns true when `architecture` is exactly `qwen3`
 * (case-insensitive).
 *
 * Exact-match predicate that drives fixed-template selection in
 * `getChatTemplateForModel` (via `isQwen3Model`). Deliberately narrower than
 * `isQwen3ReasoningFamilyArchitecture`, which also matches `qwen35`/`qwen3moe`:
 * only exact `qwen3` gets the hardcoded Qwen3 chat template. Exposed for unit
 * testing without a real ::llama_model.
 */
bool isQwen3Architecture(std::string_view architecture);
bool isHarmonyModel(const ::llama_model* model);
bool isGemma4Model(const ::llama_model* model);
llama_token getHarmonyCallToken(::llama_context* lctx);
std::optional<std::string> getModelArchitecture(const ::llama_model* model);

// Reasoning channel markers for the model family, or std::nullopt
// when the family has no recognised channel. Extend the table here
// to add support for new families.
std::optional<ReasoningTags>
selectReasoningTagsForModel(const ::llama_model* model);

// Architecture-only variant. Covers families identifiable from
// `general.architecture` alone (Qwen3-family: `qwen3`, `qwen35`,
// `qwen35moe`, and DeepSeek V4: `deepseek4`). Gemma 4 needs basename
// and is resolved in `selectReasoningTagsForModel`.
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
 * @brief Returns whether thinking-block compaction defaults on for an
 * architecture.
 *
 * Only the Qwen3 reasoning family defaults on. Other architectures,
 * including DeepSeek V4, require an explicit per-request override.
 */
bool usesThinkingCompactionByDefault(std::string_view architecture);

/**
 * @brief Returns true when `architecture` is DeepSeek V4 (`deepseek4`).
 *
 * DeepSeek V4 uses the same full-state checkpoint/replay lifecycle as hybrid
 * Qwen3.5 for cancellation and reasoning compaction.
 */
bool isDeepSeekV4Architecture(std::string_view architecture);

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

/**
 * @brief Gets the appropriate chat template for a model
 *
 * Resolution order:
 *   1. A non-empty `manualOverride` always wins.
 *   2. Models whose GGUF `general.basename` is "MedPsy" return an empty
 *      string so callers fall through to the embedded chat template, even
 *      when the architecture is reported as qwen3.
 *   3. Qwen3 models return the fixed Qwen3 template.
 *   4. All other models return an empty string.
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
 * @brief Everything a chat-template render produces besides the prompt text.
 *
 * Filled in one place for every render path (Jinja success, tools-stripped
 * retry, legacy fallback) so a field cannot be exported on one path and
 * silently left default on another.
 */
struct PromptRenderResult {
  std::string prompt;

  // Reasoning-channel metadata.
  bool thinkingForcedOpen = false;
  std::string thinkingStartTag;
  /// First entry of `thinkingEndTags`, or empty. Used for forced-close text.
  std::string thinkingEndTag;
  std::vector<std::string> thinkingEndTags;
  /// Assistant generation prompt already appended to `prompt`.
  std::string generationPrompt;

  // Tool-calling sampler machinery computed by the template. `grammar` is
  // untyped here; `configureTemplateDerivedSampling` tags it TOOL_CALLS only
  // when `renderedByJinja` is true.
  std::string grammar;
  bool grammarLazy = false;
  std::vector<common_grammar_trigger> grammarTriggers;
  std::vector<std::string> preservedTokens;
  std::vector<std::string> additionalStops;

  /// False when the legacy (non-Jinja) renderer produced this result. The
  /// legacy renderer echoes the caller's own grammar into `grammar`, which
  /// must never be treated as a tool grammar.
  bool renderedByJinja = true;

  /// True when the template rejected the tool definitions and the prompt was
  /// rendered without them.
  bool toolDefinitionsDropped = false;
};

/**
 * @brief Applies chat templates to generate a prompt, with fallback handling
 * for models that don't support tools.
 *
 * On a tools-stripped retry `inputs.tools` is cleared so callers never see a
 * tool list the prompt does not carry.
 */
PromptRenderResult getPrompt(
    const struct common_chat_templates* tmpls,
    struct common_chat_templates_inputs& inputs);

/**
 * @brief Configures the common-sampling reasoning-budget fields from
 * template-derived thinking tags.
 *
 * Returns true when the sampling block changed and the caller should recreate
 * the common_sampler.
 */
bool configureReasoningBudgetSampling(
    common_params& params, ::llama_context* lctx,
    const std::string& thinkingStartTag,
    const std::vector<std::string>& thinkingEndTags,
    const std::string& generationPrompt);

/// Tokenizes one string the way the sampler expects (`common_tokenize(lctx,
/// text, false, true)`). Injected so the conversion below is testable
/// without a model.
using Tokenizer = std::function<std::vector<llama_token>(const std::string&)>;

/**
 * @brief Configures every template-derived sampling field in one pass: the
 * reasoning-budget fields and the tool-call grammar.
 *
 * Grammar precedence is decided from `params.sampling.grammar.type`:
 *   - TOOL_CALLS is owned by this function. It is always cleared first, so a
 *     grammar applied for a previous request never survives into one that
 *     carries no tools.
 *   - USER / OUTPUT_FORMAT belong to the caller (load-time config or
 *     per-request generationParams) and are left untouched; a rendered tool
 *     grammar is then suppressed and logged.
 *   - NONE: the rendered tool grammar is applied when `toolsRequested` and
 *     the render came from the Jinja engine.
 *
 * Returns true when `params.sampling` changed and the caller must rebuild
 * the common_sampler.
 */
bool configureTemplateDerivedSampling(
    common_params& params, const Tokenizer& tokenize,
    const PromptRenderResult& rendered, bool toolsRequested);

/**
 * @brief The template-side view of a request's `tool_choice`.
 *
 * llama.cpp knows only auto / none / required. A named function is realised
 * as "render only that tool and require a call", so `tools` is the list to
 * hand to the template, not necessarily the list the caller sent.
 */
struct ResolvedToolChoice {
  common_chat_tool_choice choice = COMMON_CHAT_TOOL_CHOICE_AUTO;
  std::vector<common_chat_tool> tools;
};

/**
 * @brief Resolves a raw `tool_choice` string against the declared tools.
 *
 * - unset / "auto" / "none" / "required": the matching enum, tools unchanged.
 *   "required" with no tools is an InvalidArgument.
 * - any other string: the name of one declared function; returns REQUIRED with
 *   `tools` narrowed to that function. An unknown name is an InvalidArgument.
 */
ResolvedToolChoice resolveToolChoice(
    const std::optional<std::string>& rawToolChoice,
    const std::vector<common_chat_tool>& tools);

/**
 * @brief Fails the request when an explicit tool choice cannot be honoured.
 *
 * `REQUIRED` (from `"required"` or a named function) is a demand, not a hint.
 * If the template dropped the tool definitions, or refused to produce a
 * grammar, the model would answer in prose instead — silently, since the only
 * other trace is a log line. Throws `InvalidArgument` in that case.
 *
 * @p toolGrammarApplied is the return of `configureTemplateDerivedSampling`'s
 *    tool-grammar step, i.e. whether a TOOL_CALLS grammar is actually live.
 */
void requireToolChoiceHonoured(
    common_chat_tool_choice choice, bool toolDefinitionsDropped,
    bool toolGrammarApplied, const char* logTag);

std::string getThinkingForcedOpenText(
    const std::string& generationPrompt, const std::string& thinkingStartTag);

} // namespace utils
} // namespace qvac_lib_inference_addon_llama
