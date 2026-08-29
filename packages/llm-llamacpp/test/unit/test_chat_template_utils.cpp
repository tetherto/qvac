#include <filesystem>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>
#include <llama.h>

#include "model-interface/LlamaModel.hpp"
#include "test_common.hpp"
#include "utils/ChatTemplateUtils.hpp"
#include "utils/QwenTemplate.hpp"

namespace fs = std::filesystem;
using namespace qvac_lib_inference_addon_llama::utils;

class ChatTemplateUtilsTest : public ::testing::Test {
protected:
  void SetUp() override {
    config_files["device"] = test_common::getTestDevice();
    config_files["ctx_size"] = "2048";
    config_files["gpu_layers"] = test_common::getTestGpuLayers();
    config_files["n_predict"] = "10";

    test_model_path = test_common::BaseTestModelPath::get();
    test_projection_path = "";

    config_files["backendsDir"] = test_common::getTestBackendsDir().string();
  }

  std::unordered_map<std::string, std::string> config_files;
  std::string test_model_path;
  std::string test_projection_path;

  bool hasValidModel() { return fs::exists(test_model_path); }
};

TEST_F(ChatTemplateUtilsTest, IsQwen3ModelWithNullptr) {
  EXPECT_FALSE(isQwen3Model(nullptr));
}

// `isQwen3Architecture` is the exact-match predicate that drives fixed Qwen3
// chat-template selection (via isQwen3Model -> getChatTemplateForModel). It
// must stay strictly `qwen3`: `qwen35` and other family members must NOT match
// (they are covered separately by isQwen3ReasoningFamilyArchitecture for
// reasoning-tag purposes only).
TEST_F(ChatTemplateUtilsTest, IsQwen3ArchitectureExactMatch) {
  EXPECT_TRUE(isQwen3Architecture("qwen3"));
  EXPECT_TRUE(isQwen3Architecture("Qwen3")); // case-insensitive (normalized)
  EXPECT_FALSE(isQwen3Architecture("qwen35"));
  EXPECT_FALSE(isQwen3Architecture("qwen3moe"));
  EXPECT_FALSE(isQwen3Architecture("llama"));
  EXPECT_FALSE(isQwen3Architecture(""));
}

TEST_F(ChatTemplateUtilsTest, IsMedPsyModelWithNullptr) {
  EXPECT_FALSE(isMedPsyModel(nullptr));
}

TEST_F(ChatTemplateUtilsTest, IsMedPsyBasenameEmpty) {
  EXPECT_FALSE(isMedPsyBasename(std::string_view{}));
  EXPECT_FALSE(isMedPsyBasename(""));
}

TEST_F(ChatTemplateUtilsTest, IsMedPsyBasenameExactMatch) {
  EXPECT_TRUE(isMedPsyBasename("MedPsy"));
}

TEST_F(ChatTemplateUtilsTest, IsMedPsyBasenameCaseInsensitive) {
  EXPECT_TRUE(isMedPsyBasename("medpsy"));
  EXPECT_TRUE(isMedPsyBasename("MEDPSY"));
  EXPECT_TRUE(isMedPsyBasename("MedPSY"));
}

TEST_F(ChatTemplateUtilsTest, IsMedPsyBasenameRejectsOtherNames) {
  EXPECT_FALSE(isMedPsyBasename("Qwen3"));
  EXPECT_FALSE(isMedPsyBasename("Llama-3.1"));
  EXPECT_FALSE(isMedPsyBasename("MedPsy-7B"));
  EXPECT_FALSE(isMedPsyBasename("NotMedPsy"));
}

TEST_F(ChatTemplateUtilsTest, IsGemma4ModelWithNullptr) {
  EXPECT_FALSE(isGemma4Model(nullptr));
}

TEST_F(ChatTemplateUtilsTest, IsGemma4BasenameEmpty) {
  EXPECT_FALSE(isGemma4Basename(std::string_view{}));
  EXPECT_FALSE(isGemma4Basename(""));
}

