#pragma once

#include <string_view>

namespace onnx_addon::logger {

enum class Priority : int {
  ERROR   = 0,
  WARNING = 1,
  INFO    = 2,
  DEBUG   = 3,
  OFF     = 4
};

static constexpr std::string_view to_string(Priority priority) noexcept {
  switch (priority) {
    case Priority::INFO:    return "INFO";
    case Priority::DEBUG:   return "DEBUG";
    case Priority::WARNING: return "WARNING";
    case Priority::ERROR:   return "ERROR";
    case Priority::OFF:     return "OFF";
    default:                return "UNKNOWN";
  }
}

}  // namespace onnx_addon::logger

// When JS_LOGGER is defined, consumer addons provide JS logging via
// qvac-lib-inference-addon-cpp. This requires qvac-lib-inference-addon-cpp
// in the include path and is an opt-in compile-time dependency for consumers.
#ifdef JS_LOGGER
#include <qvac-lib-inference-addon-cpp/JsLogger.hpp>
#ifndef QLOG
// NOLINTBEGIN(cppcoreguidelines-macro-usage)
#define QLOG(prio, msg)                                                        \
  qvac_lib_inference_addon_cpp::logger::JsLogger::log(                         \
      static_cast<qvac_lib_inference_addon_cpp::logger::Priority>(             \
          static_cast<int>(prio)),                                             \
      msg)
// NOLINTEND(cppcoreguidelines-macro-usage)
#endif
#else
// Standalone fallback: log to stdout
#ifndef QLOG
#include <iostream>
// NOLINTBEGIN(cppcoreguidelines-macro-usage)
#define QLOG(prio, msg)                                                        \
  do {                                                                         \
    std::cout << "["                                                           \
              << onnx_addon::logger::to_string(                                \
                     static_cast<onnx_addon::logger::Priority>(prio))          \
              << "]: " << msg << std::endl;                                    \
  } while (0)
// NOLINTEND(cppcoreguidelines-macro-usage)
#endif
#endif

#ifndef NDEBUG
#ifndef QLOG_DEBUG
// NOLINTBEGIN(cppcoreguidelines-macro-usage)
#define QLOG_DEBUG(msg) QLOG(onnx_addon::logger::Priority::DEBUG, msg)
// NOLINTEND(cppcoreguidelines-macro-usage)
#endif
#else
#ifndef QLOG_DEBUG
// NOLINTBEGIN(cppcoreguidelines-macro-usage)
#define QLOG_DEBUG(msg) ((void)0)
// NOLINTEND(cppcoreguidelines-macro-usage)
#endif
#endif
