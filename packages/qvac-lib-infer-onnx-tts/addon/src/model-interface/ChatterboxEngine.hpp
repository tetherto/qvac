#pragma once

#include "IChatterboxEngine.hpp"
#include "OnnxInferSession.hpp"
#include "tokenizers_c.h"

namespace qvac::ttslib::chatterbox {

template <typename T> struct TensorData {
  std::vector<int64_t> shape;
  std::vector<T> data;
};

class ChatterboxEngine : public IChatterboxEngine {
public:
  explicit ChatterboxEngine(const ChatterboxConfig &cfg);
  ~ChatterboxEngine() override;
  void load(const ChatterboxConfig &cfg) override;
  void unload() override;
  bool isLoaded() const override;
  AudioResult synthesize(const std::string &text) override;

private:
  std::vector<int64_t> tokenize(const std::string &text);

  void runEmbedTokensInfer(const std::vector<int64_t> &inputIds, const std::vector<int64_t> &positionIds);
  void runSpeechEncoderInfer();
  void runLanguageModelInfer(
      const TensorData<float> &inputsEmbs,
      const TensorData<int64_t> &positionIds,
      const TensorData<int64_t> &attentionMask,
      std::unordered_map<std::string, TensorData<float>> &pastKeyValues);

  void runConditionalDecoderInfer(const std::vector<int64_t> &speechTokens,
                                  const TensorData<float> &speakerEmbeddings,
                                  const TensorData<float> &speakerFeatures);

  void ensureSession(std::unique_ptr<OnnxInferSession> &session, const std::string &modelPath);
  void releaseSession(std::unique_ptr<OnnxInferSession> &session);

  TokenizerHandle tokenizerHandle_;
  std::unique_ptr<OnnxInferSession> speechEncoderSession_;
  std::unique_ptr<OnnxInferSession> embedTokensSession_;
  std::unique_ptr<OnnxInferSession> conditionalDecoderSession_;
  std::unique_ptr<OnnxInferSession> languageModelSession_;

  ChatterboxConfig config_;
  bool loaded_ = false;
  bool lazySessionLoading_ = false;
  std::string language_;
  bool isEnglish_ = true;
  int keyValueOffset_ = 0;
};

} // namespace qvac::ttslib::chatterbox
