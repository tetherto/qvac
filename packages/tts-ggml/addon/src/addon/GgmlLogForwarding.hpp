#pragma once

#include <string>

#include <ggml.h>

#include "inference-addon-cpp/Logger.hpp"

// tts-cpp / ggml native-log forwarding.
//
// Kept JS-free (only <ggml.h> + the addon Logger) so it can be unit-tested
// without the JS runtime; AddonJs.hpp installs forwardGgmlLog() once per
// process through tts_cpp_log_set, which hands the callback to ggml so ggml
// and tts-cpp share one sink. Mirrors asr-ggml's GgmlLogForwarding.hpp.
namespace qvac::ttsggml {

// Map a ggml_log_level onto the addon logger Priority. The JS-side logger
// level then decides what is shown. CONT (a continuation fragment of a long
// line) and NONE default to INFO.
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

// Forward one tts-cpp / ggml log line into the addon logger (QLOG -> JS
// logger), preserving its verbosity. Each callback invocation is surfaced
// immediately with no cross-call buffering, so a message without a trailing
// newline is neither held back nor glued to a later one. Trailing newlines/CR
// are trimmed. JsLogger::log() is thread-safe, so this is safe on ggml's worker
// threads; it must never throw back into ggml's C log path.
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

} // namespace qvac::ttsggml
