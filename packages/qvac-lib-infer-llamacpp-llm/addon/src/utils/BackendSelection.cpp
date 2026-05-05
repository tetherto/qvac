#include "BackendSelection.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <optional>
#include <regex>
#include <string_view>
#include <variant>
#include <vector>

#include <common/log.h>
#include <ggml-backend.h>

#include "common/common.h"
#include "model-interface/ModelMetadata.hpp"

using namespace backend_selection;

namespace {

constexpr std::array<std::string_view, 3> kSupportedFinetuneArchitectures = {
    "gemma3", "qwen3", "bitnet"};

bool isSupportedFinetuneArchitecture(std::string_view arch) {
  return std::ranges::find(kSupportedFinetuneArchitectures, arch) !=
         kSupportedFinetuneArchitectures.end();
}

} // namespace

std::optional<std::string> backend_selection::getUnknownFinetuneArchitecture(
    const ModelMetaData* metadata) {
  const auto arch = metadata != nullptr
                        ? metadata->tryGetString("general.architecture")
                        : std::nullopt;
  if (arch.has_value() && isSupportedFinetuneArchitecture(arch.value())) {
    return std::nullopt;
  }
  return arch.value_or("unknown");
}

namespace {

std::optional<int> parseAdrenoVersion(const std::string& gpuDescription) {
  static const std::regex adrenoRegex(R"(dreno.*?(\d+))");
  std::smatch matches;
  if (std::regex_search(gpuDescription, matches, adrenoRegex) &&
      matches.size() > 1) {
    try {
      return std::stoi(matches[1].str());
    } catch (const std::exception& e) {
      LOG_WRN(
          "parseAdrenoVersion: failed to parse version from '%s': %s\n",
          gpuDescription.c_str(),
          e.what());
    }
  }
  return std::nullopt;
}

struct DeviceDescription {
  std::string gpuDescription;
  std::string gpuBackend;

  DeviceDescription(
      const ggml_backend_dev_t dev,
      const enum ggml_backend_dev_type backendTypeEnum,
      const BackendInterface& bckI)
      : gpuDescription(bckI.ggml_backend_dev_description(dev)),
        gpuBackend(bckI.ggml_backend_dev_name(dev)) {
    std::transform(
        gpuDescription.begin(),
        gpuDescription.end(),
        gpuDescription.begin(),
        tolower);
    std::transform(
        gpuBackend.begin(), gpuBackend.end(), gpuBackend.begin(), tolower);
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

void emplaceIfValidDevice(
    const BackendInterface& bckI, std::vector<std::string>& gpuBackends,
    std::vector<std::string>& igpuBackends,
    std::vector<std::string>& openClBackends,
    std::optional<int>& maxAdrenoVersion, const ggml_backend_reg_t reg,
    const DeviceDescription& devDescr,
    const enum ggml_backend_dev_type backendTypeEnum) {
  if (bckI.ggml_backend_reg_name(reg) != std::string("RPC")) {
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
        devDescr.gpuDescription.find("dreno") != std::string::npos;
    if (isAdreno) {
      auto version = parseAdrenoVersion(devDescr.gpuDescription);
      if (version.has_value() && (!maxAdrenoVersion.has_value() ||
                                  version.value() > maxAdrenoVersion.value())) {
        maxAdrenoVersion = version;
      }
    }

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
    std::vector<std::string>& openClBackends,
    std::optional<int>& maxAdrenoVersion) {
  const ggml_backend_dev_t dev = bckI.ggml_backend_dev_get(deviceIndex);
  const ggml_backend_reg_t reg = bckI.ggml_backend_dev_backend_reg(dev);
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
        maxAdrenoVersion,
        reg,
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
  auto hIt = configFilemap.find("main-gpu");
  auto uIt = configFilemap.find("main_gpu");
  if (hIt != configFilemap.end() && uIt != configFilemap.end()) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "both 'main-gpu' and 'main_gpu' are present; use one or the other.");
  }
  auto it = (hIt != configFilemap.end()) ? hIt : uIt;
  if (it == configFilemap.end()) {
    return std::nullopt;
  }
  std::optional<MainGpu> mainGpu = parseMainGpu(it->second);
  configFilemap.erase(it);
  return mainGpu;
}

std::pair<BackendType, std::string> backend_selection::chooseBackend(
    const BackendType preferredBackendType, const BackendInterface& bckI,
    const ModelMetaData* metadata, const std::optional<MainGpu>& mainGpu,
    std::optional<int>* outAdrenoVersion, const bool isFinetuning) {

  std::vector<std::string> gpuBackends;
  std::vector<std::string> igpuBackends;
  std::vector<std::string> openClBackends;
  std::optional<int> maxAdrenoVersion;

  if (preferredBackendType == BackendType::GPU) {
    bool loopAllDevices = true;
    std::optional<MainGpuType> gpuType = std::nullopt;
    if (mainGpu.has_value()) {
      const MainGpu& mainGpuValue = mainGpu.value();
      if (std::holds_alternative<int>(mainGpuValue)) {
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
              openClBackends,
              maxAdrenoVersion);
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
          bckI,
          i,
          gpuType,
          gpuBackends,
          igpuBackends,
          openClBackends,
          maxAdrenoVersion);
    }
  }

