#include <atomic>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include <common/common.h>
#include <gtest/gtest.h>

#include "model-interface/utils.hpp"

namespace {
common_params paramsWith(int32_t nBatch, int32_t nCtx) {
  common_params params;
  params.n_batch = nBatch;
  params.n_ctx = nCtx;
  return params;
}
} // namespace

TEST(UnifiedSequenceLimitTest, LargeBatchAdmitsLlamaMaximum) {
  EXPECT_EQ(
      unifiedSequenceLimit(paramsWith(4096, 0)),
      static_cast<int32_t>(llama_max_parallel_sequences()));
}

TEST(UnifiedSequenceLimitTest, SmallBatchCapsTheLimit) {
  EXPECT_EQ(unifiedSequenceLimit(paramsWith(64, 2048)), 64);
}

TEST(UnifiedSequenceLimitTest, ShortContextCapsTheLimit) {
  EXPECT_EQ(unifiedSequenceLimit(paramsWith(1024, 128)), 128);
}

TEST(UnifiedSequenceLimitTest, NeverBelowOne) {
  EXPECT_EQ(unifiedSequenceLimit(paramsWith(0, 0)), 1);
}

TEST(SplitLinesTest, BasicSplit) {
  std::string input = "line1\nline2\nline3";
  std::vector<std::string> result = splitLines(input);

  ASSERT_EQ(result.size(), 3);
  EXPECT_EQ(result[0], "line1");
  EXPECT_EQ(result[1], "line2");
  EXPECT_EQ(result[2], "line3");
}

TEST(SplitLinesTest, EmptyString) {
  std::string input = "";
  std::vector<std::string> result = splitLines(input);

  ASSERT_EQ(result.size(), 1);
  EXPECT_EQ(result[0], "");
}

TEST(SplitLinesTest, NoSeparator) {
  std::string input = "singleline";
  std::vector<std::string> result = splitLines(input);

  ASSERT_EQ(result.size(), 1);
  EXPECT_EQ(result[0], "singleline");
}

TEST(SplitLinesTest, TrailingNewline) {
  std::string input = "line1\nline2\n";
  std::vector<std::string> result = splitLines(input);

  ASSERT_EQ(result.size(), 3);
  EXPECT_EQ(result[0], "line1");
  EXPECT_EQ(result[1], "line2");
  EXPECT_EQ(result[2], "");
}

TEST(SplitLinesTest, LeadingNewline) {
  std::string input = "\nline1\nline2";
  std::vector<std::string> result = splitLines(input);

  ASSERT_EQ(result.size(), 3);
  EXPECT_EQ(result[0], "");
  EXPECT_EQ(result[1], "line1");
  EXPECT_EQ(result[2], "line2");
}

TEST(SplitLinesTest, MultipleConsecutiveSeparators) {
  std::string input = "line1\n\n\nline2";
  std::vector<std::string> result = splitLines(input);

  ASSERT_EQ(result.size(), 4);
  EXPECT_EQ(result[0], "line1");
  EXPECT_EQ(result[1], "");
  EXPECT_EQ(result[2], "");
  EXPECT_EQ(result[3], "line2");
}

TEST(SplitLinesTest, CustomSeparator) {
  std::string input = "part1|part2|part3";
  std::vector<std::string> result = splitLines(input, "|");

  ASSERT_EQ(result.size(), 3);
  EXPECT_EQ(result[0], "part1");
  EXPECT_EQ(result[1], "part2");
  EXPECT_EQ(result[2], "part3");
}

TEST(SplitLinesTest, MultiCharSeparator) {
  std::string input = "a::b::c";
  std::vector<std::string> result = splitLines(input, "::");

  ASSERT_EQ(result.size(), 3);
  EXPECT_EQ(result[0], "a");
  EXPECT_EQ(result[1], "b");
  EXPECT_EQ(result[2], "c");
}

