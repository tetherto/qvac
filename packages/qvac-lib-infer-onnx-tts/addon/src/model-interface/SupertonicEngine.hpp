#pragma once

#include <memory>
#include <vector>

#include "ISupertonicEngine.hpp"
#include "tokenizers_c.h"
#include <onnxruntime_cxx_api.h>

namespace qvac::ttslib::supertonic {

class SupertonicEngine : public ISupertonicEngine {
public:
  explicit SupertonicEngine(const SupertonicConfig &cfg);
  ~SupertonicEngine() override;
  void load(const SupertonicConfig &cfg) override;
  void unload() override;
  bool isLoaded() const override;
  AudioResult synthesize(const std::string &text) override;

private:
  void tokenize(const std::string &text, std::vector<int64_t> &inputIds,
                std::vector<int64_t> &attentionMask);
  void loadVoiceStyle(const std::string &voicePath);
  std::pair<std::vector<float>, int64_t>
  runLatentDenoiserLoop(const std::vector<float> &encoderOutputs,
                        const std::vector<int64_t> &attentionMask,
                        const std::vector<int64_t> &durations);
  std::vector<float> runVoiceDecoder(const std::vector<float> &latents,
                                     int64_t latentLength);

  SupertonicConfig config_;
  bool loaded_ = false;
  TokenizerHandle tokenizerHandle_ = nullptr;
  std::vector<float> styleData_;   // (1, num_frames, 128)
  int64_t styleNumFrames_ = 0;

  std::unique_ptr<Ort::Session> textEncoderSession_;
  std::unique_ptr<Ort::Session> latentDenoiserSession_;
  std::unique_ptr<Ort::Session> voiceDecoderSession_;
  std::vector<std::string> textEncoderOutputNames_;  // from model (e.g. last_hidden_state, durations)
};

} // namespace qvac::ttslib::supertonic
