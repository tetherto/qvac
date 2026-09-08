#include "BackendSelection.hpp"

#include <algorithm>
#include <cctype>
#include <optional>
#include <string_view>
#include <unordered_set>
#include <variant>
#include <vector>

#include <ggml-backend.h>

#include "common/common.h"

using namespace backend_selection;

namespace {
struct DeviceDescription {
  std::string gpuDescription;
  std::string gpuBackend;

  DeviceDescription(
      const ggml_backend_dev_t dev,
      const enum ggml_backend_dev_type backendTypeEnum,
      const BackendInterface& bckI)
      : gpuDescription(bckI.ggml_backend_dev_description(dev)),
        gpuBackend(bckI.ggml_backend_dev_name(dev)) {
    std::ranges::transform(gpuDescription, gpuDescription.begin(), tolower);
    std::ranges::transform(gpuBackend, gpuBackend.begin(), tolower);
    {
      std::string backendTypeStr;
      switch (backendTypeEnum) {
      case GGML_BACKEND_DEVICE_TYPE_CPU:
        backendTypeStr = "CPU";
        break;
      case GGML_BACKEND_DEVICE_TYPE_GPU:
        backendTypeStr = "GPU";
        break;
      case GGML_BACKEND_DEVICE_TYPE_IGPU:
        backendTypeStr = "IGPU";
        break;
      case GGML_BACKEND_DEVICE_TYPE_ACCEL:
        backendTypeStr = "ACCEL";
        break;
      default:
        backendTypeStr = "unknownEnum";
        break;
      }
      std::string text = string_format(
          "Backend detected: description = %s, backend = %s, type = %s",
          gpuDescription.c_str(),
          gpuBackend.c_str(),
          backendTypeStr.c_str());
      bckI.llamaLogCallback(GGML_LOG_LEVEL_INFO, text.c_str(), nullptr);
    }
  }
};

std::string lowerCopy(const char* value) {
  if (value == nullptr) {
    return {};
  }
  std::string lower(value);
  std::ranges::transform(lower, lower.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return lower;
}

bool hasBackendFamily(
    std::string_view deviceName, std::string_view registryName,
    std::string_view family) {
  if (registryName == family) {
    return true;
  }
  if (family == "opencl") {
    return deviceName == "gpuopencl" || deviceName.starts_with("opencl");
  }
  return deviceName.starts_with(family);
}

// Accept Metal device prefixes alongside ggml's MTL registry identity.
bool hasMetalFamily(
    std::string_view deviceName, std::string_view registryName) {
  const auto hasMetalPrefix = [](std::string_view name) {
    return name.starts_with("mtl") || name.starts_with("metal");
  };
  return hasMetalPrefix(deviceName) || registryName == "mtl" ||
         registryName == "metal";
}

// Follow ocr-ggml's matcher shape with embed-specific eligible families.
bool isEligibleGpuDevice(
    const BackendInterface& bckI, const ggml_backend_dev_t dev) {
  const enum ggml_backend_dev_type type = bckI.ggml_backend_dev_type(dev);
  if (type != GGML_BACKEND_DEVICE_TYPE_GPU &&
      type != GGML_BACKEND_DEVICE_TYPE_IGPU) {
    return false;
  }

  const ggml_backend_reg_t reg = bckI.ggml_backend_dev_backend_reg(dev);
  const std::string registryName =
      lowerCopy(reg != nullptr ? bckI.ggml_backend_reg_name(reg) : nullptr);
  if (registryName == "rpc") {
    return false;
  }

  const std::string deviceName = lowerCopy(bckI.ggml_backend_dev_name(dev));
  if (hasBackendFamily(deviceName, registryName, "opencl")) {
    return lowerCopy(bckI.ggml_backend_dev_description(dev)).find("adreno") !=
           std::string::npos;
  }
  return hasBackendFamily(deviceName, registryName, "vulkan") ||
         hasMetalFamily(deviceName, registryName);
}

void emplaceIfValidDevice(
    const BackendInterface& bckI, std::vector<std::string>& gpuBackends,
    std::vector<std::string>& igpuBackends,
    std::vector<std::string>& openClBackends, const ggml_backend_dev_t dev,
    const DeviceDescription& devDescr,
    const enum ggml_backend_dev_type backendTypeEnum) {
  if (isEligibleGpuDevice(bckI, dev)) {
    auto logEmplaceGpuBackend = [&](const std::string& gpuBackend) {
#ifndef NDEBUG
      std::string text = string_format(
          "Emplacing backend: gpuBackend = %s", gpuBackend.c_str());
      bckI.llamaLogCallback(GGML_LOG_LEVEL_INFO, text.c_str(), nullptr);
#endif
    };

    const bool isOpenCl =
        devDescr.gpuBackend.find("opencl") != std::string::npos;
    const bool isAdreno =
        devDescr.gpuDescription.find("adreno") != std::string::npos;
    if (isOpenCl && isAdreno) {
      logEmplaceGpuBackend(devDescr.gpuBackend);
      openClBackends.emplace_back(devDescr.gpuBackend);
    } else if (!isOpenCl) {
      logEmplaceGpuBackend(devDescr.gpuBackend);
      if (backendTypeEnum == GGML_BACKEND_DEVICE_TYPE_GPU) {
        gpuBackends.emplace_back(devDescr.gpuBackend);
      } else if (backendTypeEnum == GGML_BACKEND_DEVICE_TYPE_IGPU) {
        igpuBackends.emplace_back(devDescr.gpuBackend);
      }
    }
  }
}

bool shouldProcessDevice(
    const enum ggml_backend_dev_type backendTypeEnum,
    const DeviceDescription& devDescr,
    const std::optional<MainGpuType> mainGpuType) {
  const bool anyGpu = !mainGpuType.has_value() &&
                      (backendTypeEnum == GGML_BACKEND_DEVICE_TYPE_GPU ||
                       backendTypeEnum == GGML_BACKEND_DEVICE_TYPE_IGPU);
  const bool integratedGpu = mainGpuType.has_value() &&
                             mainGpuType.value() == MainGpuType::Integrated &&
                             backendTypeEnum == GGML_BACKEND_DEVICE_TYPE_IGPU;
  const bool dedicatedGpu = mainGpuType.has_value() &&
                            mainGpuType.value() == MainGpuType::Dedicated &&
                            backendTypeEnum == GGML_BACKEND_DEVICE_TYPE_GPU;
  const bool isOpenCl = devDescr.gpuBackend.find("opencl") != std::string::npos;
  return anyGpu || integratedGpu || dedicatedGpu || isOpenCl;
}

void tryEmplaceDevice(
    const BackendInterface& bckI, size_t deviceIndex,
    std::optional<MainGpuType> mainGpuType,
    std::vector<std::string>& gpuBackends,
    std::vector<std::string>& igpuBackends,
    std::vector<std::string>& openClBackends) {
  const ggml_backend_dev_t dev = bckI.ggml_backend_dev_get(deviceIndex);
  const enum ggml_backend_dev_type backendTypeEnum =
      bckI.ggml_backend_dev_type(dev);
  const DeviceDescription devDescr(dev, backendTypeEnum, bckI);
  if (shouldProcessDevice(backendTypeEnum, devDescr, mainGpuType)) {
#ifndef NDEBUG
    bckI.llamaLogCallback(GGML_LOG_LEVEL_INFO, "New GPU device", nullptr);
#endif
    ::emplaceIfValidDevice(
        bckI,
        gpuBackends,
        igpuBackends,
        openClBackends,
        dev,
        devDescr,
        backendTypeEnum);
  } else {
#ifndef NDEBUG
    bckI.llamaLogCallback(
        GGML_LOG_LEVEL_INFO, "Non-GPU type of device", nullptr);
#endif
  }
}
} // namespace

BackendType
backend_selection::preferredBackendTypeFromString(const std::string& device) {
  if (device == "gpu") {
    return BackendType::GPU;
  }
  if (device == "cpu") {
    return BackendType::CPU;
  }
  throw qvac_errors::StatusError(
      qvac_errors::general_error::InvalidArgument,
      "preferredDeviceFromString: wrong device specified, must be 'gpu' or "
      "'cpu'.\n");
}

std::optional<MainGpu>
backend_selection::parseMainGpu(const std::string& mainGpuStr) {
  if (mainGpuStr.empty()) {
    return std::nullopt;
  }

  // Try to parse as integer first
  try {
    int deviceIndex = std::stoi(mainGpuStr);
    return MainGpu(deviceIndex);
  } catch (const std::exception&) {
    // Not an integer, try enum values
    std::string lowerStr = mainGpuStr;
    std::ranges::transform(lowerStr, lowerStr.begin(), tolower);

    if (lowerStr == "integrated") {
      return MainGpu(MainGpuType::Integrated);
    }
    if (lowerStr == "dedicated") {
      return MainGpu(MainGpuType::Dedicated);
    }
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "main-gpu must be an integer device index, 'integrated', or "
        "'dedicated'");
  }
}

