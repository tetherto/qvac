#pragma once

#include <string>

#include "model-interface/ParakeetTypes.hpp"

namespace qvac_lib_infer_parakeet {

/**
 * Configuration for Parakeet model
 */
struct ParakeetConfig {
  std::string modelPath;                // Path to model directory
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
    return modelPath == other.modelPath && modelType == other.modelType &&
           maxThreads == other.maxThreads && useGPU == other.useGPU &&
           sampleRate == other.sampleRate && channels == other.channels &&
           captionEnabled == other.captionEnabled &&
           timestampsEnabled == other.timestampsEnabled && seed == other.seed;
  }

  bool operator!=(const ParakeetConfig& other) const {
    return !(*this == other);
  }
};

} // namespace qvac_lib_infer_parakeet

