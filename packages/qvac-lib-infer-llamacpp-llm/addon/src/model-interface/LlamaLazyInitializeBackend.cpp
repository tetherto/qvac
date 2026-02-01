#include "LlamaLazyInitializeBackend.hpp"

#include <filesystem>
#include <string>

#include <llama.h>

#include "LlamaModel.hpp"
#include "utils/LoggingMacros.hpp"

using namespace qvac_lib_inference_addon_llama::logging;
using namespace qvac_lib_inference_addon_cpp::logger;

std::mutex LlamaLazyInitializeBackend::initMutex;
bool LlamaLazyInitializeBackend::initialized = false;
std::string LlamaLazyInitializeBackend::recordedBackendsDir;
int LlamaLazyInitializeBackend::refCount = 0;

bool LlamaLazyInitializeBackend::initialize(const std::string& backendsDir) {
  std::lock_guard<std::mutex> lock(initMutex);

  if (initialized) {
    if (!backendsDir.empty() && !recordedBackendsDir.empty() &&
        backendsDir != recordedBackendsDir) {
      QLOG_IF(
          Priority::WARNING,
          "Backend already initialized with different backendsDir. "
          "Previously initialized at: " +
              recordedBackendsDir + ", requested: " + backendsDir);
    }
    return false;
  }

  if (!backendsDir.empty()) {
    recordedBackendsDir = backendsDir;
  }

  llama_log_set(LlamaModel::llamaLogCallback, nullptr);

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
  initialized = true;
  return true;
}

void LlamaLazyInitializeBackend::incrementRefCount() {
  std::lock_guard<std::mutex> lock(initMutex);
  refCount++;
}

void LlamaLazyInitializeBackend::decrementRefCount() {
  std::lock_guard<std::mutex> lock(initMutex);
  if (refCount > 0) {
    refCount--;
    if (refCount == 0 && initialized) {
      QLOG_IF(
          Priority::DEBUG, "Freeing backend (reference count reached zero)");
      llama_backend_free();
      initialized = false;
      recordedBackendsDir.clear();
    }
  }
}

LlamaBackendsHandle::LlamaBackendsHandle(const std::string& backendsDir)
    : ownsHandle(true) {
  LlamaLazyInitializeBackend::initialize(backendsDir);
  LlamaLazyInitializeBackend::incrementRefCount();
}

LlamaBackendsHandle::~LlamaBackendsHandle() {
  if (ownsHandle) {
    LlamaLazyInitializeBackend::decrementRefCount();
  }
}

LlamaBackendsHandle::LlamaBackendsHandle(LlamaBackendsHandle&& other) noexcept
    : ownsHandle(other.ownsHandle) {
  other.ownsHandle = false;
}

LlamaBackendsHandle&
LlamaBackendsHandle::operator=(LlamaBackendsHandle&& other) noexcept {
  if (this != &other) {
    if (ownsHandle) {
      LlamaLazyInitializeBackend::decrementRefCount();
    }
    ownsHandle = other.ownsHandle;
    other.ownsHandle = false;
  }
  return *this;
}
