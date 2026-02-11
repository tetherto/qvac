#pragma once

#include <memory>
#include <string>
#include <vector>

#include "AudioResult.hpp"

namespace qvac::ttslib {

struct TTSConfig {
  std::string modelPath;
  std::string configJsonPath;
  std::string language;
  std::string eSpeakDataPath;
  std::string tashkeelModelDir; // Path to Tashkeel model directory for Arabic
                                // diacritization //
  bool useGPU = false;
};

} // namespace qvac::ttslib

namespace qvac::ttslib::piper {

class IPiperEngine {
public:
  IPiperEngine() = default;
  virtual ~IPiperEngine() = default;
  virtual void load(const TTSConfig &cfg) = 0;
  virtual void unload() = 0;
  virtual AudioResult synthesize(const std::string &text) = 0;
};

} // namespace qvac::ttslib::piper
