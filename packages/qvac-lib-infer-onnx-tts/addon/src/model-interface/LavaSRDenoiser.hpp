#pragma once

#include <memory>
#include <string>
#include <vector>

#include <onnxruntime_cxx_api.h>

#include "dsp/StftProcessor.hpp"

namespace qvac::ttslib::lavasr {

class LavaSRDenoiser {
public:
  explicit LavaSRDenoiser(const std::string &modelPath);
  ~LavaSRDenoiser();

  void load();
  void unload();
  bool isLoaded() const;

  // Input: float waveform at 16 kHz. Output: denoised waveform at 16 kHz.
  std::vector<float> denoise(const std::vector<float> &wav16k);

private:
  std::string modelPath_;
  std::unique_ptr<Ort::Session> session_;

  std::string inputName_;
  std::string outputName_;

  dsp::StftProcessor stft_;

  static constexpr int CHUNK_FRAMES = 63;
  static constexpr int CHUNK_HOP_FRAMES = 21;
  std::vector<float> chunkWeight_;

  void buildChunkWeights();
};

} // namespace qvac::ttslib::lavasr
