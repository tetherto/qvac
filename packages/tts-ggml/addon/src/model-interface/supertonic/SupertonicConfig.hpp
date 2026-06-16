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
   *   - true:         if nGpuLayers unset, maps to nGpuLayers=99. Honored on
   *                   GPU-capable hosts (Metal on Apple, Vulkan/CUDA on
   *                   desktop). On Android it is forced back to CPU in
   *                   SupertonicModel::loadLocked() because Adreno
   *                   OpenCL/Vulkan ggml graph compute is not yet stable.
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
