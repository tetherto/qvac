#include "NmtLazyInitializeBackend.hpp"

#include <filesystem>
#include <string>

#include <ggml-backend.h>
#include <ggml.h>

#include "nmt_utils.hpp"
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
std::string NmtLazyInitializeBackend::g_recordedOpenclCacheDir;
std::string NmtLazyInitializeBackend::g_recordedOpenclCacheDirInput;
int NmtLazyInitializeBackend::g_refCount = 0;
std::atomic<bool> NmtLazyInitializeBackend::g_backendsLoaded{false};

// Forward ggml's internal log stream to QLOG so diagnostic lines
// (Adreno detection, CL_CHECK errors, OpenCL driver info, etc.) reach
// logcat on Android instead of silently going to stderr. Mirrors what
// llama_log_set does in the llamacpp-llm addon. See QVAC-17790.
namespace {

void nmtGgmlLogCallback(
    enum ggml_log_level level, const char* text, void* /*user_data*/) {
  if (text == nullptr ||
      text[0] == // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
          '\0') {
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
  // NOLINTBEGIN(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  while (len > 0 && (text[len - 1] == '\n' || text[len - 1] == '\r')) {
    // NOLINTEND(cppcoreguidelines-pro-bounds-pointer-arithmetic)
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
  message.reserve(
      7 + // NOLINT(cppcoreguidelines-avoid-magic-numbers,readability-magic-numbers)
      len);
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

int nmtBackendSoIterCallback(
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

void nmtInstallCallbacksInLoadedBackendSos() {
  std::vector<std::string> paths;
  dl_iterate_phdr(&nmtBackendSoIterCallback, &paths);

  using LogSetFn = void (*)(ggml_log_callback, void*);
  // ggml_set_abort_callback returns the previously-installed callback; declare
  // the typedef to match so the indirect call is ABI-correct.
  using AbortSetFn = ggml_abort_callback_t (*)(ggml_abort_callback_t);

  for (const auto& soPath : paths) {
    void* handle = dlopen(soPath.c_str(), RTLD_NOW | RTLD_NOLOAD);
    if (handle == nullptr) {
      continue;
    }
    auto logSetFn = reinterpret_cast<LogSetFn>(dlsym(handle, "ggml_log_set"));
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
  return initializeLocked(backendsDir, openclCacheDir);
}

bool NmtLazyInitializeBackend::initializeAndRef(
    const std::string& backendsDir, const std::string& openclCacheDir) {
  std::lock_guard<std::mutex> lock(g_initMutex);
  bool didInit = initializeLocked(backendsDir, openclCacheDir);
  // Increment unconditionally so every NmtBackendsHandle holds a reference,
  // whether it triggered the one-time init or attached to an existing one.
  // Lives in the same critical section as initializeLocked() so the count
  // and the g_initialized flag advance atomically (closes the TOCTOU
  // between two separate g_initMutex acquisitions).
  g_refCount++;
  return didInit;
}

// NOLINTBEGIN(readability-function-cognitive-complexity,bugprone-easily-swappable-parameters)
bool NmtLazyInitializeBackend::initializeLocked(
    const std::string& backendsDir,
    const std::string& openclCacheDir [[maybe_unused]]) {
  // NOLINTEND(readability-function-cognitive-complexity,bugprone-easily-swappable-parameters)
  if (g_initialized) {
    if (!backendsDir.empty() && !g_recordedBackendsDir.empty() &&
        backendsDir != g_recordedBackendsDir) {
      QLOG(
          Priority::WARNING,
          "Backend already initialized with different backendsDir. "
          "Previously initialized at: " +
              sanitizePrintableAscii(g_recordedBackendsDir) +
              ", requested: " + sanitizePrintableAscii(backendsDir));
    }
#ifdef __ANDROID__
    if (!openclCacheDir.empty() && !g_recordedOpenclCacheDirInput.empty() &&
        openclCacheDir != g_recordedOpenclCacheDirInput) {
      QLOG(
          Priority::WARNING,
          "Backend already initialized with different openclCacheDir. "
          "Previously initialized at: " +
              sanitizePrintableAscii(g_recordedOpenclCacheDirInput) +
              ", requested: " + sanitizePrintableAscii(openclCacheDir));
    }
#endif
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
    // Defense-in-depth against path traversal: require the input to be an
    // absolute path AND reject any input whose RAW (pre-normalisation)
    // components contain `..`. We must check the input — not the normalised
    // form — because lexically_normal() consumes `..` segments syntactically
    // (e.g. /a/b/../c → /a/c), so a check on the normalised path can never
    // see a `..` and would silently allow `/data/app/../../etc/passwd` to
    // resolve to `/etc/passwd`. Rejecting any `..` in the request itself
    // closes that escape; we accept the conservative trade-off that legit
    // cache paths happen never to contain `..` segments in practice.
    std::filesystem::path requested(openclCacheDir);
    bool validPath = requested.is_absolute();
    if (validPath) {
      for (const auto& seg : requested) {
        if (seg == "..") {
          validPath = false;
          break;
        }
      }
    }
    if (!validPath) {
      QLOG(
          Priority::WARNING,
          "Rejecting suspicious openclCacheDir (must be absolute and free of "
          "'..' segments): " +
              sanitizePrintableAscii(openclCacheDir));
    } else {
      std::error_code ec;
      auto resolved = std::filesystem::weakly_canonical(requested, ec);
      if (ec) {
        QLOG(
            Priority::WARNING,
            "openclCacheDir weakly_canonical() failed (" + ec.message() +
                "): " + sanitizePrintableAscii(openclCacheDir));
      } else if (resolved.string().rfind("/data/", 0) != 0) {
        QLOG(
            Priority::WARNING,
            "Rejecting openclCacheDir — resolved path outside /data/ prefix: " +
                sanitizePrintableAscii(resolved.string()));
      } else {
        auto oclCachePath = (resolved / "opencl-cache").string();
        setenv("GGML_OPENCL_CACHE_DIR", oclCachePath.c_str(), /*overwrite=*/1);
        g_recordedOpenclCacheDir = std::move(oclCachePath);
        g_recordedOpenclCacheDirInput = openclCacheDir;
      }
    }
  }
#endif

  if (!g_backendsLoaded) {
    if (!backendsDir.empty()) {
      std::filesystem::path requested(backendsDir);
      bool validBackendsDir = requested.is_absolute();
      if (validBackendsDir) {
        for (const auto& seg : requested) {
          if (seg == "..") {
            validBackendsDir = false;
            break;
          }
        }
      }
      if (!validBackendsDir) {
        QLOG(
            Priority::WARNING,
            "Rejecting suspicious backendsDir (must be absolute and free of "
            "'..' segments): " +
                sanitizePrintableAscii(backendsDir) +
                " — falling back to default backend loading");
        ggml_backend_load_all();
      } else {
        std::error_code errCode;
        std::filesystem::path backendsDirPath =
            std::filesystem::canonical(requested, errCode);
        if (errCode) {
          QLOG(
              Priority::WARNING,
              "backendsDir canonical() failed (" + errCode.message() +
                  "): " + sanitizePrintableAscii(backendsDir) +
                  " — falling back to default backend loading");
          ggml_backend_load_all();
        } else {
          auto
              resolvedStr = // NOLINT(bugprone-unused-local-non-trivial-variable)
              backendsDirPath.string();
#ifdef __ANDROID__
          if (resolvedStr.rfind("/data/", 0) != 0) {
            QLOG(
                Priority::WARNING,
                "Rejecting backendsDir — resolved path outside /data/ "
                "prefix: " +
                    sanitizePrintableAscii(resolvedStr) +
                    " — falling back to default backend loading");
            ggml_backend_load_all();
          } else {
#endif
#ifdef BACKENDS_SUBDIR
            std::filesystem::path subdirPath(BACKENDS_SUBDIR);
            backendsDirPath = backendsDirPath / subdirPath;
            backendsDirPath =
                std::filesystem::canonical(backendsDirPath, errCode);
            if (errCode) {
              QLOG(
                  Priority::WARNING,
                  "backendsDir+subdir canonical() failed (" +
                      errCode.message() +
                      ") — falling back to default backend loading");
              ggml_backend_load_all();
            } else {
#endif
              QLOG(
                  Priority::INFO,
                  "Loading backends from directory: " +
                      sanitizePrintableAscii(backendsDirPath.string()));
              ggml_backend_load_all_from_path(backendsDirPath.string().c_str());
#ifdef BACKENDS_SUBDIR
            }
#endif
#ifdef __ANDROID__
          }
#endif
        }
      }
    } else {
      QLOG(Priority::DEBUG, "Loading backends using default path");
      ggml_backend_load_all();
    }
    g_backendsLoaded = true;
  }
#ifdef __ANDROID__
  // Must run after backend loading (the backend .sos are only mapped into
  // the process after ggml_backend_load_all* returns) and regardless of
  // whether a backendsDir was provided.
  nmtInstallCallbacksInLoadedBackendSos();
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
      g_backendsLoaded = false;
      g_recordedBackendsDir.clear();
#ifdef __ANDROID__
      // Clear the process-global GGML_OPENCL_CACHE_DIR set during
      // initialize() so a fresh initialize() with a different path is not
      // shadowed by the stale value.
      if (!g_recordedOpenclCacheDir.empty()) {
        unsetenv("GGML_OPENCL_CACHE_DIR");
        g_recordedOpenclCacheDir.clear();
        g_recordedOpenclCacheDirInput.clear();
      }
#endif
    }
  }
}

NmtBackendsHandle::NmtBackendsHandle(
    const std::string& backendsDir, const std::string& openclCacheDir)
    : ownsHandle_(true) {
  // Single-locked init+ref so a racing destructor cannot decrement to zero
  // (and tear down the env var / backend state) between the initialize()
  // unlock and the incrementRefCount() lock.
  NmtLazyInitializeBackend::initializeAndRef(backendsDir, openclCacheDir);
}

NmtBackendsHandle::~NmtBackendsHandle() { // NOLINT(bugprone-exception-escape)
  if (ownsHandle_) {
    NmtLazyInitializeBackend::decrementRefCount();
  }
}

NmtBackendsHandle::NmtBackendsHandle(NmtBackendsHandle&& other) noexcept
    : ownsHandle_(other.ownsHandle_) {
  other.ownsHandle_ = false;
}

NmtBackendsHandle&
NmtBackendsHandle::operator=( // NOLINT(bugprone-exception-escape)
    NmtBackendsHandle&& other) noexcept {
  if (this != &other) {
    if (ownsHandle_) {
      NmtLazyInitializeBackend::decrementRefCount();
    }
    ownsHandle_ = other.ownsHandle_;
    other.ownsHandle_ = false;
  }
  return *this;
}
