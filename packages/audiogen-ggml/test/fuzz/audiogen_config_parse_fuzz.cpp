#include <cmath>
#include <limits>
#include <string>
#include <tuple>

#include <fuzztest/fuzztest.h>
#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "js-interface/AudiogenConfigParse.hpp"

// Property tests over the JS-adapter number parsers. parseInteger requires
// full-string consumption (unlike TTS stoi). StatusError is the expected
// reject. See docs/architecture/ADDON-FUZZING.md.

namespace {

using qvac::audiogenggml::checkedFloat;
using qvac::audiogenggml::checkedInteger;
using qvac::audiogenggml::parseFloat;
using qvac::audiogenggml::parseInteger;
using qvac_errors::StatusError;

void ParseIntegerNeverCrashes(const std::string& value) {
  try {
    (void)parseInteger(value, "n");
  } catch (const StatusError&) {
    // Rejected as invalid — not a defect.
  }
}
FUZZ_TEST(AudiogenConfigParseFuzz, ParseIntegerNeverCrashes)
    .WithDomains(fuzztest::Arbitrary<std::string>().WithMaxSize(64))
    .WithSeeds([] {
      return std::vector<std::tuple<std::string>>{
          {"0"},
          {"1"},
          {"-1"},
          {"2147483647"},
          {"2147483648"},
          {""},
          {"1.5"},
          {"1abc"},
          {" 1"},
          {std::string(40, '9')},
      };
    });

void ParseFloatNeverCrashes(const std::string& value) {
  try {
    (void)parseFloat(value, "x");
  } catch (const StatusError&) {
    // Rejected as invalid — not a defect.
  }
}
FUZZ_TEST(AudiogenConfigParseFuzz, ParseFloatNeverCrashes)
    .WithDomains(fuzztest::Arbitrary<std::string>().WithMaxSize(64))
    .WithSeeds([] {
      return std::vector<std::tuple<std::string>>{
          {"0"},
          {"1.5"},
          {"-2.25"},
          {""},
          {"nan"},
          {"inf"},
          {"1.5x"},
          {std::string(40, '9')},
      };
    });

void CheckedIntegerNeverCrashes(double value) {
  try {
    (void)checkedInteger(value, "n");
  } catch (const StatusError&) {
    // Rejected as invalid — not a defect.
  }
}
FUZZ_TEST(AudiogenConfigParseFuzz, CheckedIntegerNeverCrashes)
    .WithDomains(fuzztest::Arbitrary<double>())
    .WithSeeds([] {
      return std::vector<std::tuple<double>>{
          {0.0},
          {1.0},
          {-1.0},
          {1.5},
          {static_cast<double>(std::numeric_limits<int>::max())},
          {static_cast<double>(std::numeric_limits<int>::max()) + 1.0},
          {std::numeric_limits<double>::infinity()},
          {std::numeric_limits<double>::quiet_NaN()},
      };
    });

void CheckedFloatNeverCrashes(double value) {
  try {
    (void)checkedFloat(value, "x");
  } catch (const StatusError&) {
    // Rejected as invalid — not a defect.
  }
}
FUZZ_TEST(AudiogenConfigParseFuzz, CheckedFloatNeverCrashes)
    .WithDomains(fuzztest::Arbitrary<double>())
    .WithSeeds([] {
      return std::vector<std::tuple<double>>{
          {0.0},
          {1.5},
          {-2.25},
          {std::numeric_limits<double>::infinity()},
          {std::numeric_limits<double>::quiet_NaN()},
      };
    });

TEST(AudiogenConfigParseFuzzSeeds, ValidIntegerStillParses) {
  EXPECT_EQ(parseInteger("42", "n"), 42);
  EXPECT_EQ(checkedInteger(7.0, "n"), 7);
}

TEST(AudiogenConfigParseFuzzSeeds, PartialIntegerIsRejected) {
  EXPECT_THROW(parseInteger("1abc", "n"), StatusError);
  EXPECT_THROW(parseInteger("1.5", "n"), StatusError);
  EXPECT_THROW(checkedInteger(1.5, "n"), StatusError);
}

TEST(AudiogenConfigParseFuzzSeeds, ValidFloatStillParses) {
  EXPECT_FLOAT_EQ(parseFloat("1.25", "x"), 1.25F);
  EXPECT_FLOAT_EQ(checkedFloat(-2.0, "x"), -2.0F);
}

TEST(AudiogenConfigParseFuzzSeeds, NonFiniteFloatIsRejected) {
  EXPECT_THROW(checkedFloat(std::numeric_limits<double>::infinity(), "x"),
               StatusError);
}

} // namespace
