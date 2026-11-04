#include <optional>
#include <stdexcept>
#include <string>
#include <tuple>
#include <variant>

#include <fuzztest/fuzztest.h>
#include <gtest/gtest.h>

#include "model-interface/BackendConfigParse.hpp"

// Property tests over the config-string parsers. `main-gpu` and `device` are
// attacker-controlled at load time; they must not crash on huge integers,
// mixed-case enums, or junk. Same class of untrusted parse as the NMT
// weight-header fields. See docs/architecture/ADDON-FUZZING.md.

namespace {

using backend_selection::MainGpu;
using backend_selection::MainGpuType;
using backend_selection::parseMainGpu;
using backend_selection::preferredBackendTypeFromString;

void ParseMainGpuNeverCrashes(const std::string& value) {
  try {
    (void)parseMainGpu(value);
  } catch (const qvac_errors::StatusError&) {
    // Rejected as invalid — not a defect.
  }
}

FUZZ_TEST(EmbedConfigParseFuzz, ParseMainGpuNeverCrashes)
    .WithDomains(fuzztest::Arbitrary<std::string>().WithMaxSize(256))
    .WithSeeds([] {
      return std::vector<std::tuple<std::string>>{
          {""},
          {"0"},
          {"2"},
          {"-1"},
          {"2147483648"},
          {"99999999999999999999"},
          {"integrated"},
          {"INTEGRATED"},
          {"dedicated"},
          {"invalid"},
          {"1gpu"},
      };
    });

void PreferredDeviceNeverCrashes(const std::string& value) {
  try {
    (void)preferredBackendTypeFromString(value);
  } catch (const qvac_errors::StatusError&) {
    // Rejected as invalid — not a defect.
  }
}

FUZZ_TEST(EmbedConfigParseFuzz, PreferredDeviceNeverCrashes)
    .WithDomains(fuzztest::Arbitrary<std::string>().WithMaxSize(64))
    .WithSeeds([] {
      return std::vector<std::tuple<std::string>>{
          {"gpu"},
          {"cpu"},
          {"GPU"},
          {""},
          {"auto"},
      };
    });

TEST(EmbedConfigParseFuzzSeeds, EmptyMainGpuIsNullopt) {
  EXPECT_EQ(parseMainGpu(""), std::nullopt);
}

TEST(EmbedConfigParseFuzzSeeds, IntegerAndEnumSeedsParse) {
  auto index = parseMainGpu("2");
  ASSERT_TRUE(index.has_value());
  EXPECT_TRUE(std::holds_alternative<int>(*index));
  EXPECT_EQ(std::get<int>(*index), 2);

  auto integrated = parseMainGpu("integrated");
  ASSERT_TRUE(integrated.has_value());
  EXPECT_TRUE(std::holds_alternative<MainGpuType>(*integrated));
  EXPECT_EQ(std::get<MainGpuType>(*integrated), MainGpuType::Integrated);
}

TEST(EmbedConfigParseFuzzSeeds, InvalidMainGpuThrows) {
  EXPECT_THROW(parseMainGpu("invalid"), qvac_errors::StatusError);
}

} // namespace
