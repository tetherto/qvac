#include <map>
#include <set>
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/GenerationParamsApply.hpp"
#include "utils/ChatTemplateUtils.hpp"

using qvac_lib_inference_addon_llama::utils::configureTemplateDerivedSampling;
using qvac_lib_inference_addon_llama::utils::PromptRenderResult;
using qvac_lib_inference_addon_llama::utils::Tokenizer;

namespace {

std::vector<llama_token> tokens(std::initializer_list<llama_token> values) {
  return std::vector<llama_token>(values);
}

// Fixed string -> ids table standing in for a real vocab. "multi" tokenizes
// to two ids so single-id filtering has something to drop.
Tokenizer stubTokenizer() {
  return [](const std::string& text) -> std::vector<llama_token> {
    static const std::map<std::string, std::vector<llama_token>> table{
        {"<tool_call>", {101}},
        {"</tool_call>", {102}},
        {"multi", {7, 8}},
        {"<|im_start|>assistant\n", {5, 6}},
    };
    const auto it = table.find(text);
    return it == table.end() ? std::vector<llama_token>{} : it->second;
  };
}

PromptRenderResult toolRender() {
  PromptRenderResult rendered;
  rendered.prompt = "<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n";
  rendered.generationPrompt = "<|im_start|>assistant\n";
  rendered.grammar = "root ::= \"<tool_call>\" [^<]* \"</tool_call>\"";
  rendered.grammarLazy = true;
  rendered.grammarTriggers = {
      common_grammar_trigger{COMMON_GRAMMAR_TRIGGER_TYPE_WORD, "<tool_call>"}};
  rendered.preservedTokens = {"<tool_call>", "</tool_call>", "multi"};
  rendered.renderedByJinja = true;
  return rendered;
}

common_params paramsWithoutReasoningBudget() {
  common_params params;
  params.reasoning_budget = 0;
  return params;
}

} // namespace

TEST(TemplateDerivedSamplingTest, ToolGrammarTaggedAsToolCalls) {
  common_params params = paramsWithoutReasoningBudget();
  EXPECT_TRUE(configureTemplateDerivedSampling(
      params, stubTokenizer(), toolRender(), /* toolsRequested = */ true));
  EXPECT_EQ(params.sampling.grammar.type, COMMON_GRAMMAR_TYPE_TOOL_CALLS);
  EXPECT_EQ(params.sampling.grammar.grammar, toolRender().grammar);
  EXPECT_TRUE(params.sampling.grammar_lazy);
}

// A TOOL_CALLS grammar needs prefill, so the assistant header already in the
// prompt has to be handed to the sampler or it would be re-validated as
// generated text. Covered on an *eager* grammar because a lazy one is not
// checked against the grammar until its trigger fires, which would hide a
// missing `generation_prompt`.
TEST(TemplateDerivedSamplingTest, EagerToolGrammarCarriesGenerationPrompt) {
  common_params params = paramsWithoutReasoningBudget();
  PromptRenderResult rendered = toolRender();
  rendered.grammarLazy = false;
  rendered.grammarTriggers.clear();

  EXPECT_TRUE(configureTemplateDerivedSampling(
      params, stubTokenizer(), rendered, /* toolsRequested = */ true));
  EXPECT_FALSE(params.sampling.grammar_lazy);
  ASSERT_TRUE(common_grammar_needs_prefill(params.sampling.grammar));
  EXPECT_EQ(params.sampling.generation_prompt, "<|im_start|>assistant\n");
}

TEST(TemplateDerivedSamplingTest, LegacyRenderedGrammarNeverTaggedToolCalls) {
  common_params params = paramsWithoutReasoningBudget();
  PromptRenderResult rendered = toolRender();
  rendered.renderedByJinja = false; // legacy renderer echoed a user GBNF
  EXPECT_FALSE(configureTemplateDerivedSampling(
      params, stubTokenizer(), rendered, /* toolsRequested = */ true));
  EXPECT_EQ(params.sampling.grammar.type, COMMON_GRAMMAR_TYPE_NONE);
  EXPECT_TRUE(params.sampling.grammar.empty());
}

