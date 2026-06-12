#pragma once

#include <optional>
#include <string>

namespace qvac::ttsggml::supertonic {

struct SupertonicConfig {
  std::string modelGgufPath;
  std::string voice;
  std::string language = "en";
  std::optional<int> steps;
  std::optional<float> speed;
  std::optional<int> seed;
  std::optional<int> threads;
  std::optional<int> nGpuLayers;
  std::optional<int> outputSampleRate;
  /**
   * Tri-state GPU intent (mirrors ChatterboxConfig::useGpu):
   *   - std::nullopt: unspecified, let the engine use its library default.
   *   - true:         if nGpuLayers unset, maps to nGpuLayers=99.
   *                   Note: SupertonicModel::validateConfig still rejects
   *                   any GPU intent today because the Supertonic
   *                   engine is CPU-only ("CPU only today" — see
   *                   tts-cpp include/tts-cpp/supertonic/engine.h).
   *   - false:        if nGpuLayers unset, forces nGpuLayers=0 (CPU).
   *
   * Conflicts with nGpuLayers (true + 0, or false + !=0) are rejected
   * by validateConfig so callers can't silently get the opposite
   * backend they asked for.
   */
  std::optional<bool> useGpu;
  std::string noiseNpyPath;
  std::string backendsDir;
  std::string openclCacheDir;
};

}
