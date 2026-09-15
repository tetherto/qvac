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

// Only the linux overload of shouldWarnAboutJitCache() reads the environment,
// so these stay inside the guard rather than looking unused elsewhere.
#if defined(__linux__)
#include <cstdlib>
#include <filesystem>

#include <unistd.h>
#endif

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

// Adreno tier at and above which the restricted workloads run on Vulkan
// instead of the CPU.
constexpr int K_ADRENO800_THRESHOLD = 800;

// One-bit BitNet is the TQ1_0/TQ2_0 quantizations.
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

bool isRpcDevice(const BackendInterface& bckI, const ggml_backend_dev_t dev) {
  const ggml_backend_reg_t reg = bckI.ggml_backend_dev_backend_reg(dev);
  return hasBackendFamily(
      lowerCopy(bckI.ggml_backend_dev_name(dev)),
      lowerCopy(reg != nullptr ? bckI.ggml_backend_reg_name(reg) : nullptr),
      "rpc");
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
    std::vector<std::string>& cudaBackends,
    std::vector<std::string>& otherOpenClBackends,
    std::optional<int>& maxAdrenoVersion, bool& sawMaliGpu, const bool isOpenCl,
    const bool isRpc, const DeviceDescription& devDescr,
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
  if (!isRpc && devDescr.gpuDescription.find("mali") != std::string::npos) {
    sawMaliGpu = true;
  }
  // RPC is skipped: its description is the endpoint string, so a class parsed
  // off one is a hostname.
  if (isAdreno && !isRpc) {
    auto version = parseAdrenoVersion(devDescr.gpuDescription);
    if (version.has_value() && (!maxAdrenoVersion.has_value() ||
                                version.value() > maxAdrenoVersion.value())) {
      maxAdrenoVersion = version;
    }
  }
  const bool isCuda = devDescr.gpuBackend.find("cuda") != std::string::npos;
  if (isOpenCl && isAdreno) {
    logEmplaceGpuBackend(devDescr.gpuBackend);
    openClBackends.emplace_back(devDescr.gpuBackend);
  } else if (isOpenCl) {
    logEmplaceGpuBackend(devDescr.gpuBackend);
    otherOpenClBackends.emplace_back(devDescr.gpuBackend);
  } else if (!isOpenCl) {
    logEmplaceGpuBackend(devDescr.gpuBackend);
    if (isCuda) {
      cudaBackends.emplace_back(devDescr.gpuBackend);
    } else if (backendTypeEnum == GGML_BACKEND_DEVICE_TYPE_GPU) {
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
    std::vector<std::string>& cudaBackends,
    std::vector<std::string>& otherOpenClBackends,
    std::optional<int>& maxAdrenoVersion, bool& sawMaliGpu,
    std::vector<std::string>& rejectedDevices,
    const bool allowNonAdrenoOpenCl) {
  const ggml_backend_dev_t dev = bckI.ggml_backend_dev_get(deviceIndex);
  const enum ggml_backend_dev_type backendTypeEnum =
      bckI.ggml_backend_dev_type(dev);
  const DeviceDescription devDescr(dev, backendTypeEnum, bckI);
  const bool isOpenCl = isOpenClDevice(bckI, dev, devDescr);
  const bool isGpuType = backendTypeEnum == GGML_BACKEND_DEVICE_TYPE_GPU ||
                         backendTypeEnum == GGML_BACKEND_DEVICE_TYPE_IGPU;
  // Recorded before the main-gpu type filter so the CPU-fallback warning names
  // a refused device even when `integrated`/`dedicated` skips its type.
  if (isGpuType && !isEligibleGpuDevice(bckI, dev) &&
      !(allowNonAdrenoOpenCl && isOpenCl)) {
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
        cudaBackends,
        otherOpenClBackends,
        maxAdrenoVersion,
        sawMaliGpu,
        isOpenCl,
        ::isRpcDevice(bckI, dev),
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

namespace {

// Backend families qvac-fabric can register a GPU device for. Used to tell a
// mistyped `backend` value (hard error) apart from a correctly-spelled backend
// that simply has no device on this machine (falls through). Deliberately does
// NOT include "cpu": the CPU path is `device`, and accepting two spellings for
// it would make `device: 'gpu', backend: 'cpu'` ambiguous.
constexpr std::array<std::string_view, 7> KNOWN_GPU_BACKEND_FAMILIES = {
    "cuda", "vulkan", "metal", "opencl", "hip", "rocm", "sycl"};

// Trimmed from each family. \r matters: a value from a CRLF config file would
// otherwise throw "unknown backend 'cuda\r'", which renders identically to the
// accepted spelling.
constexpr std::string_view K_BACKEND_TRIM = " \t\r\n\v\f";

/// Whether a ggml device backend name belongs to the requested family.
/// Substring rather than equality because ggml suffixes the device index
/// ("CUDA0", "Vulkan1") and OpenCL reports as "GPUOpenCL". Metal is special:
/// some builds report "mtl..." instead of "Metal", which LoadFitNormalization
/// already special-cases the same way.
bool backendNameMatchesFamily(
    const std::string& lowercasedBackendName, std::string_view family) {
  if (lowercasedBackendName.find(family) != std::string::npos) {
    return true;
  }
  return family == "metal" && lowercasedBackendName.rfind("mtl", 0) == 0;
}

} // namespace

std::vector<std::string>
backend_selection::parseBackendOverride(const std::string& backendStr) {
  std::vector<std::string> families;
  std::string current;
  // Set for any non-blank token, 'auto' included, so 'auto' on its own is not
  // then rejected by the names-no-backend check below.
  bool namedAnyBackend = false;
  auto flush = [&]() {
    const auto begin = current.find_first_not_of(K_BACKEND_TRIM);
    if (begin == std::string::npos) {
      return;
    }
    const auto end = current.find_last_not_of(K_BACKEND_TRIM);
    std::string family = current.substr(begin, end - begin + 1);
    // Cast to unsigned char: std::tolower takes an int and is undefined for a
    // negative value, which a signed char is for any byte >= 0x80. `backend`
    // is caller-supplied, so it can carry non-ASCII.
    std::ranges::transform(family, family.begin(), [](unsigned char c) {
      return static_cast<char>(std::tolower(c));
    });
    namedAnyBackend = true;
    // 'auto' is vla-ggml's documented default for this same key, so accept and
    // drop it here rather than rejecting a selector that works on that addon.
    // 'auto' alone yields no families, which callers already read as no
    // override.
    if (family == "auto") {
      return;
    }
    if (std::ranges::find(KNOWN_GPU_BACKEND_FAMILIES, family) ==
        KNOWN_GPU_BACKEND_FAMILIES.end()) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          string_format(
              "backend: unknown backend '%s'. Expected a comma-separated list "
              "of cuda/vulkan/metal/opencl/hip/rocm/sycl or 'auto', for "
              "example "
              "'cuda,vulkan'. To run on CPU use device 'cpu' instead.\n",
              family.c_str()));
    }
    // ggml's HIP build names its devices "ROCm%d" (GGML_CUDA_NAME in
    // ggml-cuda.h), so a family kept as "hip" matches no device name at all.
    // Canonicalise to the spelling ggml actually reports; both spellings stay
    // accepted on the way in, and the dedup below then merges "hip,rocm".
    if (family == "hip") {
      family = "rocm";
    }
    if (std::ranges::find(families, family) == families.end()) {
      families.emplace_back(std::move(family));
    }
  };
  for (const char c : backendStr) {
    if (c == ',') {
      flush();
      current.clear();
    } else {
      current.push_back(c);
    }
  }
  flush();
  // An absent or blank value means the key was not configured. Anything else
  // that parses to zero families, "," or ",,", is a config mistake and gets the
  // same hard error as a misspelled name.
  if (families.empty() && !namedAnyBackend &&
      backendStr.find_first_not_of(K_BACKEND_TRIM) != std::string::npos) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        string_format(
            "backend: '%s' names no backend. Expected a comma-separated list "
            "of cuda/vulkan/metal/opencl/hip/rocm/sycl or 'auto', for example "
            "'cuda,vulkan'. To run on CPU use device 'cpu' instead.\n",
            backendStr.c_str()));
  }
  return families;
}