TEST_F(ChatTemplateUtilsTest, IsGemma4BasenameAcceptsKnownPatterns) {
  EXPECT_TRUE(isGemma4Basename("gemma-4"));
  EXPECT_TRUE(isGemma4Basename("Gemma 4"));
  EXPECT_TRUE(isGemma4Basename("Gemma 4 E2B it"));
  EXPECT_TRUE(isGemma4Basename("google_gemma-4-E2B-it"));
  EXPECT_TRUE(isGemma4Basename("GEMMA-4-E4B"));
  EXPECT_TRUE(isGemma4Basename("gemma4"));
}

TEST_F(ChatTemplateUtilsTest, IsGemma4BasenameRejectsOtherFamilies) {
  EXPECT_FALSE(isGemma4Basename("Gemma 2"));
  EXPECT_FALSE(isGemma4Basename("gemma-3"));
  EXPECT_FALSE(isGemma4Basename("Qwen3"));
  EXPECT_FALSE(isGemma4Basename("Llama-3.1"));
}

TEST_F(ChatTemplateUtilsTest, SelectReasoningTagsForNullModelReturnsNullopt) {
  EXPECT_FALSE(selectReasoningTagsForModel(nullptr).has_value());
}

TEST_F(ChatTemplateUtilsTest, SelectReasoningTagsForArchitectureQwen3Family) {
  for (std::string_view arch :
       {"qwen3", "qwen3moe", "qwen35", "qwen35moe", "qwen36", "qwen36moe"}) {
    const std::optional<ReasoningTags> tags =
        selectReasoningTagsForArchitecture(std::string(arch));
    ASSERT_TRUE(tags.has_value()) << "arch=" << arch;
    EXPECT_EQ(tags->open, "<think>") << "arch=" << arch;
    EXPECT_EQ(tags->close, "</think>") << "arch=" << arch;
  }
}

TEST_F(ChatTemplateUtilsTest, DefaultsThinkingCompactionToQwen3FamilyOnly) {
  for (std::string_view arch :
       {"qwen3", "qwen3moe", "qwen35", "qwen35moe", "qwen36", "qwen36moe"}) {
    EXPECT_TRUE(usesThinkingCompactionByDefault(arch)) << "arch=" << arch;
  }

  EXPECT_FALSE(usesThinkingCompactionByDefault("deepseek4"));
  EXPECT_FALSE(usesThinkingCompactionByDefault("gemma4"));
  EXPECT_FALSE(usesThinkingCompactionByDefault("llama"));
}

TEST_F(ChatTemplateUtilsTest, IdentifiesDeepSeekV4Architecture) {
  EXPECT_TRUE(isDeepSeekV4Architecture("deepseek4"));
  EXPECT_TRUE(isDeepSeekV4Architecture("DeepSeek4"));
  EXPECT_FALSE(isDeepSeekV4Architecture("deepseek3"));
  EXPECT_FALSE(isDeepSeekV4Architecture("qwen35"));
}

TEST_F(ChatTemplateUtilsTest, SelectReasoningTagsForArchitectureDeepSeekV4) {
  const std::optional<ReasoningTags> tags =
      selectReasoningTagsForArchitecture(std::string("deepseek4"));
  ASSERT_TRUE(tags.has_value());
  EXPECT_EQ(tags->open, "<think>");
  EXPECT_EQ(tags->close, "</think>");
  EXPECT_FALSE(isQwen3ReasoningFamilyArchitecture("deepseek4"));
}

