#include "model-interface/BackendLoader.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdlib>
#include <exception>
#include <filesystem>
#include <limits>
#include <mutex>
#include <regex>
#include <string>
#include <system_error>

#if defined(__ANDROID__) || (defined(__linux__) && defined(__aarch64__))
#include <dlfcn.h>
#endif

#include <ggml-backend.h>

#include "inference-addon-cpp/Logger.hpp"

namespace qvac::ttsggml::backend {

#if defined(__ANDROID__) || (defined(__linux__) && defined(__aarch64__))
namespace {

namespace fs = std::filesystem;

constexpr const char* BACKEND_PREFIX = "libqvac-tts-ggml-";

fs::path joinBackendsSubdir(const fs::path& root) {
#ifdef BACKENDS_SUBDIR
  return (root / fs::path(BACKENDS_SUBDIR)).lexically_normal();
#else
  return root;
#endif
}

fs::path prebuildsDirFromAddonLocation() {
  Dl_info info{};
  // NOLINTBEGIN(cppcoreguidelines-pro-type-reinterpret-cast)
  const void* selfSymbol =
      reinterpret_cast<const void*>(&prebuildsDirFromAddonLocation);
  // NOLINTEND(cppcoreguidelines-pro-type-reinterpret-cast)
  if (dladdr(selfSymbol, &info) == 0 || info.dli_fname == nullptr) {
    return {};
  }

  std::error_code ec;
  const fs::path prebuildsDir =
      fs::path(info.dli_fname).parent_path().parent_path();
  if (prebuildsDir.empty() || !fs::exists(prebuildsDir, ec)) {
    return {};
  }
  return prebuildsDir;
}

bool loadBackend(const fs::path& directory, const std::string& name) {
  const std::string filename = std::string(BACKEND_PREFIX) + name + ".so";
  const fs::path path = directory / filename;
  std::error_code ec;
  if (fs::exists(path, ec)) {
    return ggml_backend_load(path.string().c_str()) != nullptr;
  }
#if defined(__ANDROID__)
  // Android may keep native libraries compressed inside the APK. In that
  // layout there is no filesystem path, but bionic can resolve the uniquely
  // named library directly from the APK by basename.
  return ggml_backend_load(filename.c_str()) != nullptr;
#else
  return false;
#endif
}

int adrenoVersionFromDescription(const std::string& description) {
  std::string normalized = description;
  std::transform(
      normalized.begin(),
      normalized.end(),
      normalized.begin(),
      [](unsigned char character) {
        return static_cast<char>(std::tolower(character));
      });
  if (normalized.find("dreno") == std::string::npos) {
    return -1;
  }
  static const std::regex adrenoRegex(R"(dreno\D*?(\d{3,4}))");
  std::smatch matches;
  if (std::regex_search(normalized, matches, adrenoRegex) &&
      matches.size() > 1) {
    try {
      return std::stoi(matches[1].str());
    } catch (const std::exception&) {
      return -3;
    }
  }
  return -3;
}

int minimumAdrenoVersion(ggml_backend_reg_t backend) {
  if (backend == nullptr) {
    return -2;
  }
  int minimum = std::numeric_limits<int>::max();
  for (size_t index = 0; index < ggml_backend_reg_dev_count(backend); ++index) {
    ggml_backend_dev_t device = ggml_backend_reg_dev_get(backend, index);
    const char* description =
        device != nullptr ? ggml_backend_dev_description(device) : nullptr;
    const int version =
        adrenoVersionFromDescription(description != nullptr ? description : "");
    if (version > 0) {
      minimum = std::min(minimum, version);
    }
  }
  return minimum < std::numeric_limits<int>::max() ? minimum : -1;
}

bool loadCpuBackend(const fs::path& directory) {
#if defined(__ANDROID__)
  constexpr std::array<const char*, 7> CPU_VARIANTS = {
      "cpu-android_armv9.2_2",
      "cpu-android_armv9.2_1",
      "cpu-android_armv9.0_1",
      "cpu-android_armv8.6_1",
      "cpu-android_armv8.2_2",
      "cpu-android_armv8.2_1",
      "cpu-android_armv8.0_1"};
#else
  constexpr std::array<const char*, 3> CPU_VARIANTS = {
      "cpu-armv8.2_2", "cpu-armv8.2_1", "cpu-armv8.0_1"};
#endif

  for (const char* variant : CPU_VARIANTS) {
    if (loadBackend(directory, variant)) {
      return true;
    }
  }
  return false;
}

void loadBackendsFromRoot(
    const fs::path& root, const std::string& openclCacheDir) {
  const fs::path directory = joinBackendsSubdir(root);
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      std::string("loading isolated TTS ggml backends from: ") +
          directory.string());

  if (!openclCacheDir.empty()) {
    setenv("GGML_OPENCL_CACHE_DIR", openclCacheDir.c_str(), 1);
  }

  ggml_backend_reg_t vulkanBackend = nullptr;
  if (std::getenv("GGML_DISABLE_VULKAN") == nullptr) {
    loadBackend(directory, "vulkan");
    vulkanBackend = ggml_backend_reg_by_name("vulkan");
  }

  const int adrenoVersion = minimumAdrenoVersion(vulkanBackend);
  bool loadOpencl = adrenoVersion > 700;
  if (adrenoVersion > 0 && adrenoVersion <= 700 &&
      vulkanBackend != nullptr) {
    // Match ggml-speech's policy: Adreno 700 and older use CPU because neither
    // Vulkan nor OpenCL is stable there.
    ggml_backend_unload(vulkanBackend);
  }
  if (std::getenv("GGML_OPENCL_FORCE_LOAD") != nullptr) {
    loadOpencl = true;
  }
  if (loadOpencl) {
    loadBackend(directory, "opencl");
  }

  if (!loadCpuBackend(directory)) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
        "No isolated TTS CPU backend was loadable; trying the legacy "
        "qvac-speech backend prefix.");
    ggml_backend_load_all_from_path(directory.string().c_str());
  }
}

} // namespace
#endif

void ensureLoaded(
    const std::string& backendsRoot, const std::string& openclCacheDir) {
#if defined(__ANDROID__) || (defined(__linux__) && defined(__aarch64__))
  static std::once_flag flag;
  std::call_once(flag, [&]() {
    if (!backendsRoot.empty()) {
      loadBackendsFromRoot(fs::path(backendsRoot), openclCacheDir);
      return;
    }

    const fs::path selfLocatedRoot = prebuildsDirFromAddonLocation();
    std::error_code ec;
    if (!selfLocatedRoot.empty() &&
        fs::exists(joinBackendsSubdir(selfLocatedRoot), ec)) {
      loadBackendsFromRoot(selfLocatedRoot, openclCacheDir);
      return;
    }

#if defined(__ANDROID__)
    loadBackendsFromRoot(fs::path{}, openclCacheDir);
    return;
#endif

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
        "TTS backendsDir was not set and addon-relative prebuilds could not "
        "be located; falling back to GGML's default search path.");
    ggml_backend_load_all();
  });
#else
  static_cast<void>(backendsRoot);
  static_cast<void>(openclCacheDir);
#endif
}

} // namespace qvac::ttsggml::backend
