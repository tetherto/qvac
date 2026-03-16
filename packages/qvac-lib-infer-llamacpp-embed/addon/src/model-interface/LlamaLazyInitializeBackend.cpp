#include "LlamaLazyInitializeBackend.hpp"

#include <filesystem>
#include <string>

#include <ggml-backend.h>
#include <llama.h>

#include "logging.hpp"
#include "utils.hpp"

using namespace qvac_lib_infer_llamacpp_embed::logging;
using namespace qvac_lib_inference_addon_cpp::logger;

std::mutex LlamaLazyInitializeBackend::g_initMutex;
bool LlamaLazyInitializeBackend::g_initialized = false;
std::string LlamaLazyInitializeBackend::g_recordedBackendsDir;
int LlamaLazyInitializeBackend::g_refCount = 0;

bool LlamaLazyInitializeBackend::initialize(const std::string& backendsDir) {
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

  llama_log_set(llamaLogCallback, nullptr);

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
      shutdownLocked();
    }
  }
}

void LlamaLazyInitializeBackend::shutdownLocked() {
  // Explicitly unload all dynamically-loaded backend libraries (Vulkan,
  // Metal, DirectX, etc.) BEFORE freeing the llama backend. This triggers
  // their static destructors / atexit handlers while the ggml backend
  // registry is still alive and valid. Without this, those destructors
  // run during process exit in undefined order relative to the ggml
  // registry destruction, causing use-after-free (SIGSEGV / exit 139).
  //
  // Unload in reverse order to respect potential inter-backend dependencies.
  for (auto i = static_cast<int>(ggml_backend_reg_count()) - 1; i >= 0;
       --i) {
    ggml_backend_reg_t reg =
        ggml_backend_reg_get(static_cast<size_t>(i));
    ggml_backend_unload(reg);
  }

  llama_backend_free();
  g_initialized = false;
}

LlamaBackendsHandle::LlamaBackendsHandle(const std::string& backendsDir)
    : ownsHandle_(true) {
  LlamaLazyInitializeBackend::initialize(backendsDir);
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
