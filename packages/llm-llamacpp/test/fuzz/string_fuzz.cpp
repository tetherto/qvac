#include <cstddef>
#include <string>
#include <tuple>
#include <vector>

#include <fuzztest/fuzztest.h>
#include <gtest/gtest.h>

#include "utils/LogSafeString.hpp"
#include "utils/StopStringMatch.hpp"

// Property tests over the header-only string sanitiser and stop matcher.
// Both take attacker-controlled text (prompts, template stops, antiprompts,
// error fragments) and must not crash, over-read, or grow unbounded. Same
// class of untrusted-input front door as the NMT weight-header parsers.
// See docs/architecture/ADDON-FUZZING.md.

namespace {

using qvac_lib_inference_addon_llama::utils::forLogMessage;
using qvac_lib_inference_addon_llama::utils::K_MAX_LOG_DIAGNOSTIC;
using qvac_lib_inference_addon_llama::utils::K_MAX_LOG_ECHO;
using qvac_lib_inference_addon_llama::utils::matchesAnyStopString;
using qvac_lib_inference_addon_llama::utils::toLowerAscii;

void ForLogMessageNeverCrashes(const std::string& value, size_t maxLen) {
  const std::string out = forLogMessage(value, maxLen);
  EXPECT_LE(out.size(), maxLen + 3);
}

FUZZ_TEST(LlmStringFuzz, ForLogMessageNeverCrashes)
    .WithDomains(
        fuzztest::Arbitrary<std::string>().WithMaxSize(4096),
        fuzztest::InRange<size_t>(0, 1024))
    .WithSeeds([] {
      return std::vector<std::tuple<std::string, size_t>>{
          {"get_weather", K_MAX_LOG_ECHO},
          {std::string("a\nb\tc"), K_MAX_LOG_ECHO},
          {std::string("a\0b", 3), K_MAX_LOG_ECHO},
          {std::string(K_MAX_LOG_ECHO + 8, 'x'), K_MAX_LOG_ECHO},
          {std::string("\xE2\x82\xAC"), K_MAX_LOG_DIAGNOSTIC},
          {"", 0},
      };
    });

void ToLowerAsciiNeverCrashes(const std::string& value) {
  (void)toLowerAscii(value);
}

FUZZ_TEST(LlmStringFuzz, ToLowerAsciiNeverCrashes)
    .WithDomains(fuzztest::Arbitrary<std::string>().WithMaxSize(1024))
    .WithSeeds([] {
      return std::vector<std::tuple<std::string>>{
          {"</assistant>"},
          {"</ASSISTANT>"},
          {std::string("\xE2\x82\xAC")},
          {""},
      };
    });

void MatchesAnyStopNeverCrashes(
    const std::string& recent,
    const std::vector<std::string>& antipromptsLower,
    const std::vector<std::string>& templateStops) {
  (void)matchesAnyStopString(recent, antipromptsLower, templateStops);
}

FUZZ_TEST(LlmStringFuzz, MatchesAnyStopNeverCrashes)
    .WithDomains(
        fuzztest::Arbitrary<std::string>().WithMaxSize(512),
        fuzztest::VectorOf(fuzztest::Arbitrary<std::string>().WithMaxSize(64))
            .WithMaxSize(8),
        fuzztest::VectorOf(fuzztest::Arbitrary<std::string>().WithMaxSize(64))
            .WithMaxSize(8))
    .WithSeeds([] {
      return std::vector<
          std::tuple<std::string, std::vector<std::string>, std::vector<std::string>>>{
          {"hello", {}, {}},
          {"say </assistant> now", {}, {"</assistant>"}},
          {"Hello WORLD", {"hello"}, {}},
          {"x", {""}, {""}},
          {"", {"stop"}, {"</s>"}},
      };
    });

TEST(LlmStringFuzzSeeds, ForLogMessageTruncatesAndStripsControls) {
  EXPECT_EQ(forLogMessage("get_weather"), "get_weather");
  EXPECT_EQ(forLogMessage(std::string("a\nb\tc")), "a?b?c");
  const std::string longName(K_MAX_LOG_ECHO + 8, 'x');
  const std::string out = forLogMessage(longName);
  EXPECT_EQ(out.size(), K_MAX_LOG_ECHO + 3);
  EXPECT_EQ(out.substr(out.size() - 3), "...");
}

TEST(LlmStringFuzzSeeds, EmptyStopEntriesNeverMatch) {
  EXPECT_FALSE(matchesAnyStopString("hello", {""}, {""}));
  EXPECT_TRUE(matchesAnyStopString("say </assistant>", {}, {"</assistant>"}));
}

} // namespace
