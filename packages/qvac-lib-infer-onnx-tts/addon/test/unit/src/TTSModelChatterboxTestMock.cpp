#include <gtest/gtest.h>
#include "mocks/ChatterboxEngineMock.hpp"
#include "src/model-interface/TTSModel.hpp"

using namespace qvac::ttslib::chatterbox::testing;

namespace qvac::ttslib::addon_model::chatterbox_testing {

class TTSModelChatterboxTestMock : public ::testing::Test {
public:
  std::shared_ptr<ChatterboxEngineMock> engineMock_ = std::make_shared<ChatterboxEngineMock>();
  
  // Chatterbox config with required keys to trigger Chatterbox engine detection
  std::unordered_map<std::string, std::string> config_{
    {"language", "en"},
    {"tokenizerPath", "dummy"},
    {"speechEncoderPath", "dummy"},
    {"embedTokensPath", "dummy"},
    {"conditionalDecoderPath", "dummy"},
    {"languageModelPath", "dummy"}
  };

  // Reference audio (required for Chatterbox)
  std::vector<float> referenceAudio_ = {0.1f, 0.2f, 0.3f, 0.4f, 0.5f};
};

TEST_F(TTSModelChatterboxTestMock, positiveInit) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  EXPECT_NO_THROW(TTSModel model(config_, referenceAudio_, nullptr, engineMock_));
}

TEST_F(TTSModelChatterboxTestMock, positiveLoad) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(2);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));
  
  TTSModel model(config_, referenceAudio_, nullptr, engineMock_);
  EXPECT_NO_THROW(model.load());
  EXPECT_TRUE(model.isLoaded());
}

TEST_F(TTSModelChatterboxTestMock, positiveReload) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(2);
  EXPECT_CALL(*engineMock_, unload()).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));
  
  TTSModel model(config_, referenceAudio_, nullptr, engineMock_);
  EXPECT_NO_THROW(model.reload());
  EXPECT_TRUE(model.isLoaded());
}

TEST_F(TTSModelChatterboxTestMock, positiveUnload) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, unload()).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, nullptr, engineMock_);
  EXPECT_NO_THROW(model.unload());
}

TEST_F(TTSModelChatterboxTestMock, positiveReset) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, nullptr, engineMock_);
  EXPECT_NO_THROW(model.reset());
}

TEST_F(TTSModelChatterboxTestMock, positiveInitializeBackend) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, nullptr, engineMock_);
  EXPECT_NO_THROW(model.initializeBackend());
}

TEST_F(TTSModelChatterboxTestMock, positiveIsLoaded) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, nullptr, engineMock_);
  EXPECT_TRUE(model.isLoaded());
}

TEST_F(TTSModelChatterboxTestMock, positiveProcess) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));
  
  qvac::ttslib::AudioResult mockResult;
  mockResult.pcm16 = {1, 2, 3, 4, 5};
  mockResult.sampleRate = 24000;  // Chatterbox uses 24kHz
  mockResult.channels = 1;
  mockResult.samples = 5;
  mockResult.durationMs = 100.0;
  
  EXPECT_CALL(*engineMock_, synthesize(::testing::_)).Times(1).WillOnce(::testing::Return(mockResult));

  TTSModel model(config_, referenceAudio_, nullptr, engineMock_);
  const std::vector<int16_t> result = model.process("dummy");
  EXPECT_EQ(result, std::vector<int16_t>({1, 2, 3, 4, 5}));
}

TEST_F(TTSModelChatterboxTestMock, positiveProcessWithConsumer) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  qvac::ttslib::AudioResult mockResult;
  mockResult.pcm16 = {1, 2, 3, 4, 5};
  mockResult.sampleRate = 24000;
  mockResult.channels = 1;
  mockResult.samples = 5;
  mockResult.durationMs = 100.0;

  EXPECT_CALL(*engineMock_, synthesize(::testing::_)).Times(1).WillOnce(::testing::Return(mockResult));

  TTSModel model(config_, referenceAudio_, nullptr, engineMock_);
  const std::vector<int16_t> result = model.process("dummy", [](const std::vector<int16_t>& result) { EXPECT_EQ(result, std::vector<int16_t>({1, 2, 3, 4, 5})); });
}

TEST_F(TTSModelChatterboxTestMock, positiveRuntimeStats) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, nullptr, engineMock_);
  EXPECT_NO_THROW(model.runtimeStats());
}

TEST_F(TTSModelChatterboxTestMock, positiveSaveLoadParams) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, nullptr, engineMock_);
  EXPECT_NO_THROW(model.saveLoadParams(config_));
}

TEST_F(TTSModelChatterboxTestMock, negativeUnloadedProcess) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, unload()).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, nullptr, engineMock_);
  model.unload();
  EXPECT_FALSE(model.isLoaded());
  EXPECT_THROW(model.process("dummy"), std::runtime_error);
}

TEST_F(TTSModelChatterboxTestMock, positiveDoubleLoad) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(2);
  EXPECT_CALL(*engineMock_, unload()).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));
  
  TTSModel model(config_, referenceAudio_, nullptr, engineMock_);
  EXPECT_TRUE(model.isLoaded());

  EXPECT_NO_THROW(model.load());
  EXPECT_TRUE(model.isLoaded());

  EXPECT_NO_THROW(model.unload());
  EXPECT_FALSE(model.isLoaded());
}

TEST_F(TTSModelChatterboxTestMock, positiveDoubleUnload) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, unload()).Times(2);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));
  
  TTSModel model(config_, referenceAudio_, nullptr, engineMock_);
  EXPECT_TRUE(model.isLoaded());

  EXPECT_NO_THROW(model.unload());
  EXPECT_FALSE(model.isLoaded());

  EXPECT_NO_THROW(model.unload());
  EXPECT_FALSE(model.isLoaded());
}

TEST_F(TTSModelChatterboxTestMock, positiveSetReferenceAudio) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, nullptr, engineMock_);
  
  std::vector<float> newReferenceAudio = {0.5f, 0.6f, 0.7f, 0.8f, 0.9f, 1.0f};
  EXPECT_NO_THROW(model.setReferenceAudio(newReferenceAudio));
}

} // namespace qvac::ttslib::addon_model::chatterbox_testing
