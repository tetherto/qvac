#pragma once

#include <algorithm>
#include <cctype>
#include <string>

#include <ggml-backend.h>

namespace qvac::asrggml {

enum BackendFamilyId {
  AsrBackendCpu = 0,
  AsrBackendMetal = 1,
  AsrBackendCuda = 2,
  AsrBackendVulkan = 3,
  AsrBackendOpenCl = 4,
  AsrBackendWebGpu = 5,
  AsrBackendOther = 99
};
enum BackendClass { AsrDeviceUnknown = -1, AsrDeviceCpu = 0, AsrDeviceGpu = 1 };

struct BackendRegistry {
  size_t count() const { return ggml_backend_dev_count(); }
  ggml_backend_dev_t get(size_t index) const {
    return ggml_backend_dev_get(index);
  }
  const char* name(ggml_backend_dev_t device) const {
    return ggml_backend_dev_name(device);
  }
  const char* backend(ggml_backend_dev_t device) const {
    const auto registry = ggml_backend_dev_backend_reg(device);
    return registry ? ggml_backend_reg_name(registry) : nullptr;
  }
};

template <typename Registry>
auto findBackendDevice(
    const std::string& name, const Registry& registry, bool matchRegistry)
    -> decltype(registry.get(0)) {
  for (size_t index = 0; index < registry.count(); ++index) {
    auto device = registry.get(index);
    if (!device)
      continue;
    const char* candidate =
        matchRegistry ? registry.backend(device) : registry.name(device);
    if (candidate && name == candidate)
      return device;
  }
  return nullptr;
}

template <typename Registry = BackendRegistry>
auto resolveBackendDevice(
    const std::string& name, const Registry& registry = {})
    -> decltype(registry.get(0)) {
  const auto exact = findBackendDevice(name, registry, false);
  return exact ? exact : findBackendDevice(name, registry, true);
}

inline int backendFamily(std::string name) {
  std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  if (name == "cpu" || name == "blas")
    return AsrBackendCpu;
  if (name.starts_with("metal") || name.starts_with("mtl"))
    return AsrBackendMetal;
  if (name.starts_with("cuda"))
    return AsrBackendCuda;
  if (name.starts_with("vulkan"))
    return AsrBackendVulkan;
  if (name.starts_with("opencl"))
    return AsrBackendOpenCl;
  if (name.starts_with("webgpu"))
    return AsrBackendWebGpu;
  return AsrBackendOther;
}

inline int backendDeviceClass(ggml_backend_dev_t device, int family) {
  if (family == AsrBackendCpu)
    return AsrDeviceCpu;
  if (device == nullptr)
    return AsrDeviceUnknown;
  switch (ggml_backend_dev_type(device)) {
  case GGML_BACKEND_DEVICE_TYPE_CPU:
    return AsrDeviceCpu;
  case GGML_BACKEND_DEVICE_TYPE_GPU:
  case GGML_BACKEND_DEVICE_TYPE_IGPU:
    return AsrDeviceGpu;
  case GGML_BACKEND_DEVICE_TYPE_ACCEL:
    return AsrDeviceUnknown;
  default:
    return AsrDeviceUnknown;
  }
}

inline const char* backendDeviceLabel(int deviceClass) {
  switch (deviceClass) {
  case AsrDeviceCpu:
    return "CPU";
  case AsrDeviceGpu:
    return "GPU";
  default:
    return "Unknown";
  }
}

} // namespace qvac::asrggml
