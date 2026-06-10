#pragma once

// Backend-aware default for storing EasyOCR conv kernels as F16 vs F32.
//
// Storing conv kernels as F16 makes ggml_conv_2d take the faster F16
// im2col -> GEMM path, but that only pays off where the *resolved* backend has
// a fast F16 GEMM. Measured on ocr-ggml CI (run #279 all-F32 vs #297 all-F16,
// EasyOCR detection time):
//
//   backend / device                     F16 vs F32     -> default
//   -----------------------------------  -------------  ----------
//   NVIDIA Vulkan (linux/win GPU)        ~1.2-2x faster  F16
//   Apple Metal (M-series, A-series)     ~1.05-1.1x      F16
//   Apple-Silicon CPU (native FP16)      ~1.25-1.3x      F16
//   Mali Vulkan (Pixel)                  ~4x SLOWER      F32
//   x86 CPU (Windows)                    ~1.1-1.2x slow  F32
//   non-Apple ARM CPU (linux-arm64)      ~2.7x SLOWER    F32
//
// So F16 is the default only on GPUs with a fast F16 GEMM (everything except
// Mali) and on Apple-Silicon CPUs; every other CPU falls back to F32. Adreno
// Vulkan is already skipped by OcrBackendSelection (it runs on CPU), so it is
// covered by the CPU branch here. The per-pipeline env overrides
// (OCR_GGML_{CRAFT,CRNN}_KERNEL_F32 / _F16) take precedence over this default.

#include <algorithm>
#include <cctype>
#include <string>
#include <string_view>

#include <ggml-backend.h>

namespace easyocr::ggml {

// snake_case helpers match the surrounding EasyOCR weight-loader naming (see
// craft_weights.cpp / crnn_weights.cpp), which intentionally opts out of the
// camelBack FunctionCase rule for this module.
// NOLINTBEGIN(readability-identifier-naming)

// Case-insensitive substring test for a ggml device description (may be null).
inline bool ocr_desc_contains(const char* desc, std::string_view needle) {
  if (desc == nullptr) {
    return false;
  }
  std::string lower(desc);
  std::transform(
      lower.begin(), lower.end(), lower.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
      });
  return lower.find(needle) != std::string::npos;
}

// Whether F16 conv-kernel storage is the right default for `backend`'s device.
// See the file header for the measured rationale.
inline bool ocr_kernels_default_f16(ggml_backend_t backend) {
  ggml_backend_dev_t dev =
      (backend != nullptr) ? ggml_backend_get_device(backend) : nullptr;
  if (dev == nullptr) {
    return false; // unknown device -> conservative F32
  }
  if (ggml_backend_dev_type(dev) == GGML_BACKEND_DEVICE_TYPE_CPU) {
#if defined(__APPLE__)
    return true; // Apple-Silicon CPU has native FP16 arithmetic
#else
    return false; // x86 / non-Apple ARM CPU: F16 is emulated -> slower
#endif
  }
  // GPU / iGPU / accelerator: F16 unless Mali (its Vulkan F16 GEMM regresses).
  return !ocr_desc_contains(ggml_backend_dev_description(dev), "mali");
}

// NOLINTEND(readability-identifier-naming)

} // namespace easyocr::ggml
