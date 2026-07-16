#include <stdexcept>
#include <string>

#include <gtest/gtest.h>

#include "utils/ParseUnsigned.hpp"

using qvac_lib_inference_addon_llama::parseUnsignedInRange;

namespace {
unsigned parseParallel(const std::string& raw) {
  return parseUnsignedInRange(raw, 1, 1024, "parallel");
}
}  // namespace

TEST(ParseUnsignedInRangeTest, AcceptsWholeStringIntegersInRange) {
  EXPECT_EQ(parseParallel("1"), 1U);
  EXPECT_EQ(parseParallel("4"), 4U);
  EXPECT_EQ(parseParallel("1024"), 1024U);
}

TEST(ParseUnsignedInRangeTest, RejectsMalformedInput) {
  for (const char* raw : {"-1", "+1", "2.5", "2workers", " 4", ""}) {
    EXPECT_THROW(parseParallel(raw), std::invalid_argument) << raw;
  }
}

TEST(ParseUnsignedInRangeTest, RejectsOutOfRangeValues) {
  for (const char* raw : {"0", "1025", "4294967296", "99999999999999999999"}) {
    EXPECT_THROW(parseParallel(raw), std::invalid_argument) << raw;
  }
}

TEST(ParseUnsignedInRangeTest, HonoursCallerRange) {
  EXPECT_EQ(parseUnsignedInRange("0", 0, 8, "slots"), 0U);
  EXPECT_THROW(parseUnsignedInRange("9", 0, 8, "slots"), std::invalid_argument);
}
