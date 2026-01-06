#include "BackendSelection.hpp"

#include <algorithm>
#include <cctype>
#include <optional>
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
      const ggml_backend_dev_t DEV,
      const enum ggml_backend_dev_type BACKEND_TYPE_ENUM,
      const BackendInterface& bckI)
      : gpuDescription(bckI.ggml_backend_dev_description(DEV)),
        gpuBackend(bckI.ggml_backend_dev_name(DEV)) {
    std::transform(
        gpuDescription.begin(),
        gpuDescription.end(),
        gpuDescription.begin(),
        tolower);
    std::transform(
        gpuBackend.begin(), gpuBackend.end(), gpuBackend.begin(), tolower);
    {
      std::string backendTypeStr;
      switch (BACKEND_TYPE_ENUM) {
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

void emplaceIfValidDevice(
    const BackendInterface& bckI, std::vector<std::string>& gpuBackends,
    std::vector<std::string>& igpuBackends,
    std::vector<std::string>& openClBackends, const ggml_backend_reg_t REG,
    const DeviceDescription& devDescr,
    const enum ggml_backend_dev_type BACKEND_TYPE_ENUM) {
  if (bckI.ggml_backend_reg_name(REG) != std::string("RPC")) {
    auto logEmplaceGpuBackend = [&](const std::string& gpuBackend) {
#ifndef NDEBUG
      std::string text = string_format(
          "Emplacing backend: gpuBackend = %s", gpuBackend.c_str());
      bckI.llamaLogCallback(GGML_LOG_LEVEL_INFO, text.c_str(), nullptr);
#endif
    };

    const bool IS_OPEN_CL =
        devDescr.gpuBackend.find("opencl") != std::string::npos;
    const bool IS_ADRENO =
        devDescr.gpuDescription.find("adreno") != std::string::npos;
    if (IS_OPEN_CL && IS_ADRENO) {
      logEmplaceGpuBackend(devDescr.gpuBackend);
      openClBackends.emplace_back(devDescr.gpuBackend);
    } else if (!IS_OPEN_CL) {
      logEmplaceGpuBackend(devDescr.gpuBackend);
      if (BACKEND_TYPE_ENUM == GGML_BACKEND_DEVICE_TYPE_GPU) {
        gpuBackends.emplace_back(devDescr.gpuBackend);
      } else if (BACKEND_TYPE_ENUM == GGML_BACKEND_DEVICE_TYPE_IGPU) {
        igpuBackends.emplace_back(devDescr.gpuBackend);
      }
    }
  }
}

bool shouldProcessDevice(
    const enum ggml_backend_dev_type BACKEND_TYPE_ENUM,
    const DeviceDescription& DEV_DESCR,
    const std::optional<MainGpuType> MAIN_GPU_TYPE) {
  const bool ANY_GPU = !MAIN_GPU_TYPE.has_value() &&
                       (BACKEND_TYPE_ENUM == GGML_BACKEND_DEVICE_TYPE_GPU ||
                        BACKEND_TYPE_ENUM == GGML_BACKEND_DEVICE_TYPE_IGPU);
  const bool INTEGRATED_GPU =
      MAIN_GPU_TYPE.has_value() &&
      MAIN_GPU_TYPE.value() == MainGpuType::Integrated &&
      BACKEND_TYPE_ENUM == GGML_BACKEND_DEVICE_TYPE_IGPU;
  const bool DEDICATED_GPU = MAIN_GPU_TYPE.has_value() &&
                             MAIN_GPU_TYPE.value() == MainGpuType::Dedicated &&
                             BACKEND_TYPE_ENUM == GGML_BACKEND_DEVICE_TYPE_GPU;
  const bool IS_OPEN_CL =
      DEV_DESCR.gpuBackend.find("opencl") != std::string::npos;
  return ANY_GPU || INTEGRATED_GPU || DEDICATED_GPU || IS_OPEN_CL;
}

void tryEmplaceDevice(
    const BackendInterface& bckI, size_t deviceIndex,
    std::optional<MainGpuType> mainGpuType,
    std::vector<std::string>& gpuBackends,
    std::vector<std::string>& igpuBackends,
    std::vector<std::string>& openClBackends) {
  const ggml_backend_dev_t DEV = bckI.ggml_backend_dev_get(deviceIndex);
  const ggml_backend_reg_t REG = bckI.ggml_backend_dev_backend_reg(DEV);
  const enum ggml_backend_dev_type BACKEND_TYPE_ENUM =
      bckI.ggml_backend_dev_type(DEV);
  const DeviceDescription DEV_DESCR(DEV, BACKEND_TYPE_ENUM, bckI);
  if (shouldProcessDevice(BACKEND_TYPE_ENUM, DEV_DESCR, mainGpuType)) {
#ifndef NDEBUG
    bckI.llamaLogCallback(GGML_LOG_LEVEL_INFO, "New GPU device", nullptr);
#endif
    ::emplaceIfValidDevice(
        bckI,
        gpuBackends,
        igpuBackends,
        openClBackends,
        REG,
        DEV_DESCR,
        BACKEND_TYPE_ENUM);
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
    std::transform(lowerStr.begin(), lowerStr.end(), lowerStr.begin(), tolower);

    if (lowerStr == "integrated") {
      return MainGpu(MainGpuType::Integrated);
    } else if (lowerStr == "dedicated") {
      return MainGpu(MainGpuType::Dedicated);
    } else {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "main-gpu must be an integer device index, 'integrated', or "
          "'dedicated'");
    }
  }
}

std::optional<MainGpu> backend_selection::tryMainGpuFromMap(
    std::unordered_map<std::string, std::string>& configFilemap) {
  std::optional<MainGpu> mainGpu = std::nullopt;
  if (auto mainGpuIt = configFilemap.find("main-gpu");
      mainGpuIt != configFilemap.end()) {
    mainGpu = parseMainGpu(mainGpuIt->second);
    configFilemap.erase(mainGpuIt);
  }
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
      ggml_backend_dev_count,
      ggml_backend_dev_backend_reg,
      ggml_backend_dev_get,
      ggml_backend_reg_name,
      ggml_backend_dev_description,
      ggml_backend_dev_name,
      ggml_backend_dev_type,
      llamaLogcallback};
  return backend_selection::chooseBackend(preferredBackendType, bckI, mainGpu);
}
