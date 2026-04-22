#pragma once

#include <optional>
#include <string>

namespace qvac::ttsggml::chatterbox {

/**
 * Configuration for the Chatterbox engine wrapping qvac-tts::qvac-tts.
 *
 * Mapped 1:1 into `qvac_tts::chatterbox::EngineOptions` by
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
  /** Directory of baked voice-conditioning tensors (`qvac-tts --ref-dir`). */
  std::string voiceDir;
  /** RNG seed for CFM initial noise + SineGen excitation. */
  std::optional<int> seed;
  /** std::thread::hardware_concurrency() override. */
  std::optional<int> threads;
  /** Layers to move to the GPU backend.  99 (or any large number) = all. */
  std::optional<int> nGpuLayers;
  /** Post-processing output sample rate.  Currently unused (engine always emits 24 kHz). */
  std::optional<int> outputSampleRate;
  /** Shortcut: if true and nGpuLayers unset, maps to nGpuLayers=99. */
  bool useGpu = false;
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
};

} // namespace qvac::ttsggml::chatterbox
