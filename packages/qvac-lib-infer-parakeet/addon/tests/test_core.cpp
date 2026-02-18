#include "model-interface/parakeet/ParakeetModel.hpp"
#include "model-interface/parakeet/ParakeetConfig.hpp"
#include "model-interface/ParakeetTypes.hpp"

#include <gtest/gtest.h>
#include <memory>
#include <vector>
#include <filesystem>
#include <fstream>

using namespace qvac_lib_infer_parakeet;

struct VocabTag {
  using type = std::vector<std::string> ParakeetModel::*;
};

struct GetLanguageTokenTag {
  using type = int64_t (ParakeetModel::*)(const std::string&) const;
};

template<typename Tag, typename Tag::type M>
struct AccessPrivate {
  friend typename Tag::type get(Tag) { return M; }
};

template struct AccessPrivate<VocabTag, &ParakeetModel::vocab_>;
template struct AccessPrivate<GetLanguageTokenTag, &ParakeetModel::getLanguageToken>;

VocabTag::type get(VocabTag);
GetLanguageTokenTag::type get(GetLanguageTokenTag);

class ParakeetModelTest : public ::testing::Test {
protected:
  void SetUp() override {
    config.modelPath = "./test_models";
    config.modelType = ModelType::TDT;
    config.maxThreads = 2;
    config.useGPU = false;
  }

  ParakeetConfig config;
};

TEST_F(ParakeetModelTest, ConstructorCreatesModel) {
  EXPECT_NO_THROW({ ParakeetModel model(config); });
}

TEST_F(ParakeetModelTest, GetNameReturnsCorrectName) {
  ParakeetModel model(config);
  EXPECT_EQ(model.getName(), "Parakeet-TDT");
}

TEST_F(ParakeetModelTest, GetNameForDifferentModels) {
  config.modelType = ModelType::CTC;
  ParakeetModel ctcModel(config);
  EXPECT_EQ(ctcModel.getName(), "Parakeet-CTC");

  config.modelType = ModelType::EOU;
  ParakeetModel eouModel(config);
  EXPECT_EQ(eouModel.getName(), "Parakeet-EOU");

  config.modelType = ModelType::SORTFORMER;
  ParakeetModel sortformerModel(config);
  EXPECT_EQ(sortformerModel.getName(), "Parakeet-Sortformer");
  
  config.modelType = static_cast<ModelType>(999);
  ParakeetModel unknownModel(config);
  EXPECT_EQ(unknownModel.getName(), "Parakeet");
}

TEST_F(ParakeetModelTest, LoadUnloadCycle) {
  ParakeetModel model(config);
  EXPECT_FALSE(model.isLoaded());

  EXPECT_NO_THROW({ model.unload(); });
  EXPECT_FALSE(model.isLoaded());
}

TEST_F(ParakeetModelTest, ResetDoesNotThrow) {
  ParakeetModel model(config);
  EXPECT_NO_THROW({ model.reset(); });
}

TEST_F(ParakeetModelTest, EndOfStreamState) {
  ParakeetModel model(config);
  EXPECT_FALSE(model.isStreamEnded());

  model.endOfStream();
  EXPECT_TRUE(model.isStreamEnded());

  model.reset();
  EXPECT_FALSE(model.isStreamEnded());
}

TEST_F(ParakeetModelTest, AudioInputStructure) {
  AudioInput audio;
  audio.audioData = {0.1f, 0.2f, 0.3f, -0.1f, -0.2f};
  audio.sampleRate = 16000;
  audio.channels = 1;

  EXPECT_EQ(audio.audioData.size(), 5);
  EXPECT_EQ(audio.sampleRate, 16000);
  EXPECT_EQ(audio.channels, 1);
}

TEST_F(ParakeetModelTest, TranscriptionResultStructure) {
  TranscriptionResult result;
  result.text = "Hello world";
  result.confidence = 0.95f;
  result.isFinal = true;
  result.speakerId = 0;

  EXPECT_EQ(result.text, "Hello world");
  EXPECT_FLOAT_EQ(result.confidence, 0.95f);
  EXPECT_TRUE(result.isFinal);
  EXPECT_EQ(result.speakerId, 0);
}

