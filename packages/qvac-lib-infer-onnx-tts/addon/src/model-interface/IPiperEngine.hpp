#pragma once

#include <memory>
#include <string>
#include <vector>

namespace qvac::ttslib {
  struct AudioResult {
    int sampleRate = 0;
    int channels = 1;
    std::vector<int16_t> pcm16;
    double durationMs = 0.0;
    uint64_t samples = 0;
  };
  
  struct TTSConfig {
    std::string modelPath;
    std::string configJsonPath;
    std::string language;
    std::string eSpeakDataPath;
    std::string tashkeelModelDir; // Path to Tashkeel model directory for Arabic
                                  // diacritization
    bool useGPU = false;
  };
}

namespace qvac::ttslib::piper {

class IPiperEngine {
public:
  IPiperEngine() = default;
  virtual ~IPiperEngine() = default;
  virtual void load(const TTSConfig& cfg) = 0;
  virtual void unload() = 0;
  virtual AudioResult synthesize(const std::string& text) = 0;
};

} // namespace qvac::ttslib::piper
