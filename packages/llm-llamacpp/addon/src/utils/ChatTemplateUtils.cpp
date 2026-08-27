#include "ChatTemplateUtils.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <ranges>
#include <set>
#include <string_view>
#include <utility>
#include <vector>

#include <llama.h>

#include "QwenTemplate.hpp"
#include "utils/LoggingMacros.hpp"

using namespace qvac_lib_inference_addon_cpp::logger;

namespace qvac_lib_inference_addon_llama {
namespace utils {

namespace {

// Lowercased literal used for case-insensitive equality against
// `general.basename` GGUF metadata to identify MedPsy models.
inline constexpr std::string_view MEDPSY_BASENAME_LOWER{"medpsy"};

// Basename substrings used to identify Gemma 4 GGUFs by `general.basename`.
inline constexpr std::array<std::string_view, 3> GEMMA4_BASENAME_MARKERS{
    "gemma-4", "gemma 4", "gemma4"};

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

bool isHarmonyArchitecture(std::string_view architecture) {
  return normalizeArchitecture(architecture) == "gpt-oss";
}

bool isGemma4Architecture(std::string_view architecture) {
  return normalizeArchitecture(architecture) == "gemma4";
}

// Architectures in the Qwen3 family that emit `<think>`/`</think>`.
// Broader than `isQwen3Architecture` (which is exact-match "qwen3")
// but deliberately narrower than the full
// `qwen3*` HuggingFace lineage — explicit list keeps unrelated
// `qwen3*`-named archs from silently inheriting the wrong tags.
inline constexpr std::array<std::string_view, 6> QWEN3_REASONING_FAMILY_ARCHES{
    "qwen3", "qwen3moe", "qwen35", "qwen35moe", "qwen36", "qwen36moe"};

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

