#include "mocks/ChatterboxEngineMock.hpp"
#include "src/model-interface/TTSModel.hpp"
#include <gtest/gtest.h>

using namespace qvac::ttslib::chatterbox::testing;

namespace qvac::ttslib::addon_model::chatterbox_testing {

class TTSModelChatterboxTestMock : public ::testing::Test {
public:
  std::shared_ptr<ChatterboxEngineMock> engineMock_ =
      std::make_shared<ChatterboxEngineMock>();

  // Chatterbox config with required keys to trigger Chatterbox engine detection
  std::unordered_map<std::string, std::string> config_{
      {"language", "en"},
      {"tokenizerPath", "dummy"},
      {"speechEncoderPath", "dummy"},
      {"embedTokensPath", "dummy"},
      {"conditionalDecoderPath", "dummy"},
      {"languageModelPath", "dummy"}};

  // Reference audio (required for Chatterbox)
  std::vector<float> referenceAudio_ = {0.1f, 0.2f, 0.3f, 0.4f, 0.5f};
};

TEST_F(TTSModelChatterboxTestMock, positiveInit) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  EXPECT_NO_THROW(
      TTSModel model(config_, referenceAudio_, engineMock_));
}

TEST_F(TTSModelChatterboxTestMock, positiveLoad) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(2);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_NO_THROW(model.load());
  EXPECT_TRUE(model.isLoaded());
}

TEST_F(TTSModelChatterboxTestMock, positiveReload) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(2);
  EXPECT_CALL(*engineMock_, unload()).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_NO_THROW(model.reload());
  EXPECT_TRUE(model.isLoaded());
}

TEST_F(TTSModelChatterboxTestMock, positiveUnload) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, unload()).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_NO_THROW(model.unload());
}

TEST_F(TTSModelChatterboxTestMock, positiveReset) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_NO_THROW(model.reset());
}

TEST_F(TTSModelChatterboxTestMock, positiveInitializeBackend) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_NO_THROW(model.initializeBackend());
}

TEST_F(TTSModelChatterboxTestMock, positiveIsLoaded) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_TRUE(model.isLoaded());
}

TEST_F(TTSModelChatterboxTestMock, positiveProcess) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  qvac::ttslib::AudioResult mockResult;
  mockResult.pcm16 = {1, 2, 3, 4, 5};
  mockResult.sampleRate = 24000; // Chatterbox uses 24kHz
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

TEST_F(TTSModelChatterboxTestMock, positiveProcessWithConsumer) {
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

TEST_F(TTSModelChatterboxTestMock, positiveRuntimeStats) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_NO_THROW(model.runtimeStats());
}

TEST_F(TTSModelChatterboxTestMock, positiveSaveLoadParams) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_NO_THROW(model.saveLoadParams(config_));
}

TEST_F(TTSModelChatterboxTestMock, negativeUnloadedProcess) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, unload()).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  model.unload();
  EXPECT_FALSE(model.isLoaded());
  EXPECT_THROW(model.process(TTSModel::Input{"dummy"}), std::runtime_error);
}

TEST_F(TTSModelChatterboxTestMock, positiveDoubleLoad) {
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

TEST_F(TTSModelChatterboxTestMock, positiveDoubleUnload) {
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

TEST_F(TTSModelChatterboxTestMock, positiveSetReferenceAudio) {
  EXPECT_CALL(*engineMock_, load(::testing::_)).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);

  std::vector<float> newReferenceAudio = {0.5f, 0.6f, 0.7f, 0.8f, 0.9f, 1.0f};
  EXPECT_NO_THROW(model.setReferenceAudio(newReferenceAudio));
}

TEST_F(TTSModelChatterboxTestMock, numThreadsParsedWhenValid) {
  qvac::ttslib::chatterbox::ChatterboxConfig captured;
  EXPECT_CALL(*engineMock_, load(::testing::_))
      .Times(1)
      .WillOnce(::testing::SaveArg<0>(&captured));
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  auto cfg = config_;
  cfg["numThreads"] = "4";
  TTSModel model(cfg, referenceAudio_, engineMock_);
  EXPECT_EQ(captured.numThreads, 4);
}

TEST_F(TTSModelChatterboxTestMock, numThreadsDefaultsToZeroWhenKeyAbsent) {
  qvac::ttslib::chatterbox::ChatterboxConfig captured;
  EXPECT_CALL(*engineMock_, load(::testing::_))
      .Times(1)
      .WillOnce(::testing::SaveArg<0>(&captured));
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config_, referenceAudio_, engineMock_);
  EXPECT_EQ(captured.numThreads, 0);
}

