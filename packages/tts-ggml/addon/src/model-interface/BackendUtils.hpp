#pragma once

#include <string>

#include "tts-cpp/backend.h"

namespace qvac::ttsggml {

inline int backendIdFromName(const std::string& name) {
  if (name == "CPU") return 0;
  if (name.rfind("Metal",  0) == 0 || name.rfind("MTL", 0) == 0) return 1;
  if (name.rfind("CUDA",   0) == 0) return 2;
  if (name.rfind("Vulkan", 0) == 0) return 3;
  if (name.rfind("OpenCL", 0) == 0) return 4;
  return 99;
}

inline int backendDeviceCode(tts_cpp::BackendDevice d) {
  return d == tts_cpp::BackendDevice::GPU ? 1 : 0;
}

}