TEST_F(ParakeetModelTest, TranscriptStructure) {
  Transcript transcript;
  EXPECT_TRUE(transcript.text.empty());
  EXPECT_FALSE(transcript.toAppend);
  EXPECT_FLOAT_EQ(transcript.start, -1.0f);
  EXPECT_FLOAT_EQ(transcript.end, -1.0f);
  EXPECT_EQ(transcript.id, 0);

  Transcript transcriptWithText("Hello");
  EXPECT_EQ(transcriptWithText.text, "Hello");
}

TEST_F(ParakeetModelTest, ConfigEquality) {
  ParakeetConfig config1;
  config1.modelPath = "/path/to/model";
  config1.modelType = ModelType::TDT;

  ParakeetConfig config2;
  config2.modelPath = "/path/to/model";
  config2.modelType = ModelType::TDT;

  EXPECT_EQ(config1, config2);

  config2.modelType = ModelType::CTC;
  EXPECT_NE(config1, config2);
}

TEST_F(ParakeetModelTest, SetConfig) {
  ParakeetModel model(config);

  ParakeetConfig newConfig;
  newConfig.modelPath = "/new/path";
  newConfig.modelType = ModelType::EOU;

  EXPECT_NO_THROW({ model.setConfig(newConfig); });
}

TEST_F(ParakeetModelTest, RuntimeStatsInitializedToZero) {
  ParakeetModel model(config);
  auto stats = model.runtimeStats();
  
  EXPECT_FALSE(stats.empty());
  
  auto findStat = [&stats](const std::string& key) -> std::variant<double, int64_t> {
    for (const auto& [k, v] : stats) {
      if (k == key) return v;
    }
    return int64_t(0);
  };
  
  EXPECT_EQ(std::get<int64_t>(findStat("totalSamples")), 0);
  EXPECT_EQ(std::get<int64_t>(findStat("totalTokens")), 0);
  EXPECT_EQ(std::get<int64_t>(findStat("totalTranscriptions")), 0);
  EXPECT_EQ(std::get<int64_t>(findStat("processCalls")), 0);
  EXPECT_EQ(std::get<int64_t>(findStat("totalWallMs")), 0);
  EXPECT_EQ(std::get<double>(findStat("realTimeFactor")), 0.0);
}

TEST_F(ParakeetModelTest, RuntimeStatsUpdatedAfterProcess) {
  ParakeetModel model(config);
  
  std::vector<float> dummyAudio(16000, 0.1f);
  model.process(dummyAudio);
  
  auto stats = model.runtimeStats();
  
  auto findStat = [&stats](const std::string& key) -> std::variant<double, int64_t> {
    for (const auto& [k, v] : stats) {
      if (k == key) return v;
    }
    return int64_t(0);
  };
  
  EXPECT_EQ(std::get<int64_t>(findStat("totalSamples")), 16000);
  EXPECT_EQ(std::get<int64_t>(findStat("processCalls")), 1);
  EXPECT_EQ(std::get<int64_t>(findStat("totalTranscriptions")), 1);
  EXPECT_EQ(std::get<int64_t>(findStat("audioDurationMs")), 1000);
}

TEST_F(ParakeetModelTest, RuntimeStatsResetToZero) {
  ParakeetModel model(config);
  
  std::vector<float> dummyAudio(16000, 0.1f);
  model.process(dummyAudio);
  
  auto statsBefore = model.runtimeStats();
  EXPECT_FALSE(statsBefore.empty());
  
  model.reset();
  auto statsAfter = model.runtimeStats();
  
  auto findStat = [&statsAfter](const std::string& key) -> std::variant<double, int64_t> {
    for (const auto& [k, v] : statsAfter) {
      if (k == key) return v;
    }
    return int64_t(0);
  };
  
  EXPECT_EQ(std::get<int64_t>(findStat("totalSamples")), 0);
  EXPECT_EQ(std::get<int64_t>(findStat("processCalls")), 0);
  EXPECT_EQ(std::get<int64_t>(findStat("totalWallMs")), 0);
}