TEST_F(ChatTemplateUtilsTest, SelectReasoningTagsForArchitectureRejectsOthers) {
  // Unrelated arches.
  EXPECT_FALSE(
      selectReasoningTagsForArchitecture(std::string("llama")).has_value());
  EXPECT_FALSE(
      selectReasoningTagsForArchitecture(std::string("gemma3")).has_value());
  EXPECT_FALSE(
      selectReasoningTagsForArchitecture(std::string("gpt-oss")).has_value());
  EXPECT_FALSE(selectReasoningTagsForArchitecture(std::nullopt).has_value());

  // qwen3*-prefixed but not in the allow-list — explicit list (vs prefix
  // match) ensures these don't silently inherit `<think>` reasoning.
  EXPECT_FALSE(
      selectReasoningTagsForArchitecture(std::string("qwen37")).has_value());
  EXPECT_FALSE(
      selectReasoningTagsForArchitecture(std::string("qwen3vl")).has_value());
  EXPECT_FALSE(
      selectReasoningTagsForArchitecture(std::string("qwen30")).has_value());
}

// `selectReasoningTagSource` is the single source of truth for the
// "template-first, family-fallback" policy used by
// `remove_thinking_from_context` detection. The tests below pin the
// preference order so future refactors cannot silently drift back to
// hardcoded family detection.
TEST_F(ChatTemplateUtilsTest, SelectReasoningTagSourcePrefersTemplate) {
  const ReasoningTags qwenFallback{.open = "<think>", .close = "</think>"};
  const std::optional<ReasoningTags> result = selectReasoningTagSource(
      "<custom_open>", "</custom_close>", qwenFallback);
  ASSERT_TRUE(result.has_value());
  EXPECT_EQ(result->open, "<custom_open>");
  EXPECT_EQ(result->close, "</custom_close>");
}

TEST_F(ChatTemplateUtilsTest, SelectReasoningTagSourceFallsBackOnEmptyStart) {
  const ReasoningTags fallback{.open = "<think>", .close = "</think>"};
  const std::optional<ReasoningTags> result =
      selectReasoningTagSource("", "</custom_close>", fallback);
  ASSERT_TRUE(result.has_value());
  EXPECT_EQ(result->open, "<think>");
  EXPECT_EQ(result->close, "</think>");
}

TEST_F(ChatTemplateUtilsTest, SelectReasoningTagSourceFallsBackOnEmptyEnd) {
  const ReasoningTags fallback{.open = "<think>", .close = "</think>"};
  const std::optional<ReasoningTags> result =
      selectReasoningTagSource("<custom_open>", "", fallback);
  ASSERT_TRUE(result.has_value());
  EXPECT_EQ(result->open, "<think>");
  EXPECT_EQ(result->close, "</think>");
}

TEST_F(ChatTemplateUtilsTest, SelectReasoningTagSourceTemplateWithoutFallback) {
  // Template-driven detection must work even when the model family has
  // no entry in the hardcoded table (i.e. an as-yet-unsupported family
  // whose chat template still exposes thinking tags).
  const std::optional<ReasoningTags> result = selectReasoningTagSource(
      "<custom_open>", "</custom_close>", std::nullopt);
  ASSERT_TRUE(result.has_value());
  EXPECT_EQ(result->open, "<custom_open>");
  EXPECT_EQ(result->close, "</custom_close>");
}

TEST_F(ChatTemplateUtilsTest, SelectReasoningTagSourceNoTemplateNoFallback) {
  EXPECT_FALSE(selectReasoningTagSource("", "", std::nullopt).has_value());
}

// Template tags that happen to match the family fallback exactly: the
// returned ReasoningTags should still come from the template branch
// (semantically: "the template wins"), not the fallback. This is a
// behavioural assertion only, since the values are identical here.
TEST_F(ChatTemplateUtilsTest, SelectReasoningTagSourceTemplateMatchesFallback) {
  const ReasoningTags fallback{.open = "<think>", .close = "</think>"};
  const std::optional<ReasoningTags> result =
      selectReasoningTagSource("<think>", "</think>", fallback);
  ASSERT_TRUE(result.has_value());
  EXPECT_EQ(result->open, "<think>");
  EXPECT_EQ(result->close, "</think>");
}

TEST_F(ChatTemplateUtilsTest, GetChatTemplateForModelWithManualOverride) {
  std::string manual_override = "custom template";
  std::string result = getChatTemplateForModel(nullptr, manual_override);
  EXPECT_EQ(result, manual_override);
}

