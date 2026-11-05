#pragma once

#include <string>

/// Image-token cap applied when the caller sets no `image_max_tokens`, keyed by
/// the mmproj's vision projector type. 0 keeps the encoder's own budget, so
/// fixed-grid encoders and smaller-budget dynamic ones (LightOnOCR / Pixtral at
/// 1024, LFM2 at 256) are never raised above their native limit.
inline int defaultImageMaxTokens(const std::string& projectorType) {
  // Qwen-VL allows 4096 image tokens, far more than the ~1024 it needs for
  // grounding; 2048 roughly halves the worst-case encode and image prefill.
  static constexpr int kQwenVl = 2048;
  // Gemma 4's own cap is 1120 tokens. A large image then needs four times the
  // prefill and encoder compute buffer of 280, which runs phones out of memory
  // and corrupts the encode on Adreno OpenCL.
  static constexpr int kGemma4 = 280;

  // Qwen vision mergers (qwen2vl_merger / qwen2.5vl_merger / qwen3vl_merger),
  // plus qwen2.5o, the Qwen2.5-Omni projector mtmd resolves to the Qwen2.5-VL
  // merger for vision.
  const bool isQwenVlMerger = projectorType.rfind("qwen", 0) == 0 &&
                              projectorType.find("vl") != std::string::npos;
  if (isQwenVlMerger || projectorType == "qwen2.5o") {
    return kQwenVl;
  }
  if (projectorType == "gemma4v" || projectorType == "gemma4uv") {
    return kGemma4;
  }
  return 0;
}
