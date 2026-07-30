#include "BackendSelection.hpp"

#include <algorithm>
#include <cctype>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include <ggml-backend.h>
#include <inference-addon-cpp/Errors.hpp>

#include "LoggingMacros.hpp"

using namespace qvac_errors;

namespace {

constexpr std::string_view K_ADRENO_TOKEN = "adreno";
constexpr int K_ADRENO_GPU_MIN_MODEL = 600;

unsigned char toLowerAscii(unsigned char character) {
  return static_cast<unsigned char>(std::tolower(character));
}

// Extract the Adreno model number from a device description string.
// Returns 0 if the device is not an Adreno GPU.
// Example: "Adreno (TM) 830" -> 830, "Adreno (TM) 740" -> 740
int parseAdrenoModel(const std::string& description) {
  std::string lower = description;
  std::transform(lower.begin(), lower.end(), lower.begin(), toLowerAscii);

  const auto pos = lower.find(K_ADRENO_TOKEN);
  if (pos == std::string::npos) {
    return 0;
  }

  // Scan forward from "adreno" to find the first digit sequence
  for (size_t idx = pos + K_ADRENO_TOKEN.size(); idx < lower.size(); ++idx) {
    if (std::isdigit(static_cast<unsigned char>(lower[idx])) != 0) {
      return std::stoi(lower.substr(idx));
    }
  }
  return 0;
}

std::string toLowerCopy(std::string str) {
  std::transform(str.begin(), str.end(), str.begin(), toLowerAscii);
  return str;
}

bool containsOpenClToken(const std::string& value) {
  return toLowerCopy(value).find("opencl") != std::string::npos;
}

bool isOpenClAdrenoDevice(
    const std::string& backendName, const std::string& description) {
  return containsOpenClToken(backendName) &&
         (parseAdrenoModel(description) > 0 ||
          parseAdrenoModel(backendName) > 0);
}

sd_backend_selection::GpuClass
normalizedGpuClass(const sd_backend_selection::GpuCandidate& dev) {
  // Qualcomm's OpenCL backend reports Adreno as a generic GPU, while Vulkan
  // reports the same integrated hardware as IGPU. Keep main-gpu semantics tied
  // to the physical device class instead of ggml's backend-specific label.
  if (dev.cls == sd_backend_selection::GpuClass::Dedicated &&
      isOpenClAdrenoDevice(dev.name, dev.description)) {
    return sd_backend_selection::GpuClass::Integrated;
  }
  return dev.cls;
}

int parseAdrenoModelFromGpuDevice(ggml_backend_dev_t dev) {
  if (dev == nullptr) {
    return 0;
  }
  const char* descPtr = ggml_backend_dev_description(dev);
  const std::string desc = descPtr != nullptr ? descPtr : "";
  int model = parseAdrenoModel(desc);
  if (model > 0) {
    return model;
  }
  const char* namePtr = ggml_backend_dev_name(dev);
  const std::string name = namePtr != nullptr ? namePtr : "";
  return parseAdrenoModel(name);
}

} // namespace