TEST_F(ChatTemplateUtilsTest, GetChatTemplateForModelEmptyOverrideNullptr) {
  std::string result = getChatTemplateForModel(nullptr, "");
  EXPECT_EQ(result, "");
}

TEST_F(ChatTemplateUtilsTest, GetChatTemplateWithNullptrModel) {
  common_params params;
  params.chat_template = "test template";
  params.use_jinja = false;

  std::string result = getChatTemplate(nullptr, params);
  EXPECT_EQ(result, params.chat_template);
}

TEST_F(ChatTemplateUtilsTest, GetChatTemplateJinjaDisabled) {
  common_params params;
  params.chat_template = "test template";
  params.use_jinja = false;

  std::string result = getChatTemplate(nullptr, params);
  EXPECT_EQ(result, "test template");
}

TEST_F(ChatTemplateUtilsTest, GetChatTemplateJinjaEnabledWithOverride) {
  common_params params;
  params.chat_template = "custom template";
  params.use_jinja = true;

  std::string result = getChatTemplate(nullptr, params);
  EXPECT_EQ(result, "custom template");
}

TEST_F(ChatTemplateUtilsTest, GetChatTemplateJinjaEnabledWithoutOverride) {
  common_params params;
  params.chat_template = "";
  params.use_jinja = true;

  std::string result = getChatTemplate(nullptr, params);
  EXPECT_EQ(result, "");
}

TEST_F(ChatTemplateUtilsTest, GetChatTemplateParamsNotModified) {
  common_params params;
  params.chat_template = "original template";
  params.use_jinja = false;

  std::string result = getChatTemplate(nullptr, params);

  EXPECT_EQ(params.chat_template, "original template");
  EXPECT_FALSE(params.use_jinja);
  EXPECT_EQ(result, "original template");
}

TEST_F(ChatTemplateUtilsTest, GetChatTemplateForModelPreservesWhitespace) {
  std::string overrideWithSpaces = "  template with spaces  ";
  std::string result = getChatTemplateForModel(nullptr, overrideWithSpaces);
  EXPECT_EQ(result, overrideWithSpaces);
}

TEST_F(
    ChatTemplateUtilsTest, GetChatTemplateForModelPreservesSpecialCharacters) {
  std::string overrideSpecial = "template\nwith\tspecial\rchars";
  std::string result = getChatTemplateForModel(nullptr, overrideSpecial);
  EXPECT_EQ(result, overrideSpecial);
}

TEST_F(ChatTemplateUtilsTest, GetFixedQwen3TemplateNotNull) {
  const char* expectedTemplate = getFixedQwen3Template();
  ASSERT_NE(expectedTemplate, nullptr);
  EXPECT_GT(strlen(expectedTemplate), 0u);
}

namespace {

common_chat_templates_inputs makeQwenInputs() {
  common_chat_templates_inputs inputs;
  inputs.use_jinja = true;
  inputs.enable_thinking = true;
  inputs.add_generation_prompt = true;
  inputs.messages = {common_chat_msg{
      /* role = */ "user",
      /* content = */ "What is the capital of France?",
  }};
  return inputs;
}

common_chat_tool makeWeatherTool() {
  common_chat_tool tool;
  tool.name = "get_weather";
  tool.description = "Get the weather for a city";
  tool.parameters =
      R"({"type":"object","properties":{"city":{"type":"string"},)"
      R"("days":{"type":"integer"}},"required":["city"]})";
  return tool;
}

// Renders any conversation but raises as soon as tools are present, so
// getPrompt() must take its tools-stripped retry path.
constexpr const char* TOOL_REJECTING_TEMPLATE =
    "{%- if tools %}{{ raise_exception('no tools here') }}{%- endif %}"
    "{%- for m in messages %}<{{ m.role }}>{{ m.content }}{%- endfor %}"
    "{%- if add_generation_prompt %}<assistant>{%- endif %}";

// Raises unconditionally under Jinja. The `<|im_start|>` marker inside the
// message makes llama.cpp's legacy renderer recognise it as ChatML, so the
// legacy fallback succeeds instead of throwing.
constexpr const char* ALWAYS_RAISING_TEMPLATE =
    "{{ raise_exception('<|im_start|> always fails') }}";

} // namespace