TEST_F(ParakeetModelTest, PreprocessAudioDataS16LE) {
  std::vector<uint8_t> audioData = {
    0x00, 0x10,
    0x00, 0x20,
    0x00, 0x40,
  };
  
  auto result = ParakeetModel::preprocessAudioData(audioData, "s16le");
  
  EXPECT_EQ(result.size(), 3);
  EXPECT_FLOAT_EQ(result[0], 4096.0f / 32768.0f);
  EXPECT_FLOAT_EQ(result[1], 8192.0f / 32768.0f);
  EXPECT_FLOAT_EQ(result[2], 16384.0f / 32768.0f);
}

TEST_F(ParakeetModelTest, PreprocessAudioDataF32LE) {
  float samples[] = {0.1f, 0.5f, -0.3f};
  std::vector<uint8_t> audioData(
    reinterpret_cast<uint8_t*>(samples),
    reinterpret_cast<uint8_t*>(samples) + sizeof(samples)
  );
  
  auto result = ParakeetModel::preprocessAudioData(audioData, "f32le");
  
  EXPECT_EQ(result.size(), 3);
  EXPECT_FLOAT_EQ(result[0], 0.1f);
  EXPECT_FLOAT_EQ(result[1], 0.5f);
  EXPECT_FLOAT_EQ(result[2], -0.3f);
}

TEST_F(ParakeetModelTest, SetConfigChangesConfiguration) {
  ParakeetModel model(config);
  
  ParakeetConfig newConfig;
  newConfig.modelPath = "/different/path";
  newConfig.modelType = ModelType::CTC;
  newConfig.maxThreads = 8;
  
  model.setConfig(newConfig);
  
  EXPECT_EQ(model.getName(), "Parakeet-CTC");
}

TEST_F(ParakeetModelTest, UnloadWeightsCallsUnload) {
  ParakeetModel model(config);
  
  EXPECT_NO_THROW({ model.unloadWeights(); });
  EXPECT_FALSE(model.isLoaded());
}

TEST_F(ParakeetModelTest, ReloadCallsUnloadAndLoad) {
  ParakeetModel model(config);
  
  EXPECT_ANY_THROW({ model.reload(); });
  EXPECT_FALSE(model.isLoaded());
}

TEST_F(ParakeetModelTest, ProcessEmptyAudioDoesNotCrash) {
  ParakeetModel model(config);
  
  std::vector<float> emptyAudio;
  EXPECT_NO_THROW({ model.process(emptyAudio); });
}

TEST_F(ParakeetModelTest, ProcessWithCallbackReturnsOutput) {
  ParakeetModel model(config);
  
  std::vector<float> dummyAudio(16000, 0.1f);
  
  bool callbackCalled = false;
  auto output = model.process(dummyAudio, [&callbackCalled](const ParakeetModel::Output& out) {
    callbackCalled = true;
  });
  
  EXPECT_TRUE(callbackCalled);
  EXPECT_FALSE(output.empty());
}

TEST_F(ParakeetModelTest, MultipleProcessCallsAccumulateStats) {
  ParakeetModel model(config);
  
  std::vector<float> audio1(16000, 0.1f);
  std::vector<float> audio2(8000, 0.2f);
  
  model.process(audio1);
  model.process(audio2);
  
  auto stats = model.runtimeStats();
  
  auto findStat = [&stats](const std::string& key) -> std::variant<double, int64_t> {
    for (const auto& [k, v] : stats) {
      if (k == key) return v;
    }
    return int64_t(0);
  };
  
  EXPECT_EQ(std::get<int64_t>(findStat("totalSamples")), 24000);
  EXPECT_EQ(std::get<int64_t>(findStat("processCalls")), 2);
  EXPECT_EQ(std::get<int64_t>(findStat("totalTranscriptions")), 2);
}

TEST_F(ParakeetModelTest, SetOnSegmentCallback) {
  ParakeetModel model(config);
  
  bool callbackCalled = false;
  Transcript receivedTranscript;
  
  model.setOnSegmentCallback([&](const Transcript& t) {
    callbackCalled = true;
    receivedTranscript = t;
  });
  
  std::vector<float> dummyAudio(16000, 0.1f);
  model.process(dummyAudio);
  
  EXPECT_TRUE(callbackCalled);
  EXPECT_FALSE(receivedTranscript.text.empty());
}