TEST(TemplateDerivedSamplingTest, ToolsAbsentClearsToolGrammar) {
  common_params params = paramsWithoutReasoningBudget();
  params.sampling.grammar =
      common_grammar(COMMON_GRAMMAR_TYPE_TOOL_CALLS, "root ::= \"x\"");
  params.sampling.grammar_lazy = true;
  params.sampling.grammar_triggers = {
      common_grammar_trigger{COMMON_GRAMMAR_TRIGGER_TYPE_TOKEN, "<t>", 101}};
  params.sampling.preserved_tokens = {101};

  PromptRenderResult rendered;
  rendered.generationPrompt = "<|im_start|>assistant\n";
  EXPECT_TRUE(configureTemplateDerivedSampling(
      params, stubTokenizer(), rendered, /* toolsRequested = */ false));
  EXPECT_EQ(params.sampling.grammar.type, COMMON_GRAMMAR_TYPE_NONE);
  EXPECT_TRUE(params.sampling.grammar.empty());
  EXPECT_FALSE(params.sampling.grammar_lazy);
  EXPECT_TRUE(params.sampling.grammar_triggers.empty());
  EXPECT_TRUE(params.sampling.preserved_tokens.empty());
}

TEST(TemplateDerivedSamplingTest, UserGrammarSurvivesToolRender) {
  common_params params = paramsWithoutReasoningBudget();
  params.sampling.grammar =
      common_grammar(COMMON_GRAMMAR_TYPE_USER, "root ::= \"yes\" | \"no\"");
  EXPECT_FALSE(configureTemplateDerivedSampling(
      params, stubTokenizer(), toolRender(), /* toolsRequested = */ true));
  EXPECT_EQ(params.sampling.grammar.type, COMMON_GRAMMAR_TYPE_USER);
  EXPECT_EQ(params.sampling.grammar.grammar, "root ::= \"yes\" | \"no\"");
  EXPECT_FALSE(params.sampling.grammar_lazy);
  EXPECT_TRUE(params.sampling.grammar_triggers.empty());
}

// Regression: the companion fields are cleared unconditionally, not only when
// the grammar itself is TOOL_CALLS. Request 1 carries tools and no
// generationParams, so its lazy grammar + trigger are written into the
// long-lived params with no restore lambda to roll them back; request 2
// installs a USER grammar and carries no tools. If the companions survived,
// common_sampler_init would build a *lazy* sampler for the caller's grammar,
// arming only on a `<tool_call>` the caller never asked for.
TEST(TemplateDerivedSamplingTest, CompanionFieldsClearedBeforeUserGrammar) {
  common_params params = paramsWithoutReasoningBudget();
  ASSERT_TRUE(configureTemplateDerivedSampling(
      params, stubTokenizer(), toolRender(), /* toolsRequested = */ true));
  ASSERT_TRUE(params.sampling.grammar_lazy);
  ASSERT_FALSE(params.sampling.grammar_triggers.empty());

  // Request 2: the caller's own grammar, no tools.
  params.sampling.grammar =
      common_grammar(COMMON_GRAMMAR_TYPE_USER, "root ::= \"yes\" | \"no\"");
  PromptRenderResult rendered;
  EXPECT_TRUE(configureTemplateDerivedSampling(
      params, stubTokenizer(), rendered, /* toolsRequested = */ false));

  EXPECT_EQ(params.sampling.grammar.type, COMMON_GRAMMAR_TYPE_USER);
  EXPECT_FALSE(params.sampling.grammar_lazy)
      << "a stale lazy flag makes the caller's grammar arm only on a trigger";
  EXPECT_TRUE(params.sampling.grammar_triggers.empty());
  EXPECT_TRUE(params.sampling.preserved_tokens.empty());
}

TEST(TemplateDerivedSamplingTest, LoadTimeUserGrammarSurvivesToolsAbsentClear) {
  common_params params = paramsWithoutReasoningBudget();
  params.sampling.grammar =
      common_grammar(COMMON_GRAMMAR_TYPE_USER, "root ::= \"loaded\"");
  PromptRenderResult rendered;
  EXPECT_FALSE(configureTemplateDerivedSampling(
      params, stubTokenizer(), rendered, /* toolsRequested = */ false));
  EXPECT_EQ(params.sampling.grammar.type, COMMON_GRAMMAR_TYPE_USER);
  EXPECT_EQ(params.sampling.grammar.grammar, "root ::= \"loaded\"");
}

