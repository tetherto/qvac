#include "BackendLoader.hpp"

#ifdef GGML_BACKEND_DL
#include <filesystem>
#include <mutex>
#include <sstream>
#include <system_error>
#include <vector>

#include <ggml-backend.h>

#include "utils/LoggingMacros.hpp"
#endif

namespace qvac_lib_inference_addon_sd {
namespace {

#ifdef GGML_BACKEND_DL
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

void logBackendModulePathSnapshot(
    const std::filesystem::path& backendsDirPath) {
  using Priority = qvac_lib_inference_addon_cpp::logger::Priority;

  std::error_code ec;
  const bool exists = std::filesystem::exists(backendsDirPath, ec);
  QLOG_IF(
      Priority::INFO,
      "Backend module path exists=" + std::string(exists ? "true" : "false") +
          " path='" + backendsDirPath.string() + "'");
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
    const auto filename = dirEntry.path().filename().string();
    if (filename.rfind("libqvac-diffusion-ggml-", 0) == 0 &&
        dirEntry.path().extension() == ".so") {
      entries.push_back(filename);
    }
  }

  if (entries.empty()) {
    QLOG_IF(
        Priority::WARNING,
        "No qvac diffusion GGML backend modules found under: " +
            backendsDirPath.string());
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
    if (!backendsDir.empty()) {
      std::filesystem::path backendsDirPath(backendsDir);
#ifdef BACKENDS_SUBDIR
      backendsDirPath = backendsDirPath / BACKENDS_SUBDIR;
      backendsDirPath = backendsDirPath.lexically_normal();
#endif
      QLOG_IF(
          Priority::INFO,
          "Loading GPU backends from: " + backendsDirPath.string());
      logBackendModulePathSnapshot(backendsDirPath);
      ggml_backend_load_all_from_path(backendsDirPath.string().c_str());
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
