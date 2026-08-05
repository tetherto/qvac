#include <string>
#include <unordered_map>

#include <common/common.h>
#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "handlers/LoadConfigHandlers.hpp"

using qvac_errors::StatusError;
using qvac_lib_inference_addon_llama::applyLoadConfigHandlers;

// Apply the registry to a one-key config map and return the resulting params.
// Asserts the recognized key was consumed (erased so it is not forwarded to
// llama.cpp's argument parser).
static common_params
applyOne(const std::string& key, const std::string& value) {
  common_params params;
  std::unordered_map<std::string, std::string> map{{key, value}};
  applyLoadConfigHandlers(params, map);
  EXPECT_TRUE(map.empty());
  return params;
}

TEST(LoadConfigHandlers_ReasoningBudget, ParsesInteger) {
  EXPECT_EQ(applyOne("reasoning-budget", "128").reasoning_budget, 128);
}

TEST(LoadConfigHandlers_ReasoningBudget, UnderscoreAliasParses) {
  EXPECT_EQ(applyOne("reasoning_budget", "0").reasoning_budget, 0);
}

TEST(LoadConfigHandlers_ReasoningBudget, RejectsNonInteger) {
  common_params params;
  std::unordered_map<std::string, std::string> map{{"reasoning-budget", "abc"}};
  EXPECT_THROW(applyLoadConfigHandlers(params, map), StatusError);
}

TEST(LoadConfigHandlers_ReasoningBudget, RejectsBelowMinusOne) {
  common_params params;
  std::unordered_map<std::string, std::string> map{{"reasoning-budget", "-5"}};
  EXPECT_THROW(applyLoadConfigHandlers(params, map), StatusError);
}

TEST(LoadConfigHandlers_ImageTileMode, ParsesNamedValue) {
  EXPECT_EQ(
      applyOne("image-tile-mode", "sequential").image_tile_mode,
      COMMON_IMAGE_TILE_MODE_SEQUENTIAL);
}

TEST(LoadConfigHandlers_ImageTileMode, ParsesNumericValueAndAlias) {
  EXPECT_EQ(
      applyOne("image_tile_mode", "2").image_tile_mode,
      COMMON_IMAGE_TILE_MODE_DISABLED);
}

TEST(LoadConfigHandlers_ImageTileMode, RejectsUnknownValue) {
  common_params params;
  std::unordered_map<std::string, std::string> map{{"image-tile-mode", "foo"}};
  EXPECT_THROW(applyLoadConfigHandlers(params, map), StatusError);
}

TEST(LoadConfigHandlers_ImageTokens, ParsesMaxAndMin) {
  EXPECT_EQ(applyOne("image-max-tokens", "1024").image_max_tokens, 1024);
  EXPECT_EQ(applyOne("image-min-tokens", "16").image_min_tokens, 16);
}

TEST(LoadConfigHandlers_ImageTokens, UnderscoreAliasesParse) {
  EXPECT_EQ(applyOne("image_max_tokens", "512").image_max_tokens, 512);
  EXPECT_EQ(applyOne("image_min_tokens", "8").image_min_tokens, 8);
}

// Both spellings supplied: the later (underscore) entry wins deterministically,
// and both keys are consumed.
TEST(LoadConfigHandlers_Aliases, SimultaneousSpellingsAreDeterministic) {
  common_params params;
  std::unordered_map<std::string, std::string> map{
      {"reasoning-budget", "128"}, {"reasoning_budget", "0"}};
  applyLoadConfigHandlers(params, map);
  EXPECT_EQ(params.reasoning_budget, 0);
  EXPECT_TRUE(map.empty());
}

// Disclosed behavior change: when both spellings of image-max/min-tokens are
// supplied, the registry now reads both (the later underscore entry wins) and
// consumes both, instead of forwarding the second spelling to llama.cpp. Pins
// that deterministic outcome.
TEST(
    LoadConfigHandlers_Aliases,
    SimultaneousImageTokenSpellingsAreDeterministic) {
  common_params params;
  std::unordered_map<std::string, std::string> map{
      {"image-max-tokens", "1024"},
      {"image_max_tokens", "512"},
      {"image-min-tokens", "16"},
      {"image_min_tokens", "8"}};
  applyLoadConfigHandlers(params, map);
  EXPECT_EQ(params.image_max_tokens, 512);
  EXPECT_EQ(params.image_min_tokens, 8);
  EXPECT_TRUE(map.empty());
}

TEST(LoadConfigHandlers_ImageTokens, RejectsNonInteger) {
  common_params params;
  std::unordered_map<std::string, std::string> map{{"image-max-tokens", "big"}};
  EXPECT_THROW(applyLoadConfigHandlers(params, map), StatusError);
}

// Non-breaking proof: keys the registry does not recognize (llama.cpp flags and
// keys handled elsewhere, e.g. ctx-size in tuneConfigMap) are left untouched so
// the generic pass-through still forwards them.
TEST(LoadConfigHandlers_Passthrough, UnrecognizedKeysAreLeftIntact) {
  common_params params;
  std::unordered_map<std::string, std::string> map{
      {"ctx-size", "4096"}, {"some-llama-flag", "x"}};
  applyLoadConfigHandlers(params, map);
  EXPECT_EQ(map.size(), 2u);
  EXPECT_EQ(map.at("ctx-size"), "4096");
  EXPECT_EQ(map.at("some-llama-flag"), "x");
}
