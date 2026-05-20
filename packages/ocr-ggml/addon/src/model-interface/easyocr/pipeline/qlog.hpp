#pragma once

// Tiny shim that lets us lift @qvac/ocr-onnx pipeline sources into this repo
// without editing every QLOG / ALOG_DEBUG line.  Keeps the bodies diffable
// against the source-of-truth.
//
// QLOG(priority, message) — used throughout the qvac code with
//   `qvac_lib_inference_addon_cpp::logger::Priority::DEBUG` etc.
// ALOG_DEBUG(message)     — Android-style debug log.
//
// Both expand to a no-op here.  If you want to see the original log lines
// while debugging, change the macro bodies to forward to std::cerr.

#include <cstdint>
#include <string>

namespace qvac_lib_inference_addon_cpp::logger {
enum Priority : std::uint8_t {
  DEBUG,
  INFO,
  WARN,
  ERROR_
}; // ERROR clashes with windows.h
} // namespace qvac_lib_inference_addon_cpp::logger

#define QLOG(_prio, _msg) ((void)(_prio), (void)(_msg))
#define ALOG_DEBUG(_msg) ((void)(_msg))
#define ALOG_INFO(_msg) ((void)(_msg))
