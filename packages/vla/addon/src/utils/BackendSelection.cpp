#include "BackendSelection.hpp"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <string>

#include <ggml-backend.h>

namespace vla_backend_selection {

int parseAdrenoModel(const std::string& description) {
  std::string lower = description;
  std::transform(
      lower.begin(), lower.end(), lower.begin(), [](unsigned char c) {
        return std::tolower(c);
      });

  const auto pos = lower.find("adreno");
  if (pos == std::string::npos) {
    return 0;
  }
  for (size_t i = pos + 6; i < lower.size(); ++i) {
    if (std::isdigit(static_cast<unsigned char>(lower[i]))) {
      try {
        return std::stoi(lower.substr(i));
      } catch (...) {
        return 0;
      }
    }
  }
  return 0;
}

ggml_backend_dev_t pickBestGpuDevice() {
  const size_t n = ggml_backend_dev_count();
  ggml_backend_dev_t fallbackGpu = nullptr;

  for (size_t i = 0; i < n; ++i) {
    ggml_backend_dev_t dev = ggml_backend_dev_get(i);
    const enum ggml_backend_dev_type t = ggml_backend_dev_type(dev);
    if (t != GGML_BACKEND_DEVICE_TYPE_GPU &&
        t != GGML_BACKEND_DEVICE_TYPE_IGPU) {
      continue;
    }

    const char* descRaw = ggml_backend_dev_description(dev);
    const std::string desc = descRaw ? descRaw : "";
    const int adreno = parseAdrenoModel(desc);

    if (adreno > 0 && adreno < 800) {
      fprintf(
          stderr,
          "vla_backend_selection: skipping Adreno %d GPU (driver/OpenCL "
          "unreliable below 800) — will fall back to CPU\n",
          adreno);
      continue;
    }

    if (adreno >= 800) {
      fprintf(
          stderr,
          "vla_backend_selection: Adreno %d GPU accepted: %s\n",
          adreno,
          desc.c_str());
    } else {
      fprintf(
          stderr,
          "vla_backend_selection: non-Adreno GPU accepted: %s\n",
          desc.c_str());
    }

    if (fallbackGpu == nullptr) {
      fallbackGpu = dev;
    }
  }

  return fallbackGpu;
}

} // namespace vla_backend_selection
