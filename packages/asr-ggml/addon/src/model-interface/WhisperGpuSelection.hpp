#pragma once

#include <algorithm>
#include <cctype>
#include <string>
#include <vector>

#include <ggml-backend.h>

#include "MainGpuSelection.hpp"

namespace main_gpu {

inline std::string lower(const char* value) {
  std::string result = value != nullptr ? value : "";
  std::transform(
      result.begin(), result.end(), result.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
      });
  return result;
}

struct GgmlRegistry {
  size_t count() const { return ggml_backend_dev_count(); }
  ggml_backend_dev_t get(size_t index) const {
    return ggml_backend_dev_get(index);
  }
  auto type(ggml_backend_dev_t dev) const { return ggml_backend_dev_type(dev); }
  const char* backend(ggml_backend_dev_t dev) const {
    const auto reg = ggml_backend_dev_backend_reg(dev);
    return reg != nullptr ? ggml_backend_reg_name(reg) : nullptr;
  }
  const char* description(ggml_backend_dev_t dev) const {
    return ggml_backend_dev_description(dev);
  }
  const char* name(ggml_backend_dev_t dev) const {
    return ggml_backend_dev_name(dev);
  }
};

// Formatted "name (registry)" identity used in the CPU-fallback warning so
// operators can trace which physical device the allowlist or Adreno guard
// refused. Empty registry name reads as `unknown-registry` to keep the string
// unambiguous.
template <typename Registry, typename Dev>
std::string deviceIdentity(const Registry& registry, Dev dev) {
  const char* namePtr = registry.name(dev);
  const char* regPtr = registry.backend(dev);
  const std::string name = namePtr != nullptr ? namePtr : "unnamed";
  const std::string reg = regPtr != nullptr ? regPtr : "unknown-registry";
  return name + " (" + reg + ")";
}

// The registry adapter lets tests exercise the same enumeration and ordinal
// translation as the loader, including CPU/null slots and backend identities.
template <typename Registry = GgmlRegistry>
std::vector<Device> registryDevices(const Registry& registry = {}) {
  std::vector<Device> devices(registry.count());
  std::vector<bool> adrenoVulkan(devices.size(), false);
  int whisperIndex = 0;
  bool hasAdrenoOpencl = false;
  for (size_t i = 0; i < devices.size(); ++i) {
    auto dev = registry.get(i);
    if (dev == nullptr)
      continue;
    const auto type = registry.type(dev);
    if (type != GGML_BACKEND_DEVICE_TYPE_GPU &&
        type != GGML_BACKEND_DEVICE_TYPE_IGPU)
      continue;
    auto& device = devices[i];
    device.whisperIndex = whisperIndex++;
    const auto backend = lower(registry.backend(dev));
    const auto description = lower(registry.description(dev));
    const bool adreno = description.find("adreno") != std::string::npos;
    device.adrenoOpencl = backend == "opencl" && adreno;
    device.integrated =
        type == GGML_BACKEND_DEVICE_TYPE_IGPU || device.adrenoOpencl;
    // Families provided by the pinned ggml-speech port features. Metal
    // registers as MTL; retain Metal as a compatibility spelling. Every other
    // family (HIP/ROCm, SYCL, MUSA, RPC, unknown) is refused with its identity
    // captured for the CPU-fallback warning.
    device.eligible = backend == "mtl" || backend == "metal" ||
                      backend == "cuda" || backend == "vulkan" ||
                      backend == "opencl";
    hasAdrenoOpencl = hasAdrenoOpencl || device.adrenoOpencl;
    adrenoVulkan[i] = backend == "vulkan" && adreno;
    device.identity = deviceIdentity(registry, dev);
  }
  // Preserve the existing Adreno guard without redirecting an explicit index.
  // Selecting a refused Vulkan slot must use CPU, never its OpenCL sibling.
  if (hasAdrenoOpencl) {
    for (size_t i = 0; i < devices.size(); ++i) {
      if (adrenoVulkan[i])
        devices[i].eligible = false;
    }
  }
  return devices;
}

struct WhisperLoadSelection {
  bool useGpu = false;
  int gpuDevice = 0;
  bool outOfRange = false;
  bool warnMissingGpuFallback = false;
  std::vector<std::string> refused;
};

template <typename ConfigMap, typename Registry>
WhisperLoadSelection resolveWhisperLoadSelection(
    bool useGpu, int gpuDevice, bool hasLegacyGpuDevice,
    const ConfigMap& config, const Registry& registry) {
  if (!useGpu || hasLegacyGpuDevice) {
    return {useGpu, gpuDevice};
  }

  const auto selected = select(registryDevices(registry), parse(config));
  WhisperLoadSelection resolved{
      selected.whisperIndex >= 0,
      gpuDevice,
      selected.outOfRange,
      false,
      selected.refused};
  if (resolved.useGpu) {
    resolved.gpuDevice = selected.whisperIndex;
  } else {
    resolved.warnMissingGpuFallback = resolved.refused.empty();
  }
  return resolved;
}

template <typename ConfigMap>
WhisperLoadSelection resolveWhisperLoadSelection(
    bool useGpu, int gpuDevice, bool hasLegacyGpuDevice,
    const ConfigMap& config) {
  return resolveWhisperLoadSelection(
      useGpu, gpuDevice, hasLegacyGpuDevice, config, GgmlRegistry{});
}

} // namespace main_gpu
