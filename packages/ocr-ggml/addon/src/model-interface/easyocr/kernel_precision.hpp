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
#include <cstdlib>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

#include <ggml-backend.h>
#include <ggml.h>

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
#if defined(__APPLE__) && defined(__aarch64__)
    return true; // Apple-Silicon CPU has native FP16 arithmetic
#else
    return false; // Intel mac / x86 / non-Apple ARM CPU: F16 emulated -> slower
#endif
  }
  // GPU / iGPU / accelerator: F16 unless Mali (its Vulkan F16 GEMM regresses).
  return !ocr_desc_contains(ggml_backend_dev_description(dev), "mali");
}

// True when env var `name` is set to exactly "1".
inline bool ocr_env_is_one(const char* name) {
  const char* v = std::getenv(name);
  return v != nullptr && std::strcmp(v, "1") == 0;
}

// Resolve whether to store conv kernels as F16 for `backend`. The per-pipeline
// env overrides take precedence over the backend-aware default: `env_f32`=1
// forces F32, `env_f16`=1 forces F16 (F32 wins if both are set). Read at
// model-load time.
inline bool ocr_kernels_use_f16(
    ggml_backend_t backend, const char* env_f32, const char* env_f16) {
  if (ocr_env_is_one(env_f32)) {
    return false;
  }
  if (ocr_env_is_one(env_f16)) {
    return true;
  }
  return ocr_kernels_default_f16(backend);
}

// Upload a BatchNorm-folded F32 conv kernel into its (already-declared)
// destination tensor. When `w_dst` is F16, convert the F32 data first so
// ggml_conv_2d takes the F16 fast path (mirrors the doctr
// StepDoctrRecognitionGGML F16 weight upload); otherwise upload F32 verbatim.
// `w_folded` must hold exactly `ggml_nelements(w_dst)` values.
inline void
ocr_upload_kernel(::ggml_tensor* w_dst, const std::vector<float>& w_folded) {
  if (w_dst->type == GGML_TYPE_F16) {
    std::vector<ggml_fp16_t> w_f16(w_folded.size());
    ggml_fp32_to_fp16_row(
        w_folded.data(), w_f16.data(), static_cast<int64_t>(w_folded.size()));
    ggml_backend_tensor_set(
        w_dst, w_f16.data(), 0, w_f16.size() * sizeof(ggml_fp16_t));
  } else {
    ggml_backend_tensor_set(w_dst, w_folded.data(), 0, ggml_nbytes(w_dst));
  }
}

// NOLINTEND(readability-identifier-naming)

} // namespace easyocr::ggml