TEST_F(TTSModelChatterboxTestMock, numThreadsResetsToDefaultOnParseFailure) {
  qvac::ttslib::chatterbox::ChatterboxConfig captured;
  EXPECT_CALL(*engineMock_, load(::testing::_))
      .Times(1)
      .WillOnce(::testing::SaveArg<0>(&captured));
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  auto cfg = config_;
  cfg["numThreads"] = "not-an-int";
  TTSModel model(cfg, referenceAudio_, engineMock_);
  EXPECT_EQ(captured.numThreads, 0);
}

TEST_F(TTSModelChatterboxTestMock, numThreadsResetsToDefaultOnOutOfRange) {
  qvac::ttslib::chatterbox::ChatterboxConfig captured;
  EXPECT_CALL(*engineMock_, load(::testing::_))
      .Times(1)
      .WillOnce(::testing::SaveArg<0>(&captured));
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  auto cfg = config_;
  cfg["numThreads"] = "999999999999999999999";
  TTSModel model(cfg, referenceAudio_, engineMock_);
  EXPECT_EQ(captured.numThreads, 0);
}

// Regression test for the bug Omar flagged on PR #1745 (r3155500220):
// after a successful prior parse, a subsequent reload with an unparseable
// numThreads value used to silently keep the previous thread count. The
// warning text claimed "falling back to default (1 intra-op thread)", which
// was a lie. The catch block now resets numThreads to 0 so the warning
// matches reality.
TEST_F(TTSModelChatterboxTestMock,
       numThreadsResetsToDefaultOnReloadAfterPriorValidValue) {
  qvac::ttslib::chatterbox::ChatterboxConfig firstLoad;
  qvac::ttslib::chatterbox::ChatterboxConfig secondLoad;
  EXPECT_CALL(*engineMock_, load(::testing::_))
      .Times(2)
      .WillOnce(::testing::SaveArg<0>(&firstLoad))
      .WillOnce(::testing::SaveArg<0>(&secondLoad));
  EXPECT_CALL(*engineMock_, unload()).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  auto goodCfg = config_;
  goodCfg["numThreads"] = "4";
  TTSModel model(goodCfg, referenceAudio_, engineMock_);
  EXPECT_EQ(firstLoad.numThreads, 4);

  auto badCfg = config_;
  badCfg["numThreads"] = "not-an-int";
  model.saveLoadParams(badCfg);
  model.reload();
  EXPECT_EQ(secondLoad.numThreads, 0);
}

TEST_F(TTSModelChatterboxTestMock,
       numThreadsCarriesOverWhenKeyAbsentOnReload) {
  qvac::ttslib::chatterbox::ChatterboxConfig firstLoad;
  qvac::ttslib::chatterbox::ChatterboxConfig secondLoad;
  EXPECT_CALL(*engineMock_, load(::testing::_))
      .Times(2)
      .WillOnce(::testing::SaveArg<0>(&firstLoad))
      .WillOnce(::testing::SaveArg<0>(&secondLoad));
  EXPECT_CALL(*engineMock_, unload()).Times(1);
  EXPECT_CALL(*engineMock_, isLoaded()).WillRepeatedly(::testing::Return(true));

  auto goodCfg = config_;
  goodCfg["numThreads"] = "4";
  TTSModel model(goodCfg, referenceAudio_, engineMock_);
  EXPECT_EQ(firstLoad.numThreads, 4);

  // Same map without numThreads key: createChatterboxConfig should keep
  // the previously parsed value, since the field is only overwritten when
  // the key is present and non-empty.
  model.saveLoadParams(config_);
  model.reload();
  EXPECT_EQ(secondLoad.numThreads, 4);
}

} // namespace qvac::ttslib::addon_model::chatterbox_testing
