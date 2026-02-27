#pragma once

#include <string>

#include "model-interface/ParakeetTypes.hpp"

namespace qvac_lib_infer_parakeet {

/**
 * Configuration for Parakeet model
 */
struct ParakeetConfig {
  std::string modelPath;                // Path to model directory
  std::string encoderPath;              // Absolute path to encoder ONNX file
  std::string encoderDataPath;  // Absolute path to encoder external data file
  std::string decoderPath;      // Absolute path to decoder ONNX file
  std::string vocabPath;        // Absolute path to vocabulary file
  std::string preprocessorPath; // Absolute path to preprocessor ONNX file
  ModelType modelType = ModelType::TDT;
  int maxThreads = 4;                   // Maximum CPU threads to use
  bool useGPU = false;                  // Enable GPU acceleration
  int sampleRate = 16000;               // Audio sample rate
  int channels = 1;                     // Number of audio channels
  bool captionEnabled = false;          // Enable caption/subtitle mode
  bool timestampsEnabled = true;        // Include timestamps in output
  int seed = -1;                        // Random seed (-1 for random)

  ParakeetConfig() = default;

  explicit ParakeetConfig(const std::string& path) : modelPath(path) {}

  // Comparison for config change detection
  bool operator==(const ParakeetConfig& other) const {
    return modelPath == other.modelPath && encoderPath == other.encoderPath &&
           encoderDataPath == other.encoderDataPath &&
           decoderPath == other.decoderPath && vocabPath == other.vocabPath &&
           preprocessorPath == other.preprocessorPath &&
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

