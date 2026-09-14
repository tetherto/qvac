#include <string>

#include <gtest/gtest.h>

#include "utils/LogSafeString.hpp"

using qvac_lib_inference_addon_llama::utils::forLogMessage;
using qvac_lib_inference_addon_llama::utils::K_MAX_LOG_ECHO;
using qvac_lib_inference_addon_llama::utils::toLowerAscii;

// `forLogMessage` guards every caller-supplied string echoed into an error
// message, which reaches JS and every log sink that records it. On the async
// job path the error *code* is dropped, so the message text is the whole
// signal — and both of this function's jobs regress invisibly.
TEST(ForLogMessageTest, PassesThroughShortPrintableInput) {
  EXPECT_EQ(forLogMessage("get_weather"), "get_weather");
}

TEST(ForLogMessageTest, ReplacesNonPrintableBytes) {
  EXPECT_EQ(forLogMessage(std::string("a\nb\tc")), "a?b?c");
  // Embedded NUL must not terminate the result early: the parameter is a
  // string_view carrying an explicit size.
  EXPECT_EQ(forLogMessage(std::string("a\0b", 3)), "a?b");
}

TEST(ForLogMessageTest, TruncatesAtTheEchoCapAndMarksIt) {
  const std::string longName(K_MAX_LOG_ECHO + 10, 'x');
  const std::string out = forLogMessage(longName);
  EXPECT_EQ(out.size(), K_MAX_LOG_ECHO + 3);
  EXPECT_EQ(out.substr(0, K_MAX_LOG_ECHO), std::string(K_MAX_LOG_ECHO, 'x'));
  EXPECT_EQ(out.substr(K_MAX_LOG_ECHO), "...");
}

TEST(ForLogMessageTest, ExactlyAtTheCapIsNotTruncated) {
  const std::string atCap(K_MAX_LOG_ECHO, 'x');
  EXPECT_EQ(forLogMessage(atCap), atCap);
}

// Multibyte input becomes '?' per byte, so an error message can never carry
// invalid UTF-8 across the JS boundary.
TEST(ForLogMessageTest, MultibyteBecomesPlaceholders) {
  EXPECT_EQ(forLogMessage(std::string("\xE2\x82\xAC")), "???");
}

TEST(ToLowerAsciiTest, FoldsAsciiLetters) {
  EXPECT_EQ(toLowerAscii("ASSISTANT:"), "assistant:");
  EXPECT_EQ(toLowerAscii("MiXeD_123"), "mixed_123");
  EXPECT_EQ(toLowerAscii(""), "");
}

// The counterpart to `forLogMessage`: stop-string matching is byte-wise, so
// non-ASCII bytes must pass through untouched. `std::tolower` would not
// guarantee this — under a non-"C" LC_CTYPE it can fold bytes >= 0x80 and
// corrupt the UTF-8 in a stop string.
TEST(ToLowerAsciiTest, LeavesNonAsciiBytesAlone) {
  // "café" and a euro sign, both valid UTF-8.
  EXPECT_EQ(toLowerAscii("caf\xC3\xA9"), "caf\xC3\xA9");
  EXPECT_EQ(toLowerAscii("\xE2\x82\xAC"), "\xE2\x82\xAC");
  // Mixed: the ASCII half folds, the multibyte half does not.
  EXPECT_EQ(toLowerAscii("CAF\xC3\x89"), "caf\xC3\x89");
}

// Every byte outside 'A'-'Z' is preserved exactly, including the ones adjacent
// to the letter range in ASCII, which an off-by-one fold would corrupt.
TEST(ToLowerAsciiTest, PreservesRangeBoundaries) {
  EXPECT_EQ(toLowerAscii("@AZ["), "@az[");
  EXPECT_EQ(toLowerAscii("`az{"), "`az{");
}