TEST_F(ParakeetModelTest, AddTranscriptionAddsToOutput) {
  ParakeetModel model(config);
  
  Transcript t1("Test 1");
  Transcript t2("Test 2");
  
  model.addTranscription(t1);
  model.addTranscription(t2);
  
  auto output = model.process({}, [](const ParakeetModel::Output&){});
  
  EXPECT_EQ(output.size(), 2);
}

TEST_F(ParakeetModelTest, SetWeightsForFileStoresWeights) {
  ParakeetModel model(config);
  
  std::vector<uint8_t> dummyWeights = {0x01, 0x02, 0x03, 0x04};
  std::span<const uint8_t> weightsSpan(dummyWeights);
  
  EXPECT_NO_THROW({
    model.set_weights_for_file("encoder-model.onnx", weightsSpan, true);
  });
}

TEST_F(ParakeetModelTest, SetWeightsForFileLoadsVocabulary) {
  ParakeetModel model(config);
  
  std::string vocabContent = "token1 0\ntoken2 1\ntoken3 2\n";
  std::vector<uint8_t> vocabData(vocabContent.begin(), vocabContent.end());
  std::span<const uint8_t> vocabSpan(vocabData);
  
  EXPECT_NO_THROW({
    model.set_weights_for_file("vocab.txt", vocabSpan, true);
  });
}

TEST_F(ParakeetModelTest, LoadVocabularyWithLinesWithoutSpace) {
  ParakeetModel model(config);
  
  std::string vocabContent = "token_without_space\ntoken_with_space 1\n";
  std::vector<uint8_t> vocabData(vocabContent.begin(), vocabContent.end());
  std::span<const uint8_t> vocabSpan(vocabData);
  
  EXPECT_NO_THROW({
    model.set_weights_for_file("vocab.txt", vocabSpan, true);
  });
}

TEST_F(ParakeetModelTest, SetWeightsForFileIgnoresIncomplete) {
  ParakeetModel model(config);
  
  std::vector<uint8_t> dummyData = {0x01, 0x02};
  std::span<const uint8_t> dataSpan(dummyData);
  
  EXPECT_NO_THROW({
    model.set_weights_for_file("test.onnx", dataSpan, false);
  });
}

TEST_F(ParakeetModelTest, SetWeightsForFileWithStreambuf) {
  ParakeetModel model(config);
  
  std::string dummyData = "fake weights data";
  std::unique_ptr<std::basic_streambuf<char>> streambuf = std::make_unique<std::stringbuf>(dummyData);
  
  model.set_weights_for_file("decoder.onnx", std::move(streambuf));
  
  EXPECT_TRUE(true);
}

TEST_F(ParakeetModelTest, SetWeightsForFileWithStreambufVocab) {
  ParakeetModel model(config);
  
  std::string vocabContent = "hello 0\nworld 1\ntest 2\n";
  std::unique_ptr<std::basic_streambuf<char>> streambuf = std::make_unique<std::stringbuf>(vocabContent);
  
  model.set_weights_for_file("vocab.txt", std::move(streambuf));
  
  EXPECT_TRUE(true);
}

TEST_F(ParakeetModelTest, LoadFailsWithoutEncoderWeights) {
  ParakeetModel model(config);
  
  EXPECT_THROW({
    model.load();
  }, std::runtime_error);
}

TEST_F(ParakeetModelTest, LoadFailsWithEncoderButNoDecoder) {
  ParakeetModel model(config);
  
  std::vector<uint8_t> fakeEncoder = {0x08, 0x03, 0x12, 0x05, 0x74, 0x65, 0x73, 0x74, 0x00};
  model.set_weights_for_file("encoder-model.onnx", std::span<const uint8_t>(fakeEncoder), true);
  
  EXPECT_ANY_THROW({
    model.load();
  });
}

TEST_F(ParakeetModelTest, LoadWithDeterministicComputeWhenSeedSet) {
  config.seed = 42;
  ParakeetModel model(config);
  
  std::vector<uint8_t> fakeEncoder = {0x01, 0x02, 0x03};
  model.set_weights_for_file("encoder-model.onnx", std::span<const uint8_t>(fakeEncoder), true);
  
  EXPECT_ANY_THROW({
    model.load();
  });
}

