#include "src/model-interface/TTSModel.hpp"
#include "mocks/ChatterboxEngineMock.hpp"
#include <gtest/gtest.h>

#include <filesystem>

using namespace qvac::ttslib::chatterbox::testing;

namespace qvac::ttslib::addon_model::testing {

class TTSModelTest : public ::testing::Test {
public:
  std::shared_ptr<ChatterboxEngineMock> engineMock_ =
      std::make_shared<ChatterboxEngineMock>();

  std::unordered_map<std::string, std::string> config_{
      {"language", "en"},
      {"tokenizerPath", "dummy"},
      {"speechEncoderPath", "dummy"},
      {"embedTokensPath", "dummy"},
      {"conditionalDecoderPath", "dummy"},
      {"languageModelPath", "dummy"}};

  std::vector<float> referenceAudio_ = {0.1f, 0.2f, 0.3f, 0.4f, 0.5f};
};

TEST_F(TTSModelTest, positiveInit) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  EXPECT_NO_THROW(TTSModel model(config_, referenceAudio_, engineMock_));
}

TEST_F(TTSModelTest, positiveUnload) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, unload()).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_NO_THROW(model.unload());
}

TEST_F(TTSModelTest, positiveUnloadWeights) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_NO_THROW(model.unloadWeights());
}

TEST_F(TTSModelTest, positiveLoad) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(2);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_NO_THROW(model.load());
}

TEST_F(TTSModelTest, positiveReload) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(2);
  EXPECT_CALL(*engineMock_, unload()).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_NO_THROW(model.reload());
}

TEST_F(TTSModelTest, positiveSaveLoadParams) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_NO_THROW(model.saveLoadParams(config_));
}

TEST_F(TTSModelTest, positiveReset) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_NO_THROW(model.reset());
}

TEST_F(TTSModelTest, positiveInitializeBackend) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_NO_THROW(model.initializeBackend());
}

TEST_F(TTSModelTest, positiveIsLoadedTrue) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_TRUE(model.isLoaded());
}

TEST_F(TTSModelTest, positiveIsLoadedFalse) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, unload()).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  model.unload();
  EXPECT_FALSE(model.isLoaded());
}

TEST_F(TTSModelTest, positiveProcess) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  qvac::ttslib::AudioResult mockResult;
  mockResult.pcm16 = {1, 2, 3, 4, 5};
  mockResult.sampleRate = 24000;
  mockResult.channels = 1;
  mockResult.samples = 5;
  mockResult.durationMs = 100.0;

  EXPECT_CALL(*engineMock_, synthesize(::testing::_))
      .Times(1)
      .WillOnce(::testing::Return(mockResult));

  TTSModel model(config_, referenceAudio_, engineMock_);
  const TTSModel::Output output = model.process("Hello, world!");
  EXPECT_GT(output.size(), 0);
}

TEST_F(TTSModelTest, positiveProcessWithConsumer) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  qvac::ttslib::AudioResult mockResult;
  mockResult.pcm16 = {1, 2, 3, 4, 5};
  mockResult.sampleRate = 24000;
  mockResult.channels = 1;
  mockResult.samples = 5;
  mockResult.durationMs = 100.0;

  EXPECT_CALL(*engineMock_, synthesize(::testing::_))
      .Times(1)
      .WillOnce(::testing::Return(mockResult));

  bool called = false;

  auto consumer = [&called](const TTSModel::Output &audio) { called = true; };

  TTSModel model(config_, referenceAudio_, engineMock_);
  TTSModel::Output output = model.process("Hello, world!", consumer);
  EXPECT_GT(output.size(), 0);
  EXPECT_TRUE(called);
}

TEST_F(TTSModelTest, positiveRuntimeStats) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_NO_THROW(qvac_lib_inference_addon_cpp::RuntimeStats stats =
                      model.runtimeStats());
}

} // namespace qvac::ttslib::addon_model::testing