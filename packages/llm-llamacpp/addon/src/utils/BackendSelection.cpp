#include "BackendSelection.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <optional>
#include <regex>
#include <string_view>
#include <unordered_set>
#include <variant>
#include <vector>

#include <common/log.h>
#include <ggml-backend.h>

#include "common/common.h"
#include "model-interface/ModelMetadata.hpp"

using namespace backend_selection;

namespace {

constexpr std::array<std::string_view, 6> SUPPORTED_FINETUNE_ARCHITECTURES = {
    "gemma3", "qwen3", "bitnet", "qwen35", "qwen35moe", "gemma4"};

bool isSupportedFinetuneArchitecture(std::string_view arch) {
  return std::ranges::find(SUPPORTED_FINETUNE_ARCHITECTURES, arch) !=
         SUPPORTED_FINETUNE_ARCHITECTURES.end();
}

// Adreno tier at and above which the restricted workloads below run on the GPU
// (Vulkan) instead of the CPU. Shared by chooseBackend and
// applyAdrenoRestrictions so the single-device and split paths cannot drift.
constexpr int kAdreno800Threshold = 800;

// TQ1_0/TQ2_0 BitNet. Also shared by both paths, for the same reason.
bool isBitnetOneBitModel(const ModelMetaData* metadata) {
  return metadata != nullptr && metadata->hasOneBitQuantization() &&
         metadata->tryGetString("general.architecture") == "bitnet";
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

std::string lowerCopy(const char* value) {
  if (value == nullptr) {
    return {};
  }
  std::string lower(value);
  std::transform(
      lower.begin(), lower.end(), lower.begin(), [](unsigned char c) {
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

bool hasMetalFamily(
    std::string_view deviceName, std::string_view registryName) {
  const auto hasMetalPrefix = [](std::string_view name) {
    return name.starts_with("mtl") || name.starts_with("metal");
  };
  return hasMetalPrefix(deviceName) || registryName == "mtl" ||
         registryName == "metal";
}

bool isOpenClDevice(
    const BackendInterface& bckI, const ggml_backend_dev_t dev,
    const DeviceDescription& devDescr) {
  const ggml_backend_reg_t reg = bckI.ggml_backend_dev_backend_reg(dev);
  return hasBackendFamily(
      devDescr.gpuBackend,
      lowerCopy(reg != nullptr ? bckI.ggml_backend_reg_name(reg) : nullptr),
      "opencl");
}

std::string
deviceIdentity(const BackendInterface& bckI, const ggml_backend_dev_t dev) {
  const ggml_backend_reg_t reg = bckI.ggml_backend_dev_backend_reg(dev);
  const char* namePtr = bckI.ggml_backend_dev_name(dev);
  const char* registryPtr =
      reg != nullptr ? bckI.ggml_backend_reg_name(reg) : nullptr;
  const std::string name = namePtr != nullptr ? namePtr : "unnamed";
  const std::string registry =
      registryPtr != nullptr ? registryPtr : "unknown registry";
  return name + " (" + registry + ")";
}

// Follow ocr-ggml's matcher shape with LLM-specific eligible families.
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
  const std::string deviceName = lowerCopy(bckI.ggml_backend_dev_name(dev));
  if (hasBackendFamily(deviceName, registryName, "cuda") ||
      hasBackendFamily(deviceName, registryName, "rpc")) {
    return true;
  }
  if (hasBackendFamily(deviceName, registryName, "opencl")) {
    return lowerCopy(bckI.ggml_backend_dev_description(dev)).find("dreno") !=
           std::string::npos;
  }
  return hasBackendFamily(deviceName, registryName, "vulkan") ||
         hasMetalFamily(deviceName, registryName);
}

void emplaceIfValidDevice(
    const BackendInterface& bckI, std::vector<std::string>& gpuBackends,
    std::vector<std::string>& igpuBackends,
    std::vector<std::string>& openClBackends,
    std::optional<int>& maxAdrenoVersion, bool& sawMaliGpu, const bool isOpenCl,
    const DeviceDescription& devDescr,
    const enum ggml_backend_dev_type backendTypeEnum) {
  auto logEmplaceGpuBackend = [&](const std::string& gpuBackend) {
#ifndef NDEBUG
    std::string text =
        string_format("Emplacing backend: gpuBackend = %s", gpuBackend.c_str());
    bckI.llamaLogCallback(GGML_LOG_LEVEL_INFO, text.c_str(), nullptr);
#endif
  };

  const bool isAdreno =
      devDescr.gpuDescription.find("dreno") != std::string::npos;
  // QVAC-21867: track Mali GPUs (description is lowercased by
  // DeviceDescription) so callers can pick per-device-class defaults for
  // the multimodal projector backend.
  if (devDescr.gpuDescription.find("mali") != std::string::npos) {
    sawMaliGpu = true;
  }
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

bool shouldProcessDevice(
    const enum ggml_backend_dev_type backendTypeEnum, const bool isOpenCl,
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
  return anyGpu || integratedGpu || dedicatedGpu || isOpenCl;
}

void tryEmplaceDevice(
    const BackendInterface& bckI, size_t deviceIndex,
    std::optional<MainGpuType> mainGpuType,
    std::vector<std::string>& gpuBackends,
    std::vector<std::string>& igpuBackends,
    std::vector<std::string>& openClBackends,
    std::optional<int>& maxAdrenoVersion, bool& sawMaliGpu,
    std::vector<std::string>& rejectedDevices) {
  const ggml_backend_dev_t dev = bckI.ggml_backend_dev_get(deviceIndex);
  const enum ggml_backend_dev_type backendTypeEnum =
      bckI.ggml_backend_dev_type(dev);
  const DeviceDescription devDescr(dev, backendTypeEnum, bckI);
  const bool isOpenCl = isOpenClDevice(bckI, dev, devDescr);
  const bool isGpuType = backendTypeEnum == GGML_BACKEND_DEVICE_TYPE_GPU ||
                         backendTypeEnum == GGML_BACKEND_DEVICE_TYPE_IGPU;
  // Record a refused GPU before the main-gpu type filter so the CPU-fallback
  // warning names it even when `integrated`/`dedicated` skips its type.
  if (isGpuType && !isEligibleGpuDevice(bckI, dev)) {
    rejectedDevices.emplace_back(deviceIdentity(bckI, dev));
    return;
  }
  if (shouldProcessDevice(backendTypeEnum, isOpenCl, mainGpuType)) {
#ifndef NDEBUG
    bckI.llamaLogCallback(GGML_LOG_LEVEL_INFO, "New GPU device", nullptr);
#endif
    ::emplaceIfValidDevice(
        bckI,
        gpuBackends,
        igpuBackends,
        openClBackends,
        maxAdrenoVersion,
        sawMaliGpu,
        isOpenCl,
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
    std::optional<int>* outAdrenoVersion, const bool isFinetuning,
    bool* outIsMaliGpu) {

  std::vector<std::string> gpuBackends;
  std::vector<std::string> igpuBackends;
  std::vector<std::string> openClBackends;
  std::vector<std::string> rejectedDevices;
  std::optional<int> maxAdrenoVersion;
  bool sawMaliGpu = false;

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
              maxAdrenoVersion,
              sawMaliGpu,
              rejectedDevices);
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
          maxAdrenoVersion,
          sawMaliGpu,
          rejectedDevices);
    }
  }

  auto clearAllGpuBackends = [&]() {
    openClBackends.clear();
    gpuBackends.clear();
    igpuBackends.clear();
  };

  const bool noMainGpuOverride = !mainGpu.has_value();
  const bool isAdreno = maxAdrenoVersion.has_value();
  const bool hadEligibleGpu =
      !openClBackends.empty() || !gpuBackends.empty() || !igpuBackends.empty();

  if (auto unsupported = getUnknownFinetuneArchitecture(metadata);
      isFinetuning && unsupported) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "Finetuning is not supported for architecture: " + unsupported.value());
  }

  const bool isBitnetOneBit = isBitnetOneBitModel(metadata);

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
  if (outIsMaliGpu != nullptr) {
    *outIsMaliGpu = sawMaliGpu;
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

  if (preferredBackendType == BackendType::GPU && !hadEligibleGpu &&
      !rejectedDevices.empty() && bckI.llamaLogCallback != nullptr) {
    std::string message = "No eligible GPU backend found; rejected ";
    for (size_t index = 0; index < rejectedDevices.size(); ++index) {
      if (index > 0) {
        message += ", ";
      }
      message += rejectedDevices[index];
    }
    message += "; falling back to CPU";
    bckI.llamaLogCallback(GGML_LOG_LEVEL_WARN, message.c_str(), nullptr);
  }

  bckI.llamaLogCallback(GGML_LOG_LEVEL_INFO, "Chosen CPU", nullptr);
  return {BackendType::CPU, "none"};
};

std::pair<BackendType, std::string> backend_selection::chooseBackend(
    const BackendType preferredBackendType, llamaLogCallbackF llamaLogcallback,
    const std::optional<MainGpu>& mainGpu, const ModelMetaData* metadata,
    std::optional<int>* outAdrenoVersion, const bool isFinetuning,
    bool* outIsMaliGpu) {
  BackendInterface bckI{
      ggml_backend_dev_count,
      ggml_backend_dev_backend_reg,
      ggml_backend_dev_get,
      ggml_backend_reg_name,
      ggml_backend_dev_description,
      ggml_backend_dev_name,
      ggml_backend_dev_type,
      ggml_backend_dev_get_props,
      llamaLogcallback};
  return backend_selection::chooseBackend(
      preferredBackendType,
      bckI,
      metadata,
      mainGpu,
      outAdrenoVersion,
      isFinetuning,
      outIsMaliGpu);
}

size_t
backend_selection::getEffectiveGpuDeviceCount(const BackendInterface& bckI) {
  return getSplitDeviceSelection(bckI).devices.size();
}

backend_selection::SplitDeviceSelection
backend_selection::getSplitDeviceSelection(const BackendInterface& bckI) {
  SplitDeviceSelection result;
  std::vector<SplitDevice> rpc;
  std::vector<SplitDevice> discrete;
  std::vector<SplitDevice> integrated;
  std::unordered_set<std::string> seenDiscrete;

  const size_t totalDevices = bckI.ggml_backend_dev_count();
  for (size_t i = 0; i < totalDevices; ++i) {
    ggml_backend_dev_t dev = bckI.ggml_backend_dev_get(i);
    const enum ggml_backend_dev_type devType = bckI.ggml_backend_dev_type(dev);
    if (devType != GGML_BACKEND_DEVICE_TYPE_GPU &&
        devType != GGML_BACKEND_DEVICE_TYPE_IGPU) {
      continue;
    }
    const size_t sourceGpuIndex = result.sourceGpuCount++;
    if (!isEligibleGpuDevice(bckI, dev)) {
      result.rejectedDevices.emplace_back(deviceIdentity(bckI, dev));
      continue;
    }
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
    const char* namePtr = bckI.ggml_backend_dev_name(dev);
    // The name identifies the device in the pinned-device log and, for the
    // primary, becomes mmproj_backend, so an empty one is rejected like null.
    if (namePtr == nullptr || *namePtr == '\0') {
      result.rejectedDevices.emplace_back(deviceIdentity(bckI, dev));
      continue;
    }
    const ggml_backend_reg_t reg = bckI.ggml_backend_dev_backend_reg(dev);
    const std::string registryName =
        lowerCopy(reg != nullptr ? bckI.ggml_backend_reg_name(reg) : nullptr);
    const std::string deviceName = lowerCopy(namePtr);
    const std::string description =
        lowerCopy(bckI.ggml_backend_dev_description(dev));
    SplitDevice selected{
        .name = namePtr,
        .handle = dev,
        .sourceGpuIndex = sourceGpuIndex,
        .isRpc = hasBackendFamily(deviceName, registryName, "rpc"),
        .adrenoVersion = parseAdrenoVersion(description),
        .isOpenCl = hasBackendFamily(deviceName, registryName, "opencl"),
        .isMetal = hasMetalFamily(deviceName, registryName)};
    if (selected.isRpc) {
      rpc.emplace_back(std::move(selected));
      continue;
    }
    // Deliberate divergence from fabric 10549, which main pins: its
    // llama_prepare_model_devices (src/llama.cpp:265-273) keeps the first iGPU
    // plus every further one from the SAME registry; this keeps one, as do
    // embed and model-fit, and as ocr-ggml and vla-ggml do by resolving to a
    // single device. It NARROWS the deleted getTensorSplitDeviceNames, which
    // kept every iGPU deduplicated by device_id, but one shared rule across
    // the change set was judged worth more. Unobservable on shipped configs: a
    // host would need two IGPU-typed devices from one registry, and Metal and
    // OpenCL always report GPU, never IGPU (ggml-metal.cpp:685-689,
    // ggml-opencl.cpp:11459-11463), while Vulkan dedupes by UUID/LUID first
    // (ggml-vulkan.cpp:8843-8872, comparison at 8861-8865) — except between
    // two MoltenVK drivers (8866-8868), which report one UUID for distinct
    // GPUs, so the exception is a multi-GPU Apple card under MoltenVK.
    // Revisit as a fleet-wide 10549 decision, not here. Pinned by
    // BackendSelectionTest.SplitSelectionKeepsSingleIntegratedGpu.
    if (devType == GGML_BACKEND_DEVICE_TYPE_IGPU) {
      if (integrated.empty()) {
        integrated.emplace_back(std::move(selected));
      }
      continue;
    }
    // A null device_id cannot be deduped against; keep the device rather than
    // dropping it, since omitting a real GPU is worse than a duplicate. This
    // mirrors fabric, whose find_if only matches when both ids are non-null.
    if (deviceId.empty() || seenDiscrete.insert(deviceId).second) {
      discrete.emplace_back(std::move(selected));
    }
  }
  result.devices = std::move(rpc);
  auto& local = discrete.empty() ? integrated : discrete;
  result.devices.insert(
      result.devices.end(),
      std::make_move_iterator(local.begin()),
      std::make_move_iterator(local.end()));
  return result;
}

backend_selection::SplitDeviceSelection
backend_selection::getSplitDeviceSelection() {
  BackendInterface bckI{
      ggml_backend_dev_count,
      ggml_backend_dev_backend_reg,
      ggml_backend_dev_get,
      ggml_backend_reg_name,
      ggml_backend_dev_description,
      ggml_backend_dev_name,
      ggml_backend_dev_type,
      ggml_backend_dev_get_props,
      nullptr};
  return getSplitDeviceSelection(bckI);
}

void backend_selection::applyAdrenoRestrictions(
    SplitDeviceSelection& selection, const ModelMetaData& metadata,
    const bool isFinetuning) {
  const bool isBitnetOneBit = isBitnetOneBitModel(&metadata);
  if ((!isFinetuning && !isBitnetOneBit) || selection.devices.empty()) {
    return;
  }

  // The MAX tier across participants rather than a per-device test, matching
  // chooseBackend's host-wide maxAdrenoVersion. Reproduced over the SPLIT SET:
  // chooseBackend takes its maximum over a wider set that is not deduplicated
  // and has no discrete-over-integrated preference, so the two can differ on a
  // host where an Adreno is in one set and not the other. A device with no
  // tier is not an Adreno and never triggers the rule on its own.
  std::optional<int> maxAdrenoVersion;
  for (const SplitDevice& device : selection.devices) {
    if (device.adrenoVersion.has_value() &&
        (!maxAdrenoVersion.has_value() ||
         device.adrenoVersion.value() > maxAdrenoVersion.value())) {
      maxAdrenoVersion = device.adrenoVersion;
    }
  }
  if (!maxAdrenoVersion.has_value()) {
    return;
  }

  const char* workload = isFinetuning ? "Finetuning" : "BitNet TQ";
  if (maxAdrenoVersion.value() < kAdreno800Threshold) {
    LOG_WRN(
        "%s on Adreno <800 (%d): only CPU supported; dropping all %zu split "
        "device(s) and falling back to CPU\n",
        workload,
        maxAdrenoVersion.value(),
        selection.devices.size());
    selection.devices.clear();
    return;
  }
  const size_t before = selection.devices.size();
  std::erase_if(selection.devices, [](const SplitDevice& device) {
    return device.isOpenCl;
  });
  if (selection.devices.size() != before) {
    LOG_WRN(
        "%s on Adreno 800+ (%d): preferring Vulkan over OpenCL; dropped %zu "
        "OpenCL split device(s)\n",
        workload,
        maxAdrenoVersion.value(),
        before - selection.devices.size());
  }
}

std::vector<std::string>
backend_selection::getSplitDeviceNames(const BackendInterface& bckI) {
  const SplitDeviceSelection selection = getSplitDeviceSelection(bckI);
  std::vector<std::string> names;
  names.reserve(selection.devices.size());
  for (const SplitDevice& device : selection.devices) {
    names.push_back(device.name);
  }
  return names;
}
