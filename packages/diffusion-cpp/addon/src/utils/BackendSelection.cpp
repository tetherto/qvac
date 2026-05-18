#include "BackendSelection.hpp"

#include <algorithm>
#include <cctype>
#include <string>

#include <ggml-backend.h>
#include <inference-addon-cpp/Errors.hpp>

#include "LoggingMacros.hpp"

using namespace qvac_errors;

namespace {

constexpr int K_ADRENO_PREFIX_LENGTH = 6;
constexpr int K_ADRENO_OPEN_CL_MIN_MODEL = 800;
constexpr int K_ADRENO_CPU_FALLBACK_MIN_MODEL = 600;

unsigned char toLowerAscii(unsigned char character) {
  return static_cast<unsigned char>(std::tolower(character));
}

// Extract the Adreno model number from a device description string.
// Returns 0 if the device is not an Adreno GPU.
// Example: "Adreno (TM) 830" -> 830, "Adreno (TM) 740" -> 740
int parseAdrenoModel(const std::string& description) {
  std::string lower = description;
  // NOLINTNEXTLINE(modernize-use-ranges)
  std::transform(lower.begin(), lower.end(), lower.begin(), toLowerAscii);

  const auto pos = lower.find("adreno");
  if (pos == std::string::npos) {
    return 0;
  }

  // Scan forward from "adreno" to find the first digit sequence
  for (size_t idx = pos + K_ADRENO_PREFIX_LENGTH; idx < lower.size(); ++idx) {
    if (std::isdigit(static_cast<unsigned char>(lower[idx])) != 0) {
      return std::stoi(lower.substr(idx));
    }
  }
  return 0;
}

std::string toLowerCopy(std::string str) {
  // NOLINTNEXTLINE(modernize-use-ranges)
  std::transform(str.begin(), str.end(), str.begin(), toLowerAscii);
  return str;
}

} // namespace

