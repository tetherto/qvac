#pragma once

#include <string>

namespace qvac::audiogenggml::minimax {

struct MinimaxConfig {
  std::string modelDir;
  std::string lmModelPath;
  std::string synthModelPath;
  int threads = 0;
  bool useGpu = false;
  // Engine compute device: "cpu", "gpu" (fail creation when no GPU is usable)
  // or "auto". Empty derives it from useGpu ("auto" / "cpu").
  std::string device;
  std::string backendsDir;
};

} // namespace qvac::audiogenggml::minimax
