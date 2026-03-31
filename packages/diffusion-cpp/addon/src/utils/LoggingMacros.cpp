#include "LoggingMacros.hpp"

using namespace qvac_lib_inference_addon_cpp::logger;

namespace qvac_lib_inference_addon_sd {
namespace logging {

// Default to ERROR to prevent log spam before verbosity is configured
Priority g_verbosityLevel = Priority::ERROR;

void setVerbosityLevel(
    std::unordered_map<std::string, std::string>& configMap) {
  auto it = configMap.find("verbosity");
  if (it == configMap.end())
    return;

  try {
    const int v = std::stoi(it->second);
    switch (v) {
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

  configMap.erase(it);
}

} // namespace logging
} // namespace qvac_lib_inference_addon_sd
