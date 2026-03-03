#pragma once

#include <string>

namespace test_common {

inline const char* getTestDevice() {
#if defined(__APPLE__) && defined(__x86_64__)
  return "cpu";
#else
  return "gpu";
#endif
}

inline const char* getTestThreads() {
#if defined(__APPLE__) && defined(__x86_64__)
  return "4";
#else
  return "-1";
#endif
}

} // namespace test_common
