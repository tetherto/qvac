#include "BackendSelection.hpp"

#include <algorithm>
#include <cctype>
#include <string>

#include <ggml-backend.h>
#include <qvac-lib-inference-addon-cpp/Errors.hpp>

#include "LoggingMacros.hpp"

using namespace qvac_errors;

namespace {

// Extract the Adreno model number from a device description string.
// Returns 0 if the device is not an Adreno GPU.
// Example: "Adreno (TM) 830" -> 830, "Adreno (TM) 740" -> 740
int parseAdrenoModel(const std::string& description) {
  std::string lower = description;
  std::transform(
      lower.begin(), lower.end(), lower.begin(), [](unsigned char c) {
        return std::tolower(c);
      });

  auto pos = lower.find("adreno");
  if (pos == std::string::npos)
    return 0;

  // Scan forward from "adreno" to find the first digit sequence
  for (size_t i = pos + 6; i < lower.size(); ++i) {
    if (std::isdigit(static_cast<unsigned char>(lower[i]))) {
      return std::stoi(lower.substr(i));
    }
  }
  return 0;
}

} // namespace

namespace sd_backend_selection {

BackendDevice preferredDeviceFromMap(
    const std::unordered_map<std::string, std::string>& configMap) {
  auto it = configMap.find("device");
  if (it == configMap.end()) {
    return BackendDevice::GPU; // default: prefer GPU
  }

  const std::string& device = it->second;
  if (device == "gpu")
    return BackendDevice::GPU;
  if (device == "cpu")
    return BackendDevice::CPU;

  throw StatusError(
      general_error::InvalidArgument,
      "Invalid device value '" + device + "'. Must be 'gpu' or 'cpu'.");
}

int threadsFromMap(
    const std::unordered_map<std::string, std::string>& configMap) {
  auto it = configMap.find("threads");
  if (it == configMap.end())
    return -1; // auto
  try {
    return std::stoi(it->second);
  } catch (...) {
    return -1;
  }
}

BackendDevice resolveBackendForDevice(BackendDevice preferred) {
  using Priority = qvac_lib_inference_addon_cpp::logger::Priority;

  if (preferred == BackendDevice::CPU) {
    QLOG_IF(Priority::INFO, "Backend selection: user requested CPU");
    return BackendDevice::CPU;
  }

  const size_t nDevices = ggml_backend_dev_count();
  QLOG_IF(
      Priority::INFO,
      "Backend selection: " + std::to_string(nDevices) + " device(s)");

  for (size_t i = 0; i < nDevices; ++i) {
    ggml_backend_dev_t dev = ggml_backend_dev_get(i);
    enum ggml_backend_dev_type devType = ggml_backend_dev_type(dev);
    if (devType != GGML_BACKEND_DEVICE_TYPE_GPU &&
        devType != GGML_BACKEND_DEVICE_TYPE_IGPU)
      continue;

    const char* desc = ggml_backend_dev_description(dev);
    const char* name = ggml_backend_dev_name(dev);
    QLOG_IF(
        Priority::INFO,
        std::string("Backend selection: GPU device '") + desc +
            "' (backend: " + name + ")");

    int model = parseAdrenoModel(desc);
    if (model > 0) {
      QLOG_IF(
          Priority::INFO,
          "Backend selection: Adreno model " + std::to_string(model));
    }

    if (model >= 800) {
      QLOG_IF(Priority::INFO, "Backend selection: Adreno 800+ -> GPU (OpenCL)");
      return BackendDevice::GPU;
    }
    if (model >= 600) {
      QLOG_IF(Priority::INFO, "Backend selection: Adreno 600/700 -> CPU");
      return BackendDevice::CPU;
    }
  }

  QLOG_IF(Priority::INFO, "Backend selection: non-Adreno -> GPU (Vulkan)");
  return BackendDevice::GPU;
}

} // namespace sd_backend_selection
