#include "src/model-interface/ChatterboxEngine.hpp"
#include "src/model-interface/Fp16Utils.hpp"
#include <cmath>
#include <gtest/gtest.h>

namespace qvac::ttslib::chatterbox::testing {

class TestableChatterboxEngine : public ChatterboxEngine {
public:
  TestableChatterboxEngine() : ChatterboxEngine() {}

  void setEnglish(bool value) { isEnglish_ = value; }

  using ChatterboxEngine::advancePositionIds;
  using ChatterboxEngine::assembleSpeechTokenSequence;
  using ChatterboxEngine::buildInitialPositionIds;
  using ChatterboxEngine::clearSpeechEncoderCache;
  using ChatterboxEngine::convertToAudioResult;
  using ChatterboxEngine::hasSpeechEncoderCache;
  using ChatterboxEngine::selectNextToken;

  SpeechEncoderCache &getMutableCache() { return speechEncoderCache_; }
};

class BuildInitialPositionIdsTest : public ::testing::Test {
protected:
  TestableChatterboxEngine engine_;
};

class AssembleSpeechTokenSequenceTest : public ::testing::Test {
protected:
  TestableChatterboxEngine engine_;
};

class ConvertToAudioResultTest : public ::testing::Test {
protected:
  TestableChatterboxEngine engine_;
};

class AdvancePositionIdsTest : public ::testing::Test {
protected:
  TestableChatterboxEngine engine_;
};

class SelectNextTokenTest : public ::testing::Test {
protected:
  TestableChatterboxEngine engine_;
};

TEST_F(BuildInitialPositionIdsTest, buildsSpeechTokenPositions) {
  std::vector<int64_t> ids = {100, 200, 6561, 6562};
  auto result = engine_.buildInitialPositionIds(ids);

  EXPECT_EQ(result.data.size(), 4u);
  EXPECT_EQ(result.data[0], -1);
  EXPECT_EQ(result.data[1], 0);
  EXPECT_EQ(result.data[2], 0);
  EXPECT_EQ(result.data[3], 0);
  EXPECT_EQ(result.shape[0], 1);
  EXPECT_EQ(result.shape[1], 4);
}

TEST_F(BuildInitialPositionIdsTest, handlesAllNonSpeechTokens) {
  std::vector<int64_t> ids = {10, 20, 30};
  auto result = engine_.buildInitialPositionIds(ids);

  EXPECT_EQ(result.data[0], -1);
  EXPECT_EQ(result.data[1], 0);
  EXPECT_EQ(result.data[2], 1);
}

TEST_F(BuildInitialPositionIdsTest, handlesAllSpeechTokens) {
  std::vector<int64_t> ids = {6561, 6562, 7000};
  auto result = engine_.buildInitialPositionIds(ids);

  for (auto val : result.data) {
    EXPECT_EQ(val, 0);
  }
}

TEST_F(BuildInitialPositionIdsTest, handlesEmptyInput) {
  std::vector<int64_t> ids = {};
  auto result = engine_.buildInitialPositionIds(ids);
  EXPECT_TRUE(result.data.empty());
  EXPECT_EQ(result.shape[1], 0);
}

TEST_F(AssembleSpeechTokenSequenceTest,
       combinesPromptAndGeneratedTokensForEnglish) {
  engine_.setEnglish(true);

  TensorData<int64_t> prompt;
  prompt.data = {100, 200, 300};

  std::vector<int64_t> generated = {6561, 1000, 2000, 3000, 6562};

  auto result = engine_.assembleSpeechTokenSequence(prompt, generated);

  EXPECT_EQ(result[0], 100);
  EXPECT_EQ(result[1], 200);
  EXPECT_EQ(result[2], 300);
  EXPECT_EQ(result[3], 1000);
  EXPECT_EQ(result[4], 2000);
  EXPECT_EQ(result[5], 3000);

  EXPECT_EQ(result[6], 4299);
  EXPECT_EQ(result[7], 4299);
  EXPECT_EQ(result[8], 4299);
  EXPECT_EQ(result.size(), 9u);
}

TEST_F(AssembleSpeechTokenSequenceTest, combinesWithoutSilenceForMultilingual) {
  engine_.setEnglish(false);

  TensorData<int64_t> prompt;
  prompt.data = {100};

  std::vector<int64_t> generated = {6561, 500, 6562};

  auto result = engine_.assembleSpeechTokenSequence(prompt, generated);

  EXPECT_EQ(result.size(), 2u);
  EXPECT_EQ(result[0], 100);
  EXPECT_EQ(result[1], 500);
}

TEST_F(ConvertToAudioResultTest, producesCorrectPcm16) {
  std::vector<float> wav = {0.0f, 0.5f, -0.5f, 1.0f, -1.0f};

  auto result = engine_.convertToAudioResult(wav);

  EXPECT_EQ(result.sampleRate, 24000);
  EXPECT_EQ(result.channels, 1);
  EXPECT_EQ(result.samples, 5u);
  EXPECT_EQ(result.pcm16.size(), 5u);

  EXPECT_EQ(result.pcm16[0], 0);
  EXPECT_EQ(result.pcm16[1], 16383);
  EXPECT_EQ(result.pcm16[2], -16383);
  EXPECT_EQ(result.pcm16[3], 32767);
  EXPECT_EQ(result.pcm16[4], -32767);
}

TEST_F(ConvertToAudioResultTest, clampsBeyondRange) {
  std::vector<float> wav = {2.0f, -2.0f};

  auto result = engine_.convertToAudioResult(wav);

  EXPECT_EQ(result.pcm16[0], 32767);
  EXPECT_EQ(result.pcm16[1], -32767);
}

TEST_F(ConvertToAudioResultTest, handlesEmptyWaveform) {
  std::vector<float> wav = {};

  auto result = engine_.convertToAudioResult(wav);

  EXPECT_EQ(result.samples, 0u);
  EXPECT_TRUE(result.pcm16.empty());
  EXPECT_EQ(result.sampleRate, 24000);
}

TEST_F(ConvertToAudioResultTest, calculatesDurationCorrectly) {
  std::vector<float> wav(24000, 0.0f);

  auto result = engine_.convertToAudioResult(wav);

  EXPECT_EQ(result.durationMs, 1000u);
}

TEST_F(AdvancePositionIdsTest, advancesForEnglish) {
  engine_.setEnglish(true);

  TensorData<int64_t> positionIds;
  positionIds.data = {5};
  positionIds.shape = {1, 1};

  engine_.advancePositionIds(positionIds, 10);

  EXPECT_EQ(positionIds.data.size(), 1u);
  EXPECT_EQ(positionIds.data[0], 6);
  EXPECT_EQ(positionIds.shape[1], 1);
}

TEST_F(AdvancePositionIdsTest, advancesForMultilingual) {
  engine_.setEnglish(false);

  TensorData<int64_t> positionIds;
  positionIds.data = {99};
  positionIds.shape = {1, 1};

  engine_.advancePositionIds(positionIds, 7);

  EXPECT_EQ(positionIds.data.size(), 1u);
  EXPECT_EQ(positionIds.data[0], 8);
  EXPECT_EQ(positionIds.shape[0], 1);
  EXPECT_EQ(positionIds.shape[1], 1);
}

TEST_F(SelectNextTokenTest, selectsHighestLogit) {
  std::vector<float> logitsData = {0.1f, 0.5f, 0.9f, 0.2f};
  OrtTensor tensor{
      logitsData.data(), "logits", {1, 1, 4}, OrtElementType::Fp32};

  std::vector<int64_t> generatedTokens = {6561};

  int64_t token = engine_.selectNextToken(tensor, generatedTokens);

  EXPECT_EQ(token, 2);
}

TEST_F(SelectNextTokenTest, selectsHighestLogitFromFp16Tensor) {
  std::vector<uint16_t> fp16Data = {fp16::fromFp32(0.1f), fp16::fromFp32(0.5f),
                                    fp16::fromFp32(0.9f), fp16::fromFp32(0.2f)};
  OrtTensor tensor{fp16Data.data(), "logits", {1, 1, 4}, OrtElementType::Fp16};

  std::vector<int64_t> generatedTokens = {6561};

  int64_t token = engine_.selectNextToken(tensor, generatedTokens);

  EXPECT_EQ(token, 2);
}

TEST_F(SelectNextTokenTest, appliesRepetitionPenalty) {
  std::vector<float> logitsData = {0.9f, 0.1f, 0.8f, 0.2f};
  OrtTensor tensor{
      logitsData.data(), "logits", {1, 1, 4}, OrtElementType::Fp32};

  std::vector<int64_t> generatedTokens = {0};

  int64_t token = engine_.selectNextToken(tensor, generatedTokens);

  EXPECT_EQ(token, 2);
}

class SpeechEncoderCacheTest : public ::testing::Test {
protected:
  TestableChatterboxEngine engine_;
};

TEST_F(SpeechEncoderCacheTest, cacheIsInitiallyInvalid) {
  EXPECT_FALSE(engine_.hasSpeechEncoderCache());
}

TEST_F(SpeechEncoderCacheTest, cacheBecomesValidWhenPopulated) {
  auto &cache = engine_.getMutableCache();
  cache.audioFeatures.data = {1.0f, 2.0f};
  cache.audioFeatures.shape = {1, 2, 1};
  cache.promptToken.data = {100, 200};
  cache.promptToken.shape = {1, 2};
  cache.speakerEmbeddings.data = {0.5f};
  cache.speakerEmbeddings.shape = {1, 1};
  cache.speakerFeatures.data = {0.3f};
  cache.speakerFeatures.shape = {1, 1};
  cache.valid = true;

  EXPECT_TRUE(engine_.hasSpeechEncoderCache());
}

TEST_F(SpeechEncoderCacheTest, clearCacheResetsValidity) {
  auto &cache = engine_.getMutableCache();
  cache.valid = true;
  cache.audioFeatures.data = {1.0f};

  engine_.clearSpeechEncoderCache();

  EXPECT_FALSE(engine_.hasSpeechEncoderCache());
  EXPECT_TRUE(engine_.getMutableCache().audioFeatures.data.empty());
}

TEST_F(SpeechEncoderCacheTest, defaultCacheStructHasEmptyData) {
  SpeechEncoderCache cache;
  EXPECT_FALSE(cache.valid);
  EXPECT_TRUE(cache.audioFeatures.data.empty());
  EXPECT_TRUE(cache.promptToken.data.empty());
  EXPECT_TRUE(cache.speakerEmbeddings.data.empty());
  EXPECT_TRUE(cache.speakerFeatures.data.empty());
}

class TensorOpsConcatBatchTest : public ::testing::Test {};

TEST_F(TensorOpsConcatBatchTest, concatenatesFloatTensorsAlongBatchDim) {
  TensorData<float> a;
  a.shape = {1, 2, 3};
  a.data = {1, 2, 3, 4, 5, 6};

  TensorData<float> b;
  b.shape = {1, 2, 3};
  b.data = {7, 8, 9, 10, 11, 12};

  auto result = tensor_ops::concatBatch(a, b);

  EXPECT_EQ(result.shape, (std::vector<int64_t>{2, 2, 3}));
  EXPECT_EQ(result.data,
            (std::vector<float>{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}));
}

TEST_F(TensorOpsConcatBatchTest, concatenatesInt64TensorsAlongBatchDim) {
  TensorData<int64_t> a;
  a.shape = {1, 3};
  a.data = {10, 20, 30};

  TensorData<int64_t> b;
  b.shape = {1, 3};
  b.data = {40, 50, 60};

  auto result = tensor_ops::concatBatch(a, b);

  EXPECT_EQ(result.shape, (std::vector<int64_t>{2, 3}));
  EXPECT_EQ(result.data, (std::vector<int64_t>{10, 20, 30, 40, 50, 60}));
}

TEST_F(TensorOpsConcatBatchTest, handlesEmptySequenceDimension) {
  TensorData<float> a;
  a.shape = {1, 16, 0, 64};
  TensorData<float> b;
  b.shape = {1, 16, 0, 64};

  auto result = tensor_ops::concatBatch(a, b);

  EXPECT_EQ(result.shape, (std::vector<int64_t>{2, 16, 0, 64}));
  EXPECT_TRUE(result.data.empty());
}

TEST_F(TensorOpsConcatBatchTest, preservesMultiBatchInput) {
  TensorData<float> a;
  a.shape = {2, 1};
  a.data = {1, 2};

  TensorData<float> b;
  b.shape = {3, 1};
  b.data = {3, 4, 5};

  auto result = tensor_ops::concatBatch(a, b);

  EXPECT_EQ(result.shape, (std::vector<int64_t>{5, 1}));
  EXPECT_EQ(result.data, (std::vector<float>{1, 2, 3, 4, 5}));
}

class TensorOpsDuplicateBatchTest : public ::testing::Test {};

TEST_F(TensorOpsDuplicateBatchTest, doublesBatchDimForFloat) {
  TensorData<float> a;
  a.shape = {1, 2, 2};
  a.data = {1.5f, 2.5f, 3.5f, 4.5f};

  auto result = tensor_ops::duplicateBatch(a);

  EXPECT_EQ(result.shape, (std::vector<int64_t>{2, 2, 2}));
  EXPECT_EQ(result.data, (std::vector<float>{1.5f, 2.5f, 3.5f, 4.5f, 1.5f, 2.5f,
                                             3.5f, 4.5f}));
}

TEST_F(TensorOpsDuplicateBatchTest, doublesBatchDimForInt64) {
  TensorData<int64_t> a;
  a.shape = {1, 4};
  a.data = {1, 1, 1, 1};

  auto result = tensor_ops::duplicateBatch(a);

  EXPECT_EQ(result.shape, (std::vector<int64_t>{2, 4}));
  EXPECT_EQ(result.data, (std::vector<int64_t>{1, 1, 1, 1, 1, 1, 1, 1}));
}

TEST_F(TensorOpsDuplicateBatchTest, preservesEmptyPastSequence) {
  TensorData<float> a;
  a.shape = {1, 16, 0, 64};

  auto result = tensor_ops::duplicateBatch(a);

  EXPECT_EQ(result.shape, (std::vector<int64_t>{2, 16, 0, 64}));
  EXPECT_TRUE(result.data.empty());
}

} // namespace qvac::ttslib::chatterbox::testing
