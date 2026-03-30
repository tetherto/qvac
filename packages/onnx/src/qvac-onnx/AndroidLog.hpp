#pragma once

// Android logcat logging for ONNX session diagnostics.
// Disabled by default. Enable at build time with:
//   -D QVAC_ONNX_ANDROID_LOG=ON  (CMake)
//   or -DQVAC_ONNX_ENABLE_ANDROID_LOG (compiler flag)

#if defined(__ANDROID__) && defined(QVAC_ONNX_ENABLE_ANDROID_LOG)
#include <android/log.h>
#define ONNX_ALOG_TAG "QVAC_ONNX"
// NOLINTBEGIN(cppcoreguidelines-macro-usage)
#define ONNX_ALOG(fmt, ...) \
  __android_log_print(ANDROID_LOG_INFO, ONNX_ALOG_TAG, fmt, ##__VA_ARGS__)
// NOLINTEND(cppcoreguidelines-macro-usage)
#else
// NOLINTBEGIN(cppcoreguidelines-macro-usage)
#define ONNX_ALOG(fmt, ...) ((void)0)
// NOLINTEND(cppcoreguidelines-macro-usage)
#endif
