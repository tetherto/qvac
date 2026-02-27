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

  void sanitizeTokenIds(std::vector<int64_t> &inputIds);
  TensorData<int64_t> buildInitialPositionIds(const std::vector<int64_t> &inputIds);

  TensorData<float> extractEmbeddings(const std::vector<int64_t> &inputIds,
                                       const std::vector<int64_t> &positionIds);

  void processSpeechEncoderOutputs(TensorData<float> &inputsEmbs,
                                    TensorData<int64_t> &promptToken,
                                    TensorData<float> &speakerEmbeddings,
                                    TensorData<float> &speakerFeatures,
                                    TensorData<int64_t> &positionIds,
                                    TensorData<int64_t> &attentionMask,
                                    std::unordered_map<std::string, TensorData<float>> &pastKeyValues);

  int64_t selectNextToken(const OrtTensor &logitsTensor,
                           std::vector<int64_t> &generatedTokens);

  void advancePositionIds(TensorData<int64_t> &positionIds, size_t iteration);
  void cachePastKeyValues(std::unordered_map<std::string, TensorData<float>> &pastKeyValues);

  std::vector<int64_t> generateSpeechTokens(std::vector<int64_t> &inputIds,
                                             TensorData<int64_t> &positionIds,
                                             TensorData<float> &speakerEmbeddings,
                                             TensorData<float> &speakerFeatures);

  std::vector<int64_t> assembleSpeechTokenSequence(const TensorData<int64_t> &promptToken,
                                                    const std::vector<int64_t> &generatedTokens);

  std::vector<float> synthesizeWaveform(const std::vector<int64_t> &speechTokens,
                                         const TensorData<float> &speakerEmbeddings,
                                         const TensorData<float> &speakerFeatures);

  AudioResult convertToAudioResult(const std::vector<float> &wav);

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