namespace sd_backend_selection {

namespace {

[[noreturn]] void throwInvalidConfigDevice(const std::string& device) {
  throw StatusError(
      general_error::InvalidArgument,
      "device must be 'cpu' or 'gpu', got: '" + device + "'");
}

} // namespace

ConfigDevice parseConfigDeviceString(const std::string& device) {
  if (device == "cpu") {
    return ConfigDevice::Cpu;
  }
  if (device == "gpu") {
    return ConfigDevice::Gpu;
  }
  throwInvalidConfigDevice(device);
}

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

std::optional<MainGpuSpec> parseMainGpu(const std::string& spec) {
  if (spec.empty()) {
    return std::nullopt;
  }
  // A bare non-negative integer is a device index.
  try {
    size_t consumed = 0;
    const int index = std::stoi(spec, &consumed);
    if (consumed == spec.size()) {
      if (index < 0) {
        throw StatusError(
            general_error::InvalidArgument,
            "main-gpu device index must be >= 0, got: '" + spec + "'");
      }
      return MainGpuSpec{MainGpuKind::Index, index};
    }
  } catch (const std::invalid_argument&) {
    // Not a number; fall through to the symbolic forms.
  } catch (const std::out_of_range&) {
    throw StatusError(
        general_error::InvalidArgument,
        "main-gpu device index out of range, got: '" + spec + "'");
  }

  const std::string lower = toLowerCopy(spec);
  if (lower == "integrated") {
    return MainGpuSpec{MainGpuKind::Integrated, -1};
  }
  if (lower == "dedicated") {
    return MainGpuSpec{MainGpuKind::Dedicated, -1};
  }
  throw StatusError(
      general_error::InvalidArgument,
      "main-gpu must be a device index, 'integrated', or 'dedicated', got: '" +
          spec + "'");
}

std::optional<std::string>
mainGpuFromMap(const std::unordered_map<std::string, std::string>& configMap) {
  const auto hyphen = configMap.find("main-gpu");
  const auto underscore = configMap.find("main_gpu");
  if (hyphen != configMap.end() && underscore != configMap.end()) {
    throw StatusError(
        general_error::InvalidArgument,
        "both 'main-gpu' and 'main_gpu' are present; use one or the other.");
  }
  const auto entry = (hyphen != configMap.end()) ? hyphen : underscore;
  if (entry == configMap.end()) {
    return std::nullopt;
  }
  return entry->second;
}

std::optional<std::string> selectMainGpuName(
    const std::vector<GpuCandidate>& devices, const MainGpuSpec& spec) {
  auto nonEmpty = [](const std::string& name) -> std::optional<std::string> {
    if (name.empty()) {
      return std::nullopt;
    }
    return name;
  };

  if (spec.kind == MainGpuKind::Index) {
    if (spec.index < 0) {
      return std::nullopt;
    }

    int gpuIndex = 0;
    for (const auto& dev : devices) {
      if (normalizedGpuClass(dev) == GpuClass::Other) {
        continue;
      }
      if (gpuIndex == spec.index) {
        return nonEmpty(dev.name);
      }
      ++gpuIndex;
    }
    return std::nullopt;
  }

  const GpuClass wanted = spec.kind == MainGpuKind::Integrated
                              ? GpuClass::Integrated
                              : GpuClass::Dedicated;

  // Pick the matching-class device with the most VRAM; first wins on ties
  // (for integrated, VRAM is shared so the tie path is the common one).
  const GpuCandidate* best = nullptr;
  for (const auto& dev : devices) {
    if (normalizedGpuClass(dev) != wanted) {
      continue;
    }
    if (best == nullptr || dev.totalVram > best->totalVram) {
      best = &dev;
    }
  }

  return best == nullptr ? std::nullopt : nonEmpty(best->name);
}

std::optional<std::string> resolveMainGpuBackendName(const MainGpuSpec& spec) {
  using Priority = qvac_lib_inference_addon_cpp::logger::Priority;

  const size_t nDevices = ggml_backend_dev_count();
  std::vector<GpuCandidate> devices;
  devices.reserve(nDevices);
  for (size_t i = 0; i < nDevices; ++i) {
    ggml_backend_dev_t dev = ggml_backend_dev_get(i);
    const char* name = ggml_backend_dev_name(dev);
    const char* description = ggml_backend_dev_description(dev);
    size_t freeBytes = 0;
    size_t totalBytes = 0;
    ggml_backend_dev_memory(dev, &freeBytes, &totalBytes);
    GpuClass cls = GpuClass::Other;
    switch (ggml_backend_dev_type(dev)) {
    case GGML_BACKEND_DEVICE_TYPE_IGPU:
      cls = GpuClass::Integrated;
      break;
    case GGML_BACKEND_DEVICE_TYPE_GPU:
      cls = GpuClass::Dedicated;
      break;
    default:
      break;
    }
    devices.push_back(
        {name == nullptr ? std::string() : std::string(name),
         cls,
         totalBytes,
         description == nullptr ? std::string() : std::string(description)});
  }

  std::optional<std::string> name = selectMainGpuName(devices, spec);
  const std::string msg =
      name.has_value()
          ? "main-gpu resolved to backend '" + name.value() + "'"
          : std::string(
                "main-gpu: no matching device found; leaving backend "
                "unset");
  QLOG_IF(Priority::INFO, msg);
  return name;
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
        devType != GGML_BACKEND_DEVICE_TYPE_IGPU) {
      continue;
    }

