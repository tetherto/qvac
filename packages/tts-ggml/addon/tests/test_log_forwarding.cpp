// tts-cpp / ggml native-log forwarding (addon/GgmlLogForwarding.hpp).
//
// The test build does not define JS_LOGGER, so QLOG writes to std::cout; the
// helper captures it to assert what forwardGgmlLog emitted.

#include <iostream>
#include <sstream>
#include <string>

#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include "addon/GgmlLogForwarding.hpp"

using qvac::ttsggml::forwardGgmlLog;
using qvac::ttsggml::ggmlLevelToPriority;

namespace {

std::string captureForwarded(enum ggml_log_level level, const char* text) {
  std::ostringstream captured;
  std::streambuf* previous = std::cout.rdbuf(captured.rdbuf());
  forwardGgmlLog(level, text, nullptr);
  std::cout.rdbuf(previous);
  return captured.str();
}

} // namespace

TEST(TtsGgmlLogForwarding, MapsEachLevelToPriority) {
  namespace logp = qvac_lib_inference_addon_cpp::logger;
  EXPECT_EQ(ggmlLevelToPriority(GGML_LOG_LEVEL_ERROR), logp::Priority::ERROR);
  EXPECT_EQ(ggmlLevelToPriority(GGML_LOG_LEVEL_WARN), logp::Priority::WARNING);
  EXPECT_EQ(ggmlLevelToPriority(GGML_LOG_LEVEL_INFO), logp::Priority::INFO);
  EXPECT_EQ(ggmlLevelToPriority(GGML_LOG_LEVEL_DEBUG), logp::Priority::DEBUG);
  EXPECT_EQ(ggmlLevelToPriority(GGML_LOG_LEVEL_CONT), logp::Priority::INFO);
  EXPECT_EQ(ggmlLevelToPriority(GGML_LOG_LEVEL_NONE), logp::Priority::INFO);
}

TEST(TtsGgmlLogForwarding, NullEmptyAndNewlineOnlyAreNoOps) {
  EXPECT_TRUE(captureForwarded(GGML_LOG_LEVEL_INFO, nullptr).empty());
  EXPECT_TRUE(captureForwarded(GGML_LOG_LEVEL_INFO, "").empty());
  EXPECT_TRUE(captureForwarded(GGML_LOG_LEVEL_INFO, "\n").empty());
  EXPECT_TRUE(captureForwarded(GGML_LOG_LEVEL_ERROR, "\r\n").empty());
}

TEST(TtsGgmlLogForwarding, ForwardsAtMappedLevelAndTrimsNewline) {
  const std::string out = captureForwarded(
      GGML_LOG_LEVEL_WARN, "ggml_metal_init: using Apple GPU\n");
  EXPECT_THAT(out, testing::HasSubstr("ggml_metal_init: using Apple GPU"));
  EXPECT_THAT(out, testing::HasSubstr("WARNING"));
  EXPECT_THAT(out, testing::Not(testing::HasSubstr("GPU\n\n")));
}

TEST(TtsGgmlLogForwarding, MessageWithoutNewlineIsEmittedImmediately) {
  const std::string out =
      captureForwarded(GGML_LOG_LEVEL_ERROR, "backend init failed");
  EXPECT_THAT(out, testing::HasSubstr("backend init failed"));
  EXPECT_THAT(out, testing::HasSubstr("ERROR"));
}