// A per-request json_schema is enforced by the sampler-side OUTPUT_FORMAT
// grammar and must suppress the tool grammar — it is never handed to the
// template, because fabric returns a response-format-only parser that
// excludes tool calls anyway.
TEST(TemplateDerivedSamplingTest, JsonSchemaGrammarSuppressesToolGrammar) {
  common_params params = paramsWithoutReasoningBudget();
  params.sampling.grammar =
      common_grammar(COMMON_GRAMMAR_TYPE_OUTPUT_FORMAT, "root ::= \"{}\"");
  EXPECT_FALSE(configureTemplateDerivedSampling(
      params, stubTokenizer(), toolRender(), /* toolsRequested = */ true));
  EXPECT_EQ(params.sampling.grammar.type, COMMON_GRAMMAR_TYPE_OUTPUT_FORMAT);
  EXPECT_EQ(params.sampling.grammar.grammar, "root ::= \"{}\"");
}

TEST(TemplateDerivedSamplingTest, ToolChoiceDoesNotCountAsSamplerOverride) {
  GenerationParams overrides;
  overrides.tool_choice = "required";
  EXPECT_FALSE(overrides.hasOverrides())
      << "tool_choice is a render override; it must not force a no-op "
         "common_sampler_init in applyGenerationParamsToContext";
}

TEST(TemplateDerivedSamplingTest, OutputFormatGrammarSuppressesToolGrammar) {
  common_params params = paramsWithoutReasoningBudget();
  params.sampling.grammar =
      common_grammar(COMMON_GRAMMAR_TYPE_OUTPUT_FORMAT, "root ::= \"{}\"");
  EXPECT_FALSE(configureTemplateDerivedSampling(
      params, stubTokenizer(), toolRender(), /* toolsRequested = */ true));
  EXPECT_EQ(params.sampling.grammar.type, COMMON_GRAMMAR_TYPE_OUTPUT_FORMAT);
}

TEST(TemplateDerivedSamplingTest, ChangeDetectionFiresOnGrammarOnlyDelta) {
  common_params params = paramsWithoutReasoningBudget();
  ASSERT_TRUE(configureTemplateDerivedSampling(
      params, stubTokenizer(), toolRender(), true));
  PromptRenderResult rendered = toolRender();
  rendered.grammar += " | \"extra\"";
  EXPECT_TRUE(configureTemplateDerivedSampling(
      params, stubTokenizer(), rendered, true));
  EXPECT_EQ(params.sampling.grammar.grammar, rendered.grammar);
}

// common_sampler_reset() rewinds the sampler chain but not the grammar, so a
// tool grammar that a previous request drove to completion would reject every
// token if the sampler were reused. Re-applying a tool grammar must therefore
// always report a change, even when the grammar text is identical.
TEST(TemplateDerivedSamplingTest, ReappliedToolGrammarAlwaysRequestsRebuild) {
  common_params params = paramsWithoutReasoningBudget();
  ASSERT_TRUE(configureTemplateDerivedSampling(
      params, stubTokenizer(), toolRender(), true));
  EXPECT_TRUE(configureTemplateDerivedSampling(
      params, stubTokenizer(), toolRender(), true));
  EXPECT_EQ(params.sampling.grammar.type, COMMON_GRAMMAR_TYPE_TOOL_CALLS);
}

TEST(TemplateDerivedSamplingTest, NoGrammarAndNothingMovedStaysFalse) {
  common_params params = paramsWithoutReasoningBudget();
  PromptRenderResult rendered;
  rendered.generationPrompt = "<|im_start|>assistant\n";
  EXPECT_FALSE(configureTemplateDerivedSampling(
      params, stubTokenizer(), rendered, false));
  EXPECT_FALSE(configureTemplateDerivedSampling(
      params, stubTokenizer(), rendered, false));
}

TEST(
    TemplateDerivedSamplingTest,
    GenerationPromptSetForToolGrammarWithoutReasoningBudget) {
  common_params params = paramsWithoutReasoningBudget();
  ASSERT_TRUE(configureTemplateDerivedSampling(
      params, stubTokenizer(), toolRender(), true));
  EXPECT_EQ(params.sampling.generation_prompt, toolRender().generationPrompt);
}

TEST(TemplateDerivedSamplingTest, GenerationPromptClearedForUserGrammar) {
  common_params params = paramsWithoutReasoningBudget();
  params.sampling.grammar =
      common_grammar(COMMON_GRAMMAR_TYPE_USER, "root ::= \"x\"");
  params.sampling.generation_prompt = "stale";
  PromptRenderResult rendered;
  rendered.generationPrompt = "<|im_start|>assistant\n";
  EXPECT_TRUE(configureTemplateDerivedSampling(
      params, stubTokenizer(), rendered, false));
  EXPECT_TRUE(params.sampling.generation_prompt.empty());
}