  // Check architecture metadata first; this drives family-specific template
  // selection.
  char arch[64] = {0};
  int32_t len = llama_model_meta_val_str(
      model, "general.architecture", arch, sizeof(arch));
  if (len > 0 && static_cast<size_t>(len) < sizeof(arch)) {
    arch[len] = '\0';
    return normalizeArchitecture(arch);
  }
  return std::nullopt;
}

bool isQwen3Architecture(std::string_view architecture) {
  return normalizeArchitecture(architecture) == "qwen3";
}

bool isQwen3Model(const ::llama_model* model) {
  if (model == nullptr) {
    return false;
  }

  const std::optional<std::string> arch = getModelArchitecture(model);
  return arch.has_value() && isQwen3Architecture(arch.value());
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

bool isGemma4Basename(std::string_view basename) {
  if (basename.empty()) {
    return false;
  }
  const std::string lowered = toLower(basename);
  for (std::string_view marker : GEMMA4_BASENAME_MARKERS) {
    if (lowered.find(marker) != std::string::npos) {
      return true;
    }
  }
  return false;
}

bool isHarmonyModel(const ::llama_model* model) {
  if (model == nullptr) {
    return false;
  }
  std::optional<std::string> arch = getModelArchitecture(model);
  return arch.has_value() && isHarmonyArchitecture(arch.value());
}

bool isGemma4Model(const ::llama_model* model) {
  if (model == nullptr) {
    return false;
  }
  const std::optional<std::string> arch = getModelArchitecture(model);
  if (arch.has_value() && isGemma4Architecture(arch.value())) {
    return true;
  }
  return isGemma4Basename(getModelBasename(model).value_or(""));
}

llama_token getHarmonyCallToken(::llama_context* lctx) {
  std::vector<llama_token> tokens =
      common_tokenize(lctx, "<|call|>", false, true);
  if (tokens.size() == 1) {
    return tokens[0];
  }
  return LLAMA_TOKEN_NULL;
}

bool isQwen3ReasoningFamilyArchitecture(std::string_view architecture) {
  const std::string normalised = normalizeArchitecture(architecture);
  return std::ranges::find(QWEN3_REASONING_FAMILY_ARCHES, normalised) !=
         QWEN3_REASONING_FAMILY_ARCHES.end();
}

bool usesThinkingCompactionByDefault(std::string_view architecture) {
  return isQwen3ReasoningFamilyArchitecture(architecture);
}

bool isDeepSeekV4Architecture(std::string_view architecture) {
  return normalizeArchitecture(architecture) == "deepseek4";
}

std::optional<ReasoningTags> selectReasoningTagsForArchitecture(
    const std::optional<std::string>& architecture) {
  if (architecture.has_value() &&
      (isQwen3ReasoningFamilyArchitecture(architecture.value()) ||
       isDeepSeekV4Architecture(architecture.value()))) {
    return ReasoningTags{.open = "<think>", .close = "</think>"};
  }
  return std::nullopt;
}

std::optional<ReasoningTags> selectReasoningTagSource(
    const std::string& templateThinkingStartTag,
    const std::string& templateThinkingEndTag,
    const std::optional<ReasoningTags>& fallbackTags) {
  // Both template tags must be present to take effect; one without the
  // other is ambiguous (we cannot detect a channel with only an open
  // or only a close marker) and falls back to the model-family table.
  if (!templateThinkingStartTag.empty() && !templateThinkingEndTag.empty()) {
    return ReasoningTags{
        .open = templateThinkingStartTag, .close = templateThinkingEndTag};
  }
  return fallbackTags;
}

std::optional<ReasoningTags>
selectReasoningTagsForModel(const ::llama_model* model) {
  if (model == nullptr) {
    return std::nullopt;
  }
  const std::optional<ReasoningTags> archTags =
      selectReasoningTagsForArchitecture(getModelArchitecture(model));
  if (archTags.has_value()) {
    return archTags;
  }
  if (isGemma4Model(model)) {
    return ReasoningTags{.open = "<|channel>thought", .close = "<channel|>"};
  }
  return std::nullopt;
}

std::string getChatTemplateForModel(
    const ::llama_model* model, const std::string& manualOverride) {
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
    return getFixedQwen3Template();
  }

  return "";
}

std::string
getChatTemplate(const ::llama_model* model, const common_params& params) {
  std::string chatTemplate = params.chat_template;
  if (params.use_jinja) {
    chatTemplate = getChatTemplateForModel(model, params.chat_template);
    if (!chatTemplate.empty() && chatTemplate != params.chat_template) {
      QLOG_IF(
          Priority::INFO, "[ChatTemplateUtils] Using fixed Qwen3 template\n");
    }
  }
  return chatTemplate;
}

PromptRenderResult getPrompt(
    const struct common_chat_templates* tmpls,
    struct common_chat_templates_inputs& inputs) {
  // Single export point for all three render paths below.
  auto exportParams = [](const common_chat_params& params,
                         bool renderedByJinja,
                         bool toolDefinitionsDropped) {
    PromptRenderResult out;
    out.prompt = params.prompt;
    out.thinkingForcedOpen = params.thinking_forced_open;
    out.thinkingStartTag = params.thinking_start_tag;
    out.thinkingEndTag = params.thinking_end_tags.empty()
                             ? std::string()
                             : params.thinking_end_tags.front();
    out.thinkingEndTags = params.thinking_end_tags;
    out.generationPrompt = params.generation_prompt;
    out.grammar = params.grammar;
    out.grammarLazy = params.grammar_lazy;
    out.grammarTriggers = params.grammar_triggers;
    out.preservedTokens = params.preserved_tokens;
    out.additionalStops = params.additional_stops;
    out.renderedByJinja = renderedByJinja;
    out.toolDefinitionsDropped = toolDefinitionsDropped;
    return out;
  };
  // A template can fail either because it rejects the tool definitions or
  // because it rejects the shape of the message list (e.g. Qwen3.5 raises
  // when there is no user turn to anchor its tool block on). Retry without
  // tools to tell the two apart, and only drop to the legacy renderer —
  // which ignores tools and can disagree with the Jinja template — when the
  // template cannot render the conversation at all.
  std::string firstError;
  try {
    auto params = common_chat_templates_apply(tmpls, inputs);
    return exportParams(
        params,
        /* renderedByJinja = */ inputs.use_jinja,
        /* toolDefinitionsDropped = */ false);
  } catch (const std::exception& e) {
    firstError = e.what();
  } catch (...) {
    firstError = "unknown exception";
  }

