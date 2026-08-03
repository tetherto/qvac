#include "model-interface/BackendLoader.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <mutex>
#include <string>
#include <system_error>

#if defined(__ANDROID__) || (defined(__linux__) && defined(__aarch64__))
#include <dlfcn.h>
#endif

#include <ggml-backend.h>

#include "inference-addon-cpp/Logger.hpp"

namespace qvac::asrggml::backend {

#if defined(__ANDROID__) || (defined(__linux__) && defined(__aarch64__))
namespace {

namespace fs = std::filesystem;

constexpr const char* BACKEND_PREFIX = "libqvac-asr-ggml-";

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
  const fs::path path = directory / (std::string(BACKEND_PREFIX) + name + ".so");
  std::error_code ec;
  if (!fs::exists(path, ec)) {
    return false;
  }
  return ggml_backend_load(path.string().c_str()) != nullptr;
}

bool hasAdrenoGpu() {
  for (size_t index = 0; index < ggml_backend_dev_count(); ++index) {
    ggml_backend_dev_t device = ggml_backend_dev_get(index);
    if (device == nullptr) {
      continue;
    }
    const char* description = ggml_backend_dev_description(device);
    if (description == nullptr) {
      continue;
    }
    std::string normalized(description);
    std::transform(
        normalized.begin(),
        normalized.end(),
        normalized.begin(),
        [](unsigned char character) {
          return static_cast<char>(std::tolower(character));
        });
    if (normalized.find("adreno") != std::string::npos) {
      return true;
    }
  }
  return false;
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

void loadBackendsFromRoot(const fs::path& root) {
  const fs::path directory = joinBackendsSubdir(root);
  QLOG(
      qvac_lib_inference_addon_cpp::logger::Priority::INFO,
      std::string("loading isolated ASR ggml backends from: ") +
          directory.string());

  if (std::getenv("GGML_DISABLE_VULKAN") == nullptr) {
    loadBackend(directory, "vulkan");
  }
  if (hasAdrenoGpu() || std::getenv("GGML_OPENCL_FORCE_LOAD") != nullptr) {
    loadBackend(directory, "opencl");
  }

  if (!loadCpuBackend(directory)) {
    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
        "No isolated ASR CPU backend was loadable; trying the legacy "
        "qvac-speech backend prefix.");
    ggml_backend_load_all_from_path(directory.string().c_str());
  }
}

} // namespace
#endif

void ensureLoaded(const std::string& backendsRoot) {
#if defined(__ANDROID__) || (defined(__linux__) && defined(__aarch64__))
  static std::once_flag flag;
  std::call_once(flag, [&]() {
    if (!backendsRoot.empty()) {
      loadBackendsFromRoot(fs::path(backendsRoot));
      return;
    }

    const fs::path selfLocatedRoot = prebuildsDirFromAddonLocation();
    std::error_code ec;
    if (!selfLocatedRoot.empty() &&
        fs::exists(joinBackendsSubdir(selfLocatedRoot), ec)) {
      loadBackendsFromRoot(selfLocatedRoot);
      return;
    }

    QLOG(
        qvac_lib_inference_addon_cpp::logger::Priority::WARNING,
        "ASR backendsDir was not set and addon-relative prebuilds could not "
        "be located; falling back to GGML's default search path.");
    ggml_backend_load_all();
  });
#else
  static_cast<void>(backendsRoot);
#endif
}

} // namespace qvac::asrggml::backend
