#include "LoggingMacros.hpp"

#include "common/common.h"

using namespace qvac_lib_inference_addon_cpp::logger;

namespace qvac_lib_inference_addon_llama {
namespace logging {
// Global verbosity level - initialized to ERROR as safe default
// This ensures that if llamaLogCallback is triggered before verbosity is set,
// only ERROR messages will be shown, preventing log spam
Priority g_verbosityLevel = Priority::ERROR;

void setVerbosityLevel(
    std::unordered_map<std::string, std::string>& configFilemap) {
  // Parse verbosity level from config and set it globally
  // This must be called before initializeBackend() to ensure llamaLogCallback
  // has the correct verbosity level from the start
  if (auto it = configFilemap.find("verbosity"); it != configFilemap.end()) {
    try {
      int verbosity = std::stoi(it->second);
      if (verbosity < 0 || verbosity > 3) {
        QLOG_IF(
            Priority::ERROR,
            string_format(
                "Invalid verbosity value '%s', using default ERROR level",
                it->second.c_str()));
        g_verbosityLevel = Priority::ERROR;
        return;
      }
      Priority level;
      switch (verbosity) {
      case 0:
        level = Priority::ERROR;
        break;
      case 1:
        level = Priority::WARNING;
        break;
      case 2:
        level = Priority::INFO;
        break;
      case 3:
      default:
        level = Priority::DEBUG;
        break;
      }
      g_verbosityLevel = level;
    } catch (const std::exception& e) {
      // Use default ERROR level if parsing fails
      g_verbosityLevel = Priority::ERROR;
      QLOG_IF(
          Priority::ERROR,
          string_format(
              "Invalid verbosity value '%s', using default ERROR level",
              it->second.c_str()));
    }
    configFilemap.erase(it);
  }
}
} // namespace logging
} // namespace qvac_lib_inference_addon_llama
