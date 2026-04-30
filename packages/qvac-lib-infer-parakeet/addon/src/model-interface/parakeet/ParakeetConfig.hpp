#pragma once

#include <string>

#include "model-interface/ParakeetTypes.hpp"

namespace qvac_lib_infer_parakeet {

struct ParakeetConfig {
  std::string modelPath;
  std::string encoderPath;
  std::string encoderDataPath;
  std::string decoderPath;
  std::string vocabPath;
  std::string preprocessorPath;
  std::string ctcModelPath;
  std::string ctcModelDataPath;
  std::string tokenizerPath;
  std::string eouEncoderPath;
  std::string eouDecoderPath;
  std::string sortformerPath;
  ModelType modelType = ModelType::TDT;
  int maxThreads = 4;
  bool useGPU = false;
  int sampleRate = 16000;
  int channels = 1;
  bool captionEnabled = false;
  bool timestampsEnabled = true;
  int seed = -1;

  ParakeetConfig() = default;

  explicit ParakeetConfig(const std::string& path) : modelPath(path) {}

  bool operator==(const ParakeetConfig& other) const {
    return modelPath == other.modelPath && encoderPath == other.encoderPath &&
           encoderDataPath == other.encoderDataPath &&
           decoderPath == other.decoderPath && vocabPath == other.vocabPath &&
           preprocessorPath == other.preprocessorPath &&
           ctcModelPath == other.ctcModelPath &&
           ctcModelDataPath == other.ctcModelDataPath &&
           tokenizerPath == other.tokenizerPath &&
           eouEncoderPath == other.eouEncoderPath &&
           eouDecoderPath == other.eouDecoderPath &&
           sortformerPath == other.sortformerPath &&
           modelType == other.modelType && maxThreads == other.maxThreads &&
           useGPU == other.useGPU && sampleRate == other.sampleRate &&
           channels == other.channels &&
           captionEnabled == other.captionEnabled &&
           timestampsEnabled == other.timestampsEnabled && seed == other.seed;
  }

  bool operator!=(const ParakeetConfig& other) const {
    return !(*this == other);
  }
};

} // namespace qvac_lib_infer_parakeet
