#pragma once

#include <optional>
#include <string>

namespace qvac::ttsggml::audio8 {

/**
 * Audio8 splits into three GGUFs because they have different lifetimes: the
 * language model and the codec's synthesis half are needed for every
 * synthesis, the codec's analysis half only to enrol a voice from a
 * recording. A text-only deployment can leave codecEncoderPath empty.
 */
struct Audio8Config {
  std::string lmModelPath;
  std::string codecDecoderPath;
  std::string codecEncoderPath;
  /**
   * Voice cloning: a reference recording and what is said in it. The
   * transcript is not optional in practice -- the model conditions on it as
   * the turn the reference answers, and a wrong one degrades the clone.
   * Cloning needs codecEncoderPath.
   */
  std::string referenceAudio;
  std::string referenceText;
  /** Take the argmax instead of sampling; ignores temperature/topK/topP. */
  std::optional<bool> greedy;
  std::optional<int> seed;
  std::optional<int> threads;
  /** Sampling knobs; unset defers to the engine's defaults. */
  std::optional<float> temperature;
  std::optional<int> topK;
  std::optional<float> topP;
  /** Generation length cap in codec frames (~21.5/s); 0 = engine default. */
  std::optional<int> maxFrames;
  /**
   * Desired output sample rate in Hz (8000-192000), or unset/0 to keep the
   * codec's native 44100. The engine resamples, so no addon-side pass.
   */
  std::optional<int> outputSampleRate;
  // GPU offload. The engine is CPU-only today and warns on a positive value;
  // the knobs are here so callers do not have to special-case this engine.
  // nGpuLayers wins; else useGpu true->99 / false->0.
  std::optional<int> nGpuLayers;
  std::optional<bool> useGpu;
  std::string backendsDir;
};

} // namespace qvac::ttsggml::audio8
