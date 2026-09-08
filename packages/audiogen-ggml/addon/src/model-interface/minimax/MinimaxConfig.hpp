#pragma once

#include <string>

namespace qvac::audiogenggml::minimax {

struct MinimaxConfig {
  std::string modelDir;
  std::string lmModelPath;
  std::string synthModelPath;
  int threads = 0;
  bool useGpu = false;
  std::string backendsDir;
};

} // namespace qvac::audiogenggml::minimax
