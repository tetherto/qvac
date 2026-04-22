#pragma once

#include "ChatterboxTextPreprocessor.hpp"
#include "IChatterboxEngine.hpp"
#include "IOnnxInferSession.hpp"
#include "OrtTypes.hpp"
#include "tokenizers_c.h"

#include <functional>
#include <memory>
#include <random>

namespace qvac::ttslib::chatterbox {

template <typename T> struct TensorData {
  std::vector<int64_t> shape;
  std::vector<T> data;
};

namespace tensor_ops {

// Concatenate two tensors along the batch dimension (axis 0).
// Requires a.shape[i] == b.shape[i] for i > 0.
// Result shape: [a.shape[0] + b.shape[0], ...rest].
template <typename T>
TensorData<T> concatBatch(const TensorData<T> &a, const TensorData<T> &b) {
  TensorData<T> out;
  out.shape = a.shape;
  out.shape[0] = a.shape[0] + b.shape[0];
  out.data.reserve(a.data.size() + b.data.size());
  out.data.insert(out.data.end(), a.data.begin(), a.data.end());
  out.data.insert(out.data.end(), b.data.begin(), b.data.end());
  return out;
}

// Duplicate a tensor along the batch dimension (axis 0).
// Input [N, ...] produces output [2N, ...] by concatenating the input with
// itself.
template <typename T> TensorData<T> duplicateBatch(const TensorData<T> &a) {
  TensorData<T> out;
  out.shape = a.shape;
  out.shape[0] = a.shape[0] * 2;
  out.data.reserve(a.data.size() * 2);
  out.data.insert(out.data.end(), a.data.begin(), a.data.end());
  out.data.insert(out.data.end(), a.data.begin(), a.data.end());
  return out;
}

} // namespace tensor_ops

struct SpeechEncoderCache {
  TensorData<float> audioFeatures;
  TensorData<int64_t> promptToken;
  TensorData<float> speakerEmbeddings;
  TensorData<float> speakerFeatures;
  bool valid = false;
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
  void runSpeechEncoderAndCache();

protected:
  bool hasSpeechEncoderCache() const;
  void clearSpeechEncoderCache();

private:
  void loadCangjieTableIfNeeded(const std::string &tokenizerPath);
  void loadTextEmbWeight(const std::string &embedTokensPath);

  TensorData<float>
  createUnconditionalEmbeddings(const TensorData<float> &condEmbs,
                                const std::vector<int64_t> &inputIds);

  void prepareCfgEmbeddings(const std::vector<int64_t> &inputIds,
                            const std::vector<int64_t> &positionIds,
                            TensorData<float> &condEmbs,
                            TensorData<float> &uncondEmbs,
                            TensorData<int64_t> &promptToken,
                            TensorData<float> &speakerEmbeddings,
                            TensorData<float> &speakerFeatures);

  int64_t runInitialCfgStep(
      const TensorData<float> &condEmbs, const TensorData<float> &uncondEmbs,
      TensorData<int64_t> &positionIds, TensorData<int64_t> &attentionMask,
      std::unordered_map<std::string, TensorData<float>> &batchedKv,
      std::vector<int64_t> &generatedTokens);

  std::unordered_map<std::string, TensorData<float>>
  initEmptyKvCache(int64_t batchSize = 1);

  void collectKvShapes(
      std::vector<std::vector<int64_t>> &inputShapes,
      const std::unordered_map<std::string, TensorData<float>> &pastKeyValues);

  void writeKvToTensors(
      const std::unordered_map<std::string, TensorData<float>> &pastKeyValues);

  void runGenerationLoop(
      std::vector<int64_t> &inputIds, TensorData<int64_t> &positionIds,
      TensorData<int64_t> &attentionMask,
      std::unordered_map<std::string, TensorData<float>> &pastKeyValues,
      TensorData<int64_t> &promptToken, TensorData<float> &speakerEmbeddings,
      TensorData<float> &speakerFeatures,
      std::vector<int64_t> &generatedTokens);

  bool shouldStopGeneration(const std::vector<int64_t> &tokens, int step);

  void runCfgGenerationLoop(
      std::vector<int64_t> &generatedTokens, TensorData<int64_t> &positionIds,
      TensorData<int64_t> &attentionMask,
      std::unordered_map<std::string, TensorData<float>> &batchedKv,
      int maxSpeechTokens);

  std::vector<int64_t> generateSpeechTokensWithCfg(
      std::vector<int64_t> &inputIds, TensorData<int64_t> &positionIds,
      TensorData<float> &speakerEmbeddings, TensorData<float> &speakerFeatures);

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

  std::vector<float> textEmbWeight_;
  int64_t textEmbRows_ = 0;
  int64_t textEmbDim_ = 0;
  std::mt19937 rng_{std::random_device{}()};

protected:
  SpeechEncoderCache speechEncoderCache_;
};

} // namespace qvac::ttslib::chatterbox