TEST_F(ChatTemplateUtilsTest, GetPromptExportsQwenThinkingMetadata) {
  common_chat_templates_ptr tmpls =
      common_chat_templates_init(nullptr, getFixedQwen3Template());
  ASSERT_NE(tmpls, nullptr);

  common_chat_templates_inputs inputs = makeQwenInputs();
  const PromptRenderResult rendered = getPrompt(tmpls.get(), inputs);

  EXPECT_NE(rendered.prompt.find("<|im_start|>assistant"), std::string::npos);
  EXPECT_EQ(rendered.thinkingStartTag, "<think>");
  EXPECT_EQ(rendered.thinkingEndTag, "</think>");
  EXPECT_EQ(rendered.thinkingEndTags, std::vector<std::string>{"</think>"});
  EXPECT_NE(
      rendered.generationPrompt.find("<|im_start|>assistant"),
      std::string::npos);
  EXPECT_FALSE(rendered.thinkingForcedOpen);
  EXPECT_TRUE(rendered.renderedByJinja);
  EXPECT_FALSE(rendered.toolDefinitionsDropped);
}

TEST_F(ChatTemplateUtilsTest, GetPromptExportsToolGrammarWhenToolsPresent) {
  common_chat_templates_ptr tmpls =
      common_chat_templates_init(nullptr, getFixedQwen3Template());
  ASSERT_NE(tmpls, nullptr);

  common_chat_templates_inputs inputs = makeQwenInputs();
  inputs.tools = {makeWeatherTool()};
  const PromptRenderResult rendered = getPrompt(tmpls.get(), inputs);

  EXPECT_NE(rendered.prompt.find("get_weather"), std::string::npos);
  EXPECT_FALSE(rendered.grammar.empty());
  EXPECT_FALSE(rendered.preservedTokens.empty());
  // A lazy grammar without triggers can never activate; the template must
  // supply them whenever it asks for laziness.
  if (rendered.grammarLazy) {
    EXPECT_FALSE(rendered.grammarTriggers.empty());
  }
  EXPECT_TRUE(rendered.renderedByJinja);
  EXPECT_FALSE(rendered.toolDefinitionsDropped);
  EXPECT_EQ(inputs.tools.size(), 1u) << "tools must not be stripped on success";
}

TEST_F(ChatTemplateUtilsTest, ResolveToolChoicePassesThroughAutoNoneRequired) {
  const std::vector<common_chat_tool> tools{makeWeatherTool()};
  EXPECT_EQ(
      resolveToolChoice(std::nullopt, tools).choice,
      COMMON_CHAT_TOOL_CHOICE_AUTO);
  EXPECT_EQ(
      resolveToolChoice(std::string("auto"), tools).choice,
      COMMON_CHAT_TOOL_CHOICE_AUTO);
  EXPECT_EQ(
      resolveToolChoice(std::string("none"), tools).choice,
      COMMON_CHAT_TOOL_CHOICE_NONE);
  const ResolvedToolChoice required =
      resolveToolChoice(std::string("required"), tools);
  EXPECT_EQ(required.choice, COMMON_CHAT_TOOL_CHOICE_REQUIRED);
  EXPECT_EQ(required.tools.size(), 1u) << "tools list is not narrowed";
}

TEST_F(
    ChatTemplateUtilsTest, ResolveToolChoiceNamedFunctionNarrowsAndRequires) {
  common_chat_tool other = makeWeatherTool();
  other.name = "get_time";
  const std::vector<common_chat_tool> tools{makeWeatherTool(), other};
  const ResolvedToolChoice named =
      resolveToolChoice(std::string("get_time"), tools);
  EXPECT_EQ(named.choice, COMMON_CHAT_TOOL_CHOICE_REQUIRED);
  ASSERT_EQ(named.tools.size(), 1u);
  EXPECT_EQ(named.tools[0].name, "get_time");
}

