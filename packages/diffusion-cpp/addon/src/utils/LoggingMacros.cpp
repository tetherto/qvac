#include "LoggingMacros.hpp"

using namespace qvac_lib_inference_addon_cpp::logger;

namespace qvac_lib_inference_addon_sd::logging {

// Default to ERROR to prevent log spam before verbosity is configured
// NOLINTNEXTLINE(cppcoreguidelines-avoid-non-const-global-variables)
Priority g_verbosityLevel = Priority::ERROR;

void setVerbosityLevel(
    std::unordered_map<std::string, std::string>& configMap) {
  auto verbosityIt = configMap.find("verbosity");
  if (verbosityIt == configMap.end()) {
    return;
  }

  try {
    const int level = std::stoi(verbosityIt->second);
    switch (level) {
    case 0:
      g_verbosityLevel = Priority::ERROR;
      break;
    case 1:
      g_verbosityLevel = Priority::WARNING;
      break;
    case 2:
      g_verbosityLevel = Priority::INFO;
      break;
    case 3:
    default:
      g_verbosityLevel = Priority::DEBUG;
      break;
    }
  } catch (...) {
    g_verbosityLevel = Priority::ERROR;
  }

  configMap.erase(verbosityIt);
}

} // namespace qvac_lib_inference_addon_sd::logging
