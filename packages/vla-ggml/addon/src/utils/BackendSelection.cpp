#include "BackendSelection.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <filesystem>
#include <mutex>
#include <string>
#include <string_view>
#include <utility>

#include <ggml-backend.h>
#include <inference-addon-cpp/Errors.hpp>

#include "LoggingMacros.hpp"

namespace vla_backend_selection {

namespace {

// Backend families qvac-fabric can register a GPU device for. "cpu" is absent
// on purpose: the addon layer strips `backend: 'cpu'` into forceCpu before this
// is reached, so it is not a GPU family name here. See the header for why this
// differs from llm-llamacpp and embed-llamacpp.
constexpr std::array<std::string_view, 7> KNOWN_GPU_BACKEND_FAMILIES = {
    "cuda", "vulkan", "metal", "opencl", "hip", "rocm", "sycl"};

// Trimmed from each family. \r matters: a value from a CRLF config file would
// otherwise throw "unknown backend 'cuda\r'", which renders identically to the
// accepted spelling. index.js trims the whole value but not each entry.
constexpr std::string_view K_BACKEND_TRIM = " \t\r\n\v\f";

} // namespace

// Substring rather than equality because ggml suffixes the device index
// ("CUDA0", "Vulkan1") and OpenCL reports as "GPUOpenCL". Metal is special:
// some builds report "mtl..." instead of "Metal".
bool backendNameMatchesFamily(
    const std::string& lowercasedBackendName, std::string_view family) {
  if (lowercasedBackendName.find(family) != std::string::npos) {
    return true;
  }
  return family == "metal" && lowercasedBackendName.rfind("mtl", 0) == 0;
}

std::vector<std::string> parseBackendOverride(const std::string& backendStr) {
  std::vector<std::string> families;
  std::string current;
  // Set for any non-blank token, 'auto' included, so 'auto' in a list is not
  // then rejected by the names-no-backend check below.
  bool namedAnyBackend = false;
  auto flush = [&]() {
    const auto begin = current.find_first_not_of(K_BACKEND_TRIM);
    if (begin == std::string::npos) {
      return;
    }
    const auto end = current.find_last_not_of(K_BACKEND_TRIM);
    std::string family = current.substr(begin, end - begin + 1);
    std::transform(
        family.begin(), family.end(), family.begin(), [](unsigned char c) {
          return static_cast<char>(std::tolower(c));
        });
    namedAnyBackend = true;
    // createInstance already maps a bare 'auto' to no preference; accept it
    // inside a list too so 'auto,cuda' is not a hard error.
    if (family == "auto") {
      return;
    }
    if (std::find(
            KNOWN_GPU_BACKEND_FAMILIES.begin(),
            KNOWN_GPU_BACKEND_FAMILIES.end(),
            family) == KNOWN_GPU_BACKEND_FAMILIES.end()) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "backend: unknown backend '" + family +
              "'. Expected a comma-separated list of "
              "cuda/vulkan/metal/opencl/hip/rocm/sycl, for example "
              "'cuda,vulkan'. Use backend 'cpu' on its own to force CPU, or "
              "'auto' for the default order.\n");
    }
    // ggml's HIP build names its devices "ROCm%d" (GGML_CUDA_NAME in
    // ggml-cuda.h), so a family kept as "hip" matches no device name at all and
    // the override silently falls through to the default order. Canonicalise to
    // the spelling ggml reports; the default preference block below already
    // treats the two as one family.
    if (family == "hip") {
      family = "rocm";
    }
    if (std::find(families.begin(), families.end(), family) == families.end()) {
      families.emplace_back(std::move(family));
    }
  };
  for (const char c : backendStr) {
    if (c == ',') {
      flush();
      current.clear();
    } else {
      current.push_back(c);
    }
  }
  flush();
  // A blank value means the key was not configured, which index.js already
  // rejects. Anything else that parses to zero families, "," or ",,", is a
  // config mistake and gets the same hard error as a misspelled name.
  if (families.empty() && !namedAnyBackend &&
      backendStr.find_first_not_of(K_BACKEND_TRIM) != std::string::npos) {
    throw qvac_errors::StatusError(
        qvac_errors::general_error::InvalidArgument,
        "backend: '" + backendStr +
            "' names no backend. Expected a comma-separated list of "
            "cuda/vulkan/metal/opencl/hip/rocm/sycl, for example "
            "'cuda,vulkan'. "
            "Use backend 'cpu' on its own to force CPU, or 'auto' for the "
            "default order.\n");
  }
  return families;
}

