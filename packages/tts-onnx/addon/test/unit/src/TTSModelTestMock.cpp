#include "mocks/ChatterboxEngineMock.hpp"
#include "src/model-interface/TTSModel.hpp"
#include <any>
#include <gtest/gtest.h>

using namespace qvac::ttslib::chatterbox::testing;

namespace qvac::ttslib::addon_model::testing {

class TTSModelTestMock : public ::testing::Test {
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

TEST_F(TTSModelTestMock, positiveInit) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  EXPECT_NO_THROW(TTSModel model(config_, referenceAudio_, engineMock_));
}

TEST_F(TTSModelTestMock, positiveLoad) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(2);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_NO_THROW(model.load());
  EXPECT_TRUE(model.isLoaded());
}

TEST_F(TTSModelTestMock, positiveReload) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(2);
  EXPECT_CALL(*engineMock_, unload()).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_NO_THROW(model.reload());
  EXPECT_TRUE(model.isLoaded());
}

TEST_F(TTSModelTestMock, positiveUnload) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, unload()).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_NO_THROW(model.unload());
}

TEST_F(TTSModelTestMock, positiveReset) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_NO_THROW(model.reset());
}

TEST_F(TTSModelTestMock, positiveInitializeBackend) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_NO_THROW(model.initializeBackend());
}

TEST_F(TTSModelTestMock, positiveIsLoaded) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_TRUE(model.isLoaded());
}

TEST_F(TTSModelTestMock, positiveProcess) {
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
  const std::vector<int16_t> result = model.process(TTSModel::Input{"dummy"});
  EXPECT_EQ(result, std::vector<int16_t>({1, 2, 3, 4, 5}));
}

TEST_F(TTSModelTestMock, positiveProcessWithConsumer) {
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
  const std::vector<int16_t> result =
      model.process("dummy", [](const std::vector<int16_t> &result) {
        EXPECT_EQ(result, std::vector<int16_t>({1, 2, 3, 4, 5}));
      });
}

TEST_F(TTSModelTestMock, positiveRuntimeStats) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_NO_THROW(model.runtimeStats());
}

TEST_F(TTSModelTestMock, positiveSaveLoadParams) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_NO_THROW(model.saveLoadParams(config_));
}

TEST_F(TTSModelTestMock, positiveGetName) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_EQ(model.getName(), "TTSModel");
}

TEST_F(TTSModelTestMock, positiveProcessAnyInput) {
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
  std::any output = model.process(std::any(TTSModel::AnyInput{
      .text = "dummy", .config = {{"language", "en"}}}));
  ASSERT_EQ(output.type(), typeid(TTSModel::Output));
  EXPECT_EQ(std::any_cast<TTSModel::Output>(output).size(), 5);
}

TEST_F(TTSModelTestMock, positiveCancelBeforeProcessThrows) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));
  EXPECT_CALL(*engineMock_, synthesize(::testing::_)).Times(0);

  TTSModel model(config_, referenceAudio_, engineMock_);
  model.cancel();
  EXPECT_THROW(
      model.process(std::any(TTSModel::AnyInput{.text = "dummy", .config = {}})),
      std::runtime_error);
}

TEST_F(TTSModelTestMock, negativeUnloadedProcess) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, unload()).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  model.unload();
  EXPECT_FALSE(model.isLoaded());
  EXPECT_THROW(model.process(TTSModel::Input{"dummy"}), std::runtime_error);
}

TEST_F(TTSModelTestMock, positiveDoubleLoad) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(2);
  EXPECT_CALL(*engineMock_, unload()).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_TRUE(model.isLoaded());

  EXPECT_NO_THROW(model.load());
  EXPECT_TRUE(model.isLoaded());

  EXPECT_NO_THROW(model.unload());
  EXPECT_FALSE(model.isLoaded());
}

TEST_F(TTSModelTestMock, positiveDoubleUnload) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, unload()).Times(2);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_TRUE(model.isLoaded());

  EXPECT_NO_THROW(model.unload());
  EXPECT_FALSE(model.isLoaded());

  EXPECT_NO_THROW(model.unload());
  EXPECT_FALSE(model.isLoaded());
}

} // namespace qvac::ttslib::addon_model::testing