TEST(
    TemplateDerivedSamplingTest,
    LazyGrammarWithNoTriggersIsRejectedNotApplied) {
  common_params params = paramsWithoutReasoningBudget();
  PromptRenderResult rendered = toolRender();
  rendered.grammarTriggers.clear();
  EXPECT_FALSE(configureTemplateDerivedSampling(
      params, stubTokenizer(), rendered, true));
  EXPECT_EQ(params.sampling.grammar.type, COMMON_GRAMMAR_TYPE_NONE);
}

TEST(TemplateDerivedSamplingTest, TriggerWordNotPreservedIsRejected) {
  common_params params = paramsWithoutReasoningBudget();
  PromptRenderResult rendered = toolRender();
  rendered.preservedTokens = {"</tool_call>"}; // trigger word missing
  EXPECT_FALSE(configureTemplateDerivedSampling(
      params, stubTokenizer(), rendered, true));
  EXPECT_EQ(params.sampling.grammar.type, COMMON_GRAMMAR_TYPE_NONE);
}

TEST(
    TemplateDerivedSamplingTest,
    PreservedTokenConversionKeepsOnlySingleIdTokens) {
  common_params params = paramsWithoutReasoningBudget();
  ASSERT_TRUE(configureTemplateDerivedSampling(
      params, stubTokenizer(), toolRender(), true));
  EXPECT_EQ(params.sampling.preserved_tokens, (std::set<llama_token>{101, 102}))
      << "\"multi\" tokenizes to two ids and must be dropped";
}

TEST(TemplateDerivedSamplingTest, WordTriggerPromotedToTokenWhenSingleId) {
  common_params params = paramsWithoutReasoningBudget();
  PromptRenderResult rendered = toolRender();
  rendered.grammarTriggers.push_back(
      common_grammar_trigger{COMMON_GRAMMAR_TRIGGER_TYPE_WORD, "multi"});
  ASSERT_TRUE(configureTemplateDerivedSampling(
      params, stubTokenizer(), rendered, true));
  ASSERT_EQ(params.sampling.grammar_triggers.size(), 2u);
  EXPECT_EQ(
      params.sampling.grammar_triggers[0].type,
      COMMON_GRAMMAR_TRIGGER_TYPE_TOKEN);
  EXPECT_EQ(params.sampling.grammar_triggers[0].token, 101);
  EXPECT_EQ(
      params.sampling.grammar_triggers[1].type,
      COMMON_GRAMMAR_TRIGGER_TYPE_WORD)
      << "a multi-token word stays a WORD trigger";
}

TEST(TemplateDerivedSamplingTest, ToolGrammarNotAppliedWithoutTokenizer) {
  common_params params = paramsWithoutReasoningBudget();
  EXPECT_FALSE(configureTemplateDerivedSampling(
      params, Tokenizer{}, toolRender(), true));
  EXPECT_EQ(params.sampling.grammar.type, COMMON_GRAMMAR_TYPE_NONE);
}

TEST(GenerationParamsApplyTest, NoReasoningBudgetOverrideLeavesSamplingState) {
  common_params_sampling sampling;
  sampling.reasoning_budget_tokens = 12;
  sampling.reasoning_budget_start = tokens({1, 2});
  sampling.reasoning_budget_end = {tokens({3})};
  sampling.reasoning_budget_forced = tokens({4, 5});
  int nPredict = 32;

  GenerationParams overrides;
  overrides.temp = 0.25f;
  applyGenerationOverridesToSampling(sampling, nPredict, overrides);

  EXPECT_EQ(sampling.reasoning_budget_tokens, 12);
  EXPECT_EQ(sampling.reasoning_budget_start, tokens({1, 2}));
  EXPECT_EQ(
      sampling.reasoning_budget_end, std::vector<llama_tokens>{tokens({3})});
  EXPECT_EQ(sampling.reasoning_budget_forced, tokens({4, 5}));
}

