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
  std::optional<int> seed;
  std::optional<int> threads;
  std::optional<int> streamChunkFrames;
  std::optional<int> nGpuLayers;
  std::optional<bool> useGpu;
  std::string backendsDir;
};

} // namespace qvac::ttsggml::moss
