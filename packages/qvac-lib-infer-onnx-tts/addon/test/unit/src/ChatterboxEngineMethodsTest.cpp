#include "mocks/OnnxInferSessionMock.hpp"
#include "src/model-interface/ChatterboxEngine.hpp"
#include "src/model-interface/Fp16Utils.hpp"
#include <cmath>
#include <gmock/gmock.h>
#include <gtest/gtest.h>
#include <memory>
#include <utility>

namespace qvac::ttslib::chatterbox::testing {

class TestableChatterboxEngine : public ChatterboxEngine {
public:
  TestableChatterboxEngine() : ChatterboxEngine() {}

  void setEnglish(bool value) { isEnglish_ = value; }

  void setKeyValueOffset(int offset) { keyValueOffset_ = offset; }

  void setLanguageModelSession(std::unique_ptr<IOnnxInferSession> session) {
    languageModelSession_ = std::move(session);
  }

  using ChatterboxEngine::advancePositionIds;
  using ChatterboxEngine::assembleSpeechTokenSequence;
  using ChatterboxEngine::buildInitialPositionIds;
  using ChatterboxEngine::cachePastKeyValues;
  using ChatterboxEngine::clearSpeechEncoderCache;
  using ChatterboxEngine::convertToAudioResult;
  using ChatterboxEngine::enableKvCacheChaining;
  using ChatterboxEngine::hasSpeechEncoderCache;
  using ChatterboxEngine::selectNextToken;
  using ChatterboxEngine::writeKvToTensors;

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

class KvCacheChainingTest : public ::testing::Test {
protected:
  // English layout: 3 non-KV inputs, then past_key_values.i pairs.
  // Outputs: logits, then present.i pairs.
  std::vector<std::string> englishInputNames_{
      "inputs_embeds",
      "attention_mask",
      "position_ids",
      "past_key_values.0.key",
      "past_key_values.0.value",
      "past_key_values.1.key",
      "past_key_values.1.value",
  };
  std::vector<std::string> englishOutputNames_{
      "logits",        "present.0.key",   "present.0.value",
      "present.1.key", "present.1.value",
  };

  // Multilingual layout: 2 non-KV inputs.
  std::vector<std::string> multilingualInputNames_{
      "inputs_embeds",
      "attention_mask",
      "past_key_values.0.key",
      "past_key_values.0.value",
  };
  std::vector<std::string> multilingualOutputNames_{
      "logits",
      "present.0.key",
      "present.0.value",
  };