void loadBackendsOnce(const std::string& backendsDir) {
  static std::once_flag sFlag;
  std::call_once(sFlag, [&backendsDir]() {
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

ggml_backend_dev_t pickBestGpuDevice(
    const std::vector<std::string>& backendOverride,
    const bool backendRequired) {
  using Priority = qvac_lib_inference_addon_cpp::logger::Priority;

  const size_t n = ggml_backend_dev_count();
  ggml_backend_dev_t fallbackGpu = nullptr;
  ggml_backend_dev_t hipDev = nullptr;
  ggml_backend_dev_t cudaDev = nullptr;
  // QVAC-23763: every device that passed the Adreno gate, paired with its
  // lowercased backend name, so an override can only ever choose among devices
  // the gate already accepted.
  std::vector<std::pair<std::string, ggml_backend_dev_t>> accepted;

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
        backendLower.begin(),
        backendLower.end(),
        backendLower.begin(),
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
        //
        // QVAC-23763: still an early return, and deliberately so. An Adreno
        // host has no CUDA device, so there is nothing for a backend override
        // to choose between here. It can still be asked for something else,
        // 'vulkan' on an Adreno 830, so say the override was dropped rather
        // than returning a device it did not ask for in silence.
        if (!backendOverride.empty()) {
          QLOG_IF(
              Priority::WARNING,
              "vla_backend_selection: backend override ignored on Adreno " +
                  std::to_string(adreno) +
                  "; OpenCL is the only accepted backend there");
        }
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

    // HIP/ROCm is preferred over other GPU backends on AMD hardware; Vulkan is
    // the fallback. The ggml HIP backend reports its device as "ROCm%d".
    //
    // ASSUMPTION: a single AMD-GPU target (the Strix Halo / gfx1151 APU this
    // backend ships for). Because pickBestGpuDevice() is the generic picker,
    // returning the HIP device unconditionally below makes ROCm win over every
    // other backend. On a mixed-vendor host (e.g. a discrete NVIDIA GPU via
    // Vulkan + an AMD iGPU via ROCm) this would always pick the AMD iGPU even
    // if the other device is faster. Revisit this preference (e.g. score by
    // device, or scope it to the known APU) before HIP ships to multi-GPU
    // configurations.
    const bool isHip = backendLower.find("rocm") != std::string::npos ||
                       backendLower.find("hip") != std::string::npos;
    if (isHip && hipDev == nullptr) {
      hipDev = dev;
    }

    // QVAC-23763: ggml-cuda names its devices "CUDA%d". ggml-hip reports
    // "ROCm%d" instead, so this cannot collide with the AMD device above.
    const bool isCuda = backendLower.find("cuda") != std::string::npos;
    if (isCuda && cudaDev == nullptr) {
      cudaDev = dev;
    }

    accepted.emplace_back(backendLower, dev);

    if (fallbackGpu == nullptr) {
      fallbackGpu = dev;
    }
  }

  // QVAC-23763: an explicit override wins over the preference order below, but
  // only among devices the Adreno gate accepted, so it can never resurrect a
  // device the gate rejected.
  if (!backendOverride.empty()) {
    for (const std::string& family : backendOverride) {
      for (const auto& [backendLower, dev] : accepted) {
        if (backendNameMatchesFamily(backendLower, family)) {
          QLOG_IF(
              Priority::INFO,
              "vla_backend_selection: " + family +
                  " GPU selected by backend override");
          return dev;
        }
      }
    }
    // QVAC-23763: name what WAS accepted. Without it, diagnosing a pin that
    // missed needs a second run - and on this picker the Adreno gate can be the
    // reason a device is not in the list at all, which is worth seeing.
    std::string acceptedNames;
    for (const auto& [backendLower, dev] : accepted) {
      (void) dev;
      if (!acceptedNames.empty()) {
        acceptedNames += ", ";
      }
      acceptedNames += backendLower;
    }
    if (acceptedNames.empty()) {
      acceptedNames = "none";
    }

    std::string requested;
    for (const std::string& family : backendOverride) {
      if (!requested.empty()) {
        requested += ",";
      }
      requested += family;
    }

    if (backendRequired) {
      throw qvac_errors::StatusError(
          qvac_errors::general_error::InvalidArgument,
          "vla_backend_selection: backend '" + requested +
              "' is required but matched no accepted device. Accepted: " +
              acceptedNames + ".\n");
    }
    QLOG_IF(
        Priority::WARNING,
        "vla_backend_selection: backend override '" + requested +
            "' matched no accepted device; falling back to the default backend "
            "order. Accepted: " +
            acceptedNames);
  }

  // CUDA ahead of HIP: see the header. A CUDA device only ever appears on a
  // discrete NVIDIA GPU, which is the mixed-vendor case the HIP comment above
  // flags as picking the wrong device. AMD-only hosts are unaffected.
  if (cudaDev != nullptr) {
    QLOG_IF(
        Priority::INFO,
        "vla_backend_selection: preferring CUDA GPU (HIP and Vulkan are "
        "fallbacks)");
    return cudaDev;
  }

  if (hipDev != nullptr) {
    QLOG_IF(
        Priority::INFO,
        "vla_backend_selection: preferring HIP/ROCm GPU (Vulkan is fallback)");
    return hipDev;
  }
  return fallbackGpu;
}

} // namespace vla_backend_selection