  if (!inputs.tools.empty()) {
    common_chat_templates_inputs withoutTools = inputs;
    withoutTools.tools.clear();
    try {
      auto params = common_chat_templates_apply(tmpls, withoutTools);
      QLOG_IF(
          Priority::ERROR,
          string_format(
              "[ChatTemplateUtils] chat template rejected the tool "
              "definitions; rendering without tools. Error: %s\n",
              firstError.c_str()));
      inputs.tools.clear();
      return exportParams(
          params,
          /* renderedByJinja = */ inputs.use_jinja,
          /* toolDefinitionsDropped = */ true);
    } catch (...) {
      // Falls through: the template rejects this conversation with or
      // without tools, so tools were not the cause.
    }
  }

  QLOG_IF(
      Priority::ERROR,
      string_format(
          "[ChatTemplateUtils] chat template could not render this "
          "conversation; falling back to the legacy renderer, which ignores "
          "tools. Error: %s\n",
          firstError.c_str()));
  inputs.use_jinja = false;
  auto params = common_chat_templates_apply(tmpls, inputs);
  return exportParams(
      params,
      /* renderedByJinja = */ false,
      /* toolDefinitionsDropped = */ !inputs.tools.empty());
}

namespace {

Tokenizer tokenizerFor(::llama_context* lctx) {
  if (lctx == nullptr) {
    return {};
  }
  return [lctx](const std::string& text) {
    return common_tokenize(lctx, text, false, true);
  };
}

void applyReasoningBudget(
    common_params_sampling& next, const common_params& params,
    const Tokenizer& tokenize, const std::string& thinkingStartTag,
    const std::vector<std::string>& thinkingEndTags,
    const std::string& generationPrompt) {
  next.reasoning_budget_tokens =
      params.reasoning_budget > 0 ? params.reasoning_budget : -1;
  next.reasoning_budget_start.clear();
  next.reasoning_budget_end.clear();
  next.reasoning_budget_forced.clear();
  next.generation_prompt.clear();

  if (params.reasoning_budget > 0 && tokenize && !thinkingEndTags.empty() &&
      !thinkingEndTags.front().empty()) {
    next.generation_prompt = generationPrompt;
    if (!thinkingStartTag.empty()) {
      next.reasoning_budget_start = tokenize(thinkingStartTag);
    }

    next.reasoning_budget_end.reserve(thinkingEndTags.size());
    for (const std::string& thinkingEndTag : thinkingEndTags) {
      if (!thinkingEndTag.empty()) {
        next.reasoning_budget_end.emplace_back(tokenize(thinkingEndTag));
      }
    }
    next.reasoning_budget_forced = tokenize(
        params.sampling.reasoning_budget_message + thinkingEndTags.front());
  }
}

bool sameTriggers(
    const std::vector<common_grammar_trigger>& a,
    const std::vector<common_grammar_trigger>& b) {
  return std::ranges::equal(
      a, b, [](const common_grammar_trigger& x, const common_grammar_trigger& y) {
        return x.type == y.type && x.value == y.value && x.token == y.token;
      });
}

bool samplingChanged(
    const common_params_sampling& before, const common_params_sampling& next) {
  return before.reasoning_budget_tokens != next.reasoning_budget_tokens ||
         before.reasoning_budget_start != next.reasoning_budget_start ||
         before.reasoning_budget_end != next.reasoning_budget_end ||
         before.reasoning_budget_forced != next.reasoning_budget_forced ||
         before.generation_prompt != next.generation_prompt ||
         before.grammar.type != next.grammar.type ||
         before.grammar.grammar != next.grammar.grammar ||
         before.grammar_lazy != next.grammar_lazy ||
         !sameTriggers(before.grammar_triggers, next.grammar_triggers) ||
         before.preserved_tokens != next.preserved_tokens;
}

// Mirrors tools/server/server-schema.cpp: preserved tokens keep only strings
// that tokenize to a single id; a WORD trigger that tokenizes to a single id
// is promoted to a TOKEN trigger. Returns false when the resulting grammar
// would be rejected by common_sampler_init (lazy with no triggers).
bool applyToolGrammar(
    common_params_sampling& next, const Tokenizer& tokenize,
    const PromptRenderResult& rendered) {
  std::set<llama_token> preserved;
  for (const std::string& text : rendered.preservedTokens) {
    const auto ids = tokenize(text);
    if (ids.size() == 1) {
      preserved.insert(ids[0]);
    }
  }

  std::vector<common_grammar_trigger> triggers;
  triggers.reserve(rendered.grammarTriggers.size());
  for (const common_grammar_trigger& trigger : rendered.grammarTriggers) {
    if (trigger.type != COMMON_GRAMMAR_TRIGGER_TYPE_WORD) {
      triggers.push_back(trigger);
      continue;
    }
    const auto ids = tokenize(trigger.value);
    if (ids.size() == 1) {
      if (!preserved.contains(ids[0])) {
        QLOG_IF(
            Priority::ERROR,
            string_format(
                "[ChatTemplateUtils] tool grammar trigger word is not a "
                "preserved token; not applying the tool grammar: %s\n",
                trigger.value.c_str()));
        return false;
      }
      common_grammar_trigger promoted;
      promoted.type = COMMON_GRAMMAR_TRIGGER_TYPE_TOKEN;
      promoted.value = trigger.value;
      promoted.token = ids[0];
      triggers.push_back(std::move(promoted));
    } else {
      triggers.push_back(trigger);
    }
  }

  if (rendered.grammarLazy && triggers.empty()) {
    QLOG_IF(
        Priority::ERROR,
        "[ChatTemplateUtils] template produced a lazy tool grammar with no "
        "triggers; not applying the tool grammar\n");
    return false;
  }

  next.grammar =
      common_grammar(COMMON_GRAMMAR_TYPE_TOOL_CALLS, rendered.grammar);
  next.grammar_lazy = rendered.grammarLazy;
  next.grammar_triggers = std::move(triggers);
  next.preserved_tokens = std::move(preserved);
  // The grammar sampler must skip the assistant prefix already in the prompt.
  next.generation_prompt = rendered.generationPrompt;
  return true;
}

} // namespace

bool configureReasoningBudgetSampling(
    common_params& params, ::llama_context* lctx,
    const std::string& thinkingStartTag,
    const std::vector<std::string>& thinkingEndTags,
    const std::string& generationPrompt) {
  common_params_sampling next = params.sampling;
  applyReasoningBudget(
      next,
      params,
      tokenizerFor(lctx),
      thinkingStartTag,
      thinkingEndTags,
      generationPrompt);
  const bool changed = samplingChanged(params.sampling, next);
  if (changed) {
    params.sampling = std::move(next);
  }
  return changed;
}

bool configureTemplateDerivedSampling(
    common_params& params, const Tokenizer& tokenize,
    const PromptRenderResult& rendered, bool toolsRequested) {
  common_params_sampling next = params.sampling;
  applyReasoningBudget(
      next,
      params,
      tokenize,
      rendered.thinkingStartTag,
      rendered.thinkingEndTags,
      rendered.generationPrompt);

  // Only a TOOL_CALLS grammar is ours to clear. A USER or OUTPUT_FORMAT
  // grammar was set by load-time config or per-request generationParams and
  // must survive a tools-free request untouched.
  if (next.grammar.type == COMMON_GRAMMAR_TYPE_TOOL_CALLS) {
    next.grammar = {};
    next.grammar_lazy = false;
    next.grammar_triggers.clear();
    next.preserved_tokens.clear();
  }

  bool toolGrammarApplied = false;
  if (toolsRequested && rendered.renderedByJinja && !rendered.grammar.empty() &&
      tokenize) {
    if (next.grammar.type == COMMON_GRAMMAR_TYPE_USER ||
        next.grammar.type == COMMON_GRAMMAR_TYPE_OUTPUT_FORMAT) {
      QLOG_IF(
          Priority::WARNING,
          "[ChatTemplateUtils] a user grammar or json_schema is active; the "
          "template's tool-call grammar is not applied\n");
    } else {
      toolGrammarApplied = applyToolGrammar(next, tokenize, rendered);
    }
  }

  // A tool grammar is stateful: the previous request may have driven it to
  // its terminal state, and common_sampler_reset() rewinds only the sampler
  // chain, never the grammar. So an applied tool grammar always needs a fresh
  // sampler, even when the grammar text is identical to the last request's.
  const bool changed =
      toolGrammarApplied || samplingChanged(params.sampling, next);
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
