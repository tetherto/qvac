#include "NmtLazyInitializeBackend.hpp"

#include <filesystem>
#include <string>

#include <ggml-backend.h>
#include <ggml.h>

#include "qvac-lib-inference-addon-cpp/Logger.hpp"

#ifdef __ANDROID__
#include <android/log.h>
#include <dlfcn.h>
#include <link.h>
#endif

using namespace qvac_lib_inference_addon_cpp::logger;

std::mutex NmtLazyInitializeBackend::g_initMutex;
bool NmtLazyInitializeBackend::g_initialized = false;
std::string NmtLazyInitializeBackend::g_recordedBackendsDir;
int NmtLazyInitializeBackend::g_refCount = 0;

// Forward ggml's internal log stream to QLOG so diagnostic lines
// (Adreno detection, CL_CHECK errors, OpenCL driver info, etc.) reach
// logcat on Android instead of silently going to stderr. Mirrors what
// llama_log_set does in the llamacpp-llm addon. See QVAC-17790.
namespace {
void nmtGgmlLogCallback(
    enum ggml_log_level level, const char* text, void* /*user_data*/) {
  if (text == nullptr || text[0] == '\0') {
    return;
  }

  // Early exit for DEBUG messages — avoids heap allocations on the hot path.
  // ggml emits dozens of DEBUG lines per forward pass; only ERROR/WARN/INFO
  // are worth the cost of string construction + QLOG queue dispatch.
  if (level == GGML_LOG_LEVEL_DEBUG) {
    return;
  }

  Priority priority = Priority::INFO;
  switch (level) {
  case GGML_LOG_LEVEL_ERROR:
    priority = Priority::ERROR;
    break;
  case GGML_LOG_LEVEL_WARN:
    priority = Priority::WARNING;
    break;
  default:
    break;
  }

  // Compute the trimmed length without heap allocation.
  size_t len = std::strlen(text);
  while (len > 0 && (text[len - 1] == '\n' || text[len - 1] == '\r')) {
    --len;
  }
  if (len == 0) {
    return;
  }

#ifdef __ANDROID__
  if (level == GGML_LOG_LEVEL_ERROR || level == GGML_LOG_LEVEL_WARN) {
    __android_log_print(
        level == GGML_LOG_LEVEL_ERROR ? ANDROID_LOG_ERROR : ANDROID_LOG_WARN,
        "ggml-nmt",
        "%.*s",
        static_cast<int>(len),
        text);
  }
#endif

  std::string message;
  message.reserve(7 + len);
  message.append("[ggml] ");
  message.append(text, len);
  QLOG(priority, message);
}

// ggml_abort uses its own callback (not the log callback). Without this
// hook, the "file:line: GGML_ASSERT(...) failed" message that precedes
// every SIGABRT goes to stderr — which is dropped on Android. Route it
// to logcat via __android_log_print (synchronous) so post-mortem logs
// show the failing assertion site.
void nmtGgmlAbortCallback(const char* message) {
  if (message == nullptr) {
    message = "(null abort message)";
  }
#ifdef __ANDROID__
  __android_log_print(
      ANDROID_LOG_FATAL, "ggml-nmt-abort", "GGML_ABORT: %s", message);
#endif
  QLOG(Priority::ERROR, std::string("[ggml-abort] ") + message);
}

#ifdef __ANDROID__
// ggml-backend loads each backend via dlopen(path, RTLD_NOW | RTLD_LOCAL)
// (see ggml-backend-reg.cpp). Because each backend .so statically links its
// own copy of libggml-base, the g_logger_state and g_abort_callback symbols
// inside every backend .so are PRIVATE — calling ggml_log_set /
// ggml_set_abort_callback from the main .bare only mutates the main .bare's
// copy. A GGML_ASSERT that fires inside the OpenCL or Vulkan backend (the
// exact crash we are chasing) therefore goes through an *uninstalled*
// callback and falls back to stderr, which is dropped on Android.
//
// Workaround: enumerate every loaded shared object via dl_iterate_phdr,
// collect paths matching ggml backend .so files, then install callbacks in
// a separate loop AFTER dl_iterate_phdr returns (to avoid holding the
// Bionic linker lock while calling dlopen/dlclose, which can deadlock on
// pre-API-30 devices).

static std::vector<std::string> g_collectedBackendPaths;

int backendSoIterCallback(
    struct dl_phdr_info* info, size_t /*size*/, void* data) {
  if (info == nullptr || info->dlpi_name == nullptr ||
      info->dlpi_name[0] == '\0') {
    return 0;
  }
  const char* soPath = info->dlpi_name;
  const char* slash = strrchr(soPath, '/');
  const char* filename = slash ? slash + 1 : soPath;

  if (strstr(filename, "ggml") == nullptr) {
    return 0;
  }
  if (strstr(filename, ".so") == nullptr) {
    return 0;
  }

  auto* paths = static_cast<std::vector<std::string>*>(data);
  paths->emplace_back(soPath);
  return 0;
}

void installCallbacksInLoadedBackendSos() {
  std::vector<std::string> paths;
  dl_iterate_phdr(&backendSoIterCallback, &paths);

  using LogSetFn = void (*)(ggml_log_callback, void*);
  using AbortSetFn = void (*)(ggml_abort_callback_t);

  for (const auto& soPath : paths) {
    void* handle = dlopen(soPath.c_str(), RTLD_NOW | RTLD_NOLOAD);
    if (handle == nullptr) {
      continue;
    }
    auto logSetFn =
        reinterpret_cast<LogSetFn>(dlsym(handle, "ggml_log_set"));
    if (logSetFn != nullptr) {
      logSetFn(&nmtGgmlLogCallback, nullptr);
    }
    auto abortSetFn =
        reinterpret_cast<AbortSetFn>(dlsym(handle, "ggml_set_abort_callback"));
    if (abortSetFn != nullptr) {
      abortSetFn(&nmtGgmlAbortCallback);
    }
    dlclose(handle);
  }
}
#endif
} // namespace

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

  // Install the ggml log + abort callbacks BEFORE
  // ggml_backend_load_all_from_path so backend-registration messages, CL_CHECK
  // error lines, and the actual "file:line: GGML_ASSERT(...) failed" abort
  // message are captured by the platform logger. Without these, ggml writes to
  // stderr which is dropped on Android, which is why the Adreno 830 OpenCL
  // crash looks silent. ggml_abort uses a separate callback from ggml_log_set,
  // so set both.
  ggml_log_set(&nmtGgmlLogCallback, nullptr);
  ggml_set_abort_callback(&nmtGgmlAbortCallback);

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
#ifdef __ANDROID__
  // Must run after backend loading (the backend .sos are only mapped into
  // the process after ggml_backend_load_all* returns) and regardless of
  // whether a backendsDir was provided.
  installCallbacksInLoadedBackendSos();
#endif

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
