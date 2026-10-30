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
  AsrBackendHexagon = 6,
  AsrBackendOther = 99
};
enum BackendClass {
  AsrDeviceUnknown = -1,
  AsrDeviceCpu = 0,
  AsrDeviceGpu = 1,
  AsrDeviceNpu = 2
};
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
  if (name.starts_with("hexagon") || name.starts_with("htp"))
    return AsrBackendHexagon;
  return AsrBackendOther;
}

inline int backendDeviceClass(ggml_backend_dev_t device, int family) {
  if (family == AsrBackendHexagon)
    return AsrDeviceNpu;
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
  case AsrDeviceNpu:
    return "NPU";
  default:
    return "Unknown";
  }
}

} // namespace qvac::asrggml