  TestableChatterboxEngine engine_;
};

TEST_F(KvCacheChainingTest, enableBuildsPresentToPastMappingForEnglish) {
  auto mock = std::make_unique<::testing::NiceMock<OnnxInferSessionMock>>();
  EXPECT_CALL(*mock, getInputNames())
      .WillRepeatedly(::testing::Return(englishInputNames_));
  EXPECT_CALL(*mock, getOutputNames())
      .WillRepeatedly(::testing::Return(englishOutputNames_));

  std::vector<std::pair<std::string, std::string>> expectedMapping = {
      {"present.0.key", "past_key_values.0.key"},
      {"present.0.value", "past_key_values.0.value"},
      {"present.1.key", "past_key_values.1.key"},
      {"present.1.value", "past_key_values.1.value"},
  };
  EXPECT_CALL(*mock, setOutputToInputChain(::testing::Eq(expectedMapping)))
      .Times(1);

  engine_.setKeyValueOffset(3);
  engine_.setLanguageModelSession(std::move(mock));
  engine_.enableKvCacheChaining();
}

TEST_F(KvCacheChainingTest, enableBuildsPresentToPastMappingForMultilingual) {
  auto mock = std::make_unique<::testing::NiceMock<OnnxInferSessionMock>>();
  EXPECT_CALL(*mock, getInputNames())
      .WillRepeatedly(::testing::Return(multilingualInputNames_));
  EXPECT_CALL(*mock, getOutputNames())
      .WillRepeatedly(::testing::Return(multilingualOutputNames_));

  std::vector<std::pair<std::string, std::string>> expectedMapping = {
      {"present.0.key", "past_key_values.0.key"},
      {"present.0.value", "past_key_values.0.value"},
  };
  EXPECT_CALL(*mock, setOutputToInputChain(::testing::Eq(expectedMapping)))
      .Times(1);

  engine_.setKeyValueOffset(2);
  engine_.setLanguageModelSession(std::move(mock));
  engine_.enableKvCacheChaining();
}

TEST_F(KvCacheChainingTest, enableSkipsKvInputsWithoutMatchingPresentOutput) {
  // Pathological case: 4 `past_key_values.*` inputs but the model only
  // exposes `present.*` outputs for layer 0. Name-based matching must emit
  // pairs only for inputs whose corresponding `present.*` output exists and
  // silently drop the rest — never read past the end of the output list.
  std::vector<std::string> truncatedOutputs{
      "logits",
      "present.0.key",
      "present.0.value",
  };

  auto mock = std::make_unique<::testing::NiceMock<OnnxInferSessionMock>>();
  EXPECT_CALL(*mock, getInputNames())
      .WillRepeatedly(::testing::Return(englishInputNames_));
  EXPECT_CALL(*mock, getOutputNames())
      .WillRepeatedly(::testing::Return(truncatedOutputs));

  std::vector<std::pair<std::string, std::string>> expectedMapping = {
      {"present.0.key", "past_key_values.0.key"},
      {"present.0.value", "past_key_values.0.value"},
  };
  EXPECT_CALL(*mock, setOutputToInputChain(::testing::Eq(expectedMapping)))
      .Times(1);

  engine_.setKeyValueOffset(3);
  engine_.setLanguageModelSession(std::move(mock));
  engine_.enableKvCacheChaining();
}

TEST_F(KvCacheChainingTest, enablePairsByNameIndependentOfOutputOrder) {
  // The ONNX export is not required to list `present.*` outputs in the same
  // order as `past_key_values.*` inputs. Name-based pairing must survive a
  // scrambled output list: `past_key_values.X.Y` always pairs with
  // `present.X.Y`, regardless of where each sits in the metadata vectors.
  std::vector<std::string> scrambledOutputs{
      "logits",        "present.1.value", "present.0.key",
      "present.1.key", "present.0.value",
  };

  auto mock = std::make_unique<::testing::NiceMock<OnnxInferSessionMock>>();
  EXPECT_CALL(*mock, getInputNames())
      .WillRepeatedly(::testing::Return(englishInputNames_));
  EXPECT_CALL(*mock, getOutputNames())
      .WillRepeatedly(::testing::Return(scrambledOutputs));

  // The mapping is still keyed on input order (which is `past_key_values.0.*`
  // then `past_key_values.1.*`) but each entry's output name is resolved by
  // name substitution, NOT by position in `scrambledOutputs`.
  std::vector<std::pair<std::string, std::string>> expectedMapping = {
      {"present.0.key", "past_key_values.0.key"},
      {"present.0.value", "past_key_values.0.value"},
      {"present.1.key", "past_key_values.1.key"},
      {"present.1.value", "past_key_values.1.value"},
  };
  EXPECT_CALL(*mock, setOutputToInputChain(::testing::Eq(expectedMapping)))
      .Times(1);

  engine_.setKeyValueOffset(3);
  engine_.setLanguageModelSession(std::move(mock));
  engine_.enableKvCacheChaining();
}

TEST_F(KvCacheChainingTest, enableSkipsInputsThatAreNotPastKeyValues) {
  // Any extra KV-offset input that doesn't carry the `past_key_values.`
  // prefix (e.g. a future auxiliary tensor) must be skipped, not mis-wired
  // into `present.<whatever>`. Pair only real `past_key_values.*` entries.
  std::vector<std::string> inputsWithExtra{
      "inputs_embeds",         "attention_mask",          "position_ids",
      "past_key_values.0.key", "past_key_values.0.value",
      "auxiliary_state", // non-KV but sits in the KV-offset region
  };

  auto mock = std::make_unique<::testing::NiceMock<OnnxInferSessionMock>>();
  EXPECT_CALL(*mock, getInputNames())
      .WillRepeatedly(::testing::Return(inputsWithExtra));
  EXPECT_CALL(*mock, getOutputNames())
      .WillRepeatedly(::testing::Return(englishOutputNames_));

  std::vector<std::pair<std::string, std::string>> expectedMapping = {
      {"present.0.key", "past_key_values.0.key"},
      {"present.0.value", "past_key_values.0.value"},
  };
  EXPECT_CALL(*mock, setOutputToInputChain(::testing::Eq(expectedMapping)))
      .Times(1);

  engine_.setKeyValueOffset(3);
  engine_.setLanguageModelSession(std::move(mock));
  engine_.enableKvCacheChaining();
}

TEST_F(KvCacheChainingTest, writeKvToTensorsSkipsAllChainedInputs) {
  auto mock = std::make_unique<::testing::NiceMock<OnnxInferSessionMock>>();
  EXPECT_CALL(*mock, getInputNames())
      .WillRepeatedly(::testing::Return(englishInputNames_));
  EXPECT_CALL(*mock, isInputChained(::testing::_))
      .WillRepeatedly(::testing::Return(true));

  // When every KV input is chained, no input tensor is fetched and no
  // float data is written.
  EXPECT_CALL(*mock, getInput(::testing::_)).Times(0);

  std::unordered_map<std::string, TensorData<float>> pastKeyValues;
  pastKeyValues["past_key_values.0.key"].data = {1.0f};
  pastKeyValues["past_key_values.0.value"].data = {1.0f};
  pastKeyValues["past_key_values.1.key"].data = {1.0f};
  pastKeyValues["past_key_values.1.value"].data = {1.0f};

  engine_.setKeyValueOffset(3);
  engine_.setLanguageModelSession(std::move(mock));
  engine_.writeKvToTensors(pastKeyValues);
}

TEST_F(KvCacheChainingTest, cachePastKeyValuesSkipsAllChainedInputs) {
  auto mock = std::make_unique<::testing::NiceMock<OnnxInferSessionMock>>();
  EXPECT_CALL(*mock, getInputNames())
      .WillRepeatedly(::testing::Return(englishInputNames_));
  EXPECT_CALL(*mock, getOutputNames())
      .WillRepeatedly(::testing::Return(englishOutputNames_));
  EXPECT_CALL(*mock, isInputChained(::testing::_))
      .WillRepeatedly(::testing::Return(true));

  // When every KV input is chained, no output tensor is fetched (the chain
  // already moved it into the next-step input slot) and the pastKeyValues
  // map is left untouched.
  EXPECT_CALL(*mock, getOutput(::testing::_)).Times(0);

  std::unordered_map<std::string, TensorData<float>> pastKeyValues;

  engine_.setKeyValueOffset(3);
  engine_.setLanguageModelSession(std::move(mock));
  engine_.cachePastKeyValues(pastKeyValues);

  EXPECT_TRUE(pastKeyValues.empty());
}

TEST_F(KvCacheChainingTest, enableCalledTwiceResetsPreviousMapping) {
  // Two back-to-back enableKvCacheChaining() calls (e.g. across two
  // synthesize() calls on the same engine) must each produce a fresh mapping
  // and never pile up on top of the previous one.
  auto mock = std::make_unique<::testing::NiceMock<OnnxInferSessionMock>>();
  EXPECT_CALL(*mock, getInputNames())
      .WillRepeatedly(::testing::Return(englishInputNames_));
  EXPECT_CALL(*mock, getOutputNames())
      .WillRepeatedly(::testing::Return(englishOutputNames_));

  std::vector<std::pair<std::string, std::string>> expectedMapping = {
      {"present.0.key", "past_key_values.0.key"},
      {"present.0.value", "past_key_values.0.value"},
      {"present.1.key", "past_key_values.1.key"},
      {"present.1.value", "past_key_values.1.value"},
  };
  // Expect the same mapping twice and nothing more.
  EXPECT_CALL(*mock, setOutputToInputChain(::testing::Eq(expectedMapping)))
      .Times(2);

  engine_.setKeyValueOffset(3);
  engine_.setLanguageModelSession(std::move(mock));
  engine_.enableKvCacheChaining();
  engine_.enableKvCacheChaining();
}

} // namespace qvac::ttslib::chatterbox::testing
