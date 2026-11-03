#pragma once

#include <optional>
#include <string>
#include <vector>

namespace qvac::ttsggml::moss {

struct MossConfig {
  std::string backbonePath;
  std::string codecDecoderPath;
  std::string codecEncoderPath;
  std::string referenceAudio;
  std::vector<std::string> dialogueReferences;
  std::string language;
  std::optional<int> durationTokens;
  std::optional<int> nCtx;
  std::optional<int> maxNewTokens;
  std::optional<float> textTemperature;
  std::optional<float> textTopP;
  std::optional<int> textTopK;
  std::optional<float> audioTemperature;
  std::optional<float> audioTopP;
  std::optional<int> audioTopK;
  std::optional<float> audioRepetitionPenalty;
  std::optional<int> seed;
  std::optional<int> threads;
  std::optional<int> streamChunkFrames;
  std::optional<int> nGpuLayers;
  std::optional<bool> useGpu;
  std::string backend;
  std::string backendsDir;
};

} // namespace qvac::ttsggml::moss
