#include "LlamaLazyInitializeBackend.hpp"

#include <filesystem>
#include <string>

#include <llama.h>

#include "LlamaModel.hpp"
#include "utils/LoggingMacros.hpp"

using namespace qvac_lib_inference_addon_llama::logging;
using namespace qvac_lib_inference_addon_cpp::logger;

std::mutex LlamaLazyInitializeBackend::g_initMutex;
bool LlamaLazyInitializeBackend::g_initialized = false;
std::string LlamaLazyInitializeBackend::g_recordedBackendsDir;
int LlamaLazyInitializeBackend::g_refCount = 0;

bool LlamaLazyInitializeBackend::initialize(
    const std::string& backendsDir, const std::string& openclCacheDir) {
  std::lock_guard<std::mutex> lock(g_initMutex);

  if (g_initialized) {
    if (!backendsDir.empty() && !g_recordedBackendsDir.empty() &&
        backendsDir != g_recordedBackendsDir) {
      QLOG_IF(
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

  llama_log_set(LlamaModel::llamaLogCallback, nullptr);

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
    QLOG_IF(
        Priority::INFO,
        "Loading backends from directory: " + backendsDirPath.string());
    ggml_backend_load_all_from_path(backendsDirPath.string().c_str());
  } else {
    QLOG_IF(Priority::DEBUG, "Loading backends using default path");
    ggml_backend_load_all();
  }

  llama_backend_init();
  g_initialized = true;
  return true;
}

void LlamaLazyInitializeBackend::incrementRefCount() {
  std::lock_guard<std::mutex> lock(g_initMutex);
  g_refCount++;
}

void LlamaLazyInitializeBackend::decrementRefCount() {
  std::lock_guard<std::mutex> lock(g_initMutex);
  if (g_refCount > 0) {
    g_refCount--;
    if (g_refCount == 0 && g_initialized) {
      QLOG_IF(
          Priority::DEBUG, "Freeing backend (reference count reached zero)");
      llama_backend_free();
      g_initialized = false;
      g_recordedBackendsDir.clear();
    }
  }
}

LlamaBackendsHandle::LlamaBackendsHandle(
    const std::string& backendsDir, const std::string& openclCacheDir)
    : ownsHandle_(true) {
  LlamaLazyInitializeBackend::initialize(backendsDir, openclCacheDir);
  LlamaLazyInitializeBackend::incrementRefCount();
}

LlamaBackendsHandle::~LlamaBackendsHandle() {
  if (ownsHandle_) {
    LlamaLazyInitializeBackend::decrementRefCount();
  }
}

LlamaBackendsHandle::LlamaBackendsHandle(LlamaBackendsHandle&& other) noexcept
    : ownsHandle_(other.ownsHandle_) {
  other.ownsHandle_ = false;
}

LlamaBackendsHandle&
LlamaBackendsHandle::operator=(LlamaBackendsHandle&& other) noexcept {
  if (this != &other) {
    if (ownsHandle_) {
      LlamaLazyInitializeBackend::decrementRefCount();
    }
    ownsHandle_ = other.ownsHandle_;
    other.ownsHandle_ = false;
  }
  return *this;
}