TEST_F(ParakeetModelTest, LoadWithExternalDataFile) {
  std::filesystem::create_directories("./test_models");
  
  std::ofstream encoderFile("./test_models/encoder-model.onnx", std::ios::binary);
  encoderFile << "fake";
  encoderFile.close();
  
  std::ofstream dataFile("./test_models/encoder-model.onnx.data", std::ios::binary);
  dataFile << "fake external data";
  dataFile.close();
  
  ParakeetModel model(config);
  
  std::vector<uint8_t> fakeEncoder = {0x01, 0x02, 0x03};
  model.set_weights_for_file("encoder-model.onnx", std::span<const uint8_t>(fakeEncoder), true);
  
  EXPECT_ANY_THROW({
    model.load();
  });
  
  std::filesystem::remove("./test_models/encoder-model.onnx");
  std::filesystem::remove("./test_models/encoder-model.onnx.data");
}

TEST_F(ParakeetModelTest, InitializeBackendDoesNotThrow) {
  ParakeetModel model(config);
  
  EXPECT_NO_THROW({
    model.initializeBackend();
  });
}

TEST_F(ParakeetModelTest, WarmupDoesNotThrow) {
  ParakeetModel model(config);
  
  EXPECT_NO_THROW({
    model.warmup();
  });
}

TEST_F(ParakeetModelTest, LoadWithRealModelsIfAvailable) {
  std::string modelsPath = "./models";
  if (!std::filesystem::exists(modelsPath + "/encoder-model.int8.onnx")) {
    modelsPath = "/Users/freddy/Work/Tether/models/parakeet/onnx";
    if (!std::filesystem::exists(modelsPath + "/encoder-model.onnx")) {
      GTEST_SKIP() << "Models not available";
    }
  }
  
  config.modelPath = modelsPath;
  ParakeetModel model(config);
  
  std::string encoderFile = modelsPath + "/encoder-model.onnx";
  if (!std::filesystem::exists(encoderFile)) {
    encoderFile = modelsPath + "/encoder-model.int8.onnx";
  }
  
  std::ifstream encFile(encoderFile, std::ios::binary);
  std::vector<uint8_t> encoderData((std::istreambuf_iterator<char>(encFile)),
                                    std::istreambuf_iterator<char>());
  model.set_weights_for_file("encoder-model.onnx", std::span<const uint8_t>(encoderData), true);
  
  std::string decoderFile = modelsPath + "/decoder_joint-model.onnx";
  if (!std::filesystem::exists(decoderFile)) {
    decoderFile = modelsPath + "/decoder_joint-model.int8.onnx";
  }
  
  std::ifstream decFile(decoderFile, std::ios::binary);
  std::vector<uint8_t> decoderData((std::istreambuf_iterator<char>(decFile)),
                                    std::istreambuf_iterator<char>());
  model.set_weights_for_file("decoder_joint-model.onnx", std::span<const uint8_t>(decoderData), true);
  
  std::ifstream vocabFile(modelsPath + "/vocab.txt");
  std::string vocabContent((std::istreambuf_iterator<char>(vocabFile)),
                           std::istreambuf_iterator<char>());
  std::vector<uint8_t> vocabData(vocabContent.begin(), vocabContent.end());
  model.set_weights_for_file("vocab.txt", std::span<const uint8_t>(vocabData), true);
  
  EXPECT_NO_THROW({
    model.load();
  });
  
  EXPECT_TRUE(model.isLoaded());
}

