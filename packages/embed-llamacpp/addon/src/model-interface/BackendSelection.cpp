#include "BackendSelection.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <optional>
#include <string_view>
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

void emplaceIfValidDevice(
    const BackendInterface& bckI, std::vector<std::string>& gpuBackends,
    std::vector<std::string>& igpuBackends,
    std::vector<std::string>& openClBackends,
    std::vector<std::string>& cudaBackends,
    std::vector<std::string>& otherOpenClBackends, const ggml_backend_reg_t reg,
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
        devDescr.gpuDescription.find("adreno") != std::string::npos;
    // QVAC-23763: ggml-cuda names its devices "CUDA%d". ggml-hip reports
    // "ROCm%d" instead, so this cannot collide with an AMD device.
    const bool isCuda = devDescr.gpuBackend.find("cuda") != std::string::npos;
    if (isOpenCl && isAdreno) {
      logEmplaceGpuBackend(devDescr.gpuBackend);
      openClBackends.emplace_back(devDescr.gpuBackend);
    } else if (isOpenCl) {
      // QVAC-23763: a non-Adreno OpenCL device is deliberately kept out of the
      // default cascade, which is Adreno-tuned. It goes in its own bucket so an
      // explicit backend:'opencl' can still reach it, instead of `opencl` being
      // an accepted family that matches nothing on an Intel or AMD host.
      logEmplaceGpuBackend(devDescr.gpuBackend);
      otherOpenClBackends.emplace_back(devDescr.gpuBackend);
    } else {
      logEmplaceGpuBackend(devDescr.gpuBackend);
      if (isCuda && backendTypeEnum == GGML_BACKEND_DEVICE_TYPE_GPU) {
        cudaBackends.emplace_back(devDescr.gpuBackend);
      } else if (backendTypeEnum == GGML_BACKEND_DEVICE_TYPE_GPU) {
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
    std::vector<std::string>& cudaBackends,
    std::vector<std::string>& otherOpenClBackends) {
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
        cudaBackends,
        otherOpenClBackends,
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
/// some builds report "mtl..." instead of "Metal", which BertModel already
/// special-cases the same way.
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
    const std::optional<MainGpu>& mainGpu,
    const std::vector<std::string>& backendOverride) {

  std::vector<std::string> gpuBackends;
  std::vector<std::string> igpuBackends;
  std::vector<std::string> openClBackends;
  std::vector<std::string> cudaBackends;
  // Non-Adreno OpenCL: reachable only through an explicit backend override.
  std::vector<std::string> otherOpenClBackends;

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
              openClBackends,
              cudaBackends,
              otherOpenClBackends);
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
          otherOpenClBackends);
    }
  }

  // QVAC-23763: an explicit `backend` override wins over the cascade below.
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

  // check if Adreno GPU is present and force OpenCL backend, otherwise let
  // llama.cpp choose Vulkan GPU backend
  if (!openClBackends.empty()) {
    bckI.llamaLogCallback(GGML_LOG_LEVEL_INFO, "Chosen GPU OpenCL", nullptr);
    return {BackendType::GPU, openClBackends.front()};
  }

  // Before the generic GPU bucket, which is where Vulkan lands.
  if (!cudaBackends.empty()) {
    bckI.llamaLogCallback(GGML_LOG_LEVEL_INFO, "Chosen GPU CUDA", nullptr);
    return {BackendType::GPU, cudaBackends.front()};
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
    const std::optional<MainGpu>& mainGpu,
    const std::vector<std::string>& backendOverride) {
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
  return backend_selection::chooseBackend(
      preferredBackendType, bckI, mainGpu, backendOverride);
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
  std::vector<std::string> selectedIds;
  for (const auto& candidate : devices) {
    if (!candidate.isIgpu && candidate.registry == selectedRegistry &&
        !candidate.deviceId.empty()) {
      selectedIds.push_back(candidate.deviceId);
    }
  }

  std::vector<std::string> names;
  std::vector<std::string> seenIds;
  for (const auto& candidate : devices) {
    if (candidate.isIgpu) {
      continue;
    }
    // No bus id to compare on, so fall back to registry scoping. Keeping such
    // a device could list one physical card twice, which is the failure this
    // function exists to prevent, and qvac-fabric treats a null id as
    // non-matching for the same reason.
    if (candidate.deviceId.empty()) {
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
  return backend_selection::splitModeDeviceNames(bckI, selectedDeviceName);
}
