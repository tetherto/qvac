#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iterator>

#include <gtest/gtest.h>

#include "addon/NativeStderrDiagnostics.hpp"

#ifndef _WIN32
TEST(NativeStderrDiagnostics, UnsetPathDoesNotRedirect) {
  EXPECT_NO_THROW(qvac::ttsggml::captureNativeStderr(nullptr));
  EXPECT_NO_THROW(qvac::ttsggml::captureNativeStderr(""));
}

TEST(NativeStderrDiagnostics, UnwritablePathReportsAnError) {
  EXPECT_THROW(
      qvac::ttsggml::captureNativeStderr("/dev/null/native-stderr.log"),
      std::runtime_error);
}

TEST(NativeStderrDiagnostics, CapturesNativeErrorImmediately) {
  auto log =
      (std::filesystem::temp_directory_path() / "tts-stderr-XXXXXX").string();
  const int fd = mkstemp(log.data());
  ASSERT_GE(fd, 0);
  close(fd);
  ASSERT_EXIT(
      {
        qvac::ttsggml::captureNativeStderr(log.c_str());
        std::fprintf(stderr, "scheduler fallback impossible\n");
        _exit(0);
      },
      ::testing::ExitedWithCode(0), "");
  std::ifstream input(log);
  const std::string output((std::istreambuf_iterator<char>(input)), {});
  EXPECT_EQ(output, "scheduler fallback impossible\n");
  std::filesystem::remove(log);
}
#endif
