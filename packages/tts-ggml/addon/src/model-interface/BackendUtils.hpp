#pragma once

#include <cctype>
#include <cstddef>
#include <string>

#include "ggml-backend.h"
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

// ASCII case-insensitive substring test. nullptr/empty-needle -> false.
inline bool containsCaseInsensitive(const char* haystack, const char* needle) {
  if (haystack == nullptr || needle == nullptr || needle[0] == '\0')
    return false;
  std::string h(haystack);
  std::string n(needle);
  for (char& c : h)
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  for (char& c : n)
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return h.find(n) != std::string::npos;
}

// True when an ARM Mali / Immortalis (Valhall) GPU device is registered with
// ggml. Read-only: enumerates devices and inspects their name/description; it
// never inits a device or commits a backend selection, so it is safe to call
// after the engine has chosen its backend. Mirrors tts-cpp's
// desc_or_name_is_arm_mali (matches "mali" or "immortalis"). Defensive
// observability only (tts-cpp now admits Chatterbox on Mali): scopes the
// gpuUnsupported_ "GPU present but unused" signal to Mali/Immortalis so a
// genuine GPU->CPU regression on Adreno / Xclipse stays distinguishable.
inline bool androidOffAllowlistGpuPresent() {
  const size_t count = ggml_backend_dev_count();
  for (size_t i = 0; i < count; ++i) {
    ggml_backend_dev_t dev = ggml_backend_dev_get(i);
    if (dev == nullptr)
      continue;
    const enum ggml_backend_dev_type type = ggml_backend_dev_type(dev);
    if (type != GGML_BACKEND_DEVICE_TYPE_GPU &&
        type != GGML_BACKEND_DEVICE_TYPE_IGPU) {
      continue;
    }
    const char* name = ggml_backend_dev_name(dev);
    const char* desc = ggml_backend_dev_description(dev);
    if (containsCaseInsensitive(name, "mali") ||
        containsCaseInsensitive(desc, "mali") ||
        containsCaseInsensitive(name, "immortalis") ||
        containsCaseInsensitive(desc, "immortalis")) {
      return true;
    }
  }
  return false;
}
}
