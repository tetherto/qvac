#pragma once

#include <string>
#include <variant>

#include <inference-addon-cpp/RuntimeStats.hpp>

namespace test_common {

inline const char* getTestDevice() {
#if defined(__APPLE__) && defined(__x86_64__)
  return "cpu";
#else
  return "gpu";
#endif
}

inline const char* getTestGpuLayers() {
#if defined(__APPLE__) && defined(__x86_64__)
  return "0";
#else
  return "99";
#endif
}

inline std::string getStatString(
    const qvac_lib_inference_addon_cpp::RuntimeStats& stats,
    const std::string& key) {
  for (const auto& [statKey, value] : stats) {
    if (statKey == key) {
      const auto* text = std::get_if<std::string>(&value);
      return text != nullptr ? *text : std::string();
    }
  }
  return {};
}

} // namespace test_common
