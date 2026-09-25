#pragma once

#include <optional>
#include <string>

namespace qvac::ttsggml::moss {

struct MossConfig {
  std::string backbonePath;
  std::string codecDecoderPath;
  std::string codecEncoderPath;
  std::string referenceAudio;
  std::string language;
  std::optional<int> seed;
  std::optional<int> threads;
  std::optional<int> streamChunkFrames;
  std::optional<int> nGpuLayers;
  std::optional<bool> useGpu;
};

} // namespace qvac::ttsggml::moss
