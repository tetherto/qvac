#include <filesystem>
#include <optional>
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
#include "utils/LogSafeString.hpp"
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

// `selectReasoningBudgetTags` decides which markers the reasoning-budget
// sampler is built from, and has to agree with `selectReasoningTagSource`
// above on every input — a disagreement means the reasoning detector arms
// while fabric builds no budget sampler.
TEST_F(ChatTemplateUtilsTest, SelectReasoningBudgetTagsPrefersTemplate) {
  const ReasoningTags fallback{.open = "<other>", .close = "</other>"};
  const ReasoningBudgetTags result = selectReasoningBudgetTags(
      "<think>", "</think>", {"</think>", "<tool_call>"}, fallback);
  EXPECT_EQ(result.startTag, "<think>");
  ASSERT_EQ(result.endTags.size(), 2u)
      << "the template's extra end markers must survive";
  EXPECT_EQ(result.endTags.front(), "</think>");
  EXPECT_EQ(result.endTags.back(), "<tool_call>");
}

TEST_F(ChatTemplateUtilsTest, SelectReasoningBudgetTagsFallsBackOnEmptyStart) {
  const ReasoningTags fallback{.open = "<think>", .close = "</think>"};
  const ReasoningBudgetTags result =
      selectReasoningBudgetTags("", "</think>", {"</think>"}, fallback);
  EXPECT_EQ(result.startTag, "<think>");
  ASSERT_EQ(result.endTags.size(), 1u);
  EXPECT_EQ(result.endTags.front(), "</think>");
}

TEST_F(ChatTemplateUtilsTest, SelectReasoningBudgetTagsFallsBackOnEmptyEnd) {
  const ReasoningTags fallback{.open = "<think>", .close = "</think>"};
  const ReasoningBudgetTags result =
      selectReasoningBudgetTags("<start>", "", {}, fallback);
  EXPECT_EQ(result.startTag, "<think>");
  ASSERT_EQ(result.endTags.size(), 1u);
  EXPECT_EQ(result.endTags.front(), "</think>");
}

TEST_F(ChatTemplateUtilsTest, SelectReasoningBudgetTagsEmptyWithoutAnySource) {
  const ReasoningBudgetTags result =
      selectReasoningBudgetTags("", "", {}, std::nullopt);
  EXPECT_TRUE(result.startTag.empty());
  EXPECT_TRUE(result.endTags.empty());
}

// The two selectors must never disagree about which source is in play: the
// budget having markers while the detector has none, or the reverse, is the
// state that silently disarms the tool grammar's reasoning-block guard.
TEST_F(ChatTemplateUtilsTest, ReasoningBudgetAndDetectorAgreeOnSource) {
  const ReasoningTags fallback{.open = "<think>", .close = "</think>"};
  struct Case {
    std::string startTag;
    std::string endTag;
    std::optional<ReasoningTags> fallback;
  };
  const std::vector<Case> cases{
      {"<t>", "</t>", fallback},
      {"<t>", "</t>", std::nullopt},
      {"", "</t>", fallback},
      {"<t>", "", fallback},
      {"", "", fallback},
      {"", "", std::nullopt},
      {"", "</t>", std::nullopt},
  };
  for (const Case& c : cases) {
    const std::optional<ReasoningTags> detector =
        selectReasoningTagSource(c.startTag, c.endTag, c.fallback);
    const ReasoningBudgetTags budget =
        selectReasoningBudgetTags(c.startTag, c.endTag, {c.endTag}, c.fallback);
    EXPECT_EQ(detector.has_value(), !budget.startTag.empty())
        << "start='" << c.startTag << "' end='" << c.endTag << "'";
    if (detector.has_value()) {
      EXPECT_EQ(budget.startTag, detector->open);
      ASSERT_FALSE(budget.endTags.empty());
      EXPECT_EQ(budget.endTags.front(), detector->close);
    }
  }
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
  // Two tools, so "tools are not narrowed" is observable: against a
  // one-element list the size assertion below would hold either way.
  common_chat_tool other = makeWeatherTool();
  other.name = "get_time";
  const std::vector<common_chat_tool> tools{makeWeatherTool(), other};
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
  EXPECT_EQ(required.tools.size(), 2u) << "tools list is not narrowed";
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
  EXPECT_THROW(
      resolveToolChoice(std::nullopt, tools), qvac_errors::StatusError);
  EXPECT_THROW(
      resolveToolChoice(std::string("get_weather"), tools),
      qvac_errors::StatusError);
}

