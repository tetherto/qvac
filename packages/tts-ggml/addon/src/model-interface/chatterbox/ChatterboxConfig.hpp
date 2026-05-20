#pragma once

#include <optional>
#include <string>

namespace qvac::ttsggml::chatterbox {

/**
 * Configuration for the Chatterbox engine wrapping tts-cpp::tts-cpp.
 *
 * Mapped 1:1 into `tts_cpp::chatterbox::EngineOptions` by
 * {@link ChatterboxModel::load} and then passed to a persistent Engine that
 * owns the T3 + S3Gen + voice-conditioning state for the lifetime of the
 * addon.  The Engine is re-created on reload() when any of these fields
 * change (ex: a new reference voice or a flip between CPU / GPU).
 */
struct ChatterboxConfig {
  /** Path to the T3 (text -> speech tokens) GGUF. */
  std::string t3ModelPath;
  /** Path to the S3Gen + HiFT (speech tokens -> 24 kHz wav) GGUF. */
  std::string s3genModelPath;
  /** Language code; only "en" is supported by the current Chatterbox model. */
  std::string language = "en";
  /** Voice-cloning reference wav path. */
  std::string referenceAudio;
  /** Directory of baked voice-conditioning tensors (`tts-cpp --ref-dir`). */
  std::string voiceDir;
  /** RNG seed for CFM initial noise + SineGen excitation. */
  std::optional<int> seed;
  /** std::thread::hardware_concurrency() override. */
  std::optional<int> threads;
  /** Layers to move to the GPU backend.  99 (or any large number) = all. */
  std::optional<int> nGpuLayers;
  /** Post-processing output sample rate.  Currently unused (engine always emits 24 kHz). */
  std::optional<int> outputSampleRate;
  /**
   * Tri-state GPU intent:
   *   - std::nullopt: unspecified, let the engine use its library default.
   *   - true:         if nGpuLayers unset, maps to nGpuLayers=99.
   *   - false:        if nGpuLayers unset, forces nGpuLayers=0 (CPU).
   *
   * Conflicts with nGpuLayers (true + 0, or false + !=0) are rejected
   * by ChatterboxModel::validateConfig so callers can't silently get
   * the opposite backend they asked for.
   */
  std::optional<bool> useGpu;
  /**
   * Native streaming controls.  When `streamChunkTokens > 0` and the
   * caller passes a chunk callback on the job input, the engine runs
   * the chunked S3Gen+HiFT loop and emits PCM per chunk (~25 tokens
   * = 1 s of audio).  0 = batch synthesis.
   */
  std::optional<int> streamChunkTokens;
  /** Smaller first chunk for low first-audio-out latency.  0 = same as streamChunkTokens. */
  std::optional<int> streamFirstChunkTokens;
  /** CFM Euler steps for streaming chunks.  0 = library default (2). */
  std::optional<int> streamCfmSteps;

  /**
   * Forwarded to `tts_cpp::chatterbox::EngineOptions::backends_dir` /
   * `opencl_cache_dir`. On Android (and any other `GGML_BACKEND_DL=ON`
   * build) the addon ships the per-backend `.so` files under
   * `<package_dir>/prebuilds/<bare-target>/qvac__tts-ggml/`; the JS
   * layer (`index.js`) resolves `backendsDir` to that prebuild folder
   * at construction time. The C++ side joins
   * `backendsDir / BACKENDS_SUBDIR` before forwarding so a host that
   * already passes `path.join(__dirname, 'prebuilds')` (the qvac
   * llm-llamacpp / transcription-parakeet convention) gets identical
   * resolution semantics here.
   *
   * On Apple / Windows static-only builds these are no-ops:
   * `GGML_BACKEND_DL=OFF` makes every backend statically linked into
   * libtts-cpp.a, so the registry walk never touches the filesystem.
   *
   * `openclCacheDir` sets `$GGML_OPENCL_CACHE_DIR` for ggml-opencl's
   * program-binary cache (Android-only; the program-binary cache
   * patch only ships in the qvac-ext-ggml/speech Android build).
   * Pass the host platform's app cache directory to skip the cold
   * `clBuildProgram` cost on every process restart.
   *
   * Empty string -> leave the parakeet-style default in place (the
   * library falls back to ggml's compile-time search path, and
   * `$GGML_OPENCL_CACHE_DIR` is left alone).
   */
  std::string backendsDir;
  std::string openclCacheDir;
};

} // namespace qvac::ttsggml::chatterbox
