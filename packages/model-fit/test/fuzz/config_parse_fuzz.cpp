#include <limits>
#include <stdexcept>
#include <string>
#include <tuple>

#include <fuzztest/fuzztest.h>
#include <gtest/gtest.h>

#include "fit/LlamaLoadConfigParse.hpp"

// Property tests over the llama config integer / key parsers. Config strings
// are attacker-controlled at fit time; overflowing stoll or a partial
// consume must throw, not crash. Same class of untrusted parse as the NMT
// n_dims / length fields. See docs/architecture/ADDON-FUZZING.md.

namespace {

using model_fit::canonicalKey;
using model_fit::lower;
using model_fit::parseInteger;

void ParseIntegerNeverCrashes(const std::string& value) {
  try {
    (void)parseInteger(value, "fuzz");
  } catch (const std::invalid_argument&) {
    // Rejected as invalid — not a defect.
  }
}

FUZZ_TEST(ModelFitConfigParseFuzz, ParseIntegerNeverCrashes)
    .WithDomains(fuzztest::Arbitrary<std::string>().WithMaxSize(64))
    .WithSeeds([] {
      return std::vector<std::tuple<std::string>>{
          {"0"},
          {"-1"},
          {"2147483647"},
          {"-2147483648"},
          {"2147483648"},
          {"99999999999999999999"},
          {"1x"},
          {""},
          {"-"},
          {" 1"},
          {"0x10"},
      };
    });

void CanonicalKeyNeverCrashes(const std::string& value) {
  (void)canonicalKey(value);
  (void)lower(value);
}

FUZZ_TEST(ModelFitConfigParseFuzz, CanonicalKeyNeverCrashes)
    .WithDomains(fuzztest::Arbitrary<std::string>().WithMaxSize(256))
    .WithSeeds([] {
      return std::vector<std::tuple<std::string>>{
          {"gpu_layers"},
          {"GPU-LAYERS"},
          {""},
          {"main-gpu"},
      };
    });

TEST(ModelFitConfigParseFuzzSeeds, IntMinMaxParse) {
  EXPECT_EQ(parseInteger("2147483647", "x"), std::numeric_limits<int>::max());
  EXPECT_EQ(parseInteger("-2147483648", "x"), std::numeric_limits<int>::min());
}

TEST(ModelFitConfigParseFuzzSeeds, OverflowAndJunkAreRejected) {
  EXPECT_THROW(parseInteger("2147483648", "x"), std::invalid_argument);
  EXPECT_THROW(parseInteger("1x", "x"), std::invalid_argument);
  EXPECT_THROW(parseInteger("", "x"), std::invalid_argument);
}

TEST(ModelFitConfigParseFuzzSeeds, CanonicalKeyFoldsUnderscoreAndCase) {
  EXPECT_EQ(canonicalKey("GPU_LAYERS"), "gpu-layers");
}

} // namespace
