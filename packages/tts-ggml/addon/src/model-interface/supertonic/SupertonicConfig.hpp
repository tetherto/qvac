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
  /**
   * Desired output sample rate in Hz (8000–192000), or unset/0 to keep the
   * engine's native rate. Forwarded to the engine
   * (EngineOptions::output_sample_rate), which resamples the PCM. When the
   * LavaSR enhancer is active the engine emits its native rate and the model
   * resamples after enhancement instead (see SupertonicModel::synthesize); the
   * final emitted rate is this value either way.
   */
  std::optional<int> outputSampleRate;
  /**
   * Tri-state GPU intent (mirrors ChatterboxConfig::useGpu):
   *   - std::nullopt: unspecified, let the engine use its library default.
   *   - true:         if nGpuLayers unset, maps to nGpuLayers=99. Honored on
   *                   GPU-capable hosts (Metal on Apple, Vulkan/CUDA on
   *                   desktop, Vulkan/OpenCL on Android), delegated to
   *                   tts-cpp's per-vendor allowlist (Adreno/Xclipse/Mali);
   *                   it falls back to CPU on GPUs it can't drive.
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

  // LavaSR neural speech enhancement. A non-empty `enhancerGgufPath` is the
  // single switch: when set, the model loads the enhancer GGUF and
  // bandwidth-extends the synthesized PCM to 48 kHz before returning it; empty
  // disables enhancement (full backward compat).
  //
  // The enhancer always produces 48 kHz; if `outputSampleRate` is also set the
  // model resamples the enhanced signal to that rate afterwards.
  std::string enhancerGgufPath;

  // LavaSR neural speech denoiser (UL-UNAS). A non-empty `denoiserGgufPath` is
  // the single switch: when set, the model denoises the synthesized PCM BEFORE
  // the enhancer (rate-preserving); empty disables it (full backward compat).
  // The tts-cpp UL-UNAS forward is implemented in qvac-ext-lib-whisper.cpp PR
  // #78; a non-empty path activates it once the pinned tts-cpp includes #78.
  std::string denoiserGgufPath;
};

}