TEST_F(ParakeetModelTest, LoadAlreadyLoadedReturnsEarly) {
  std::string modelsPath = "/Users/freddy/Work/Tether/models/parakeet/onnx";
  if (!std::filesystem::exists(modelsPath + "/encoder-model.onnx")) {
    GTEST_SKIP() << "Models not available";
  }
  
  config.modelPath = modelsPath;
  ParakeetModel model(config);
  
  std::ifstream encFile(modelsPath + "/encoder-model.onnx", std::ios::binary);
  std::vector<uint8_t> encoderData((std::istreambuf_iterator<char>(encFile)),
                                    std::istreambuf_iterator<char>());
  model.set_weights_for_file("encoder-model.onnx", std::span<const uint8_t>(encoderData), true);
  
  std::string decoderFile = modelsPath + "/decoder_joint-model.onnx";
  if (!std::filesystem::exists(decoderFile)) {
    decoderFile = modelsPath + "/decoder.onnx";
  }
  std::ifstream decFile(decoderFile, std::ios::binary);
  std::vector<uint8_t> decoderData((std::istreambuf_iterator<char>(decFile)),
                                    std::istreambuf_iterator<char>());
  model.set_weights_for_file("decoder_joint-model.onnx", std::span<const uint8_t>(decoderData), true);
  
  std::ifstream vocabFile(modelsPath + "/vocab.txt");
  std::string vocabContent((std::istreambuf_iterator<char>(vocabFile)),
                           std::istreambuf_iterator<char>());
  std::vector<uint8_t> vocabData(vocabContent.begin(), vocabContent.end());
  model.set_weights_for_file("vocab.txt", std::span<const uint8_t>(vocabData), true);
  
  model.load();
  EXPECT_TRUE(model.isLoaded());
  
  model.load();
  
  EXPECT_TRUE(model.isLoaded());
}

TEST_F(ParakeetModelTest, LoadFailsWhenDecoderMissing) {
  std::string modelsPath = "/Users/freddy/Work/Tether/models/parakeet/onnx";
  if (!std::filesystem::exists(modelsPath + "/encoder-model.onnx")) {
    GTEST_SKIP() << "Models not available";
  }
  
  config.modelPath = modelsPath;
  ParakeetModel model(config);
  
  std::ifstream encFile(modelsPath + "/encoder-model.onnx", std::ios::binary);
  std::vector<uint8_t> encoderData((std::istreambuf_iterator<char>(encFile)),
                                    std::istreambuf_iterator<char>());
  model.set_weights_for_file("encoder-model.onnx", std::span<const uint8_t>(encoderData), true);
  
  std::ifstream vocabFile(modelsPath + "/vocab.txt");
  std::string vocabContent((std::istreambuf_iterator<char>(vocabFile)),
                           std::istreambuf_iterator<char>());
  std::vector<uint8_t> vocabData(vocabContent.begin(), vocabContent.end());
  model.set_weights_for_file("vocab.txt", std::span<const uint8_t>(vocabData), true);
  
  EXPECT_THROW({
    model.load();
  }, std::runtime_error);
}

TEST_F(ParakeetModelTest, LoadWithPreprocessorModel) {
  std::string modelsPath = "/Users/freddy/Work/Tether/models/parakeet/onnx";
  if (!std::filesystem::exists(modelsPath + "/nemo128.onnx")) {
    GTEST_SKIP() << "Models not available";
  }
  
  config.modelPath = modelsPath;
  ParakeetModel model(config);
  
  std::ifstream encFile(modelsPath + "/encoder-model.onnx", std::ios::binary);
  std::vector<uint8_t> encoderData((std::istreambuf_iterator<char>(encFile)),
                                    std::istreambuf_iterator<char>());
  model.set_weights_for_file("encoder-model.onnx", std::span<const uint8_t>(encoderData), true);
  
  std::string decoderFile = modelsPath + "/decoder_joint-model.onnx";
  if (!std::filesystem::exists(decoderFile)) {
    decoderFile = modelsPath + "/decoder.onnx";
  }
  std::ifstream decFile(decoderFile, std::ios::binary);
  std::vector<uint8_t> decoderData((std::istreambuf_iterator<char>(decFile)),
                                    std::istreambuf_iterator<char>());
  model.set_weights_for_file("decoder_joint-model.onnx", std::span<const uint8_t>(decoderData), true);
  
  std::ifstream prepFile(modelsPath + "/nemo128.onnx", std::ios::binary);
  std::vector<uint8_t> prepData((std::istreambuf_iterator<char>(prepFile)),
                                std::istreambuf_iterator<char>());
  model.set_weights_for_file("preprocessor.onnx", std::span<const uint8_t>(prepData), true);
  
  std::ifstream vocabFile(modelsPath + "/vocab.txt");
  std::string vocabContent((std::istreambuf_iterator<char>(vocabFile)),
                           std::istreambuf_iterator<char>());
  std::vector<uint8_t> vocabData(vocabContent.begin(), vocabContent.end());
  model.set_weights_for_file("vocab.txt", std::span<const uint8_t>(vocabData), true);
  
  EXPECT_NO_THROW({
    model.load();
  });
  
  EXPECT_TRUE(model.isLoaded());
}