TEST(GenerationParamsApplyTest, PositiveReasoningBudgetUpdatesOnlyTokenCap) {
  common_params_sampling sampling;
  sampling.reasoning_budget_tokens = -1;
  sampling.reasoning_budget_start = tokens({10});
  sampling.reasoning_budget_end = {tokens({11})};
  sampling.reasoning_budget_forced = tokens({12});
  int nPredict = 32;

  GenerationParams overrides;
  overrides.reasoning_budget = 16;
  applyGenerationOverridesToSampling(sampling, nPredict, overrides);

  EXPECT_EQ(sampling.reasoning_budget_tokens, 16);
  EXPECT_EQ(sampling.reasoning_budget_start, tokens({10}));
  EXPECT_EQ(
      sampling.reasoning_budget_end, std::vector<llama_tokens>{tokens({11})});
  EXPECT_EQ(sampling.reasoning_budget_forced, tokens({12}));
}

TEST(GenerationParamsApplyTest, ZeroReasoningBudgetClearsBudgetSamplerState) {
  common_params_sampling sampling;
  sampling.reasoning_budget_tokens = 16;
  sampling.reasoning_budget_start = tokens({10});
  sampling.reasoning_budget_end = {tokens({11})};
  sampling.reasoning_budget_forced = tokens({12});
  int nPredict = 32;

  GenerationParams overrides;
  overrides.reasoning_budget = 0;
  applyGenerationOverridesToSampling(sampling, nPredict, overrides);

  EXPECT_EQ(sampling.reasoning_budget_tokens, -1);
  EXPECT_TRUE(sampling.reasoning_budget_start.empty());
  EXPECT_TRUE(sampling.reasoning_budget_end.empty());
  EXPECT_TRUE(sampling.reasoning_budget_forced.empty());
}

TEST(
    GenerationParamsApplyTest,
    UnrestrictedReasoningBudgetClearsBudgetSamplerState) {
  common_params_sampling sampling;
  sampling.reasoning_budget_tokens = 16;
  sampling.reasoning_budget_start = tokens({10});
  sampling.reasoning_budget_end = {tokens({11})};
  sampling.reasoning_budget_forced = tokens({12});
  int nPredict = 32;

  GenerationParams overrides;
  overrides.reasoning_budget = -1;
  applyGenerationOverridesToSampling(sampling, nPredict, overrides);

  EXPECT_EQ(sampling.reasoning_budget_tokens, -1);
  EXPECT_TRUE(sampling.reasoning_budget_start.empty());
  EXPECT_TRUE(sampling.reasoning_budget_end.empty());
  EXPECT_TRUE(sampling.reasoning_budget_forced.empty());
}

// Builds the render a reasoning-budget test needs: thinking tags present, no
// tool grammar, so only the budget half of the pass is exercised.
static PromptRenderResult reasoningRender() {
  PromptRenderResult rendered;
  rendered.renderedByJinja = true;
  rendered.thinkingStartTag = "<think>";
  rendered.thinkingEndTags = {"</think>", "<tool_call>"};
  rendered.generationPrompt = "<assistant><think>";
  return rendered;
}

TEST(TemplateDerivedSamplingTest, ReasoningBudgetClearsStaleStateWhenDisabled) {
  common_params params;
  params.reasoning_budget = 0;
  params.sampling.reasoning_budget_tokens = 16;
  params.sampling.reasoning_budget_start = tokens({10});
  params.sampling.reasoning_budget_end = {tokens({11})};
  params.sampling.reasoning_budget_forced = tokens({12});
  params.sampling.generation_prompt = "<assistant><think>";

  // No tokenizer: the tag vectors cannot be built, so they must end up empty
  // rather than keeping the previous request's ids.
  EXPECT_TRUE(configureTemplateDerivedSampling(
      params, Tokenizer{}, reasoningRender(), /* toolsRequested = */ false));
  EXPECT_EQ(params.sampling.reasoning_budget_tokens, -1);
  EXPECT_TRUE(params.sampling.reasoning_budget_start.empty());
  EXPECT_TRUE(params.sampling.reasoning_budget_end.empty());
  EXPECT_TRUE(params.sampling.reasoning_budget_forced.empty());
  EXPECT_TRUE(params.sampling.generation_prompt.empty());
}