  auto clearAllGpuBackends = [&]() {
    openClBackends.clear();
    gpuBackends.clear();
    igpuBackends.clear();
  };

  constexpr int kAdreno800Threshold = 800;

  const bool noMainGpuOverride = !mainGpu.has_value();
  const bool isAdreno = maxAdrenoVersion.has_value();

  if (auto unsupported = getUnknownFinetuneArchitecture(metadata);
      isFinetuning && unsupported) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Finetuning is not supported for architecture: " + unsupported.value());
  }

  const bool isBitnetOneBit =
      metadata != nullptr && metadata->hasOneBitQuantization() &&
      metadata->tryGetString("general.architecture") == "bitnet";

  if (noMainGpuOverride && isAdreno && isFinetuning) {
    if (maxAdrenoVersion.value() >= kAdreno800Threshold) {
      bckI.llamaLogCallback(
          GGML_LOG_LEVEL_INFO,
          "Finetuning on Adreno 800+: preferring Vulkan",
          nullptr);
      openClBackends.clear();
    } else {
      bckI.llamaLogCallback(
          GGML_LOG_LEVEL_INFO, "Finetuning on Adreno <800: CPU only", nullptr);
      clearAllGpuBackends();
    }
  } else if (noMainGpuOverride && isAdreno) {
    if (isBitnetOneBit && maxAdrenoVersion.value() < kAdreno800Threshold) {
      bckI.llamaLogCallback(
          GGML_LOG_LEVEL_INFO,
          "BitNet TQ on Adreno <800: only CPU supported",
          nullptr);
      clearAllGpuBackends();
    } else if (
        isBitnetOneBit && maxAdrenoVersion.value() >= kAdreno800Threshold) {
      bckI.llamaLogCallback(
          GGML_LOG_LEVEL_INFO,
          "BitNet TQ on Adreno 800+: preferring Vulkan over OpenCL",
          nullptr);
      openClBackends.clear();
    }
  }

  if (outAdrenoVersion != nullptr) {
    *outAdrenoVersion = maxAdrenoVersion;
  }

  if (!openClBackends.empty()) {
    bckI.llamaLogCallback(GGML_LOG_LEVEL_INFO, "Chosen GPU OpenCL", nullptr);
    return {BackendType::GPU, openClBackends.front()};
  }

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
    const std::optional<MainGpu>& mainGpu, const ModelMetaData* metadata,
    std::optional<int>* outAdrenoVersion, const bool isFinetuning) {
  BackendInterface bckI{
      ggml_backend_dev_count,
      ggml_backend_dev_backend_reg,
      ggml_backend_dev_get,
      ggml_backend_reg_name,
      ggml_backend_dev_description,
      ggml_backend_dev_name,
      ggml_backend_dev_type,
      llamaLogcallback};
  return backend_selection::chooseBackend(
      preferredBackendType,
      bckI,
      metadata,
      mainGpu,
      outAdrenoVersion,
      isFinetuning);
}

size_t
backend_selection::getEffectiveGpuDeviceCount(const BackendInterface& bckI) {
  size_t gpuCount = 0;
  size_t igpuCount = 0;
  const size_t totalDevices = bckI.ggml_backend_dev_count();
  for (size_t i = 0; i < totalDevices; ++i) {
    ggml_backend_dev_t dev = bckI.ggml_backend_dev_get(i);
    enum ggml_backend_dev_type devType = bckI.ggml_backend_dev_type(dev);
    if (devType == GGML_BACKEND_DEVICE_TYPE_GPU) {
      ++gpuCount;
    } else if (devType == GGML_BACKEND_DEVICE_TYPE_IGPU) {
      ++igpuCount;
    }
  }
  return gpuCount > 0 ? gpuCount : igpuCount;
}