std::optional<MainGpu> backend_selection::tryMainGpuFromMap(
    std::unordered_map<std::string, std::string>& configFilemap) {
  auto hIt = configFilemap.find("main-gpu");
  auto uIt = configFilemap.find("main_gpu");
  if (hIt != configFilemap.end() && uIt != configFilemap.end()) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "both 'main-gpu' and 'main_gpu' are present; use one or the other.");
  }
  auto foundIt = (hIt != configFilemap.end()) ? hIt : uIt;
  if (foundIt == configFilemap.end()) {
    return std::nullopt;
  }
  std::optional<MainGpu> mainGpu = parseMainGpu(foundIt->second);
  configFilemap.erase(foundIt);
  return mainGpu;
}

std::pair<BackendType, std::string> backend_selection::chooseBackend(
    const BackendType preferredBackendType, const BackendInterface& bckI,
    const std::optional<MainGpu>& mainGpu) {

  std::vector<std::string> gpuBackends;
  std::vector<std::string> igpuBackends;
  std::vector<std::string> openClBackends;

  if (preferredBackendType == BackendType::GPU) {
    bool loopAllDevices = true;
    std::optional<MainGpuType> gpuType = std::nullopt;
    if (mainGpu.has_value()) {
      const MainGpu& mainGpuValue = mainGpu.value();
      if (std::holds_alternative<int>(mainGpuValue)) {
        // Direct device index specified
        const int deviceIndex = std::get<int>(mainGpuValue);
        const size_t deviceCount = bckI.ggml_backend_dev_count();
        if (deviceIndex >= 0 &&
            static_cast<size_t>(deviceIndex) < deviceCount) {
          ::tryEmplaceDevice(
              bckI,
              static_cast<size_t>(deviceIndex),
              std::nullopt,
              gpuBackends,
              igpuBackends,
              openClBackends);
          loopAllDevices = false;
        } else {
          std::string errorMsg = string_format(
              "main-gpu device index %d is out of range (0-%zu)",
              deviceIndex,
              deviceCount - 1);
          bckI.llamaLogCallback(GGML_LOG_LEVEL_WARN, errorMsg.c_str(), nullptr);
        }
      } else if (std::holds_alternative<MainGpuType>(mainGpuValue)) {
        gpuType = std::get<MainGpuType>(mainGpuValue);
      }
    }
    for (size_t i = 0; loopAllDevices && i < bckI.ggml_backend_dev_count();
         ++i) {
      ::tryEmplaceDevice(
          bckI, i, gpuType, gpuBackends, igpuBackends, openClBackends);
    }
  }

  // check if Adreno GPU is present and force OpenCL backend, otherwise let
  // llama.cpp choose Vulkan GPU backend
  if (!openClBackends.empty()) {
    bckI.llamaLogCallback(GGML_LOG_LEVEL_INFO, "Chosen GPU OpenCL", nullptr);
    return {BackendType::GPU, openClBackends.front()};
  }

  // Prefer GPU over iGPU when possible
  if (!gpuBackends.empty()) {
    bckI.llamaLogCallback(GGML_LOG_LEVEL_INFO, "Chosen GPU Backend", nullptr);
    return {BackendType::GPU, gpuBackends.front()};
  }

  if (!igpuBackends.empty()) {
    bckI.llamaLogCallback(GGML_LOG_LEVEL_INFO, "Chosen iGPU Backend", nullptr);
    return {BackendType::GPU, igpuBackends.front()};
  }

  bckI.llamaLogCallback(GGML_LOG_LEVEL_INFO, "Chosen CPU", nullptr);
  return {BackendType::CPU, "none"};
};

