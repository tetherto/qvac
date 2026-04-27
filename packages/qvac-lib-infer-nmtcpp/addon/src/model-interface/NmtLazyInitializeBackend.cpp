#include "NmtLazyInitializeBackend.hpp"

#include <filesystem>
#include <string>

#include <ggml-backend.h>

#include "qvac-lib-inference-addon-cpp/Logger.hpp"

using namespace qvac_lib_inference_addon_cpp::logger;

std::mutex NmtLazyInitializeBackend::g_initMutex;
bool NmtLazyInitializeBackend::g_initialized = false;
std::string NmtLazyInitializeBackend::g_recordedBackendsDir;
int NmtLazyInitializeBackend::g_refCount = 0;

bool NmtLazyInitializeBackend::initialize(
    const std::string& backendsDir, const std::string& openclCacheDir) {
  std::lock_guard<std::mutex> lock(g_initMutex);

  if (g_initialized) {
    if (!backendsDir.empty() && !g_recordedBackendsDir.empty() &&
        backendsDir != g_recordedBackendsDir) {
      QLOG(
          Priority::WARNING,
          "Backend already initialized with different backendsDir. "
          "Previously initialized at: " +
              g_recordedBackendsDir + ", requested: " + backendsDir);
    }
    return false;
  }

  if (!backendsDir.empty()) {
    g_recordedBackendsDir = backendsDir;
  }

#ifdef __ANDROID__
  if (!openclCacheDir.empty()) {
    auto oclCachePath =
        (std::filesystem::path(openclCacheDir) / "opencl-cache").string();
    setenv("GGML_OPENCL_CACHE_DIR", oclCachePath.c_str(), /*overwrite=*/1);
  }
#endif

  if (!backendsDir.empty()) {
    std::filesystem::path backendsDirPath(backendsDir);
#ifdef BACKENDS_SUBDIR
    std::filesystem::path subdirPath(BACKENDS_SUBDIR);
    backendsDirPath = backendsDirPath / subdirPath;
    backendsDirPath = backendsDirPath.lexically_normal();
#endif
    QLOG(
        Priority::INFO,
        "Loading backends from directory: " + backendsDirPath.string());
    ggml_backend_load_all_from_path(backendsDirPath.string().c_str());
  } else {
    QLOG(Priority::DEBUG, "Loading backends using default path");
    ggml_backend_load_all();
  }

  g_initialized = true;
  return true;
}

void NmtLazyInitializeBackend::incrementRefCount() {
  std::lock_guard<std::mutex> lock(g_initMutex);
  g_refCount++;
}

void NmtLazyInitializeBackend::decrementRefCount() {
  std::lock_guard<std::mutex> lock(g_initMutex);
  if (g_refCount > 0) {
    g_refCount--;
    if (g_refCount == 0 && g_initialized) {
      QLOG(
          Priority::DEBUG,
          "Resetting backend state (reference count reached zero)");
      g_initialized = false;
      g_recordedBackendsDir.clear();
    }
  }
}

NmtBackendsHandle::NmtBackendsHandle(
    const std::string& backendsDir, const std::string& openclCacheDir)
    : ownsHandle_(true) {
  NmtLazyInitializeBackend::initialize(backendsDir, openclCacheDir);
  NmtLazyInitializeBackend::incrementRefCount();
}

NmtBackendsHandle::~NmtBackendsHandle() {
  if (ownsHandle_) {
    NmtLazyInitializeBackend::decrementRefCount();
  }
}

NmtBackendsHandle::NmtBackendsHandle(NmtBackendsHandle&& other) noexcept
    : ownsHandle_(other.ownsHandle_) {
  other.ownsHandle_ = false;
}

NmtBackendsHandle&
NmtBackendsHandle::operator=(NmtBackendsHandle&& other) noexcept {
  if (this != &other) {
    if (ownsHandle_) {
      NmtLazyInitializeBackend::decrementRefCount();
    }
    ownsHandle_ = other.ownsHandle_;
    other.ownsHandle_ = false;
  }
  return *this;
}
