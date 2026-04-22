#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace qvac_lib_inference_addon_bci {

// Preprocesses raw multi-channel neural signals for whisper.cpp.
//
// Pipeline: neural(512ch) → smooth → day_proj → pad to 3000 frames
// Output is 512-dim x 3000 frames, fed to whisper_set_mel().
// whisper.cpp (patched) handles: conv1(512→384,k=7) → GELU → conv2 → GELU
//   → positional_embedding → 6-layer transformer → LoRA-merged decoder → text
class NeuralProcessor {
public:
  static constexpr int K_WHISPER_N_MEL = 512;       // n_mels in GGML model
  static constexpr int K_WHISPER_MEL_FRAMES = 3000;

  struct EmbedderWeights {
    bool loaded = false;
    uint32_t numFeatures = 512;
    uint32_t numDays = 0;
    uint32_t numMonths = 0;
    uint32_t r = 0;

    std::vector<int32_t> sessionToDayMap;
    std::vector<std::vector<float>> dayAs;
    std::vector<std::vector<float>> dayBs;
    std::vector<std::vector<float>> dayBiases;
    std::vector<std::vector<float>> monthWeights;
    std::vector<std::vector<float>> monthBiases;
  };

  NeuralProcessor();

  bool loadEmbedderWeights(const std::string& path);

  std::vector<float> processToMel(
      const std::vector<uint8_t>& rawData,
      int dayIdx = 0) const;

  static std::vector<float> gaussianSmooth(
      const std::vector<float>& data,
      uint32_t numTimesteps, uint32_t numChannels,
      float kernelStd = 2.0F, int kernelSize = 100);

  std::vector<float> applyDayProjection(
      const std::vector<float>& features,
      uint32_t numTimesteps, uint32_t numChannels,
      int dayIdx) const;

  bool hasWeights() const { return weights_.loaded; }
  uint32_t getNumDays() const { return weights_.numDays; }
  int getMelBins() const { return K_WHISPER_N_MEL; }
  int getMelFrames() const { return K_WHISPER_MEL_FRAMES; }

private:
  EmbedderWeights weights_;

  // Memoized dense projection (W, bias) per resolved day index. The
  // underlying low-rank dayA · dayB + month correction is O(nf*nf*r) to
  // materialize; caching makes same-day batch inference much cheaper.
  mutable int cachedDayIdx_ = -1;
  mutable std::vector<float> cachedProjectionW_;
  mutable std::vector<float> cachedProjectionBias_;
};

} // namespace qvac_lib_inference_addon_bci
