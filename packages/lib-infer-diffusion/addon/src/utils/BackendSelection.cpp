#include "BackendSelection.hpp"

#include <qvac-lib-inference-addon-cpp/Errors.hpp>

using namespace qvac_errors;

namespace sd_backend_selection {

BackendDevice preferredDeviceFromMap(
    const std::unordered_map<std::string, std::string>& configMap) {
  auto it = configMap.find("device");
  if (it == configMap.end()) {
    return BackendDevice::GPU; // default: prefer GPU
  }

  const std::string& device = it->second;
  if (device == "gpu") return BackendDevice::GPU;
  if (device == "cpu") return BackendDevice::CPU;

  throw StatusError(
      general_error::InvalidArgument,
      "Invalid device value '" + device + "'. Must be 'gpu' or 'cpu'.");
}

int threadsFromMap(
    const std::unordered_map<std::string, std::string>& configMap) {
  auto it = configMap.find("threads");
  if (it == configMap.end()) return -1; // auto
  try {
    return std::stoi(it->second);
  } catch (...) {
    return -1;
  }
}

} // namespace sd_backend_selection
