#include "BackendSelection.hpp"

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <mutex>
#include <string>

#include <ggml-backend.h>

#include "LoggingMacros.hpp"

namespace vla_backend_selection {

void loadBackendsOnce(const std::string& backendsDir) {
  static std::once_flag s_flag;
  std::call_once(s_flag, [&backendsDir]() {
    using Priority = qvac_lib_inference_addon_cpp::logger::Priority;
    if (!backendsDir.empty()) {
      std::filesystem::path p(backendsDir);
#ifdef BACKENDS_SUBDIR
      p = (p / std::filesystem::path(BACKENDS_SUBDIR)).lexically_normal();
#endif
      QLOG_IF(Priority::INFO, "Loading backends from: " + p.string());
      ggml_backend_load_all_from_path(p.string().c_str());
    } else {
      ggml_backend_load_all();
    }
  });
}

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

    // Adreno-specific policy. Empirical data:
    //   * Adreno 830 Vulkan (Samsung Galaxy S25 Ultra): cos sim 0.73 vs
    //     PyTorch on the LIBERO real fixture — numerically broken. Every
    //     other accepted Vulkan target (Apple Metal, NVIDIA, Intel Iris,
    //     Mali on Pixel 9 Pro) sits above 0.999. Reject Vulkan on any Adreno.
    //   * Adreno 830 OpenCL (Samsung Galaxy S25 Ultra, PR #1784 CI run
    //     Manual-1229): cos sim 0.9843 / 0.9998 on fixed + real LIBERO
    //     fixtures, 4x faster than CPU (1.5 s vs 6 s total). Passes all
    //     thresholds. Accept OpenCL on Adreno >= 800.
    //   * Adreno < 800: known Qualcomm OpenCL ICD issues (incomplete
    //     OpenCL 3.0, kernel-compile failures on several ggml ops,
    //     shared-memory OOMs). Reject any backend on Adreno < 800.
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
