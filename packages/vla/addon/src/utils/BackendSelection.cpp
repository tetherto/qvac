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

    // Reject every Adreno generation we can identify. The original cutoff
    // assumed Adreno >= 800 had working Vulkan drivers, but mobile CI on
    // Samsung Galaxy S25 Ultra (Adreno 830) produced numerically broken
    // output: cos sim 0.73 vs PyTorch on the real-LIBERO fixture, where
    // every other accepted Vulkan target (Apple Metal, NVIDIA, Intel Iris,
    // Mali on Pixel 9 Pro) lands above 0.999. Re-enable a specific Adreno
    // model only with evidence that its driver round-trips ggml matmul
    // correctly (cos > 0.99 on the real-LIBERO fixture).
    if (adreno > 0) {
      fprintf(
          stderr,
          "vla_backend_selection: skipping Adreno %d GPU (driver path "
          "produces incorrect ggml output) — will fall back to CPU\n",
          adreno);
      continue;
    }

    fprintf(
        stderr,
        "vla_backend_selection: non-Adreno GPU accepted: %s\n",
        desc.c_str());

    if (fallbackGpu == nullptr) {
      fallbackGpu = dev;
    }
  }

  return fallbackGpu;
}

} // namespace vla_backend_selection
