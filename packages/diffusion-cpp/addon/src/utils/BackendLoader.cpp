#include "BackendLoader.hpp"

#ifdef GGML_BACKEND_DL
#include <filesystem>
#include <mutex>
#include <sstream>
#include <system_error>
#include <vector>

#include <ggml-backend.h>

#include "utils/LoggingMacros.hpp"
#include "utils/ModuleBackendsDir.hpp"
#endif

namespace qvac_lib_inference_addon_sd {
namespace {

#ifdef GGML_BACKEND_DL
// ggml reads the backends dir with fs::u8path, and path::string() is ANSI on
// Windows (it throws on characters the code page cannot map).
std::string utf8(const std::filesystem::path& path) {
  const auto u8 = path.u8string();
  return {reinterpret_cast<const char*>(u8.data()), u8.size()};
}

std::string backendDeviceTypeToString(enum ggml_backend_dev_type type) {
  switch (type) {
  case GGML_BACKEND_DEVICE_TYPE_CPU:
    return "CPU";
  case GGML_BACKEND_DEVICE_TYPE_GPU:
    return "GPU";
  case GGML_BACKEND_DEVICE_TYPE_IGPU:
    return "IGPU";
  case GGML_BACKEND_DEVICE_TYPE_ACCEL:
    return "ACCEL";
  default:
    return "UNKNOWN";
  }
}

void logBackendRegistrySnapshot() {
  using Priority = qvac_lib_inference_addon_cpp::logger::Priority;

  const size_t regCount = ggml_backend_reg_count();
  const size_t devCount = ggml_backend_dev_count();
  QLOG_IF(
      Priority::INFO,
      "GGML backend registry snapshot: " + std::to_string(regCount) +
          " registry entries, " + std::to_string(devCount) + " devices");

  for (size_t i = 0; i < regCount; ++i) {
    ggml_backend_reg_t reg = ggml_backend_reg_get(i);
    const char* regName = reg ? ggml_backend_reg_name(reg) : nullptr;
    const size_t regDevCount = reg ? ggml_backend_reg_dev_count(reg) : 0;
    QLOG_IF(
        Priority::INFO,
        "GGML backend registry[" + std::to_string(i) + "]: name='" +
            std::string(regName ? regName : "<null>") +
            "', devices=" + std::to_string(regDevCount));
  }

  for (size_t i = 0; i < devCount; ++i) {
    ggml_backend_dev_t dev = ggml_backend_dev_get(i);
    if (!dev) {
      QLOG_IF(
          Priority::WARNING,
          "GGML backend device[" + std::to_string(i) + "]: null device handle");
      continue;
    }

    const char* name = ggml_backend_dev_name(dev);
    const char* desc = ggml_backend_dev_description(dev);
    const auto type = ggml_backend_dev_type(dev);
    size_t memFree = 0;
    size_t memTotal = 0;
    ggml_backend_dev_memory(dev, &memFree, &memTotal);

    ggml_backend_reg_t reg = ggml_backend_dev_backend_reg(dev);
    const char* regName = reg ? ggml_backend_reg_name(reg) : nullptr;

    QLOG_IF(
        Priority::INFO,
        "GGML backend device[" + std::to_string(i) + "]: name='" +
            std::string(name ? name : "<null>") + "', desc='" +
            std::string(desc ? desc : "<null>") +
            "', type=" + backendDeviceTypeToString(type) + ", reg='" +
            std::string(regName ? regName : "<null>") +
            "', mem_free=" + std::to_string(memFree) +
            ", mem_total=" + std::to_string(memTotal));
  }
}

// Module file naming follows ggml-backend-reg.cpp: no lib prefix and .dll
// on Windows, lib prefix and .so elsewhere.
#ifdef _WIN32
constexpr const char* BACKEND_MODULE_PREFIX = "qvac-diffusion-ggml-";
constexpr const char* BACKEND_MODULE_EXTENSION = ".dll";
#else
constexpr const char* BACKEND_MODULE_PREFIX = "libqvac-diffusion-ggml-";
constexpr const char* BACKEND_MODULE_EXTENSION = ".so";
#endif

void logBackendModulePathSnapshot(
    const std::filesystem::path& backendsDirPath) {
  using Priority = qvac_lib_inference_addon_cpp::logger::Priority;

  std::error_code ec;
  const bool exists = std::filesystem::exists(backendsDirPath, ec);
  QLOG_IF(
      Priority::INFO,
      "Backend module path exists=" + std::string(exists ? "true" : "false") +
          " path='" + utf8(backendsDirPath) + "'");
  if (ec) {
    QLOG_IF(
        Priority::WARNING,
        "Backend module path existence check error: " + ec.message());
    return;
  }
  if (!exists) {
    return;
  }

  const bool isDir = std::filesystem::is_directory(backendsDirPath, ec);
  QLOG_IF(
      Priority::INFO,
      "Backend module path is_directory=" +
          std::string(isDir ? "true" : "false"));
  if (ec || !isDir) {
    if (ec) {
      QLOG_IF(
          Priority::WARNING,
          "Backend module path type check error: " + ec.message());
    }
    return;
  }

  std::vector<std::string> entries;
  for (const auto& dirEntry :
       std::filesystem::directory_iterator(backendsDirPath, ec)) {
    if (ec) {
      QLOG_IF(
          Priority::WARNING,
          "Backend module path iteration error: " + ec.message());
      break;
    }
    // MSVC's u8string() throws on a name that is not valid UTF-16; skip it
    // rather than fail the model load from a log-only scan.
    std::string filename;
    try {
      filename = utf8(dirEntry.path().filename());
    } catch (const std::exception&) {
      continue;
    }
    if (filename.rfind(BACKEND_MODULE_PREFIX, 0) == 0 &&
        dirEntry.path().extension() == BACKEND_MODULE_EXTENSION) {
      entries.push_back(filename);
    }
  }

  if (entries.empty()) {
    QLOG_IF(
        Priority::WARNING,
        "No qvac diffusion GGML backend modules found under: " +
            utf8(backendsDirPath));
    return;
  }

  std::ostringstream oss;
  for (size_t i = 0; i < entries.size(); ++i) {
    if (i > 0) {
      oss << ", ";
    }
    oss << entries[i];
  }
  QLOG_IF(
      Priority::INFO,
      "Detected qvac diffusion GGML backend modules: " + oss.str());
}
#endif

} // namespace

void loadBackendModulesOnce(const std::string& backendsDir) {
#ifdef GGML_BACKEND_DL
  static std::once_flag backendsLoaded;
  std::call_once(backendsLoaded, [&backendsDir]() {
    using Priority = qvac_lib_inference_addon_cpp::logger::Priority;
    // A configured directory is scanned as given. An empty one resolves to the
    // directory next to this module (see ModuleBackendsDir.hpp).
    const std::filesystem::path backendsDirPath =
        resolveBackendsDir(backendsDir);
    if (!backendsDirPath.empty()) {
      QLOG_IF(
          Priority::INFO,
          "Loading GPU backends from: " + utf8(backendsDirPath));
      logBackendModulePathSnapshot(backendsDirPath);
      ggml_backend_load_all_from_path(utf8(backendsDirPath).c_str());
    } else {
      QLOG_IF(Priority::INFO, "Loading GPU backends from default path");
      ggml_backend_load_all();
    }
    logBackendRegistrySnapshot();
  });
#else
  (void)backendsDir;
#endif
}

} // namespace qvac_lib_inference_addon_sd
