#pragma once

#include <string>

namespace qvac::audiogenggml::acestep {

// Mirrors tts_cpp::acestep::EngineOptions, populated by JSAdapter from the JS
// `configuration` object. Either set `modelDir` (auto-classify the four GGUFs
// by architecture) or the explicit per-stage paths (explicit wins).
//
// The numeric/bool fields are REQUIRED: C++ carries no defaults. JS (index.js)
// is the single place that decides default values and always sends every field;
// JSAdapter throws if any is missing. `0` for inferenceSteps/shift/threads means
// "auto" (the value JS chose), not a C++ fallback.
struct AcestepConfig {
  std::string modelDir;

  std::string textEncModelPath;  // Qwen3-Embedding-*.gguf
  std::string lmModelPath;       // acestep-5Hz-lm-*.gguf
  std::string ditModelPath;      // acestep-v15-*.gguf
  std::string vaeModelPath;      // vae-*.gguf

  int   inferenceSteps;  // 0 = auto (turbo 8, base/sft 50)
  float shift;           // 0 = auto (turbo 3.0, base/sft 1.0)
  int   threads;         // 0 = auto
  bool  useGpu;
  int   nGpuLayers;      // GPU layers to offload when useGpu is set
};

}  // namespace qvac::audiogenggml::acestep