// An exotic name on its own is a warning, not an error: the fold still gives
// it a rule name no other tool claims, so nothing can be shadowed. Only a
// *collision* is rejected — see the next test.
TEST_F(ChatTemplateUtilsTest, ResolveToolChoiceAllowsUnusualToolNames) {
  common_chat_tool odd = makeWeatherTool();
  odd.name = "get weather/now";
  const std::vector<common_chat_tool> tools{odd};
  EXPECT_NO_THROW(resolveToolChoice(std::nullopt, tools));
  EXPECT_EQ(
      resolveToolChoice(std::string("get weather/now"), tools).choice,
      COMMON_CHAT_TOOL_CHOICE_REQUIRED);
}

// Two names that fold to one grammar rule are rejected before rendering or
// sampling. `get_weather` and `get-weather` both become `get-weather` under
// fabric's `rule_name()`, and every handler that builds a tool grammar
// registers its rules as `"tool-" + name` — so both refs would resolve to the
// last rule registered, constraining a call to one tool with the other's
// argument schema while both stay advertised in the prompt.
//
// The argument schemas differ on purpose: with identical schemas the case
// could pass merely because either shadowed rule happens to accept the same
// payload, which would make the test blind to the bug it exists for.
TEST_F(ChatTemplateUtilsTest, ResolveToolChoiceRejectsFoldedRuleNameCollision) {
  common_chat_tool underscored = makeWeatherTool();
  underscored.name = "get_weather";
  underscored.parameters =
      R"({"type":"object","properties":{"city":{"type":"string"}},"required":["city"]})";
  common_chat_tool hyphenated = makeWeatherTool();
  hyphenated.name = "get-weather";
  hyphenated.parameters =
      R"({"type":"object","properties":{"lat":{"type":"number"},"lon":{"type":"number"}},"required":["lat","lon"]})";
  const std::vector<common_chat_tool> tools{underscored, hyphenated};

  // Rejected under every choice that leaves both tools advertised, which is
  // where the shadowing bites; a named choice narrows to one tool, but the
  // check runs before the narrowing so it is refused there too.
  EXPECT_THROW(
      resolveToolChoice(std::nullopt, tools), qvac_errors::StatusError);
  EXPECT_THROW(
      resolveToolChoice(std::string("required"), tools),
      qvac_errors::StatusError);
  EXPECT_THROW(
      resolveToolChoice(std::string("get_weather"), tools),
      qvac_errors::StatusError);

  // Either tool alone is fine: the rejection is about the pair, not about
  // underscores or hyphens in a name.
  EXPECT_NO_THROW(resolveToolChoice(std::nullopt, {underscored}));
  EXPECT_NO_THROW(resolveToolChoice(std::nullopt, {hyphenated}));
}

// A run of unsafe bytes folds to a single '-' in fabric, so `a__b` and `a-b`
// collide while `a__b` and `a-_b` (which folds to `a--b`) do not. Pinned
// because getting the run-collapse wrong in either direction turns the check
// above into a false negative or a false positive.
TEST_F(ChatTemplateUtilsTest, ResolveToolChoiceFoldCollapsesRunsOfUnsafeBytes) {
  auto named = [](const char* name) {
    common_chat_tool tool = makeWeatherTool();
    tool.name = name;
    return tool;
  };
  EXPECT_THROW(
      resolveToolChoice(std::nullopt, {named("a__b"), named("a-b")}),
      qvac_errors::StatusError)
      << "a run of unsafe bytes collapses to one '-'";
  EXPECT_NO_THROW(
      resolveToolChoice(std::nullopt, {named("a__b"), named("a-_b")}))
      << "'a-_b' folds to 'a--b', which is a different rule";
}

