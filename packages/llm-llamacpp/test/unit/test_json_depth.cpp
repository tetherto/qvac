#include <string>

#include <gtest/gtest.h>

#include "utils/JsonDepth.hpp"

using qvac_lib_inference_addon_llama::utils::K_MAX_JSON_DEPTH;
using qvac_lib_inference_addon_llama::utils::nestsTooDeep;

namespace {
std::string nestedArrays(size_t depth) {
  return std::string(depth, '[') + std::string(depth, ']');
}
} // namespace

TEST(JsonDepthTest, AcceptsNestingUpToTheLimit) {
  EXPECT_FALSE(nestsTooDeep(""));
  EXPECT_FALSE(nestsTooDeep(R"({"a":[1,{"b":2}]})"));
  EXPECT_FALSE(nestsTooDeep(nestedArrays(K_MAX_JSON_DEPTH)));
}

TEST(JsonDepthTest, RejectsNestingPastTheLimit) {
  EXPECT_TRUE(nestsTooDeep(nestedArrays(K_MAX_JSON_DEPTH + 1)));
  EXPECT_TRUE(nestsTooDeep(std::string(K_MAX_JSON_DEPTH + 1, '{')));
  // Mixed arrays and objects count alike.
  std::string mixed;
  for (size_t i = 0; i <= K_MAX_JSON_DEPTH; ++i) {
    mixed += i % 2 == 0 ? R"({"a":)" : "[";
  }
  EXPECT_TRUE(nestsTooDeep(mixed));
}

TEST(JsonDepthTest, SkipsBracketsInsideStrings) {
  const std::string brackets(K_MAX_JSON_DEPTH * 2, '[');
  EXPECT_FALSE(nestsTooDeep(R"(["prefix )" + brackets + R"("])"));
  // An escaped quote does not end the string.
  EXPECT_FALSE(nestsTooDeep(R"(["\")" + brackets + R"("])"));
  // An escaped backslash does, so the brackets after it count.
  EXPECT_TRUE(nestsTooDeep(R"(["\\")" + brackets));
}

TEST(JsonDepthTest, IgnoresClosersBelowTheTopLevel) {
  // Unbalanced closers never take the depth below zero, so shallow input after
  // them is not counted as deep, and deep input still is.
  EXPECT_FALSE(nestsTooDeep("]]]" + nestedArrays(2)));
  EXPECT_TRUE(nestsTooDeep(
      std::string(K_MAX_JSON_DEPTH, ']') + nestedArrays(K_MAX_JSON_DEPTH + 1)));
}
