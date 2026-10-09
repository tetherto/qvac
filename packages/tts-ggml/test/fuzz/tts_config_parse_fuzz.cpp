#include <string>
#include <tuple>

#include <fuzztest/fuzztest.h>
#include <gtest/gtest.h>
#include <inference-addon-cpp/Errors.hpp>

#include "js-interface/TtsConfigParse.hpp"

// Property tests over the JS-adapter config string parsers. Malformed input
// is rejected with StatusError — the expected, non-buggy outcome. No
// engine/fabric, so ASan + LeakSanitizer stay at full strength.
// See docs/architecture/ADDON-FUZZING.md.

namespace {

using qvac::ttsggml::parseFloatString;
using qvac::ttsggml::parseIntString;
using qvac_errors::StatusError;

void ParseIntNeverCrashes(const std::string& value) {
  try {
    (void)parseIntString(value, "n");
  } catch (const StatusError&) {
    // Rejected as invalid — not a defect.
  }
}
FUZZ_TEST(TtsConfigParseFuzz, ParseIntNeverCrashes)
    .WithDomains(fuzztest::Arbitrary<std::string>().WithMaxSize(64))
    .WithSeeds([] {
      return std::vector<std::tuple<std::string>>{
          {"0"},
          {"1"},
          {"-1"},
          {"2147483647"},
          {"2147483648"},
          {""},
          {"not-a-number"},
          {"1.5"},
          {" 1"},
          {std::string(40, '9')},
      };
    });

void ParseFloatNeverCrashes(const std::string& value) {
  try {
    (void)parseFloatString(value, "x");
  } catch (const StatusError&) {
    // Rejected as invalid — not a defect.
  }
}
FUZZ_TEST(TtsConfigParseFuzz, ParseFloatNeverCrashes)
    .WithDomains(fuzztest::Arbitrary<std::string>().WithMaxSize(64))
    .WithSeeds([] {
      return std::vector<std::tuple<std::string>>{
          {"0"},
          {"1.5"},
          {"-2.25"},
          {""},
          {"nan"},
          {"inf"},
          {"not-a-number"},
          {std::string(40, '9')},
      };
    });

TEST(TtsConfigParseFuzzSeeds, ValidIntStillParses) {
  EXPECT_EQ(parseIntString("42", "n"), 42);
  EXPECT_EQ(parseIntString("-7", "n"), -7);
}

TEST(TtsConfigParseFuzzSeeds, NonNumericIntIsRejected) {
  EXPECT_THROW(parseIntString("nope", "n"), StatusError);
  EXPECT_THROW(parseIntString("", "n"), StatusError);
}

TEST(TtsConfigParseFuzzSeeds, ValidFloatStillParses) {
  EXPECT_FLOAT_EQ(parseFloatString("1.25", "x"), 1.25F);
}

TEST(TtsConfigParseFuzzSeeds, NonNumericFloatIsRejected) {
  EXPECT_THROW(parseFloatString("nope", "x"), StatusError);
}

} // namespace
