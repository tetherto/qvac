// JS number -> native conversion (js-interface/NumberConversion.hpp): a value
// the target type cannot represent must be rejected, never cast.

#include <cmath>
#include <limits>

#include <gtest/gtest.h>

#include "js-interface/NumberConversion.hpp"

using qvac::ttsggml::floatFromJsNumber;
using qvac::ttsggml::intFromJsNumber;

TEST(NumberConversion, IntKeepsRepresentableValuesAndTruncates) {
  EXPECT_EQ(intFromJsNumber(0.0), 0);
  EXPECT_EQ(intFromJsNumber(2500.0), 2500);
  EXPECT_EQ(intFromJsNumber(-1.0), -1);
  EXPECT_EQ(intFromJsNumber(2.9), 2);
  EXPECT_EQ(intFromJsNumber(-2.9), -2);
  EXPECT_EQ(
      intFromJsNumber(static_cast<double>(std::numeric_limits<int>::max())),
      std::numeric_limits<int>::max());
  EXPECT_EQ(
      intFromJsNumber(static_cast<double>(std::numeric_limits<int>::min())),
      std::numeric_limits<int>::min());
}

TEST(NumberConversion, IntRejectsOutOfRangeAndNonFinite) {
  EXPECT_FALSE(intFromJsNumber(1e20).has_value());
  EXPECT_FALSE(intFromJsNumber(-1e20).has_value());
  EXPECT_FALSE(
      intFromJsNumber(static_cast<double>(std::numeric_limits<int>::max()) + 1)
          .has_value());
  EXPECT_FALSE(
      intFromJsNumber(std::numeric_limits<double>::quiet_NaN()).has_value());
  EXPECT_FALSE(
      intFromJsNumber(std::numeric_limits<double>::infinity()).has_value());
}

TEST(NumberConversion, FloatKeepsRepresentableValues) {
  EXPECT_FLOAT_EQ(*floatFromJsNumber(0.95), 0.95f);
  EXPECT_FLOAT_EQ(*floatFromJsNumber(-0.5), -0.5f);
  EXPECT_FLOAT_EQ(
      *floatFromJsNumber(
          static_cast<double>(std::numeric_limits<float>::max())),
      std::numeric_limits<float>::max());
}

TEST(NumberConversion, FloatRejectsFiniteValuesBeyondTheFloatRange) {
  EXPECT_FALSE(floatFromJsNumber(1e300).has_value());
  EXPECT_FALSE(floatFromJsNumber(-1e40).has_value());
}

// NaN and infinity convert exactly; the option range checks reject them.
TEST(NumberConversion, FloatPassesNonFiniteThroughToRangeChecks) {
  EXPECT_TRUE(
      std::isnan(*floatFromJsNumber(std::numeric_limits<double>::quiet_NaN())));
  EXPECT_TRUE(
      std::isinf(*floatFromJsNumber(std::numeric_limits<double>::infinity())));
}
