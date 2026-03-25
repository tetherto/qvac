#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "AudioResult.hpp"

namespace qvac::ttslib::supertonic {

struct SupertonicConfig {
  std::string modelDir;
  std::string textEncoderPath;
  std::string voiceName;
  std::string language;
  float speed = 1.0f;
  int numInferenceSteps = 5;
  std::string unicodeIndexerPath;
  std::string ttsConfigPath;
  std::string durationPredictorPath;
  std::string vectorEstimatorPath;
  std::string vocoderPath;
  std::string voiceStyleJsonPath;
  bool supertonicMultilingual = true;
};

class ISupertonicEngine {
public:
  ISupertonicEngine() = default;
  virtual ~ISupertonicEngine() = default;
  virtual void load(const SupertonicConfig &cfg) = 0;
  virtual void unload() = 0;
  virtual bool isLoaded() const = 0;
  virtual AudioResult synthesize(const std::string &text) = 0;
};

} // namespace qvac::ttslib::supertonic
