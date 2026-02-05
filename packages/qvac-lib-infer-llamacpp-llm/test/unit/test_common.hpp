#pragma once

#include <string>

namespace test_common {

/**
 * Get the appropriate device string for the current platform.
 * Uses CPU on Darwin x64 (Intel Mac) to avoid GPU initialization issues.
 * GPU backend initialization can hang on Intel Macs.
 *
 * @return "cpu" on Darwin x64, "gpu" otherwise
 */
inline const char* getTestDevice() {
#if defined(__APPLE__) && defined(__x86_64__)
  return "cpu";
#else
  return "gpu";
#endif
}

/**
 * Get the appropriate gpu_layers value for the current platform.
 * Uses 0 on Darwin x64 (Intel Mac) when using CPU to avoid GPU-related issues.
 *
 * @return "0" on Darwin x64, "99" otherwise
 */
inline const char* getTestGpuLayers() {
#if defined(__APPLE__) && defined(__x86_64__)
  return "0";
#else
  return "99";
#endif
}

} // namespace test_common
