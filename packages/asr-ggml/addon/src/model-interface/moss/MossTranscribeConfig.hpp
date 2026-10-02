#pragma once

#include <string>
#include <vector>

namespace qvac::asrggml::moss {

struct MossTranscribeConfig {
  std::string modelPath;
  int maxThreads = 0;
  bool useGPU = false;
  std::string backendsDir;
};

struct MossTranscribeRequest {
  std::string prompt;
  std::vector<std::string> hotwords;
  int maxNewTokens = 0;
};

} // namespace qvac::asrggml::moss
