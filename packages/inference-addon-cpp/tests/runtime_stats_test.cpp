#include <cstdint>
#include <optional>
#include <string>

#include <gtest/gtest.h>

#include "inference-addon-cpp/RuntimeStats.hpp"

namespace qvac_lib_inference_addon_cpp {

TEST(RuntimeStatsTest, NumericValueReturnsDouble) {
  EXPECT_EQ(numericValue(RuntimeStatValue{1.5}), std::optional<double>{1.5});
}

TEST(RuntimeStatsTest, NumericValueWidensInt64) {
  EXPECT_EQ(
      numericValue(RuntimeStatValue{int64_t{7}}), std::optional<double>{7.0});
}

TEST(RuntimeStatsTest, NumericValueReturnsNulloptForString) {
  EXPECT_EQ(numericValue(RuntimeStatValue{std::string{"metal"}}), std::nullopt);
  EXPECT_EQ(numericValue(RuntimeStatValue{std::string{}}), std::nullopt);
}

} // namespace qvac_lib_inference_addon_cpp