// The three `tool_choice` mode words are matched before any function lookup,
// so a tool carrying one could be advertised and yet never be selectable.
// Rejected at declaration time to keep the invariant that every accepted
// definition can be named.
TEST_F(ChatTemplateUtilsTest, ResolveToolChoiceRejectsReservedToolNames) {
  for (const char* reserved : {"auto", "none", "required"}) {
    common_chat_tool tool = makeWeatherTool();
    tool.name = reserved;
    const std::vector<common_chat_tool> tools{tool};
    EXPECT_THROW(
        resolveToolChoice(std::nullopt, tools), qvac_errors::StatusError)
        << "tool named " << reserved << " must be rejected under auto";
    // And the mode words keep their mode meaning rather than being read as a
    // reference to the tool that tried to claim them.
    EXPECT_THROW(
        resolveToolChoice(std::string(reserved), tools),
        qvac_errors::StatusError)
        << "tool named " << reserved << " must be rejected when named";
  }

  // The reservation is exact: only these three strings, and only in full.
  common_chat_tool nearMiss = makeWeatherTool();
  nearMiss.name = "auto_select";
  EXPECT_NO_THROW(resolveToolChoice(std::nullopt, {nearMiss}));
}

// An empty name is unselectable from both directions — the JS layer rejects
// `tool_choice: ""` outright, and natively an empty choice is read as `auto` —
// so it breaks the same invariant as a reserved name and is rejected with it.
// It would also give the tool the bare `"tool-"` grammar rule.
TEST_F(ChatTemplateUtilsTest, ResolveToolChoiceRejectsAnEmptyToolName) {
  common_chat_tool unnamed = makeWeatherTool();
  unnamed.name = "";
  EXPECT_THROW(
      resolveToolChoice(std::nullopt, {unnamed}), qvac_errors::StatusError)
      << "an unnameable tool must not be accepted under auto";
  EXPECT_THROW(
      resolveToolChoice(std::string("required"), {unnamed}),
      qvac_errors::StatusError);

  // Rejected as a single declaration, not only as a pair: two empty names
  // already fold to the same rule and would trip the collision check instead,
  // which is what hid this.
  common_chat_tool alsoUnnamed = makeWeatherTool();
  alsoUnnamed.name = "";
  alsoUnnamed.description = "a second unnamed tool";
  EXPECT_THROW(
      resolveToolChoice(std::nullopt, {unnamed, alsoUnnamed}),
      qvac_errors::StatusError);
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
  const PromptRenderResult withResponseFormat =
      getPrompt(tmpls.get(), withSchema);

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

// The silent case, and the one a successful render used to hide: a template
// that never references `tools` *or* tool calls renders happily and leaves the
// definitions out. Nothing downstream can tell that apart from a tools-aware
// render, which is exactly what `toolDefinitionsDropped` exists to answer.
//
// Not an exotic template: any GGUF whose embedded template has no tools branch
// behaves this way, which is most models not tuned for tool calling.
TEST_F(ChatTemplateUtilsTest, GetPromptFlagsAToolsIgnoringJinjaTemplate) {
  // Renders the conversation correctly and mentions neither tools nor tool
  // calls, so fabric's caps report support for neither.
  constexpr const char* kToolsIgnoringTemplate =
      "{%- for m in messages %}<{{ m.role }}>{{ m.content }}{%- endfor %}"
      "{%- if add_generation_prompt %}<assistant>{%- endif %}";
  common_chat_templates_ptr tmpls =
      common_chat_templates_init(nullptr, kToolsIgnoringTemplate);
  ASSERT_NE(tmpls, nullptr);

  common_chat_templates_inputs inputs = makeQwenInputs();
  inputs.tools = {makeWeatherTool()};
  const PromptRenderResult rendered = getPrompt(tmpls.get(), inputs);

  EXPECT_TRUE(rendered.renderedByJinja)
      << "the render succeeded; this is not the legacy fallback";
  EXPECT_EQ(rendered.prompt.find("get_weather"), std::string::npos)
      << "the tool never reached the prompt: " << rendered.prompt;
  EXPECT_TRUE(rendered.toolDefinitionsDropped)
      << "a successful render that omitted the tools must still report the "
         "drop, or the caller is told its tools were fine";
  EXPECT_TRUE(inputs.tools.empty())
      << "omitted tools must not leak to callers, or a tool grammar could be "
         "applied for definitions the model never read";
}

// The masking case, and the reason a substring scan cannot carry this flag on
// its own: the *same* tools-ignoring template, with the tool's name occurring
// in ordinary conversation text. A check that reads "the prompt names a tool,
// so the tools were rendered" reports no drop here and tells the caller its
// definitions were fine when the template never referenced them.
//
// A user can name a tool in prose, which is what this covers.
// `GetPromptFlagsAMaskedNameFromReplayedToolCalls` below covers the shape that
// makes masking routine rather than incidental.
TEST_F(ChatTemplateUtilsTest, GetPromptFlagsAToolNameFromTheConversation) {
  constexpr const char* kToolsIgnoringTemplate =
      "{%- for m in messages %}<{{ m.role }}>{{ m.content }}{%- endfor %}"
      "{%- if add_generation_prompt %}<assistant>{%- endif %}";
  common_chat_templates_ptr tmpls =
      common_chat_templates_init(nullptr, kToolsIgnoringTemplate);
  ASSERT_NE(tmpls, nullptr);

  common_chat_templates_inputs inputs = makeQwenInputs();
  inputs.messages = {common_chat_msg{
      /* role = */ "user",
      /* content = */ "please call get_weather for Paris",
  }};
  inputs.tools = {makeWeatherTool()};
  const PromptRenderResult rendered = getPrompt(tmpls.get(), inputs);

  EXPECT_TRUE(rendered.renderedByJinja);
  EXPECT_NE(rendered.prompt.find("get_weather"), std::string::npos)
      << "precondition: the name is in the prompt, from the user's text";
  EXPECT_TRUE(rendered.toolDefinitionsDropped)
      << "the template references tools nowhere; the name in the prompt came "
         "from the conversation, not from a rendered definition";
  EXPECT_TRUE(inputs.tools.empty())
      << "a masked omission must strip the tools like any other omission";
}

// Masking as the *ordinary* case rather than an odd one, which is what
// makes the substring scan untenable rather than merely imperfect.
//
// A tools-describing template whose definitions block is guarded on the
// conversation shape (the QVAC-23251 shape again) renders the message
// history either way. So the moment the loop takes its second turn, the
// history replays `tool_calls[].name`, the prompt carries the tool's own
// name, and the guard has still dropped every definition. Every
// multi-turn tool conversation on such a template reaches this state; a
// name-in-the-prompt check reports no drop for all of them.
TEST_F(ChatTemplateUtilsTest, GetPromptFlagsAMaskedNameFromReplayedToolCalls) {
  // Describes tools (so fabric applies no tool-call fallback of its own) and
  // renders call history, but emits the definitions only for a user-first
  // conversation.
  // `<def>` rather than `<tool>` for the definitions: `tool` is also a message
  // role, so `<{{ m.role }}>` would emit the same marker for the result turn.
  constexpr const char* kUserFirstWithHistoryTemplate =
      "{%- if messages[0].role == 'user' and tools %}"
      "{%- for t in tools %}<def>{{ t.function.name }}</def>{%- endfor %}"
      "{%- endif %}"
      "{%- for m in messages %}<{{ m.role }}>{{ m.content }}"
      "{%- for c in m.tool_calls %}<call>{{ c.function.name }}</call>"
      "{%- endfor %}{%- endfor %}"
      "{%- if add_generation_prompt %}<assistant>{%- endif %}";
  common_chat_templates_ptr tmpls =
      common_chat_templates_init(nullptr, kUserFirstWithHistoryTemplate);
  ASSERT_NE(tmpls, nullptr);

  common_chat_msg system;
  system.role = "system";
  system.content = "You are helpful.";
  common_chat_msg ask;
  ask.role = "user";
  ask.content = "What is the weather in Paris?";
  common_chat_msg call;
  call.role = "assistant";
  call.tool_calls = {common_chat_tool_call{
      /* name = */ "get_weather",
      /* arguments = */ R"({"city":"Paris"})",
      /* id = */ "call_1",
  }};
  common_chat_msg result;
  result.role = "tool";
  result.tool_name = "get_weather";
  result.content = "17C";

  // System-first, so the guard drops the definitions for this render.
  common_chat_templates_inputs inputs = makeQwenInputs();
  inputs.messages = {system, ask, call, result};
  inputs.tools = {makeWeatherTool()};
  const PromptRenderResult rendered = getPrompt(tmpls.get(), inputs);

  EXPECT_EQ(rendered.prompt.find("<def>"), std::string::npos)
      << "precondition: the guard dropped the definitions: " << rendered.prompt;
  EXPECT_NE(rendered.prompt.find("get_weather"), std::string::npos)
      << "precondition: the replayed call still put the name in the prompt: "
      << rendered.prompt;
  EXPECT_TRUE(rendered.toolDefinitionsDropped)
      << "a replayed tool call is not a rendered definition; removing the "
         "tools leaves this prompt byte-identical: "
      << rendered.prompt;
  EXPECT_TRUE(inputs.tools.empty())
      << "a masked omission must strip the tools like any other omission";
}

// The other direction of the same check, so the masking fix cannot be
// satisfied by reporting a drop for everything: a template that really does
// render the definitions, on a conversation that also names the tool. The
// differential render is what separates this from the case above — removing
// the tools changes this prompt and leaves the masked one identical.
TEST_F(ChatTemplateUtilsTest, GetPromptFlagsAMaskedNameOnARenderingTemplate) {
  constexpr const char* kToolsRenderingTemplate =
      "{%- if tools %}{%- for t in tools %}<tool>{{ t.function.name }}</tool>"
      "{%- endfor %}{%- endif %}"
      "{%- for m in messages %}<{{ m.role }}>{{ m.content }}{%- endfor %}"
      "{%- if add_generation_prompt %}<assistant>{%- endif %}";
  common_chat_templates_ptr tmpls =
      common_chat_templates_init(nullptr, kToolsRenderingTemplate);
  ASSERT_NE(tmpls, nullptr);

  common_chat_templates_inputs inputs = makeQwenInputs();
  inputs.messages = {common_chat_msg{
      /* role = */ "user",
      /* content = */ "please call get_weather for Paris",
  }};
  inputs.tools = {makeWeatherTool()};
  const PromptRenderResult rendered = getPrompt(tmpls.get(), inputs);

  EXPECT_FALSE(rendered.toolDefinitionsDropped)
      << "the template rendered <tool>get_weather</tool>; a conversation that "
         "also names the tool must not turn that into a reported drop";
  EXPECT_FALSE(inputs.tools.empty())
      << "a rendered tool list must survive for the grammar to constrain";
}

// A tools-capable template that omits the definitions for *this* conversation.
// The guard fires on a leading user turn, which fabric's own capability probe
// supplies (common/jinja/caps.cpp feeds a synthetic user-first conversation),
// so `supports_tools` reports true — while a request whose first message is a
// system turn renders with no tools at all. A capability answer reports no
// drop here; only looking at what was rendered catches it.
//
// This is the shape QVAC-23251 hit, where the Qwen3.5 template rejected a
// prefix primed without a user turn. That template raised and so was caught by
// the retry path; one that silently omits instead needs this.
TEST_F(ChatTemplateUtilsTest, GetPromptFlagsAConditionalOmissionForThisRender) {
  constexpr const char* kUserFirstToolsTemplate =
      "{%- if messages[0].role == 'user' and tools %}"
      "{%- for t in tools %}<tool>{{ t.function.name }}</tool>{%- endfor %}"
      "{%- endif %}"
      "{%- for m in messages %}<{{ m.role }}>{{ m.content }}{%- endfor %}"
      "{%- if add_generation_prompt %}<assistant>{%- endif %}";
  common_chat_templates_ptr tmpls =
      common_chat_templates_init(nullptr, kUserFirstToolsTemplate);
  ASSERT_NE(tmpls, nullptr);

  // Same template, two conversations. User-first renders the tools.
  {
    common_chat_templates_inputs inputs = makeQwenInputs();
    inputs.tools = {makeWeatherTool()};
    const PromptRenderResult rendered = getPrompt(tmpls.get(), inputs);
    EXPECT_NE(rendered.prompt.find("get_weather"), std::string::npos)
        << rendered.prompt;
    EXPECT_FALSE(rendered.toolDefinitionsDropped)
        << "the tools were rendered for this conversation";
  }

  // System-first does not, though the template is just as capable.
  {
    common_chat_templates_inputs inputs = makeQwenInputs();
    inputs.messages.insert(
        inputs.messages.begin(),
        common_chat_msg{/* role = */ "system", /* content = */ "Be brief."});
    inputs.tools = {makeWeatherTool()};
    const PromptRenderResult rendered = getPrompt(tmpls.get(), inputs);
    EXPECT_EQ(rendered.prompt.find("get_weather"), std::string::npos)
        << "the guard did not fire, so nothing named the tool: "
        << rendered.prompt;
    EXPECT_TRUE(rendered.toolDefinitionsDropped)
        << "a capability check reports no drop here; the flag has to describe "
           "this render";
    EXPECT_TRUE(inputs.tools.empty())
        << "omitted tools must not leak to callers";
  }
}

// The other side of the same guard: a template that *does* describe tools must
// not be reported as dropping them. Without this the check would turn every
// tools request into a false positive, which is worse than the false negative
// it was added to fix.
TEST_F(ChatTemplateUtilsTest, GetPromptDoesNotFlagAToolsAwareTemplate) {
  common_chat_templates_ptr tmpls =
      common_chat_templates_init(nullptr, getFixedQwen3Template());
  ASSERT_NE(tmpls, nullptr);

  common_chat_templates_inputs inputs = makeQwenInputs();
  inputs.tools = {makeWeatherTool()};
  const PromptRenderResult rendered = getPrompt(tmpls.get(), inputs);

  EXPECT_FALSE(rendered.toolDefinitionsDropped);
  EXPECT_NE(rendered.prompt.find("get_weather"), std::string::npos)
      << "the tool must be in the prompt: " << rendered.prompt;
  EXPECT_EQ(inputs.tools.size(), 1u) << "tools must not be stripped";
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

// `requireToolChoiceHonoured` is the whole fail-closed rule for an explicit
// tool_choice. It takes four plain values, so every path is testable with no
// model — which is what makes its previous zero coverage worth closing.
TEST(RequireToolChoiceHonouredTest, RequiredThrowsWhenDefinitionsDropped) {
  EXPECT_THROW(
      requireToolChoiceHonoured(
          COMMON_CHAT_TOOL_CHOICE_REQUIRED,
          /* toolDefinitionsDropped = */ true,
          /* toolGrammarApplied = */ true,
          "[test]"),
      qvac_errors::StatusError);
}

TEST(RequireToolChoiceHonouredTest, RequiredThrowsWhenNoGrammarApplied) {
  EXPECT_THROW(
      requireToolChoiceHonoured(
          COMMON_CHAT_TOOL_CHOICE_REQUIRED,
          /* toolDefinitionsDropped = */ false,
          /* toolGrammarApplied = */ false,
          "[test]"),
      qvac_errors::StatusError);
}

TEST(RequireToolChoiceHonouredTest, RequiredAcceptsAnAppliedGrammar) {
  EXPECT_NO_THROW(requireToolChoiceHonoured(
      COMMON_CHAT_TOOL_CHOICE_REQUIRED,
      /* toolDefinitionsDropped = */ false,
      /* toolGrammarApplied = */ true,
      "[test]"));
}

// AUTO tolerates a prose answer by definition and NONE asked for no
// constraint, so neither can be violated however the render turned out.
TEST(RequireToolChoiceHonouredTest, AutoAndNoneNeverThrow) {
  for (const bool dropped : {false, true}) {
    for (const bool applied : {false, true}) {
      EXPECT_NO_THROW(requireToolChoiceHonoured(
          COMMON_CHAT_TOOL_CHOICE_AUTO, dropped, applied, "[test]"))
          << "dropped=" << dropped << " applied=" << applied;
      EXPECT_NO_THROW(requireToolChoiceHonoured(
          COMMON_CHAT_TOOL_CHOICE_NONE, dropped, applied, "[test]"))
          << "dropped=" << dropped << " applied=" << applied;
    }
  }
}

// `forLogMessage` and `toLowerAscii` are declared in `utils/LogSafeString.hpp`,
// so their tests live in `test_log_safe_string.cpp` — one test file per header,
// as elsewhere in this directory.
