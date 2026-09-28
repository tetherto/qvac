#pragma once

#include <optional>
#include <string>

namespace qvac::ttsggml::supertonic {

struct SupertonicConfig {
  std::string modelGgufPath;
  std::string voice;
  /**
   * External voice JSON ({ style_ttl, style_dp }), forwarded to
   * EngineOptions::voice_json_path. Overrides the baked `voice` preset; the
   * engine checks the tensor sizes against the model at construction.
   */
  std::string voiceJsonPath;
  std::string language = "en";
  std::optional<int> steps;
  /** Exact rate multiplier. Mutually exclusive with `pace` (engine rejects). */
  std::optional<float> speed;
  /** Canonical rate step: slow | moderate | fast (tts-cpp/voice_controls.h). */
  std::string pace;
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

  // Persistent Vulkan pipeline-cache dir; empty -> no cross-process cache.
  std::string vulkanCacheDir;

  /**
   * Vulkan adapter index, forwarded to EngineOptions::vulkan_device and to the
   * LavaSR enhancer: 0 (engine default) = first adapter, N = the Nth, -1 =
   * auto-pick by free VRAM preferring a discrete adapter.
   */
  std::optional<int> vulkanDevice;

  /**
   * Throwaway synthesis run at load (EngineOptions::prewarm_text) so GPU
   * pipelines compile (and a Core ML vocoder sidecar specializes) before the
   * first run(); the engine skips it on a plain CPU run. Wins over the
   * vulkanCacheDir default pre-warm sentence.
   */
  std::string prewarmText;

  /**
   * Native streaming, forwarded to EngineOptions::stream_*. With
   * streamChunkTokens > 0 the engine splits the text into chunks of about that
   * many text tokens and emits each chunk's PCM as it is synthesized; 0 =
   * batch. streamFirstChunkTokens sizes the first chunk (0 = same),
   * streamChunkTolerancePct is the boundary-snap window (engine default 20)
   * and streamMinChunkTokens the per-chunk floor (engine default 30).
   */
  std::optional<int> streamChunkTokens;
  std::optional<int> streamFirstChunkTokens;
  std::optional<int> streamChunkTolerancePct;
  std::optional<int> streamMinChunkTokens;

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
  // The tts-cpp UL-UNAS forward is implemented in qvac-fabric-speech.cpp PR
  // #78; a non-empty path activates it once the pinned tts-cpp includes #78.
  std::string denoiserGgufPath;
};

}