TEST_F(ChatTemplateUtilsTest, ResolveToolChoiceRejectsDuplicateToolNames) {
  common_chat_tool duplicate = makeWeatherTool();
  duplicate.description = "a second, different weather tool";
  const std::vector<common_chat_tool> tools{makeWeatherTool(), duplicate};
  // Rejected even for "auto", where no name is being looked up: the duplicate
  // would still reach the template as two indistinguishable blocks.
  EXPECT_THROW(resolveToolChoice(std::nullopt, tools), qvac_errors::StatusError);
  EXPECT_THROW(
      resolveToolChoice(std::string("get_weather"), tools),
      qvac_errors::StatusError);
}

// An exotic name is a warning, not an error — the grammar rule it maps to is
// an internal detail of the vendored converter.
TEST_F(ChatTemplateUtilsTest, ResolveToolChoiceAllowsUnusualToolNames) {
  common_chat_tool odd = makeWeatherTool();
  odd.name = "get weather/now";
  const std::vector<common_chat_tool> tools{odd};
  EXPECT_NO_THROW(resolveToolChoice(std::nullopt, tools));
  EXPECT_EQ(
      resolveToolChoice(std::string("get weather/now"), tools).choice,
      COMMON_CHAT_TOOL_CHOICE_REQUIRED);
}

TEST_F(ChatTemplateUtilsTest, ResolveToolChoiceRejectsUnknownOrToolless) {
  const std::vector<common_chat_tool> tools{makeWeatherTool()};
  EXPECT_THROW(
      resolveToolChoice(std::string("GET_WEATHER"), tools),
      qvac_errors::StatusError)
      << "function names are case-sensitive";
  EXPECT_THROW(
      resolveToolChoice(std::string("required"), {}), qvac_errors::StatusError);
  EXPECT_NO_THROW(resolveToolChoice(std::string("none"), {}));
}

TEST_F(ChatTemplateUtilsTest, GetPromptRequiredToolChoiceMakesGrammarEager) {
  common_chat_templates_ptr tmpls =
      common_chat_templates_init(nullptr, getFixedQwen3Template());
  ASSERT_NE(tmpls, nullptr);

  common_chat_templates_inputs inputs = makeQwenInputs();
  inputs.tools = {makeWeatherTool()};
  inputs.tool_choice = COMMON_CHAT_TOOL_CHOICE_REQUIRED;
  const PromptRenderResult rendered = getPrompt(tmpls.get(), inputs);

  EXPECT_FALSE(rendered.grammar.empty());
  EXPECT_FALSE(rendered.grammarLazy) << "required must not wait for a trigger";
}

TEST_F(ChatTemplateUtilsTest, GetPromptNoneToolChoiceKeepsToolsDropsGrammar) {
  common_chat_templates_ptr tmpls =
      common_chat_templates_init(nullptr, getFixedQwen3Template());
  ASSERT_NE(tmpls, nullptr);

  common_chat_templates_inputs inputs = makeQwenInputs();
  inputs.tools = {makeWeatherTool()};
  inputs.tool_choice = COMMON_CHAT_TOOL_CHOICE_NONE;
  const PromptRenderResult rendered = getPrompt(tmpls.get(), inputs);

  EXPECT_NE(rendered.prompt.find("get_weather"), std::string::npos)
      << "none keeps the tool definitions in the prompt";
  EXPECT_TRUE(rendered.grammar.empty());
}

