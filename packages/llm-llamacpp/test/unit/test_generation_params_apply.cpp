#include <vector>

#include <gtest/gtest.h>

#include "model-interface/GenerationParamsApply.hpp"
#include "utils/ChatTemplateUtils.hpp"

using qvac_lib_inference_addon_llama::utils::configureReasoningBudgetSampling;

namespace {

std::vector<llama_token> tokens(std::initializer_list<llama_token> values) {
  return std::vector<llama_token>(values);
}

} // namespace

TEST(GenerationParamsApplyTest, NoReasoningBudgetOverrideLeavesSamplingState) {
  common_params_sampling sampling;
  sampling.reasoning_budget_tokens = 12;
  sampling.reasoning_budget_start = tokens({1, 2});
  sampling.reasoning_budget_end = tokens({3});
  sampling.reasoning_budget_forced = tokens({4, 5});
  int nPredict = 32;

  GenerationParams overrides;
  overrides.temp = 0.25f;
  applyGenerationOverridesToSampling(sampling, nPredict, overrides);

  EXPECT_EQ(sampling.reasoning_budget_tokens, 12);
  EXPECT_EQ(sampling.reasoning_budget_start, tokens({1, 2}));
  EXPECT_EQ(sampling.reasoning_budget_end, tokens({3}));
  EXPECT_EQ(sampling.reasoning_budget_forced, tokens({4, 5}));
}

TEST(GenerationParamsApplyTest, PositiveReasoningBudgetUpdatesOnlyTokenCap) {
  common_params_sampling sampling;
  sampling.reasoning_budget_tokens = -1;
  sampling.reasoning_budget_start = tokens({10});
  sampling.reasoning_budget_end = tokens({11});
  sampling.reasoning_budget_forced = tokens({12});
  int nPredict = 32;

  GenerationParams overrides;
  overrides.reasoning_budget = 16;
  applyGenerationOverridesToSampling(sampling, nPredict, overrides);

  EXPECT_EQ(sampling.reasoning_budget_tokens, 16);
  EXPECT_EQ(sampling.reasoning_budget_start, tokens({10}));
  EXPECT_EQ(sampling.reasoning_budget_end, tokens({11}));
  EXPECT_EQ(sampling.reasoning_budget_forced, tokens({12}));
}

TEST(GenerationParamsApplyTest, ZeroReasoningBudgetClearsBudgetSamplerState) {
  common_params_sampling sampling;
  sampling.reasoning_budget_tokens = 16;
  sampling.reasoning_budget_start = tokens({10});
  sampling.reasoning_budget_end = tokens({11});
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
  sampling.reasoning_budget_end = tokens({11});
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

TEST(
    GenerationParamsApplyTest,
    ConfigureReasoningBudgetSamplingClearsStaleStateWhenDisabled) {
  common_params params;
  params.reasoning_budget = 0;
  params.sampling.reasoning_budget_tokens = 16;
  params.sampling.reasoning_budget_start = tokens({10});
  params.sampling.reasoning_budget_end = tokens({11});
  params.sampling.reasoning_budget_forced = tokens({12});
  params.sampling.generation_prompt = "<assistant><think>";

  EXPECT_TRUE(configureReasoningBudgetSampling(
      params, nullptr, "<think>", "</think>", "<assistant><think>"));
  EXPECT_EQ(params.sampling.reasoning_budget_tokens, -1);
  EXPECT_TRUE(params.sampling.reasoning_budget_start.empty());
  EXPECT_TRUE(params.sampling.reasoning_budget_end.empty());
  EXPECT_TRUE(params.sampling.reasoning_budget_forced.empty());
  EXPECT_TRUE(params.sampling.generation_prompt.empty());
}

TEST(
    GenerationParamsApplyTest,
    ConfigureReasoningBudgetSamplingKeepsPositiveCapWithoutContext) {
  common_params params;
  params.reasoning_budget = 8;
  params.sampling.reasoning_budget_tokens = -1;
  params.sampling.reasoning_budget_start = tokens({10});
  params.sampling.reasoning_budget_end = tokens({11});
  params.sampling.reasoning_budget_forced = tokens({12});
  params.sampling.generation_prompt = "<assistant><think>";

  EXPECT_TRUE(configureReasoningBudgetSampling(
      params, nullptr, "<think>", "</think>", "<assistant><think>"));
  EXPECT_EQ(params.sampling.reasoning_budget_tokens, 8);
  EXPECT_TRUE(params.sampling.reasoning_budget_start.empty());
  EXPECT_TRUE(params.sampling.reasoning_budget_end.empty());
  EXPECT_TRUE(params.sampling.reasoning_budget_forced.empty());
  EXPECT_TRUE(params.sampling.generation_prompt.empty());
}