std::vector<std::string> backend_selection::tryBackendOverrideFromMap(
    std::unordered_map<std::string, std::string>& configFilemap) {
  auto it = configFilemap.find("backend");
  if (it == configFilemap.end()) {
    return {};
  }
  std::vector<std::string> families = parseBackendOverride(it->second);
  configFilemap.erase(it);
  return families;
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
    bool* outIsMaliGpu, const std::vector<std::string>& backendOverride) {

  std::vector<std::string> gpuBackends;
  std::vector<std::string> igpuBackends;
  std::vector<std::string> openClBackends;
  std::vector<std::string> cudaBackends;
  std::vector<std::string> otherOpenClBackends;
  std::vector<std::string> rejectedDevices;
  const bool allowNonAdrenoOpenCl =
      std::ranges::find(backendOverride, "opencl") != backendOverride.end();
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
              cudaBackends,
              otherOpenClBackends,
              maxAdrenoVersion,
              sawMaliGpu,
              rejectedDevices,
              allowNonAdrenoOpenCl);
          loopAllDevices = false;
        } else {
          std::string errorMsg;
          if (deviceCount == 0) {
            errorMsg = string_format(
                "main-gpu device index %d is out of range: no devices are "
                "available",
                deviceIndex);
          } else {
            errorMsg = string_format(
                "main-gpu device index %d is out of range (0-%zu)",
                deviceIndex,
                deviceCount - 1);
          }
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
          cudaBackends,
          otherOpenClBackends,
          maxAdrenoVersion,
          sawMaliGpu,
          rejectedDevices,
          allowNonAdrenoOpenCl);
    }
  }

  auto clearAllGpuBackends = [&]() {
    openClBackends.clear();
    cudaBackends.clear();
    gpuBackends.clear();
    igpuBackends.clear();
    otherOpenClBackends.clear();
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
    if (maxAdrenoVersion.value() >= K_ADRENO800_THRESHOLD) {
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
    if (isBitnetOneBit && maxAdrenoVersion.value() < K_ADRENO800_THRESHOLD) {
      bckI.llamaLogCallback(
          GGML_LOG_LEVEL_INFO,
          "BitNet TQ on Adreno <800: only CPU supported",
          nullptr);
      clearAllGpuBackends();
    } else if (
        isBitnetOneBit && maxAdrenoVersion.value() >= K_ADRENO800_THRESHOLD) {
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

  // QVAC-23763: an explicit `backend` override wins over the cascade below,
  // but only over candidates that survived the guards above: a request for a
  // backend that was just cleared (BitNet TQ on Adreno <800, finetuning on
  // Adreno <800) must not resurrect it.
  //
  // Skipped entirely for a CPU load. No devices are enumerated in that case, so
  // the block could only ever reach its "matched no available device" warning,
  // which would be noise on a deliberate device:'cpu' request.
  if (!backendOverride.empty() && preferredBackendType == BackendType::GPU) {
    for (const std::string& family : backendOverride) {
      for (const std::vector<std::string>* candidates :
           {&openClBackends,
            &cudaBackends,
            &gpuBackends,
            &igpuBackends,
            &otherOpenClBackends}) {
        for (const std::string& name : *candidates) {
          if (::backendNameMatchesFamily(name, family)) {
            std::string text = string_format(
                "Chosen %s Backend (backend override)", family.c_str());
            bckI.llamaLogCallback(GGML_LOG_LEVEL_INFO, text.c_str(), nullptr);
            return {BackendType::GPU, name};
          }
        }
      }
    }
    bckI.llamaLogCallback(
        GGML_LOG_LEVEL_WARN,
        "backend override matched no available device; falling back to the "
        "default backend order",
        nullptr);
  }

  if (!openClBackends.empty()) {
    bckI.llamaLogCallback(GGML_LOG_LEVEL_INFO, "Chosen GPU OpenCL", nullptr);
    return {BackendType::GPU, openClBackends.front()};
  }

  // Before the generic GPU bucket, which is where Vulkan lands.
  if (!cudaBackends.empty()) {
    bckI.llamaLogCallback(GGML_LOG_LEVEL_INFO, "Chosen GPU CUDA", nullptr);
    return {BackendType::GPU, cudaBackends.front()};
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

bool backend_selection::shouldWarnAboutJitCache(const JitCacheEnv& env) {
  if (env.cacheDisabled) {
    return true;
  }
  return !env.haveCacheDir || !env.cacheDirWritable;
}

#if defined(__linux__)
bool backend_selection::shouldWarnAboutJitCache() {
  JitCacheEnv env;

  // The driver treats any value other than "0" as disabling the cache.
  if (const char* disable = std::getenv("CUDA_CACHE_DISABLE");
      disable != nullptr && *disable != '\0' &&
      std::string_view(disable) != "0") {
    env.cacheDisabled = true;
  }

  // CUDA_CACHE_PATH wins, otherwise the driver's default.
  std::filesystem::path dir;
  if (const char* explicitPath = std::getenv("CUDA_CACHE_PATH");
      explicitPath != nullptr && *explicitPath != '\0') {
    dir = explicitPath;
  } else if (
      const char* home = std::getenv("HOME");
      home != nullptr && *home != '\0') {
    dir = std::filesystem::path(home) / ".nv" / "ComputeCache";
  }
  env.haveCacheDir = !dir.empty();

  // Walk up to the nearest ancestor that exists and ask whether it is writable.
  // Checking the leaf alone reports "missing" for the common first-run case,
  // where the driver would simply create it. Nothing is created here: probing
  // must not have side effects on a host that turns out to be read-only anyway.
  if (env.haveCacheDir) {
    std::error_code ec;
    std::filesystem::path probe = dir;
    while (!probe.empty() && !std::filesystem::exists(probe, ec)) {
      const std::filesystem::path parent = probe.parent_path();
      if (parent == probe) {
        break;
      }
      probe = parent;
    }
    env.cacheDirWritable = !probe.empty() &&
                           std::filesystem::exists(probe, ec) &&
                           ::access(probe.c_str(), W_OK) == 0;
  }

  return shouldWarnAboutJitCache(env);
}
#else
bool backend_selection::shouldWarnAboutJitCache() { return false; }
#endif

std::pair<BackendType, std::string> backend_selection::chooseBackend(
    const BackendType preferredBackendType, llamaLogCallbackF llamaLogcallback,
    const std::optional<MainGpu>& mainGpu, const ModelMetaData* metadata,
    std::optional<int>* outAdrenoVersion, const bool isFinetuning,
    bool* outIsMaliGpu, const std::vector<std::string>& backendOverride) {
  BackendInterface bckI{
      ggml_backend_dev_count,
      ggml_backend_dev_backend_reg,
      ggml_backend_dev_get,
      ggml_backend_reg_name,
      ggml_backend_dev_description,
      ggml_backend_dev_name,
      ggml_backend_dev_type,
      ggml_backend_reg_get_proc_address,
      ggml_backend_dev_get_props,
      llamaLogcallback};
  std::pair<BackendType, std::string> selected =
      backend_selection::chooseBackend(
          preferredBackendType,
          bckI,
          metadata,
          mainGpu,
          outAdrenoVersion,
          isFinetuning,
          outIsMaliGpu,
          backendOverride);

  // Only on the real path, and only once a CUDA device actually won: the inner
  // overload is what the unit tests drive, and it must not touch the
  // filesystem. The device name is checked rather than the bucket, because a
  // unified-memory card such as the GB10 registers CUDA as an iGPU and is
  // selected through the iGPU branch.
  if (selected.first == BackendType::GPU &&
      selected.second.find("cuda") != std::string::npos &&
      shouldWarnAboutJitCache()) {
    llamaLogcallback(
        GGML_LOG_LEVEL_WARN,
        "CUDA PTX JIT cache is unwritable or disabled; if this GPU has no "
        "precompiled kernels in this build, every process start pays the full "
        "JIT cost (measured at 27s on sm_121) instead of only the first. Set "
        "CUDA_CACHE_PATH to a writable path that survives restarts.",
        nullptr);
  }
  return selected;
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
    // The primary device's name becomes mmproj_backend, so an empty name is
    // rejected like a null one.
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
    // Keep the first integrated GPU plus every later one whose backend registry
    // HANDLE matches the last kept one's, as qvac-fabric does. Identity, not
    // name: one device seen by two backends is a duplicate, several devices
    // from one backend are not.
    if (devType == GGML_BACKEND_DEVICE_TYPE_IGPU) {
      if (integrated.empty() ||
          reg == bckI.ggml_backend_dev_backend_reg(integrated.back().handle)) {
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
      ggml_backend_reg_get_proc_address,
      ggml_backend_dev_get_props,
      nullptr};
  return getSplitDeviceSelection(bckI);
}

bool backend_selection::gpuBackendSupportsRowSplit(
    const BackendInterface& bckI) {
  // Mirror what qvac-fabric actually checks: llama_model::load_tensors() calls
  // make_gpu_buft_list() for EVERY device it was given and throws "device %s
  // does not support split buffers" on the first one whose backend registry
  // lacks `ggml_backend_split_buffer_type`. So require all of them, not any
  // one, and treat "no GPU devices at all" as unsupported.
  //
  // QVAC-23763: split mode now scopes `--device` to one registry (see
  // splitModeDeviceNames), so qvac-fabric sees a narrower set than is checked
  // here. Left registry-wide on purpose: that only degrades row to layer sooner
  // than needed, never the other way, and no shipped backend has split buffers.
  size_t gpuDevices = 0;
  const size_t totalDevices = bckI.ggml_backend_dev_count();
  for (size_t i = 0; i < totalDevices; ++i) {
    ggml_backend_dev_t dev = bckI.ggml_backend_dev_get(i);
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
      ggml_backend_dev_count,
      ggml_backend_dev_backend_reg,
      ggml_backend_dev_get,
      ggml_backend_reg_name,
      ggml_backend_dev_description,
      ggml_backend_dev_name,
      ggml_backend_dev_type,
      ggml_backend_reg_get_proc_address,
      ggml_backend_dev_get_props,
      nullptr};
  return gpuBackendSupportsRowSplit(bckI);
}

void backend_selection::applyAdrenoRestrictions(
    SplitDeviceSelection& selection, const ModelMetaData& metadata,
    const bool isFinetuning) {
  const bool isBitnetOneBit = isBitnetOneBitModel(&metadata);
  if ((!isFinetuning && !isBitnetOneBit) || selection.devices.empty()) {
    return;
  }

  // Max tier across local participants. RPC is skipped: its description is the
  // endpoint string, so a tier parsed from it is a hostname.
  std::optional<int> maxAdrenoVersion;
  for (const SplitDevice& device : selection.devices) {
    if (!device.isRpc && device.adrenoVersion.has_value() &&
        (!maxAdrenoVersion.has_value() ||
         device.adrenoVersion.value() > maxAdrenoVersion.value())) {
      maxAdrenoVersion = device.adrenoVersion;
    }
  }
  if (!maxAdrenoVersion.has_value()) {
    return;
  }

  const char* workload = isFinetuning ? "Finetuning" : "BitNet TQ";
  if (maxAdrenoVersion.value() < K_ADRENO800_THRESHOLD) {
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

std::vector<std::string> backend_selection::splitModeDeviceNames(
    const BackendInterface& bckI, const std::string& selectedDeviceName) {
  // Kept in ggml's enumeration order, so the list matches what qvac-fabric
  // would have discovered on its own.
  struct SplitCandidate {
    std::string registry;
    std::string name;
    std::string deviceId;
    bool isIgpu;
  };
  std::vector<SplitCandidate> devices;
  std::vector<std::string> registries;
  std::string selectedRegistry;
  bool selectedIsIgpu = false;

  const size_t totalDevices = bckI.ggml_backend_dev_count();
  for (size_t i = 0; i < totalDevices; ++i) {
    ggml_backend_dev_t dev = bckI.ggml_backend_dev_get(i);
    const enum ggml_backend_dev_type devType = bckI.ggml_backend_dev_type(dev);
    if (devType != GGML_BACKEND_DEVICE_TYPE_GPU &&
        devType != GGML_BACKEND_DEVICE_TYPE_IGPU) {
      continue;
    }
    ggml_backend_reg_t reg = bckI.ggml_backend_dev_backend_reg(dev);
    if (reg == nullptr) {
      continue;
    }
    std::string registry = bckI.ggml_backend_reg_name(reg);
    // RPC is skipped for the same reason emplaceIfValidDevice skips it: those
    // devices are never candidates for selection in the first place.
    if (registry == "RPC") {
      continue;
    }
    std::string deviceName = bckI.ggml_backend_dev_name(dev);
    std::ranges::transform(deviceName, deviceName.begin(), [](unsigned char c) {
      return static_cast<char>(std::tolower(c));
    });
    const bool isIgpu = devType == GGML_BACKEND_DEVICE_TYPE_IGPU;
    if (deviceName == selectedDeviceName) {
      selectedRegistry = registry;
      selectedIsIgpu = isIgpu;
    }
    if (std::ranges::find(registries, registry) == registries.end()) {
      registries.push_back(registry);
    }
    // Both CUDA and Vulkan publish the PCI bus id here, lowercased and in the
    // same "domain:bus:device.function" form, which is what makes them
    // comparable across registries. An absent id is left empty; see below.
    std::string deviceId;
    if (bckI.ggml_backend_dev_get_props != nullptr) {
      ggml_backend_dev_props props{};
      bckI.ggml_backend_dev_get_props(dev, &props);
      if (props.device_id != nullptr) {
        deviceId = props.device_id;
      }
    }
    devices.push_back(
        {std::move(registry),
         std::move(deviceName),
         std::move(deviceId),
         isIgpu});
  }

  if (registries.size() < 2 || selectedRegistry.empty()) {
    return {};
  }

  // QVAC-23763: mirror qvac-fabric's own iGPU rules, because they only apply on
  // the path this list bypasses. llama_prepare_model_devices() drops iGPUs once
  // any discrete GPU was found and keeps at most one otherwise, but with
  // `--device` set it takes every named device verbatim, so emitting an iGPU
  // beside a discrete card would put layers on hardware it would never have
  // used. A deliberately selected iGPU, `main-gpu: 'integrated'`, is the
  // exception: scope to that one device.
  if (selectedIsIgpu) {
    return {selectedDeviceName};
  }

  // Dedupe by device_id rather than scoping to the selected registry. The
  // hazard this list exists for is one physical card registering under two
  // backends; scoping by registry also dropped a *second* physical card on a
  // mixed-vendor host, an NVIDIA plus a discrete AMD say, which is the very
  // population split mode is for. Preferring the selected registry on a tie
  // keeps an explicit `backend` override binding, which omitting `--device`
  // would not: qvac-fabric's own dedupe keeps whichever backend registered
  // first, and CUDA loads before Vulkan.
  // Deduping needs EVERY selected-registry device to publish a bus id. One that
  // does not leaves no key to match its twin in another registry by, and a
  // partial key list is worse than none: the cross-registry skip below would
  // not fire, so the id-less device and its id-bearing twin would both be
  // emitted, naming one physical card twice. Fall back to registry scoping for
  // the whole list in that case.
  bool selectedRegistryHasAllIds = true;
  std::vector<std::string> selectedIds;
  for (const auto& candidate : devices) {
    if (candidate.isIgpu || candidate.registry != selectedRegistry) {
      continue;
    }
    if (candidate.deviceId.empty()) {
      selectedRegistryHasAllIds = false;
    } else {
      selectedIds.push_back(candidate.deviceId);
    }
  }

  std::vector<std::string> names;
  std::vector<std::string> seenIds;
  for (const auto& candidate : devices) {
    if (candidate.isIgpu) {
      continue;
    }
    // Either there is no usable key set at all, or this particular device has
    // no id to match on. Both reduce to registry scoping, which can never name
    // one card twice.
    if (!selectedRegistryHasAllIds || candidate.deviceId.empty()) {
      if (candidate.registry == selectedRegistry) {
        names.push_back(candidate.name);
      }
      continue;
    }
    if (std::ranges::find(seenIds, candidate.deviceId) != seenIds.end()) {
      continue;
    }
    if (candidate.registry != selectedRegistry &&
        std::ranges::find(selectedIds, candidate.deviceId) !=
            selectedIds.end()) {
      continue;
    }
    seenIds.push_back(candidate.deviceId);
    names.push_back(candidate.name);
  }
  return names;
}

std::vector<std::string>
backend_selection::splitModeDeviceNames(const std::string& selectedDeviceName) {
  BackendInterface bckI{
      ggml_backend_dev_count,
      ggml_backend_dev_backend_reg,
      ggml_backend_dev_get,
      ggml_backend_reg_name,
      ggml_backend_dev_description,
      ggml_backend_dev_name,
      ggml_backend_dev_type,
      ggml_backend_reg_get_proc_address,
      ggml_backend_dev_get_props,
      nullptr};
  return backend_selection::splitModeDeviceNames(bckI, selectedDeviceName);
}
