#pragma once

// Shared input/config types for the ocr-ggml `Pipeline` adapter.
//
// `OcrInput` and `OcrConfig` mirror @qvac/ocr-onnx's JS API surface; the
// `PipelineMode` enum lets `OcrConfig::mode` select between the EasyOCR
// (CRAFT + bounding-box + CRNN gen-2) and DocTR (DBNet + DocTR
// recognition) step sequences at load time, the same way ocr-onnx's
// `PipelineConfig::mode` does.

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

// NOLINTBEGIN(readability-identifier-naming)
// OcrInput / OcrConfig field names follow the @qvac/ocr-onnx JS API
// surface; constructor parameter pairs (pathDetector/pathRecognizer) and
// (imageWidth/imageHeight) are documented at the call site.

namespace qvac_lib_infer_ocr_ggml {

// Selects which backend the `Pipeline` constructs at load time. Mirrors
// `qvac_lib_inference_addon_onnx_ocr_fasttext::PipelineMode`.
enum class PipelineMode : std::uint8_t {
  EASYOCR, // CRAFT detection + bounding-box extraction + CRNN gen-2 recognition
  DOCTR    // DBNet detection + DocTR recognition
};

// Selects which ggml backend device the inference steps run on. `CPU` is the
// always-available default; `VULKAN` (Linux/Windows/Android), `METAL` (Apple)
// and `OPENCL` (Android/Adreno) opt in to GPU execution when a matching device
// is present, otherwise the steps fall back to CPU (see `OcrBackendSelection`).
// Mirrors the opt-in GPU pattern in `vla_backend_selection`. OPENCL is the
// preferred GPU path on Qualcomm Adreno, whose Vulkan compute path is
// numerically broken and therefore guarded off on the auto Vulkan path.
enum class BackendDevice : std::uint8_t { CPU, VULKAN, METAL, OPENCL };

// Mirrors @qvac/ocr-onnx's PipelineInput so the JS side can interchangeably
// drive both addons. Either pass an encoded JPEG/PNG byte buffer (set
// `isEncoded`) or a raw RGB image with explicit width/height.
struct OcrInput {
  int imageWidth{};
  int imageHeight{};
  // NOLINTNEXTLINE(cppcoreguidelines-avoid-magic-numbers,readability-magic-numbers)
  int bitsPerPixel{24};
  std::vector<uint8_t> data;
  bool isEncoded{false};
  bool paragraph{false};
  std::optional<std::vector<int>> rotationAngles;
  // NOLINTNEXTLINE(cppcoreguidelines-avoid-magic-numbers,readability-magic-numbers)
  float boxMarginMultiplier{0.1F};
};

// NOLINTBEGIN(cppcoreguidelines-avoid-magic-numbers,readability-magic-numbers)
struct OcrConfig {
  // Pipeline mode (EasyOCR vs DocTR). Default matches the JS / CLI /
  // README contract: EasyOCR is the primary pipeline; callers opt in to
  // DocTR explicitly via `params.pipelineType: 'doctr'`.
  PipelineMode mode{PipelineMode::EASYOCR};
  float magRatio{1.5F};
  // EasyOCR `canvas_size`: detection canvas cap (long side, px) after magRatio
  // scaling. Bounds the CRAFT graph's peak memory; default 2560 matches
  // @qvac/ocr-onnx and EasyOCR. Lower on memory-constrained targets (mobile)
  // to avoid the dense-page OOM in QVAC-19340. EasyOCR only.
  int canvasSize{2560};
  std::vector<int> defaultRotationAngles{90, 270};
  bool contrastRetry{false};
  float lowConfidenceThreshold{0.4F};
  // DocTR recognizer feature-extractor batch (crops per backend compute).
  // 0 = auto: resolved per backend in Pipeline. On Metal a small batch is
  // markedly faster than a large one (per-op cost grows super-linearly with
  // batch); measured optimum ~4 on Apple GPUs. On Vulkan the opposite holds —
  // many tiny per-crop dispatches dominate (especially on mobile GPUs like
  // Mali), so a large batch (32) is markedly faster. A positive value here
  // overrides the auto choice on every backend.
  int recognizerBatchSize{0};
  // <0 leave GGML default, 0 auto-detect physical cores, >0 explicit override.
  int nThreads{0};
  // Directory that holds dynamic ggml backend shared libraries (libggml-*.so).
  // Default empty -> ggml_backend_load_all() picks up backends via env / dl
  // path.
  std::string backendsDir;
  // Requested ggml backend device. CPU is the default and is always available;
  // VULKAN / METAL opt in to GPU inference and transparently fall back to CPU
  // when no matching device is present (mapped from `params.backendDevice` in
  // AddonJs.hpp).
  BackendDevice backendDevice{BackendDevice::CPU};
  // Optional explicit GPU device selection (mapped from `params.gpuDevice`).
  // 0-based index into the matching GPU/iGPU devices for the requested backend,
  // in ggml enumeration order. When unset (the default), selection prefers a
  // discrete GPU and falls back to an integrated GPU. When set out of range,
  // the pipeline falls back to CPU (see `OcrBackendSelection`). Ignored for the
  // CPU backend.
  std::optional<int> gpuDevice;
  // Optional per-stage backend override for the DocTR detector (mapped from
  // `params.detectionBackendDevice`). When set, detection runs on this backend
  // while recognition uses `backendDevice`. Motivation: on Mali-G715 the DBNet
  // detector's many conv2d dispatches carry ~3.4s of Vulkan GPU-side overhead
  // (measured), while CPU detection is ~1.3s; running detection on CPU and
  // recognition on Vulkan ("hybrid") is the fastest config on that device.
  std::optional<BackendDevice> detectionBackendDevice;
  // Optional toggle for the DocTR recognizer's CPU-assist worker (mapped from
  // `params.recognizerCpuAssist`). When recognition runs on a GPU backend, a
  // second CPU feature-extractor instance steals crop chunks and computes them
  // concurrently with the GPU. Unset = auto (enabled on Mali/Immortalis Vulkan,
  // where the CPU is idle during the GPU compute wait and the two are of
  // comparable speed). Ignored when recognition already runs on CPU.
  std::optional<bool> recognizerCpuAssist;
};
// NOLINTEND(cppcoreguidelines-avoid-magic-numbers,readability-magic-numbers)

} // namespace qvac_lib_infer_ocr_ggml

// NOLINTEND(readability-identifier-naming)