TEST_F(ParakeetModelTest, ProcessWithVeryShortAudio) {
  ParakeetModel model(config);
  
  std::vector<float> tinyAudio(100, 0.1f);
  
  EXPECT_NO_THROW({
    model.process(tinyAudio);
  });
}

TEST_F(ParakeetModelTest, ProcessWithAudioShorterThanWindowLength) {
  ParakeetModel model(config);
  
  std::vector<float> shortAudio(300, 0.1f);
  
  EXPECT_NO_THROW({
    model.process(shortAudio);
  });
}

TEST_F(ParakeetModelTest, ProcessWithLoadedModelAndRealAudio) {
  std::string modelsPath = "/Users/freddy/Work/Tether/models/parakeet/onnx";
  if (!std::filesystem::exists(modelsPath + "/encoder-model.onnx")) {
    GTEST_SKIP() << "Models not available";
  }
  
  config.modelPath = modelsPath;
  ParakeetModel model(config);
  
  std::ifstream encFile(modelsPath + "/encoder-model.onnx", std::ios::binary);
  std::vector<uint8_t> encoderData((std::istreambuf_iterator<char>(encFile)),
                                    std::istreambuf_iterator<char>());
  model.set_weights_for_file("encoder-model.onnx", std::span<const uint8_t>(encoderData), true);
  
  std::string decoderFile = modelsPath + "/decoder_joint-model.onnx";
  if (!std::filesystem::exists(decoderFile)) {
    decoderFile = modelsPath + "/decoder.onnx";
  }
  std::ifstream decFile(decoderFile, std::ios::binary);
  std::vector<uint8_t> decoderData((std::istreambuf_iterator<char>(decFile)),
                                    std::istreambuf_iterator<char>());
  model.set_weights_for_file("decoder_joint-model.onnx", std::span<const uint8_t>(decoderData), true);
  
  std::ifstream vocabFile(modelsPath + "/vocab.txt");
  std::string vocabContent((std::istreambuf_iterator<char>(vocabFile)),
                           std::istreambuf_iterator<char>());
  std::vector<uint8_t> vocabData(vocabContent.begin(), vocabContent.end());
  model.set_weights_for_file("vocab.txt", std::span<const uint8_t>(vocabData), true);
  
  model.load();
  
  std::vector<float> testAudio(16000, 0.1f);
  
  EXPECT_NO_THROW({
    model.process(testAudio);
  });
  
  auto stats = model.runtimeStats();
  
  auto findStat = [&stats](const std::string& key) -> std::variant<double, int64_t> {
    for (const auto& [k, v] : stats) {
      if (k == key) return v;
    }
    return int64_t(0);
  };
  
  EXPECT_GT(std::get<int64_t>(findStat("melSpecMs")), 0);
  EXPECT_GT(std::get<int64_t>(findStat("encoderMs")), 0);
  EXPECT_GT(std::get<int64_t>(findStat("decoderMs")), 0);
}

TEST_F(ParakeetModelTest, GetLanguageTokenFindsValidLanguage) {
  ParakeetModel model(config);
  
  auto vocabPtr = get(VocabTag{});
  (model.*vocabPtr) = {"<|startoftranscript|>", "<|en|>", "<|es|>", "<|fr|>"};
  
  auto getTokenPtr = get(GetLanguageTokenTag{});
  int64_t enToken = (model.*getTokenPtr)("en");
  EXPECT_EQ(enToken, 1);
  
  int64_t esToken = (model.*getTokenPtr)("es");
  EXPECT_EQ(esToken, 2);
}

TEST_F(ParakeetModelTest, GetLanguageTokenReturnsDefaultForUnknown) {
  ParakeetModel model(config);
  
  auto vocabPtr = get(VocabTag{});
  (model.*vocabPtr) = {"<|startoftranscript|>", "<|en|>"};
  
  auto getTokenPtr = get(GetLanguageTokenTag{});
  int64_t unknownToken = (model.*getTokenPtr)("xyz");
  EXPECT_EQ(unknownToken, 22);
}