// Pins why the addon never hands a per-request json_schema to the template:
// fabric short-circuits on `has_response_format` and returns a
// response-format-only parser, so the rendered grammar excludes tool calls
// rather than composing with them.
TEST_F(ChatTemplateUtilsTest, TemplateResponseFormatExcludesToolCalls) {
  common_chat_templates_ptr tmpls =
      common_chat_templates_init(nullptr, getFixedQwen3Template());
  ASSERT_NE(tmpls, nullptr);

  common_chat_templates_inputs plain = makeQwenInputs();
  plain.tools = {makeWeatherTool()};
  const PromptRenderResult toolsOnly = getPrompt(tmpls.get(), plain);
  ASSERT_FALSE(toolsOnly.grammar.empty());

  common_chat_templates_inputs withSchema = makeQwenInputs();
  withSchema.tools = {makeWeatherTool()};
  withSchema.json_schema =
      R"({"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]})";
  const PromptRenderResult withResponseFormat = getPrompt(tmpls.get(), withSchema);

  EXPECT_NE(withResponseFormat.grammar, toolsOnly.grammar)
      << "a response format must replace the tool-call grammar, not extend it";
}

TEST_F(ChatTemplateUtilsTest, GetPromptWithoutToolsExportsNoGrammar) {
  common_chat_templates_ptr tmpls =
      common_chat_templates_init(nullptr, getFixedQwen3Template());
  ASSERT_NE(tmpls, nullptr);

  common_chat_templates_inputs inputs = makeQwenInputs();
  const PromptRenderResult rendered = getPrompt(tmpls.get(), inputs);

  EXPECT_TRUE(rendered.grammar.empty());
  EXPECT_FALSE(rendered.grammarLazy);
  EXPECT_TRUE(rendered.grammarTriggers.empty());
  // preservedTokens is deliberately not asserted empty: the template also
  // preserves its reasoning tags (<think>, </think>) with no tools present.
}

TEST_F(ChatTemplateUtilsTest, GetPromptFlagsToolDefinitionsDropped) {
  common_chat_templates_ptr tmpls =
      common_chat_templates_init(nullptr, TOOL_REJECTING_TEMPLATE);
  ASSERT_NE(tmpls, nullptr);

  common_chat_templates_inputs inputs = makeQwenInputs();
  inputs.tools = {makeWeatherTool()};
  const PromptRenderResult rendered = getPrompt(tmpls.get(), inputs);

  EXPECT_TRUE(rendered.toolDefinitionsDropped);
  EXPECT_TRUE(rendered.renderedByJinja);
  EXPECT_TRUE(inputs.tools.empty())
      << "stripped tools must not leak to callers";
  EXPECT_NE(rendered.prompt.find("<user>"), std::string::npos);
  EXPECT_TRUE(rendered.grammar.empty());
}

TEST_F(ChatTemplateUtilsTest, GetPromptLegacyFallbackMarksProvenance) {
  common_chat_templates_ptr tmpls =
      common_chat_templates_init(nullptr, ALWAYS_RAISING_TEMPLATE);
  ASSERT_NE(tmpls, nullptr);

  common_chat_templates_inputs inputs = makeQwenInputs();
  // The legacy renderer echoes the caller's grammar back untouched; it must
  // arrive tagged as non-Jinja so it is never mistaken for a tool grammar.
  inputs.grammar = "root ::= \"x\"";
  const PromptRenderResult rendered = getPrompt(tmpls.get(), inputs);

  EXPECT_FALSE(rendered.renderedByJinja);
  EXPECT_FALSE(inputs.use_jinja);
  EXPECT_EQ(rendered.grammar, "root ::= \"x\"");
  EXPECT_FALSE(rendered.prompt.empty());
}

TEST_F(ChatTemplateUtilsTest, ThinkingForcedOpenTextUsesTemplateSuffix) {
  EXPECT_EQ(
      getThinkingForcedOpenText("<|assistant|>\n<reason>\n", "<reason>"),
      "<reason>\n");
}

TEST_F(ChatTemplateUtilsTest, ThinkingForcedOpenTextFallsBackToStartTag) {
  EXPECT_EQ(
      getThinkingForcedOpenText("<|assistant|>\n", "<reason>"), "<reason>");
}

TEST_F(ChatTemplateUtilsTest, ThinkingForcedOpenTextEmptyWithoutStartTag) {
  EXPECT_EQ(getThinkingForcedOpenText("<|assistant|>\n", ""), "");
}
