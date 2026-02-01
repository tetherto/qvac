#include <gtest/gtest.h>
#include "mocks/PiperEngineMock.hpp"
#include "src/model-interface/TTSModel.hpp"

using namespace qvac::ttslib::piper::testing;

namespace qvac::ttslib::addon_model::testing {

class TTSModelTestMock : public ::testing::Test {
public:
  std::shared_ptr<PiperEngineMock> engineMock_ = std::make_shared<PiperEngineMock>();
  
  std::unordered_map<std::string, std::string> config_{
    {"modelPath", "dummy"}, {"language", "dummy"},
    {"eSpeakDataPath", "dummy"}, {"configJsonPath", "dummy"}};
};

TEST_F(TTSModelTestMock, positiveInit) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);

  EXPECT_NO_THROW(TTSModel model(config_, engineMock_));
}

TEST_F(TTSModelTestMock, positiveLoad) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(2);
  
  TTSModel model(config_, engineMock_);
  EXPECT_NO_THROW(model.load());
  EXPECT_TRUE(model.isLoaded());
}

TEST_F(TTSModelTestMock, positiveReload) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(2);
  EXPECT_CALL(*engineMock_, unload()).Times(1);
  
  TTSModel model(config_, engineMock_);
  EXPECT_NO_THROW(model.reload());
  EXPECT_TRUE(model.isLoaded());
}

TEST_F(TTSModelTestMock, positiveUnload) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, unload()).Times(1);

  TTSModel model(config_, engineMock_);
  EXPECT_NO_THROW(model.unload());
}

TEST_F(TTSModelTestMock, positiveReset) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);

  TTSModel model(config_, engineMock_);
  EXPECT_NO_THROW(model.reset());
}

TEST_F(TTSModelTestMock, positiveInitializeBackend) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);

  TTSModel model(config_, engineMock_);
  EXPECT_NO_THROW(model.initializeBackend());
}

TEST_F(TTSModelTestMock, positiveIsLoaded) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);

  TTSModel model(config_, engineMock_);
  EXPECT_TRUE(model.isLoaded());
}

TEST_F(TTSModelTestMock, positiveProcess) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  
  qvac::ttslib::AudioResult mockResult;
  mockResult.pcm16 = {1, 2, 3, 4, 5};
  mockResult.sampleRate = 16000;
  mockResult.channels = 1;
  mockResult.samples = 5;
  mockResult.durationMs = 100.0;
  
  EXPECT_CALL(*engineMock_, synthesize(::testing::_)).Times(1).WillOnce(::testing::Return(mockResult));

  TTSModel model(config_, engineMock_);
  const std::vector<int16_t> result = model.process("dummy");
  EXPECT_EQ(result, std::vector<int16_t>({1, 2, 3, 4, 5}));
}

TEST_F(TTSModelTestMock, positiveProcessWithConsumer) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);

  qvac::ttslib::AudioResult mockResult;
  mockResult.pcm16 = {1, 2, 3, 4, 5};
  mockResult.sampleRate = 16000;
  mockResult.channels = 1;
  mockResult.samples = 5;
  mockResult.durationMs = 100.0;

  EXPECT_CALL(*engineMock_, synthesize(::testing::_)).Times(1).WillOnce(::testing::Return(mockResult));

  TTSModel model(config_, engineMock_);
  const std::vector<int16_t> result = model.process("dummy", [](const std::vector<int16_t>& result) { EXPECT_EQ(result, std::vector<int16_t>({1, 2, 3, 4, 5})); });
}

TEST_F(TTSModelTestMock, positiveRuntimeStats) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);

  TTSModel model(config_, engineMock_);
  EXPECT_NO_THROW(model.runtimeStats());
}

TEST_F(TTSModelTestMock, positiveSaveLoadParams) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);

  TTSModel model(config_, engineMock_);
  EXPECT_NO_THROW(model.saveLoadParams(config_));
}

TEST_F(TTSModelTestMock, negativeUnloadedProcess) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, unload()).Times(1);

  TTSModel model(config_, engineMock_);
  model.unload();
  EXPECT_FALSE(model.isLoaded());
  EXPECT_THROW(model.process("dummy"), std::runtime_error);
}

TEST_F(TTSModelTestMock, positiveDoubleLoad) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(2);
  EXPECT_CALL(*engineMock_, unload()).Times(1);
  
  TTSModel model(config_, engineMock_);
  EXPECT_TRUE(model.isLoaded());

  EXPECT_NO_THROW(model.load());
  EXPECT_TRUE(model.isLoaded());

  EXPECT_NO_THROW(model.unload());
  EXPECT_FALSE(model.isLoaded());
}

TEST_F(TTSModelTestMock, positiveDoubleUnload) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, unload()).Times(2);
  
  TTSModel model(config_, engineMock_);
  EXPECT_TRUE(model.isLoaded());

  EXPECT_NO_THROW(model.unload());
  EXPECT_FALSE(model.isLoaded());

  EXPECT_NO_THROW(model.unload());
  EXPECT_FALSE(model.isLoaded());
}

} // namespace qvac::ttslib::addon_model::testing