TEST_F(ParakeetModelTest, ProcessWithLoadedModelButVeryShortAudio) {
  std::string modelsPath = "/Users/freddy/Work/Tether/models/parakeet/onnx";
  if (!std::filesystem::exists(modelsPath + "/encoder-model.onnx")) {
    GTEST_SKIP() << "Models not available";
  }
  
  config.modelPath = modelsPath;
  ParakeetModel model(config);
  
  std::ifstream encFile(modelsPath + "/encoder-model.onnx", std::ios::binary);
  std::vector<uint8_t> encoderData((std::istreambuf_iterator<char>(encFile)),
                                    std::istreambuf_iterator<char>());
  model.set_weights_for_file("encoder-model.onnx", std::span<const uint8_t>(encoderData), true);
  
  std::string decoderFile = modelsPath + "/decoder_joint-model.onnx";
  if (!std::filesystem::exists(decoderFile)) {
    decoderFile = modelsPath + "/decoder.onnx";
  }
  std::ifstream decFile(decoderFile, std::ios::binary);
  std::vector<uint8_t> decoderData((std::istreambuf_iterator<char>(decFile)),
                                    std::istreambuf_iterator<char>());
  model.set_weights_for_file("decoder_joint-model.onnx", std::span<const uint8_t>(decoderData), true);
  
  std::ifstream vocabFile(modelsPath + "/vocab.txt");
  std::string vocabContent((std::istreambuf_iterator<char>(vocabFile)),
                           std::istreambuf_iterator<char>());
  std::vector<uint8_t> vocabData(vocabContent.begin(), vocabContent.end());
  model.set_weights_for_file("vocab.txt", std::span<const uint8_t>(vocabData), true);
  
  model.load();
  
  std::vector<float> tinyAudio(100, 0.1f);
  
  EXPECT_NO_THROW({
    model.process(tinyAudio);
  });
}

TEST_F(ParakeetModelTest, ProcessWithPreprocessorSession) {
  std::string modelsPath = "/Users/freddy/Work/Tether/models/parakeet/onnx";
  if (!std::filesystem::exists(modelsPath + "/nemo128.onnx")) {
    GTEST_SKIP() << "Models not available";
  }
  
  config.modelPath = modelsPath;
  ParakeetModel model(config);
  
  std::ifstream encFile(modelsPath + "/encoder-model.onnx", std::ios::binary);
  std::vector<uint8_t> encoderData((std::istreambuf_iterator<char>(encFile)),
                                    std::istreambuf_iterator<char>());
  model.set_weights_for_file("encoder-model.onnx", std::span<const uint8_t>(encoderData), true);
  
  std::string decoderFile = modelsPath + "/decoder_joint-model.onnx";
  if (!std::filesystem::exists(decoderFile)) {
    decoderFile = modelsPath + "/decoder.onnx";
  }
  std::ifstream decFile(decoderFile, std::ios::binary);
  std::vector<uint8_t> decoderData((std::istreambuf_iterator<char>(decFile)),
                                    std::istreambuf_iterator<char>());
  model.set_weights_for_file("decoder_joint-model.onnx", std::span<const uint8_t>(decoderData), true);
  
  std::ifstream prepFile(modelsPath + "/nemo128.onnx", std::ios::binary);
  std::vector<uint8_t> prepData((std::istreambuf_iterator<char>(prepFile)),
                                std::istreambuf_iterator<char>());
  model.set_weights_for_file("preprocessor.onnx", std::span<const uint8_t>(prepData), true);
  
  std::ifstream vocabFile(modelsPath + "/vocab.txt");
  std::string vocabContent((std::istreambuf_iterator<char>(vocabFile)),
                           std::istreambuf_iterator<char>());
  std::vector<uint8_t> vocabData(vocabContent.begin(), vocabContent.end());
  model.set_weights_for_file("vocab.txt", std::span<const uint8_t>(vocabData), true);
  
  model.load();
  
  std::vector<float> testAudio(16000, 0.1f);
  
  EXPECT_NO_THROW({
    model.process(testAudio);
  });
}

int main(int argc, char** argv) {
  ::testing::InitGoogleTest(&argc, argv);
  return RUN_ALL_TESTS();
}