namespace sd_backend_selection {

BackendDevice preferredDeviceFromMap(
    const std::unordered_map<std::string, std::string>& configMap) {
  const auto deviceEntry = configMap.find("device");
  if (deviceEntry == configMap.end()) {
    return BackendDevice::GPU; // default: prefer GPU
  }

  const std::string& device = deviceEntry->second;
  if (device == "gpu") {
    return BackendDevice::GPU;
  }
  if (device == "cpu") {
    return BackendDevice::CPU;
  }

  throw StatusError(
      general_error::InvalidArgument,
      "Invalid device value '" + device + "'. Must be 'gpu' or 'cpu'.");
}

int threadsFromMap(
    const std::unordered_map<std::string, std::string>& configMap) {
  const auto threadsEntry = configMap.find("threads");
  if (threadsEntry == configMap.end()) {
    return -1; // auto
  }
  try {
    return std::stoi(threadsEntry->second);
  } catch (...) {
    return -1;
  }
}

// NOLINTNEXTLINE(readability-function-cognitive-complexity)
BackendDevice resolveBackendForDevice(BackendDevice preferred) {
  using Priority = qvac_lib_inference_addon_cpp::logger::Priority;

  if (preferred == BackendDevice::CPU) {
    // NOLINTNEXTLINE(cppcoreguidelines-avoid-do-while)
    QLOG_IF(Priority::INFO, "Backend selection: user requested CPU");
    return BackendDevice::CPU;
  }

  const size_t nDevices = ggml_backend_dev_count();
  // NOLINTNEXTLINE(cppcoreguidelines-avoid-do-while)
  QLOG_IF(
      Priority::INFO,
      "Backend selection: " + std::to_string(nDevices) + " device(s)");

  for (size_t i = 0; i < nDevices; ++i) {
    ggml_backend_dev_t dev = ggml_backend_dev_get(i);
    enum ggml_backend_dev_type devType = ggml_backend_dev_type(dev);
    if (devType != GGML_BACKEND_DEVICE_TYPE_GPU &&
        devType != GGML_BACKEND_DEVICE_TYPE_IGPU) {
      continue;
    }

    const char* desc = ggml_backend_dev_description(dev);
    const char* name = ggml_backend_dev_name(dev);
    // NOLINTNEXTLINE(cppcoreguidelines-avoid-do-while)
    QLOG_IF(
        Priority::INFO,
        std::string("Backend selection: GPU device '") + desc +
            "' (backend: " + name + ")");

    const int model = parseAdrenoModel(desc);
    if (model > 0) {
      // NOLINTNEXTLINE(cppcoreguidelines-avoid-do-while)
      QLOG_IF(
          Priority::INFO,
          "Backend selection: Adreno model " + std::to_string(model));
    }

    if (model >= K_ADRENO_OPEN_CL_MIN_MODEL) {
      // NOLINTNEXTLINE(cppcoreguidelines-avoid-do-while)
      QLOG_IF(Priority::INFO, "Backend selection: Adreno 800+ -> GPU (OpenCL)");
      return BackendDevice::GPU;
    }
    if (model >= K_ADRENO_CPU_FALLBACK_MIN_MODEL) {
      // NOLINTNEXTLINE(cppcoreguidelines-avoid-do-while)
      QLOG_IF(Priority::INFO, "Backend selection: Adreno 600/700 -> CPU");
      return BackendDevice::CPU;
    }
  }

  // NOLINTNEXTLINE(cppcoreguidelines-avoid-do-while)
  QLOG_IF(Priority::INFO, "Backend selection: non-Adreno -> GPU (Vulkan)");
  return BackendDevice::GPU;
}

bool shouldPreferOpenClForAdreno(BackendDevice preferred) {
  using Priority = qvac_lib_inference_addon_cpp::logger::Priority;

  if (preferred == BackendDevice::CPU) {
    return false;
  }

  const size_t nDevices = ggml_backend_dev_count();
  bool hasAdreno800Plus = false;
  bool hasOpenClGpu = false;

  for (size_t i = 0; i < nDevices; ++i) {
    ggml_backend_dev_t dev = ggml_backend_dev_get(i);
    enum ggml_backend_dev_type devType = ggml_backend_dev_type(dev);
    if (devType != GGML_BACKEND_DEVICE_TYPE_GPU &&
        devType != GGML_BACKEND_DEVICE_TYPE_IGPU) {
      continue;
    }

    const char* descPtr = ggml_backend_dev_description(dev);
    const std::string desc = descPtr != nullptr ? descPtr : "";
    const char* namePtr = ggml_backend_dev_name(dev);
    const std::string backendName = namePtr != nullptr ? namePtr : "";

    const int model = parseAdrenoModel(desc);
    if (model >= K_ADRENO_OPEN_CL_MIN_MODEL) {
      hasAdreno800Plus = true;
    }

    if (toLowerCopy(backendName).find("opencl") != std::string::npos) {
      hasOpenClGpu = true;
    }
  }

  const bool preferOpenCl = hasAdreno800Plus && hasOpenClGpu;
  if (preferOpenCl) {
    // NOLINTNEXTLINE(cppcoreguidelines-avoid-do-while)
    QLOG_IF(
        Priority::INFO,
        "Backend selection: Adreno 800+ with OpenCL backend available -> "
        "prefer OpenCL");
  }
  return preferOpenCl;
}

sd_backend_preference_t
preferredGpuBackendForConfigDevice(const std::string& device) {
  if (device == "cpu") {
    return SD_BACKEND_PREF_CPU;
  }
  if (device == "auto") {
    return SD_BACKEND_PREF_AUTO;
  }

  const BackendDevice preferred = BackendDevice::GPU;
  const BackendDevice effective = resolveBackendForDevice(preferred);
  if (effective == BackendDevice::CPU) {
    return SD_BACKEND_PREF_CPU;
  }
  if (shouldPreferOpenClForAdreno(preferred)) {
    return SD_BACKEND_PREF_OPENCL;
  }
  return SD_BACKEND_PREF_GPU;
}

} // namespace sd_backend_selection
