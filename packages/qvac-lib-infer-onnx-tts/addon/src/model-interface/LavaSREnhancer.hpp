#pragma once

#include <memory>
#include <string>
#include <vector>

#include <onnxruntime_cxx_api.h>

#include "dsp/FastLRMerge.hpp"
#include "dsp/MelFilterbank.hpp"
#include "dsp/StftProcessor.hpp"

namespace qvac::ttslib::lavasr {

// Vocos-based neural bandwidth extension.
// Two ONNX sessions: backbone (feature extractor) + spec head (ISTFT head).
// Input: 48 kHz waveform. Output: enhanced 48 kHz waveform.
class LavaSREnhancer {
public:
  LavaSREnhancer(const std::string &backbonePath,
                 const std::string &specHeadPath);
  ~LavaSREnhancer();

  void load();
  void unload();
  bool isLoaded() const;

  // Input: float waveform at 48 kHz. cutoffHz determines the spectral
  // crossover point for FastLR merge (typically engineSampleRate / 2).
  std::vector<float> enhance(const std::vector<float> &wav48k,
                             float cutoffHz = 4000.0f);

private:
  std::string backbonePath_;
  std::string specHeadPath_;

  std::unique_ptr<Ort::Session> backboneSession_;
  std::unique_ptr<Ort::Session> specHeadSession_;

  std::string bbInputName_;
  std::string bbOutputName_;
  std::string shInputName_;
  std::string shOutputName1_;
  std::string shOutputName2_;

  // Vocos config: sample_rate=44100 in the exported model config
  // despite processing 48 kHz audio (matches reference)
  static constexpr int CONFIG_SAMPLE_RATE = 44100;
  static constexpr int N_FFT = 2048;
  static constexpr int HOP_LENGTH = 512;
  static constexpr int N_MELS = 80;
  static constexpr float F_MIN = 0.0f;
  static constexpr float F_MAX = 8000.0f;

  dsp::MelFilterbank mel_;
  dsp::StftProcessor stft_;
};

} // namespace qvac::ttslib::lavasr