    const char* desc = ggml_backend_dev_description(dev);
    const char* name = ggml_backend_dev_name(dev);
    QLOG_IF(
        Priority::INFO,
        std::string("Backend selection: GPU device '") +
            (desc != nullptr ? desc : "<null>") +
            "' (backend: " + (name != nullptr ? name : "<null>") + ")");

    const int model = parseAdrenoModelFromGpuDevice(dev);
    if (model > 0) {
      QLOG_IF(
          Priority::INFO,
          "Backend selection: Adreno model " + std::to_string(model));
    }

    if (model >= K_ADRENO_GPU_MIN_MODEL) {
      QLOG_IF(Priority::INFO, "Backend selection: Adreno -> GPU");
      return BackendDevice::GPU;
    }
  }

  QLOG_IF(Priority::INFO, "Backend selection: non-Adreno -> GPU (Vulkan)");
  return BackendDevice::GPU;
}

bool shouldPreferOpenClForAdreno(BackendDevice preferred) {
  using Priority = qvac_lib_inference_addon_cpp::logger::Priority;

  if (preferred == BackendDevice::CPU) {
    return false;
  }

  const size_t nDevices = ggml_backend_dev_count();
  bool hasAdrenoGpu = false;
  bool hasOpenClGpu = false;

  for (size_t i = 0; i < nDevices; ++i) {
    ggml_backend_dev_t dev = ggml_backend_dev_get(i);
    enum ggml_backend_dev_type devType = ggml_backend_dev_type(dev);
    if (devType != GGML_BACKEND_DEVICE_TYPE_GPU &&
        devType != GGML_BACKEND_DEVICE_TYPE_IGPU) {
      continue;
    }

    const char* namePtr = ggml_backend_dev_name(dev);
    const std::string backendName = namePtr != nullptr ? namePtr : "";

    const int model = parseAdrenoModelFromGpuDevice(dev);
    if (model >= K_ADRENO_GPU_MIN_MODEL) {
      hasAdrenoGpu = true;
    }

    if (toLowerCopy(backendName).find("opencl") != std::string::npos) {
      hasOpenClGpu = true;
    }
  }

  const bool preferOpenCl = hasAdrenoGpu && hasOpenClGpu;
  if (preferOpenCl) {
    QLOG_IF(
        Priority::INFO,
        "Backend selection: Adreno with OpenCL backend available -> "
        "prefer OpenCL");
  }
  return preferOpenCl;
}

sd_backend_preference_t preferredGpuBackendForGpuLikeDevice() {
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

sd_backend_preference_t
preferredGpuBackendForConfigDevice(const std::string& device) {
  switch (parseConfigDeviceString(device)) {
  case ConfigDevice::Cpu:
    return SD_BACKEND_PREF_CPU;
  case ConfigDevice::Gpu:
    return preferredGpuBackendForGpuLikeDevice();
  }
}

sd_backend_preference_t
preferredEsrganBackendForConfigDevice(const std::string& device) {
#if defined(__ANDROID__)
  switch (parseConfigDeviceString(device)) {
  case ConfigDevice::Cpu:
    return SD_BACKEND_PREF_CPU;
  case ConfigDevice::Gpu: {
    using Priority = qvac_lib_inference_addon_cpp::logger::Priority;
    QLOG_IF(
        Priority::INFO,
        "Backend selection: Android ESRGAN gpu -> CPU (unstable GPU/OpenCL "
        "path)");
    return SD_BACKEND_PREF_CPU;
  }
  }
#else
  return preferredGpuBackendForConfigDevice(device);
#endif
}

std::string expectedEsrganBackendDeviceForConfig(const std::string& device) {
  switch (parseConfigDeviceString(device)) {
  case ConfigDevice::Cpu:
    return "cpu";
  case ConfigDevice::Gpu:
#if defined(__ANDROID__)
    return "cpu";
#else
  {
    const BackendDevice effective = resolveBackendForDevice(BackendDevice::GPU);
    return effective == BackendDevice::CPU ? "cpu" : "gpu";
  }
#endif
  }
}

} // namespace sd_backend_selection