std::pair<BackendType, std::string> backend_selection::chooseBackend(
    const BackendType preferredBackendType, llamaLogCallbackF llamaLogcallback,
    const std::optional<MainGpu>& mainGpu) {
  BackendInterface bckI{
      .ggml_backend_dev_count = ggml_backend_dev_count,
      .ggml_backend_dev_backend_reg = ggml_backend_dev_backend_reg,
      .ggml_backend_dev_get = ggml_backend_dev_get,
      .ggml_backend_reg_name = ggml_backend_reg_name,
      .ggml_backend_dev_description = ggml_backend_dev_description,
      .ggml_backend_dev_name = ggml_backend_dev_name,
      .ggml_backend_dev_type = ggml_backend_dev_type,
      .ggml_backend_reg_get_proc_address = ggml_backend_reg_get_proc_address,
      .ggml_backend_dev_get_props = ggml_backend_dev_get_props,
      .llamaLogCallback = llamaLogcallback};
  return backend_selection::chooseBackend(preferredBackendType, bckI, mainGpu);
}

size_t
backend_selection::getEffectiveGpuDeviceCount(const BackendInterface& bckI) {
  size_t gpuCount = 0;
  size_t igpuCount = 0;
  const size_t totalDevices = bckI.ggml_backend_dev_count();
  for (size_t i = 0; i < totalDevices; ++i) {
    ggml_backend_dev_t dev = bckI.ggml_backend_dev_get(i);
    if (!isEligibleGpuDevice(bckI, dev)) {
      continue;
    }
    enum ggml_backend_dev_type devType = bckI.ggml_backend_dev_type(dev);
    if (devType == GGML_BACKEND_DEVICE_TYPE_GPU) {
      ++gpuCount;
    } else if (devType == GGML_BACKEND_DEVICE_TYPE_IGPU) {
      ++igpuCount;
    }
  }
  return gpuCount > 0 ? gpuCount : igpuCount;
}

