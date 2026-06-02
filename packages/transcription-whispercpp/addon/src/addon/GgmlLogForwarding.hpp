#pragma once

#include <string>

#include <ggml.h>

#include "inference-addon-cpp/Logger.hpp"

// whisper.cpp / ggml native-log forwarding (QVAC-19783).
//
// Kept JS-free (only <ggml.h> + the addon Logger) so it can be unit-tested
// without the JS runtime; AddonJs.hpp installs forwardGgmlLog() via
// whisper_log_set(). See AddonJs.hpp for the hook-choice rationale.
namespace qvac_lib_inference_addon_whisper {

// Map a ggml_log_level onto the addon logger Priority. This is the "verbosity"
// mapping: the JS-side logger level then decides what is shown. CONT (a
// continuation fragment of a long line that whisper/ggml split) and NONE
// default to INFO.
inline qvac_lib_inference_addon_cpp::logger::Priority
ggmlLevelToPriority(enum ggml_log_level level) {
  namespace logp = qvac_lib_inference_addon_cpp::logger;
  switch (level) {
  case GGML_LOG_LEVEL_ERROR:
    return logp::Priority::ERROR;
  case GGML_LOG_LEVEL_WARN:
    return logp::Priority::WARNING;
  case GGML_LOG_LEVEL_DEBUG:
    return logp::Priority::DEBUG;
  case GGML_LOG_LEVEL_INFO:
  case GGML_LOG_LEVEL_CONT:
  case GGML_LOG_LEVEL_NONE:
  default:
    return logp::Priority::INFO;
  }
}

// Forward a single whisper.cpp / ggml log line into the addon logger (QLOG ->
// JS logger), preserving its verbosity. Each callback invocation is surfaced
// immediately, with no cross-call buffering — mirroring llm-llamacpp's
// LlamaModel::llamaLogCallback. This is deterministic regardless of newline
// termination: whisper.cpp / ggml have error paths that emit a message WITHOUT
// a trailing '\n', so a newline-gated buffer could hold such a message pending
// indefinitely, or prepend it to a later unrelated message at the wrong
// priority. Per-call forwarding avoids that and keeps no shared mutable state
// (no unbounded buffer growth, no partial line lost at shutdown). Trailing
// newlines/CR are trimmed so the JS logger gets a clean line. JsLogger::log()
// is thread-safe, so this is safe on ggml's worker threads; it must never
// throw back into ggml's C log path.
inline void forwardGgmlLog(
    enum ggml_log_level level, const char* text, void* /*userData*/) {
  if (text == nullptr) {
    return;
  }
  std::string message(text);
  while (!message.empty() &&
         (message.back() == '\n' || message.back() == '\r')) {
    message.pop_back();
  }
  if (message.empty()) {
    return;
  }
  try {
    QLOG(ggmlLevelToPriority(level), message);
  } catch (...) {
    // A logging failure (e.g. JS logger not yet initialised) must never
    // propagate back into ggml's C log callback.
  }
}

} // namespace qvac_lib_inference_addon_whisper
