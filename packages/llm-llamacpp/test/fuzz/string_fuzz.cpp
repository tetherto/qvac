#include <cstddef>
#include <string>
#include <string_view>
#include <tuple>
#include <vector>

#include <fuzztest/fuzztest.h>
#include <gtest/gtest.h>

#include "utils/LogSafeString.hpp"
#include "utils/StopStringMatch.hpp"

// Property tests over the header-only string sanitiser and stop matcher.
// Both take attacker-controlled text (prompts, template stops, antiprompts,
// error fragments). Same class of untrusted-input front door as the NMT
// weight-header parsers. See docs/architecture/ADDON-FUZZING.md.
//
// The properties check the contract, not only that the call returns. ASan
// still owns crashes and leaks. The ellipsis is appended only when the input
// is longer than maxLen; an untruncated value may itself end in "...", so the
// suffix alone is not the truncation signal.

namespace {

using qvac_lib_inference_addon_llama::utils::forLogMessage;
using qvac_lib_inference_addon_llama::utils::K_MAX_LOG_DIAGNOSTIC;
using qvac_lib_inference_addon_llama::utils::K_MAX_LOG_ECHO;
using qvac_lib_inference_addon_llama::utils::matchesAnyStopString;
using qvac_lib_inference_addon_llama::utils::toLowerAscii;

void ForLogMessageNeverCrashes(const std::string& value, size_t maxLen) {
  const std::string out = forLogMessage(value, maxLen);
  const bool truncated = value.size() > maxLen;
  const size_t kept = truncated ? maxLen : value.size();
  ASSERT_EQ(out.size(), kept + (truncated ? 3 : 0));
  for (size_t i = 0; i < kept; ++i) {
    const auto c = static_cast<unsigned char>(value[i]);
    const unsigned char expected =
        (c >= 0x20 && c < 0x7F) ? c : static_cast<unsigned char>('?');
    EXPECT_EQ(static_cast<unsigned char>(out[i]), expected);
  }
  if (truncated) {
    EXPECT_EQ(out.compare(kept, 3, "..."), 0);
  }
  for (const unsigned char c : out) {
    EXPECT_GE(c, 0x20);
    EXPECT_LT(c, 0x7F);
  }
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
  const std::string out = toLowerAscii(value);
  ASSERT_EQ(out.size(), value.size());
  for (size_t i = 0; i < value.size(); ++i) {
    const auto c = static_cast<unsigned char>(value[i]);
    const auto got = static_cast<unsigned char>(out[i]);
    if (c >= 'A' && c <= 'Z') {
      EXPECT_EQ(got, static_cast<unsigned char>(c - 'A' + 'a'));
    } else {
      EXPECT_EQ(got, c);
    }
    EXPECT_TRUE(got < 'A' || got > 'Z');
  }
  EXPECT_EQ(toLowerAscii(out), out);
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

// Independent of matchesAnyStopString: non-empty antiprompts are sought in the
// lowercased window as given (the caller lowercases them), and non-empty
// template stops are sought in the raw window. Empty entries match nothing,
// because find("") returns 0.
bool referenceMatchesAnyStop(
    std::string_view recent, const std::vector<std::string>& antipromptsLower,
    const std::vector<std::string>& templateStops) {
  const std::string recentLower = toLowerAscii(recent);
  for (const std::string& antiprompt : antipromptsLower) {
    if (!antiprompt.empty() &&
        recentLower.find(antiprompt) != std::string::npos) {
      return true;
    }
  }
  for (const std::string& stop : templateStops) {
    if (!stop.empty() && recent.find(stop) != std::string_view::npos) {
      return true;
    }
  }
  return false;
}

void MatchesAnyStopNeverCrashes(
    const std::string& recent, const std::vector<std::string>& antipromptsLower,
    const std::vector<std::string>& templateStops) {
  EXPECT_EQ(
      matchesAnyStopString(recent, antipromptsLower, templateStops),
      referenceMatchesAnyStop(recent, antipromptsLower, templateStops));
}

FUZZ_TEST(LlmStringFuzz, MatchesAnyStopNeverCrashes)
    .WithDomains(
        fuzztest::Arbitrary<std::string>().WithMaxSize(512),
        fuzztest::VectorOf(fuzztest::Arbitrary<std::string>().WithMaxSize(64))
            .WithMaxSize(8),
        fuzztest::VectorOf(fuzztest::Arbitrary<std::string>().WithMaxSize(64))
            .WithMaxSize(8))
    .WithSeeds([] {
      return std::vector<std::tuple<
          std::string,
          std::vector<std::string>,
          std::vector<std::string>>>{
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
