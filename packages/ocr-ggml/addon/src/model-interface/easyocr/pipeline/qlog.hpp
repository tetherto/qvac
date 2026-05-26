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

// NOLINTBEGIN(readability-identifier-naming,cppcoreguidelines-macro-usage)
// Shim macros (QLOG, ALOG_DEBUG, ALOG_INFO) replace upstream qvac logging
// in lifted files; macro form preserves diff-vs-upstream parity.

namespace qvac_lib_inference_addon_cpp::logger {
// Unscoped to mirror upstream `qvac::logger::Priority` enum used at the QLOG
// call sites lifted verbatim from ocr-onnx.
// NOLINTNEXTLINE(cppcoreguidelines-use-enum-class)
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

// NOLINTEND(readability-identifier-naming,cppcoreguidelines-macro-usage)
