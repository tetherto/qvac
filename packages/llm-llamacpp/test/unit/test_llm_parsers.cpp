#include <limits>

#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "handlers/LlmParsers.hpp"

using qvac_errors::StatusError;
using qvac_lib_inference_addon_llama::parsers::parseReasoningBudgetConfig;
using qvac_lib_inference_addon_llama::parsers::validateReasoningBudgetOverride;

TEST(LlmParsers_ReasoningBudget, AcceptsUnrestricted) {
  EXPECT_EQ(validateReasoningBudgetOverride(-1.0), -1);
}

TEST(LlmParsers_ReasoningBudget, AcceptsDisabled) {
  EXPECT_EQ(validateReasoningBudgetOverride(0.0), 0);
}

TEST(LlmParsers_ReasoningBudget, AcceptsPositiveCap) {
  EXPECT_EQ(validateReasoningBudgetOverride(128.0), 128);
}

TEST(LlmParsers_ReasoningBudget, RejectsFractional) {
  EXPECT_THROW(validateReasoningBudgetOverride(0.5), StatusError);
}

TEST(LlmParsers_ReasoningBudget, RejectsBelowMinusOne) {
  EXPECT_THROW(validateReasoningBudgetOverride(-2.0), StatusError);
}

TEST(LlmParsers_ReasoningBudget, RejectsAboveIntMax) {
  const double aboveMax =
      static_cast<double>(std::numeric_limits<int>::max()) + 1.0;
  EXPECT_THROW(validateReasoningBudgetOverride(aboveMax), StatusError);
}

TEST(LlmParsers_ReasoningBudgetConfig, ParsesValues) {
  EXPECT_EQ(parseReasoningBudgetConfig("-1"), -1);
  EXPECT_EQ(parseReasoningBudgetConfig("0"), 0);
  EXPECT_EQ(parseReasoningBudgetConfig("128"), 128);
}

TEST(LlmParsers_ReasoningBudgetConfig, RejectsNonInteger) {
  EXPECT_THROW(parseReasoningBudgetConfig("abc"), StatusError);
  EXPECT_THROW(parseReasoningBudgetConfig("1.5"), StatusError);
}

TEST(LlmParsers_ReasoningBudgetConfig, RejectsBelowMinusOne) {
  EXPECT_THROW(parseReasoningBudgetConfig("-2"), StatusError);
}

TEST(LlmParsers_ReasoningBudgetConfig, RejectsOverflow) {
  EXPECT_THROW(parseReasoningBudgetConfig("99999999999"), StatusError);
}