std::vector<std::string>
backend_selection::getSplitDeviceNames(const BackendInterface& bckI) {
  std::vector<std::string> discrete;
  std::vector<std::string> integrated;
  std::unordered_set<std::string> seenDiscrete;
  std::unordered_set<std::string> seenIntegrated;

  const size_t totalDevices = bckI.ggml_backend_dev_count();
  for (size_t i = 0; i < totalDevices; ++i) {
    ggml_backend_dev_t dev = bckI.ggml_backend_dev_get(i);
    if (!isEligibleGpuDevice(bckI, dev)) {
      continue;
    }
    const bool isDiscrete =
        bckI.ggml_backend_dev_type(dev) == GGML_BACKEND_DEVICE_TYPE_GPU;
    // Materialise each string before the next interface call. The returned
    // pointers are not guaranteed to outlive a subsequent call on the same
    // interface, and holding one across another call is a use-after-free
    // against any implementation that stores results in a reallocating
    // container. DeviceDescription above is safe for the same reason: its
    // std::string members copy in declaration order.
    ggml_backend_dev_props props{};
    bckI.ggml_backend_dev_get_props(dev, &props);
    const std::string deviceId = props.device_id != nullptr
                                     ? std::string(props.device_id)
                                     : std::string();
    const char* name = bckI.ggml_backend_dev_name(dev);
    // An empty name would join into a leading or trailing comma and make the
    // whole --device list unparseable, so it is skipped like a null one.
    if (name == nullptr || *name == '\0') {
      continue;
    }
    auto& bucket = isDiscrete ? discrete : integrated;
    auto& seen = isDiscrete ? seenDiscrete : seenIntegrated;
    if (deviceId.empty() || seen.insert(deviceId).second) {
      bucket.emplace_back(name);
    }
  }
  return !discrete.empty() ? discrete : integrated;
}

