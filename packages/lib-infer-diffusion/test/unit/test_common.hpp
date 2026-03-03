#pragma once

#include <string>

namespace sd_test_helpers {

inline std::string getTestDevice() {
#if defined(__APPLE__)
  return "gpu";  // Metal
#else
  return "cpu";
#endif
}

inline int getTestThreads() {
  return 4;
}

}  // namespace sd_test_helpers
