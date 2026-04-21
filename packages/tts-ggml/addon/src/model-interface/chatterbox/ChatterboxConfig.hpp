#pragma once

#include <optional>
#include <string>

namespace qvac::ttsggml::chatterbox {

/**
 * Configuration for the Chatterbox engine wrapping qvac-tts::qvac-tts.
 *
 * Mirrors the argv flags accepted by the `qvac-tts` CLI — the current
 * implementation of {@link ChatterboxModel::process} assembles these fields
 * into an argv array and calls `qvac_tts_cli_main` (see
 * addon/src/model-interface/chatterbox/ChatterboxModel.cpp).  When a proper
 * struct-based public API is added to qvac-tts.cpp we'll switch this struct
 * to carry the engine handle directly and drop the argv dance.
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
};

} // namespace qvac::ttsggml::chatterbox