std::vector<std::string> backend_selection::getSplitDeviceNames() {
  BackendInterface bckI{
      .ggml_backend_dev_count = ggml_backend_dev_count,
      .ggml_backend_dev_backend_reg = ggml_backend_dev_backend_reg,
      .ggml_backend_dev_get = ggml_backend_dev_get,
      .ggml_backend_reg_name = ggml_backend_reg_name,
      .ggml_backend_dev_description = ggml_backend_dev_description,
      .ggml_backend_dev_name = ggml_backend_dev_name,
      .ggml_backend_dev_type = ggml_backend_dev_type,
      .ggml_backend_reg_get_proc_address = ggml_backend_reg_get_proc_address,
      .ggml_backend_dev_get_props = ggml_backend_dev_get_props,
      .llamaLogCallback = nullptr};
  return getSplitDeviceNames(bckI);
}

bool backend_selection::gpuBackendSupportsRowSplit(
    const BackendInterface& bckI) {
  // Mirror what qvac-fabric actually checks: llama_model::load_tensors() calls
  // make_gpu_buft_list() for EVERY device it was given and throws "device %s
  // does not support split buffers" on the first one whose backend registry
  // lacks `ggml_backend_split_buffer_type`. Split mode now pins `--device` to
  // the eligible list, so that set is every eligible GPU device — a single
  // eligible backend without split buffers is enough to fail the load. So
  // require all of them, not any one, and treat an empty eligible list as
  // unsupported.
  size_t gpuDevices = 0;
  const size_t totalDevices = bckI.ggml_backend_dev_count();
  for (size_t i = 0; i < totalDevices; ++i) {
    ggml_backend_dev_t dev = bckI.ggml_backend_dev_get(i);
    if (!isEligibleGpuDevice(bckI, dev)) {
      continue;
    }
    const enum ggml_backend_dev_type devType = bckI.ggml_backend_dev_type(dev);
    if (devType != GGML_BACKEND_DEVICE_TYPE_GPU &&
        devType != GGML_BACKEND_DEVICE_TYPE_IGPU) {
      continue;
    }
    ++gpuDevices;
    ggml_backend_reg_t reg = bckI.ggml_backend_dev_backend_reg(dev);
    if (reg == nullptr ||
        bckI.ggml_backend_reg_get_proc_address(
            reg, "ggml_backend_split_buffer_type") == nullptr) {
      return false;
    }
  }
  return gpuDevices > 0;
}

bool backend_selection::gpuBackendSupportsRowSplit() {
  BackendInterface bckI{
      .ggml_backend_dev_count = ggml_backend_dev_count,
      .ggml_backend_dev_backend_reg = ggml_backend_dev_backend_reg,
      .ggml_backend_dev_get = ggml_backend_dev_get,
      .ggml_backend_reg_name = ggml_backend_reg_name,
      .ggml_backend_dev_description = ggml_backend_dev_description,
      .ggml_backend_dev_name = ggml_backend_dev_name,
      .ggml_backend_dev_type = ggml_backend_dev_type,
      .ggml_backend_reg_get_proc_address = ggml_backend_reg_get_proc_address,
      .ggml_backend_dev_get_props = ggml_backend_dev_get_props,
      .llamaLogCallback = nullptr};
  return backend_selection::gpuBackendSupportsRowSplit(bckI);
}
