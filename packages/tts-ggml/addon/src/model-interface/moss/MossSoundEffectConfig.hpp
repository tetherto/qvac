#pragma once

#include <optional>
#include <string>

namespace qvac::ttsggml::moss {

struct MossSoundEffectConfig {
  std::string modelPath;
  std::optional<int> seed;
  std::optional<int> threads;
  std::optional<int> nGpuLayers;
  std::optional<bool> useGpu;
  std::string backendsDir;
};

struct MossSoundEffectCall {
  std::optional<double> seconds;
  std::optional<int> steps;
  std::optional<float> guidance;
  std::optional<float> shift;
  std::string negativePrompt;
};

} // namespace qvac::ttsggml::moss
