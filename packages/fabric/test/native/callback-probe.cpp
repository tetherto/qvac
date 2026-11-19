#include <ggml.h>

// This internal emitter is what GGML_LOG_* uses in backend translation units.
extern "C" {
GGML_API void
ggml_log_internal(enum ggml_log_level level, const char* format, ...);
}

#ifdef _WIN32
#define PROBE_EXPORT extern "C" __declspec(dllexport)
#else
#define PROBE_EXPORT extern "C" __attribute__((visibility("default")))
#endif

PROBE_EXPORT void qvac_test_log() {
  ggml_log_internal(GGML_LOG_LEVEL_INFO, "%s", "qvac-boundary-log");
}

PROBE_EXPORT void qvac_test_abort() {
  ggml_abort(__FILE__, __LINE__, "%s", "qvac-boundary-abort");
}