TEST(LazyCommonInitTest, MultipleCalls) {
  EXPECT_NO_THROW({
    lazyCommonInit();
    lazyCommonInit();
    lazyCommonInit();
  });
}

TEST(ExtractVerbosityConfigTest, BasicExtraction) {
  std::string config = "verbosity\t2\nother\tvalue";
  auto result = extractVerbosityConfig(config);

  ASSERT_EQ(result.size(), 1);
  EXPECT_EQ(result["verbosity"], "2");
  EXPECT_EQ(config, "other\tvalue");
}

TEST(ExtractVerbosityConfigTest, VerbosityAtStart) {
  std::string config = "verbosity\t3\nline1\nline2";
  auto result = extractVerbosityConfig(config);

  ASSERT_EQ(result.size(), 1);
  EXPECT_EQ(result["verbosity"], "3");
  EXPECT_EQ(config, "line1\nline2");
}

TEST(ExtractVerbosityConfigTest, VerbosityInMiddle) {
  std::string config = "line1\nverbosity\t1\nline2";
  auto result = extractVerbosityConfig(config);

  ASSERT_EQ(result.size(), 1);
  EXPECT_EQ(result["verbosity"], "1");
  EXPECT_EQ(config, "line1\nline2");
}

TEST(ExtractVerbosityConfigTest, VerbosityAtEnd) {
  std::string config = "line1\nline2\nverbosity\t0";
  auto result = extractVerbosityConfig(config);

  ASSERT_EQ(result.size(), 1);
  EXPECT_EQ(result["verbosity"], "0");
  EXPECT_EQ(config, "line1\nline2");
}

TEST(ExtractVerbosityConfigTest, VerbosityAtEndWithNewline) {
  std::string config = "line1\nline2\nverbosity\t2\n";
  auto result = extractVerbosityConfig(config);

  ASSERT_EQ(result.size(), 1);
  EXPECT_EQ(result["verbosity"], "2");
  EXPECT_EQ(config, "line1\nline2\n");
}

TEST(ExtractVerbosityConfigTest, VerbosityOnly) {
  std::string config = "verbosity\t3";
  auto result = extractVerbosityConfig(config);

  ASSERT_EQ(result.size(), 1);
  EXPECT_EQ(result["verbosity"], "3");
  EXPECT_EQ(config, "");
}

TEST(ExtractVerbosityConfigTest, VerbosityOnlyWithNewline) {
  std::string config = "verbosity\t1\n";
  auto result = extractVerbosityConfig(config);

  ASSERT_EQ(result.size(), 1);
  EXPECT_EQ(result["verbosity"], "1");
  EXPECT_EQ(config, "");
}

TEST(ExtractVerbosityConfigTest, MissingVerbosity) {
  std::string config = "other\tvalue\nanother\tline";
  auto result = extractVerbosityConfig(config);

  EXPECT_TRUE(result.empty());
  EXPECT_EQ(config, "other\tvalue\nanother\tline");
}

TEST(ExtractVerbosityConfigTest, EmptyConfig) {
  std::string config = "";
  auto result = extractVerbosityConfig(config);

  EXPECT_TRUE(result.empty());
  EXPECT_EQ(config, "");
}

TEST(ExtractVerbosityConfigTest, VerbosityWithPrecedingNewline) {
  std::string config = "line1\n\nverbosity\t2\nline2";
  auto result = extractVerbosityConfig(config);

  ASSERT_EQ(result.size(), 1);
  EXPECT_EQ(result["verbosity"], "2");
  EXPECT_EQ(config, "line1\n\nline2");
}

TEST(ExtractVerbosityConfigTest, InvalidVerbosityNonNumeric) {
  std::string config = "verbosity\tinvalid\nline1";
  auto result = extractVerbosityConfig(config);

  EXPECT_TRUE(result.empty());
  EXPECT_EQ(config, "verbosity\tinvalid\nline1");
}

TEST(ExtractVerbosityConfigTest, VerbosityWithNoValue) {
  std::string config = "verbosity\t\nline1";
  auto result = extractVerbosityConfig(config);

  EXPECT_TRUE(result.empty());
  EXPECT_EQ(config, "verbosity\t\nline1");
}