TEST(
    TemplateDerivedSamplingTest,
    ReasoningBudgetKeepsPositiveCapWithoutTokenizer) {
  common_params params;
  params.reasoning_budget = 8;
  params.sampling.reasoning_budget_tokens = -1;
  params.sampling.reasoning_budget_start = tokens({10});
  params.sampling.reasoning_budget_end = {tokens({11})};
  params.sampling.reasoning_budget_forced = tokens({12});
  params.sampling.generation_prompt = "<assistant><think>";

  EXPECT_TRUE(configureTemplateDerivedSampling(
      params, Tokenizer{}, reasoningRender(), /* toolsRequested = */ false));
  EXPECT_EQ(params.sampling.reasoning_budget_tokens, 8);
  EXPECT_TRUE(params.sampling.reasoning_budget_start.empty());
  EXPECT_TRUE(params.sampling.reasoning_budget_end.empty());
  EXPECT_TRUE(params.sampling.reasoning_budget_forced.empty());
  EXPECT_TRUE(params.sampling.generation_prompt.empty());
}

// Regression: a tools request leaves `generation_prompt` (and the rest of the
// tool grammar's companion fields) in the context's long-lived sampling block,
// because `tool_choice` is excluded from `hasOverrides()` and so takes no
// restore snapshot. `common_grammar_needs_prefill` is true for OUTPUT_FORMAT
// too, so inheriting an assistant prefix into a json_schema request made
// fabric prefill it into a JSON grammar and throw — permanently, since that
// happens before `tokenizeChat` and so before the clear there could run.
TEST(GenerationParamsApplyTest, InstallingASchemaClearsToolGrammarCompanions) {
  common_params_sampling sampling;
  // State a preceding `tool_choice: "required"` request would leave behind.
  sampling.grammar =
      common_grammar(COMMON_GRAMMAR_TYPE_TOOL_CALLS, "root ::= \"x\"");
  sampling.generation_prompt = "<|im_start|>assistant\n<think>\n";
  sampling.grammar_lazy = true;
  sampling.grammar_triggers = {
      common_grammar_trigger{COMMON_GRAMMAR_TRIGGER_TYPE_TOKEN, "<t>", 101}};
  sampling.preserved_tokens = {101};

  GenerationParams overrides;
  overrides.json_schema = R"({"type":"object"})";
  int nPredict = -1;
  applyGenerationOverridesToSampling(sampling, nPredict, overrides);

  EXPECT_EQ(sampling.grammar.type, COMMON_GRAMMAR_TYPE_OUTPUT_FORMAT);
  EXPECT_TRUE(sampling.generation_prompt.empty())
      << "an assistant prefix prefilled into a JSON grammar throws";
  EXPECT_FALSE(sampling.grammar_lazy);
  EXPECT_TRUE(sampling.grammar_triggers.empty());
  EXPECT_TRUE(sampling.preserved_tokens.empty());
}

// The same clear applies to a per-request `grammar`, which is USER-typed and
// does not need prefill — but inheriting a stale lazy trigger would make the
// caller's own grammar arm on a token it never asked for.
TEST(
    GenerationParamsApplyTest,
    InstallingAUserGrammarClearsToolGrammarCompanions) {
  common_params_sampling sampling;
  sampling.grammar =
      common_grammar(COMMON_GRAMMAR_TYPE_TOOL_CALLS, "root ::= \"x\"");
  sampling.generation_prompt = "<|im_start|>assistant\n";
  sampling.grammar_lazy = true;

  GenerationParams overrides;
  overrides.grammar = "root ::= \"yes\" | \"no\"";
  int nPredict = -1;
  applyGenerationOverridesToSampling(sampling, nPredict, overrides);

  EXPECT_EQ(sampling.grammar.type, COMMON_GRAMMAR_TYPE_USER);
  EXPECT_TRUE(sampling.generation_prompt.empty());
  EXPECT_FALSE(sampling.grammar_lazy);
}

// A request that installs no grammar must not touch the companions: the tool
// grammar it inherits is still the live one, and
// `configureTemplateDerivedSampling` owns clearing it at render time.
TEST(GenerationParamsApplyTest, NoGrammarOverrideLeavesCompanionsAlone) {
  common_params_sampling sampling;
  sampling.grammar =
      common_grammar(COMMON_GRAMMAR_TYPE_TOOL_CALLS, "root ::= \"x\"");
  sampling.generation_prompt = "<|im_start|>assistant\n";
  sampling.grammar_lazy = true;

  GenerationParams overrides;
  overrides.temp = 0.5F;
  int nPredict = -1;
  applyGenerationOverridesToSampling(sampling, nPredict, overrides);

  EXPECT_EQ(sampling.grammar.type, COMMON_GRAMMAR_TYPE_TOOL_CALLS);
  EXPECT_EQ(sampling.generation_prompt, "<|im_start|>assistant\n");
  EXPECT_TRUE(sampling.grammar_lazy);
}
