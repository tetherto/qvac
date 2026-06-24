#include "OcrLazyInitializeBackend.hpp"

#include <cstring>
#include <filesystem>
#include <string>
#include <vector>

#include "ggml-backend.h"
#include "ggml-cpu.h"
#include "ggml.h"

#include "easyocr/pipeline/qlog.hpp"

#ifdef __ANDROID__
#include <android/log.h>
#include <dlfcn.h>
#include <link.h>
#endif

// NOLINTBEGIN(readability-identifier-naming,readability-identifier-length)

using Priority = qvac_lib_inference_addon_cpp::logger::Priority;

std::mutex OcrLazyInitializeBackend::g_initMutex;
bool OcrLazyInitializeBackend::g_initialized = false;
std::string OcrLazyInitializeBackend::g_recordedBackendsDir;
int OcrLazyInitializeBackend::g_refCount = 0;

namespace {

// Route ggml log lines to logcat on Android. Mirrors the nmtGgmlLogCallback
// in translation-nmtcpp's NmtLazyInitializeBackend.cpp.
void ocrGgmlLogCallback(
    enum ggml_log_level level, const char* text, void* /*user_data*/) {
  if (text == nullptr || text[0] == '\0') { // NOLINT(cppcoreguidelines-pro-bounds-pointer-arithmetic)
    return;
  }
  if (level == GGML_LOG_LEVEL_DEBUG) {
    return;
  }

  Priority priority = Priority::INFO;
  switch (level) {
  case GGML_LOG_LEVEL_ERROR:
    priority = Priority::ERROR_;
    break;
  case GGML_LOG_LEVEL_WARN:
    priority = Priority::WARN;
    break;
  default:
    break;
  }

  size_t len = std::strlen(text);
  // NOLINTBEGIN(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  while (len > 0 && (text[len - 1] == '\n' || text[len - 1] == '\r')) {
    --len;
  }
  // NOLINTEND(cppcoreguidelines-pro-bounds-pointer-arithmetic)
  if (len == 0) {
    return;
  }

#ifdef __ANDROID__
  if (level == GGML_LOG_LEVEL_ERROR || level == GGML_LOG_LEVEL_WARN) {
    __android_log_print(
        level == GGML_LOG_LEVEL_ERROR ? ANDROID_LOG_ERROR : ANDROID_LOG_WARN,
        "ggml-ocr", "%.*s", static_cast<int>(len), text);
  }
#endif

  std::string message;
  message.reserve(7 + len); // NOLINT(cppcoreguidelines-avoid-magic-numbers)
  message.append("[ggml] ");
  message.append(text, len);
  QLOG(priority, message);
}

// Route GGML_ABORT messages to logcat synchronously before abort() fires.
// Without this, assertion failures inside backend .so code are silent on
// Android because stderr is dropped. See NmtLazyInitializeBackend.cpp.
void ocrGgmlAbortCallback(const char* message) {
  if (message == nullptr) {
    message = "(null abort message)";
  }
#ifdef __ANDROID__
  __android_log_print(
      ANDROID_LOG_FATAL, "ggml-ocr-abort", "GGML_ABORT: %s", message);
#endif
  QLOG(
      Priority::ERROR_,
      std::string("[ggml-abort] ") + message);
}

#ifdef __ANDROID__
// Collect all loaded .so paths whose filename contains "ggml".
static int ocrBackendSoIterCallback(
    struct dl_phdr_info* info, size_t /*size*/, void* data) {
  if (info == nullptr || info->dlpi_name == nullptr ||
      info->dlpi_name[0] == '\0') {
    return 0;
  }
  const char* slash = strrchr(info->dlpi_name, '/');
  const char* filename = slash ? slash + 1 : info->dlpi_name;
  if (strstr(filename, "ggml") == nullptr || strstr(filename, ".so") == nullptr) {
    return 0;
  }
  static_cast<std::vector<std::string>*>(data)->emplace_back(info->dlpi_name);
  return 0;
}

