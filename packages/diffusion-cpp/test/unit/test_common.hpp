#pragma once

#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <string>
#include <vector>

namespace sd_test_helpers {

inline std::string getTestDevice() {
  if (std::getenv("SD_CPU_ONLY"))
    return "cpu";
#if defined(__APPLE__)
  return "gpu"; // Metal
#else
  return "cpu";
#endif
}

inline int getTestThreads() { return 4; }

// Returns the absolute path to the SD2.1 Q8_0 model file.
// Checks SD_TEST_MODEL_PATH env first, then the default location used by the
// JS integration test runner (test/model/ relative to the package root, which
// is CMAKE_SOURCE_DIR and the ctest WORKING_DIRECTORY).
// Returns an empty string when no model is found so callers can GTEST_SKIP().
inline std::string getModelPath() {
  if (const char* p = std::getenv("SD_TEST_MODEL_PATH")) {
    if (std::filesystem::exists(p))
      return p;
  }

#ifdef PROJECT_ROOT
  const std::string root = PROJECT_ROOT;
#else
  const std::string root = ".";
#endif

  const std::string candidates[] = {
      root + "/test/model/stable-diffusion-v2-1-Q8_0.gguf",
      root + "/models/stable-diffusion-v2-1-Q8_0.gguf",
  };
  for (const auto& path : candidates) {
    if (std::filesystem::exists(path))
      return path;
  }
  return {};
}

inline bool isPng(const std::vector<uint8_t>& buf) {
  if (buf.size() < 8)
    return false;
  return buf[0] == 0x89 && buf[1] == 0x50 && buf[2] == 0x4E && buf[3] == 0x47 &&
         buf[4] == 0x0D && buf[5] == 0x0A && buf[6] == 0x1A && buf[7] == 0x0A;
}

} // namespace sd_test_helpers
