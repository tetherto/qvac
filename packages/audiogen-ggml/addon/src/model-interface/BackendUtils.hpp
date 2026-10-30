#pragma once

#include <cstdint>
#include <string>

#include "model-interface/ModuleBackendsDir.hpp"

namespace qvac::audiogenggml {

inline int64_t backendIdFromName(const std::string& name) {
  if (name == "CPU")
    return 0;
  if (name.starts_with("Metal") || name.starts_with("MTL"))
    return 1;
  if (name.starts_with("CUDA"))
    return 2;
  if (name.starts_with("Vulkan"))
    return 3;
  if (name.starts_with("OpenCL") || name.starts_with("GPUOpenCL"))
    return 4;
  if (name.starts_with("WebGPU") || name.starts_with("WEBGPU"))
    return 5;
  return 99;
}

} // namespace qvac::audiogenggml