// Install log + abort callbacks into each already-loaded ggml backend .so.
// Each backend is loaded with RTLD_LOCAL, so its copy of g_logger_state and
// g_abort_callback is private. We must patch each one separately after
// ggml_backend_load_all_from_path returns. Mirrors
// nmtInstallCallbacksInLoadedBackendSos in translation-nmtcpp.
static void installCallbacksInBackendSos() {
  std::vector<std::string> paths;
  dl_iterate_phdr(&ocrBackendSoIterCallback, &paths);

  using LogSetFn = void (*)(ggml_log_callback, void*);
  using AbortSetFn = ggml_abort_callback_t (*)(ggml_abort_callback_t);

  for (const auto& soPath : paths) {
    void* handle = dlopen(soPath.c_str(), RTLD_NOW | RTLD_NOLOAD);
    if (handle == nullptr) {
      continue;
    }
    if (auto* fn = reinterpret_cast<LogSetFn>(dlsym(handle, "ggml_log_set"))) {
      fn(&ocrGgmlLogCallback, nullptr);
    }
    if (auto* fn = reinterpret_cast<AbortSetFn>(
            dlsym(handle, "ggml_set_abort_callback"))) {
      fn(&ocrGgmlAbortCallback);
    }
    dlclose(handle);
  }
}
#endif

} // namespace

bool OcrLazyInitializeBackend::initialize(const std::string& backendsDir) {
  std::lock_guard<std::mutex> lock(g_initMutex);

  if (g_initialized) {
    if (!backendsDir.empty() && !g_recordedBackendsDir.empty() &&
        backendsDir != g_recordedBackendsDir) {
      QLOG(
          Priority::WARN,
          "ocr-ggml: backend already initialized with a different backendsDir. "
          "Previously: " +
              g_recordedBackendsDir + ", requested: " + backendsDir);
    }
    return false;
  }

  if (!backendsDir.empty()) {
    g_recordedBackendsDir = backendsDir;
  }

  // Install callbacks in the main .bare copy BEFORE loading so that any
  // registration-time ggml log lines reach logcat.
  ggml_log_set(&ocrGgmlLogCallback, nullptr);
  ggml_set_abort_callback(&ocrGgmlAbortCallback);

  if (!backendsDir.empty()) {
    std::filesystem::path p(backendsDir);
#ifdef BACKENDS_SUBDIR
    p = (p / std::filesystem::path(BACKENDS_SUBDIR)).lexically_normal();
#endif
    QLOG(Priority::INFO, "ocr-ggml: loading backends from " + p.string());
    ggml_backend_load_all_from_path(p.string().c_str());
  } else {
    ggml_backend_load_all();
  }

#ifdef __ANDROID__
  // Patch callbacks into each backend .so's private ggml copy so that any
  // GGML_ASSERT inside the Vulkan/OpenCL backend reaches logcat.
  installCallbacksInBackendSos();
#endif

  g_initialized = true;
  return true;
}

void OcrLazyInitializeBackend::incrementRefCount() {
  std::lock_guard<std::mutex> lock(g_initMutex);
  g_refCount++;
}

void OcrLazyInitializeBackend::decrementRefCount() {
  std::lock_guard<std::mutex> lock(g_initMutex);
  if (g_refCount > 0) {
    g_refCount--;
    // Unlike llm-llamacpp (which calls llama_backend_free when count reaches
    // zero), GGML dynamically-loaded backends have no process-scoped teardown
    // API. The .so files stay resident for the process lifetime, so g_initialized
    // is intentionally left set.
  }
}

OcrBackendsHandle::OcrBackendsHandle(const std::string& backendsDir)
    : ownsHandle_(true) {
  OcrLazyInitializeBackend::initialize(backendsDir);
  OcrLazyInitializeBackend::incrementRefCount();
}

OcrBackendsHandle::~OcrBackendsHandle() {
  if (ownsHandle_) {
    OcrLazyInitializeBackend::decrementRefCount();
  }
}

OcrBackendsHandle::OcrBackendsHandle(OcrBackendsHandle&& other) noexcept
    : ownsHandle_(other.ownsHandle_) {
  other.ownsHandle_ = false;
}

OcrBackendsHandle&
OcrBackendsHandle::operator=(OcrBackendsHandle&& other) noexcept {
  if (this != &other) {
    if (ownsHandle_) {
      OcrLazyInitializeBackend::decrementRefCount();
    }
    ownsHandle_ = other.ownsHandle_;
    other.ownsHandle_ = false;
  }
  return *this;
}

// NOLINTEND(readability-identifier-naming,readability-identifier-length)
