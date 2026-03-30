#pragma once

#include "ISupertonicEngine.hpp"
#include <memory>
#include <onnxruntime_cxx_api.h>
#include <string>
#include <vector>

namespace qvac::ttslib::supertonic {

/// Official Supertonic 4-graph ONNX stack (Supertone HF layout) + unicode_indexer.json + voice_styles/*.json.
class SupertonicEngine : public ISupertonicEngine {
public:
  explicit SupertonicEngine(const SupertonicConfig &cfg = {});
  ~SupertonicEngine() override;

  void load(const SupertonicConfig &cfg) override;
  void unload() override;
  bool isLoaded() const override;
  AudioResult synthesize(const std::string &text) override;

private:
  SupertonicConfig config_;
  bool loaded_ = false;

  int sampleRate_ = 44100;
  int baseChunkSize_ = 512;
  int chunkCompressFactor_ = 6;
  int latentDim_ = 24;

  std::vector<int32_t> unicodeIndexer_;
  std::vector<int64_t> styleTtlShape_;
  std::vector<float> styleTtl_;
  std::vector<int64_t> styleDpShape_;
  std::vector<float> styleDp_;

  std::unique_ptr<Ort::Session> dpSession_;
  std::unique_ptr<Ort::Session> textEncSession_;
  std::unique_ptr<Ort::Session> vectorEstSession_;
  std::unique_ptr<Ort::Session> vocoderSession_;

  std::vector<std::string> chunkText(const std::string &text, int maxCharLen) const;
  AudioResult synthesizeChunk(const std::string &text);
};

} // namespace qvac::ttslib::supertonic
