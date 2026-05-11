#include <algorithm>

#include "mocks/ChatterboxEngineMock.hpp"
#include "src/model-interface/TTSModel.hpp"

using namespace qvac::ttslib::addon_model;
using namespace qvac::ttslib::chatterbox::testing;

namespace {

std::unordered_map<std::string, std::string> makeConfig() {
  return {{"language", "en"},
          {"tokenizerPath", "dummy"},
          {"speechEncoderPath", "dummy"},
          {"embedTokensPath", "dummy"},
          {"conditionalDecoderPath", "dummy"},
          {"languageModelPath", "dummy"}};
}

qvac::ttslib::AudioResult makeAudioResult() {
  qvac::ttslib::AudioResult result;
  result.pcm16 = {1, 2, 3, 4, 5};
  result.sampleRate = 24000;
  result.channels = 1;
  result.samples = 5;
  result.durationMs = 100.0;
  return result;
}

TEST(TTSModelIModelTest, ProcessAnyInputAndGetName) {
  auto mock = std::make_shared<ChatterboxEngineMock>();
  EXPECT_CALL(*mock, load(::testing::_)).Times(1);
  EXPECT_CALL(*mock, isLoaded()).WillRepeatedly(::testing::Return(true));
  EXPECT_CALL(*mock, synthesize(::testing::_))
      .Times(1)
      .WillOnce(::testing::Return(makeAudioResult()));

  TTSModel model(makeConfig(), {0.1f, 0.2f, 0.3f}, mock);
  EXPECT_EQ(model.getName(), "TTSModel");

  std::any output = model.process(std::any(TTSModel::AnyInput{
      .text = "Hello world!", .config = {{"language", "en"}}}));
  ASSERT_TRUE(output.has_value());
  ASSERT_EQ(output.type(), typeid(TTSModel::Output));
  EXPECT_EQ(std::any_cast<TTSModel::Output>(output).size(), 5);
}

TEST(TTSModelIModelTest, InvalidAnyInputThrows) {
  auto mock = std::make_shared<ChatterboxEngineMock>();
  EXPECT_CALL(*mock, load(::testing::_)).Times(1);
  EXPECT_CALL(*mock, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(makeConfig(), {0.1f, 0.2f}, mock);
  EXPECT_THROW(model.process(std::any(1234)), std::exception);
}

TEST(TTSModelIModelTest, CancelBeforeProcessThrows) {
  auto mock = std::make_shared<ChatterboxEngineMock>();
  EXPECT_CALL(*mock, load(::testing::_)).Times(1);
  EXPECT_CALL(*mock, isLoaded()).WillRepeatedly(::testing::Return(true));
  EXPECT_CALL(*mock, synthesize(::testing::_)).Times(0);

  TTSModel model(makeConfig(), {0.1f, 0.2f}, mock);
  model.cancel();
  EXPECT_THROW(
      model.process(std::any(TTSModel::AnyInput{.text = "Hello", .config = {}})),
      std::runtime_error);
}

TEST(TTSModelIModelTest, RuntimeStatsHasExpectedMetrics) {
  auto mock = std::make_shared<ChatterboxEngineMock>();
  EXPECT_CALL(*mock, load(::testing::_)).Times(1);
  EXPECT_CALL(*mock, isLoaded()).WillRepeatedly(::testing::Return(true));
  EXPECT_CALL(*mock, synthesize(::testing::_))
      .Times(1)
      .WillOnce(::testing::Return(makeAudioResult()));

  TTSModel model(makeConfig(), {0.1f, 0.2f, 0.3f}, mock);
  (void)model.process(TTSModel::Input{"stats sample"});

  auto stats = model.runtimeStats();
  EXPECT_FALSE(stats.empty());
  EXPECT_TRUE(std::any_of(
      stats.begin(), stats.end(),
      [](const auto &entry) { return entry.first == "totalTime"; }));
  EXPECT_TRUE(std::any_of(
      stats.begin(), stats.end(),
      [](const auto &entry) { return entry.first == "totalSamples"; }));
}
} // namespace