#pragma once

#include "ChatterboxTextPreprocessor.hpp"
#include "IChatterboxEngine.hpp"
#include "IOnnxInferSession.hpp"
#include "OrtTypes.hpp"
#include "tokenizers_c.h"

#include <functional>
#include <memory>

namespace qvac::ttslib::chatterbox {

template <typename T> struct TensorData {
  std::vector<int64_t> shape;
  std::vector<T> data;
};

class ChatterboxEngine : public IChatterboxEngine {
protected:
  // Only for testing
  ChatterboxEngine() = default;

public:
  using SessionFactory =
      std::function<std::unique_ptr<IOnnxInferSession>(const std::string &)>;

  explicit ChatterboxEngine(const ChatterboxConfig &cfg,
                            SessionFactory factory = nullptr);
  ~ChatterboxEngine() override;
  void load(const ChatterboxConfig &cfg) override;
  void unload() override;
  bool isLoaded() const override;
  AudioResult synthesize(const std::string &text) override;

protected:
  TensorData<int64_t>
  buildInitialPositionIds(const std::vector<int64_t> &inputIds);

  int64_t selectNextToken(const OrtTensor &logitsTensor,
                          std::vector<int64_t> &generatedTokens);

  void advancePositionIds(TensorData<int64_t> &positionIds, size_t iteration);

  std::vector<int64_t>
  assembleSpeechTokenSequence(const TensorData<int64_t> &promptToken,
                              const std::vector<int64_t> &generatedTokens);

  AudioResult convertToAudioResult(const std::vector<float> &wav);

  bool isEnglish_ = true;

private:
  std::vector<int64_t> tokenize(const std::string &text);

  TensorData<float> extractEmbeddings(const std::vector<int64_t> &inputIds,
                                      const std::vector<int64_t> &positionIds);

  void processSpeechEncoderOutputs(
      TensorData<float> &inputsEmbs, TensorData<int64_t> &promptToken,
      TensorData<float> &speakerEmbeddings, TensorData<float> &speakerFeatures,
      TensorData<int64_t> &positionIds, TensorData<int64_t> &attentionMask,
      std::unordered_map<std::string, TensorData<float>> &pastKeyValues);

  void cachePastKeyValues(
      std::unordered_map<std::string, TensorData<float>> &pastKeyValues);

  std::vector<int64_t> generateSpeechTokens(
      std::vector<int64_t> &inputIds, TensorData<int64_t> &positionIds,
      TensorData<float> &speakerEmbeddings, TensorData<float> &speakerFeatures);

  std::vector<float>
  synthesizeWaveform(const std::vector<int64_t> &speechTokens,
                     const TensorData<float> &speakerEmbeddings,
                     const TensorData<float> &speakerFeatures);

  void runEmbedTokensInfer(const std::vector<int64_t> &inputIds,
                           const std::vector<int64_t> &positionIds);
  void runSpeechEncoderInfer();
  void runLanguageModelInfer(
      const TensorData<float> &inputsEmbs,
      const TensorData<int64_t> &positionIds,
      const TensorData<int64_t> &attentionMask,
      std::unordered_map<std::string, TensorData<float>> &pastKeyValues);

  void runConditionalDecoderInfer(const std::vector<int64_t> &speechTokens,
                                  const TensorData<float> &speakerEmbeddings,
                                  const TensorData<float> &speakerFeatures);

  void ensureSession(std::unique_ptr<IOnnxInferSession> &session,
                     const std::string &modelPath);
  void releaseSession(std::unique_ptr<IOnnxInferSession> &session);
  void loadCangjieTableIfNeeded(const std::string &tokenizerPath);

  TokenizerHandle tokenizerHandle_;
  SessionFactory sessionFactory_;
  std::unique_ptr<IOnnxInferSession> speechEncoderSession_;
  std::unique_ptr<IOnnxInferSession> embedTokensSession_;
  std::unique_ptr<IOnnxInferSession> conditionalDecoderSession_;
  std::unique_ptr<IOnnxInferSession> languageModelSession_;

  ChatterboxConfig config_;
  bool loaded_ = false;
  bool lazySessionLoading_ = false;
  std::string language_;
  int keyValueOffset_ = 0;
  text_preprocess::CangjieTable cangjieTable_;
};

} // namespace qvac::ttslib::chatterbox