TEST(ExtractVerbosityConfigTest, VerbosityWithMultiDigitValue) {
  std::string config = "verbosity\t123\nline1";
  auto result = extractVerbosityConfig(config);

  ASSERT_EQ(result.size(), 1);
  EXPECT_EQ(result["verbosity"], "123");
  EXPECT_EQ(config, "line1");
}

TEST(ExtractVerbosityConfigTest, VerbosityWithTrailingText) {
  std::string config = "verbosity\t2extra\nline1";
  auto result = extractVerbosityConfig(config);

  ASSERT_EQ(result.size(), 1);
  EXPECT_EQ(result["verbosity"], "2");
  EXPECT_EQ(config, "extra\nline1");
}

TEST(DeprecatedLoadFlagModeTest, MapsEachFlagAndPolarity) {
  EXPECT_EQ(deprecatedLoadFlagMode("mmap", ""), LLAMA_LOAD_MODE_MMAP);
  EXPECT_EQ(deprecatedLoadFlagMode("mmap", "off"), LLAMA_LOAD_MODE_NONE);
  EXPECT_EQ(deprecatedLoadFlagMode("no-mmap", ""), LLAMA_LOAD_MODE_NONE);
  EXPECT_EQ(deprecatedLoadFlagMode("no-mmap", "false"), LLAMA_LOAD_MODE_MMAP);
  EXPECT_EQ(
      deprecatedLoadFlagMode("direct-io", "on"), LLAMA_LOAD_MODE_DIRECT_IO);
  EXPECT_EQ(deprecatedLoadFlagMode("no-direct-io", ""), LLAMA_LOAD_MODE_NONE);
  EXPECT_EQ(deprecatedLoadFlagMode("mlock", "1"), LLAMA_LOAD_MODE_MLOCK);
  EXPECT_EQ(deprecatedLoadFlagMode("load-mode", "mmap"), std::nullopt);
}

TEST(DeprecatedLoadFlagModeTest, RejectsValuesTheFlagDoesNotTake) {
  EXPECT_THROW(
      static_cast<void>(deprecatedLoadFlagMode("mmap", "maybe")),
      std::invalid_argument);
  // mlock is valueless in llama, so it cannot be turned off.
  EXPECT_THROW(
      static_cast<void>(deprecatedLoadFlagMode("mlock", "off")),
      std::invalid_argument);
}

TEST(LoadModeNameTest, NamesMatchLoadModeValues) {
  EXPECT_STREQ(loadModeName(LLAMA_LOAD_MODE_AUTO), "auto");
  EXPECT_STREQ(loadModeName(LLAMA_LOAD_MODE_NONE), "none");
  EXPECT_STREQ(loadModeName(LLAMA_LOAD_MODE_MMAP), "mmap");
  EXPECT_STREQ(loadModeName(LLAMA_LOAD_MODE_MLOCK), "mlock");
  EXPECT_STREQ(loadModeName(LLAMA_LOAD_MODE_MMAP_MLOCK), "mmap+mlock");
  EXPECT_STREQ(loadModeName(LLAMA_LOAD_MODE_DIRECT_IO), "dio");
}

namespace {
template <typename Flag>
constexpr bool kAbortAcceptsFlag = requires(llama_context* ctx, Flag&& flag) {
  abortDecodeWhen(ctx, std::forward<Flag>(flag));
};
} // namespace

// The abort callback keeps the flag's address, so a temporary flag would
// dangle once the call returns.
TEST(UtilsTest, AbortDecodeWhenRejectsATemporaryFlag) {
  static_assert(kAbortAcceptsFlag<std::atomic<bool>&>);
  static_assert(kAbortAcceptsFlag<const std::atomic<bool>&>);
  static_assert(!kAbortAcceptsFlag<std::atomic<bool>>);
  SUCCEED();
}
