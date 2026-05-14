#include "BackendSelection.hpp"

#include <algorithm>
#include <cctype>
#include <string>

#include <ggml-backend.h>

#include "LoggingMacros.hpp"

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
  using Priority = qvac_lib_inference_addon_cpp::logger::Priority;

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
    const char* nameRaw = ggml_backend_dev_name(dev);
    const std::string backendName = nameRaw ? nameRaw : "";
    std::string backendLower = backendName;
    std::transform(
        backendLower.begin(), backendLower.end(), backendLower.begin(),
        [](unsigned char c) { return std::tolower(c); });

    const int adreno = parseAdrenoModel(desc);

    // Adreno-specific policy. Empirical data so far:
    //   * Adreno 830 Vulkan on the Samsung Galaxy S25 Ultra produces cos sim
    //     0.73 vs PyTorch on the LIBERO real fixture (every other accepted
    //     Vulkan target — Apple Metal, NVIDIA, Intel Iris, Mali on Pixel 9
    //     Pro — sits above 0.999). Reject Vulkan on any Adreno.
    //   * Adreno < 800 has known Qualcomm OpenCL ICD issues (incomplete
    //     OpenCL 3.0, kernel-compile failures on several ggml ops,
    //     shared-memory OOMs). Reject any backend on Adreno < 800.
    //   * Adreno >= 800 on OpenCL is the path Qualcomm and qvac-fabric's own
    //     ggml backend loader actively maintain (GGML_OPENCL_USE_ADRENO_KERNELS,
    //     "Adreno > 700 found keeping OpenCL backend"), and diffusion-cpp
    //     uses it for Adreno 800+. Accept OpenCL on Adreno >= 800 and let
    //     the integration test's cos-sim assertion vs PyTorch catch
    //     regressions on the LIBERO fixture.
    if (adreno > 0) {
      const bool isOpenCl = backendLower.find("opencl") != std::string::npos;
      if (isOpenCl && adreno >= 800) {
        QLOG_IF(
            Priority::INFO,
            "vla_backend_selection: Adreno " + std::to_string(adreno) +
                " OpenCL accepted (preferred Adreno path)");
        // Prefer OpenCL-on-Adreno-800+ over any other candidate iterated
        // later (in particular Vulkan-on-Adreno, which would otherwise be
        // skipped but only after we'd already accepted nothing).
        return dev;
      }
      QLOG_IF(
          Priority::WARNING,
          "vla_backend_selection: skipping Adreno " + std::to_string(adreno) +
              " " + backendName +
              " GPU (driver path known/suspected broken) — will fall back to "
              "CPU unless another acceptable GPU is found");
      continue;
    }

    QLOG_IF(
        Priority::INFO,
        "vla_backend_selection: non-Adreno GPU accepted: " + desc +
            " (backend: " + backendName + ")");

    if (fallbackGpu == nullptr) {
      fallbackGpu = dev;
    }
  }

  return fallbackGpu;
}

} // namespace vla_backend_selection
