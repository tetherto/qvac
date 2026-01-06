#pragma once

#include <string_view>


namespace qvac_lib_inference_addon_cpp::logger {

  enum class Priority : int {
    //Source: tetherto/qvac-lib-logging/constants.js:21
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

  static constexpr std::string_view to_string(int priority) noexcept {
    return to_string(static_cast<Priority>(priority));
  }

} //namespace qvac_lib_inference_addon_cpp::logger


#ifdef JS_LOGGER
#include "JsLogger.hpp"
#define QLOG(prio, msg) \
qvac_lib_inference_addon_cpp::logger::JsLogger::log(static_cast<qvac_lib_inference_addon_cpp::logger::Priority>(prio), msg)
#else
#include <iostream>
#define QLOG(prio, msg) \
do { \
std::cout << "[" << qvac_lib_inference_addon_cpp::logger::to_string(prio)<<"]: "<< msg <<std::endl; \
} while (0)
#endif
