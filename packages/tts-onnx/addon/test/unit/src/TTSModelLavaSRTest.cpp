#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include "mocks/ChatterboxEngineMock.hpp"
#include "src/model-interface/TTSModel.hpp"

using namespace qvac::ttslib::addon_model;
using namespace qvac::ttslib;
namespace chatterbox = qvac::ttslib::chatterbox;

class TTSModelLavaSRTest : public ::testing::Test {
protected:
  std::unordered_map<std::string, std::string> baseConfig() {
    return {
        {"language", "en"},
        {"tokenizerPath", "dummy_tokenizer.json"},
        {"speechEncoderPath", "dummy_speech_encoder.onnx"},
        {"embedTokensPath", "dummy_embed_tokens.onnx"},
        {"conditionalDecoderPath", "dummy_conditional_decoder.onnx"},
        {"languageModelPath", "dummy_language_model.onnx"},
    };
  }

  std::vector<float> dummyReferenceAudio() {
    return std::vector<float>(24000, 0.1f);
  }
};

TEST_F(TTSModelLavaSRTest, LavaSRConfigDefaultsOff) {
  auto config = baseConfig();

  auto mockEngine =
      std::make_shared<chatterbox::testing::ChatterboxEngineMock>();
  EXPECT_CALL(*mockEngine, load(::testing::_)).Times(1);
  EXPECT_CALL(*mockEngine, isLoaded()).WillRepeatedly(::testing::Return(true));

  TTSModel model(config, dummyReferenceAudio(), mockEngine);
  EXPECT_TRUE(model.isLoaded());
}

TEST_F(TTSModelLavaSRTest, LavaSRConfigParsed) {
  auto config = baseConfig();
  config["enhance"] = "true";
  config["denoise"] = "true";
  config["outputSampleRate"] = "22050";
  config["enhancerBackbonePath"] = "/path/to/backbone.onnx";
  config["enhancerSpecHeadPath"] = "/path/to/spec_head.onnx";
  config["denoiserPath"] = "/path/to/denoiser.onnx";

  auto mockEngine =
      std::make_shared<chatterbox::testing::ChatterboxEngineMock>();
  EXPECT_CALL(*mockEngine, load(::testing::_)).Times(1);
  EXPECT_CALL(*mockEngine, isLoaded()).WillRepeatedly(::testing::Return(true));

  // LavaSR load will throw because model files don't exist on disk
  EXPECT_THROW(TTSModel model(config, dummyReferenceAudio(), mockEngine),
               std::exception);
}

TEST_F(TTSModelLavaSRTest, OutputSampleRateOnly) {
  auto config = baseConfig();
  config["outputSampleRate"] = "16000";

  auto mockEngine =
      std::make_shared<chatterbox::testing::ChatterboxEngineMock>();
  EXPECT_CALL(*mockEngine, load(::testing::_)).Times(1);
  EXPECT_CALL(*mockEngine, isLoaded()).WillRepeatedly(::testing::Return(true));

  AudioResult synthResult;
  synthResult.sampleRate = 24000;
  synthResult.channels = 1;
  synthResult.pcm16.resize(24000, 1000);
  synthResult.durationMs = 1000.0;
  synthResult.samples = 24000;

  EXPECT_CALL(*mockEngine, synthesize(::testing::_))
      .WillOnce(::testing::Return(synthResult));

  TTSModel model(config, dummyReferenceAudio(), mockEngine);
  ASSERT_TRUE(model.isLoaded());

  auto output = model.process(std::string("Hello"));
  EXPECT_FALSE(output.empty());

  // With outputSampleRate=16000 and engine at 24000,
  // the output should be resampled (shorter than original)
  EXPECT_LT(output.size(), 24000u);
}

TEST_F(TTSModelLavaSRTest, NoFlagsBackwardCompatible) {
  auto config = baseConfig();

  auto mockEngine =
      std::make_shared<chatterbox::testing::ChatterboxEngineMock>();
  EXPECT_CALL(*mockEngine, load(::testing::_)).Times(1);
  EXPECT_CALL(*mockEngine, isLoaded()).WillRepeatedly(::testing::Return(true));

  AudioResult synthResult;
  synthResult.sampleRate = 24000;
  synthResult.channels = 1;
  synthResult.pcm16.resize(24000, 1000);
  synthResult.durationMs = 1000.0;
  synthResult.samples = 24000;

  EXPECT_CALL(*mockEngine, synthesize(::testing::_))
      .WillOnce(::testing::Return(synthResult));

  TTSModel model(config, dummyReferenceAudio(), mockEngine);
  auto output = model.process(std::string("Hello"));

  EXPECT_EQ(output.size(), 24000u);
}

TEST_F(TTSModelLavaSRTest, PerJobOutputSampleRateToggle) {
  auto config = baseConfig();

  auto mockEngine =
      std::make_shared<chatterbox::testing::ChatterboxEngineMock>();
  EXPECT_CALL(*mockEngine, load(::testing::_)).Times(1);
  EXPECT_CALL(*mockEngine, isLoaded()).WillRepeatedly(::testing::Return(true));

  AudioResult synthResult;
  synthResult.sampleRate = 24000;
  synthResult.channels = 1;
  synthResult.pcm16.resize(24000, 1000);
  synthResult.durationMs = 1000.0;
  synthResult.samples = 24000;

  EXPECT_CALL(*mockEngine, synthesize(::testing::_))
      .Times(2)
      .WillRepeatedly(::testing::Return(synthResult));

  TTSModel model(config, dummyReferenceAudio(), mockEngine);
  ASSERT_TRUE(model.isLoaded());

  // First job: no enhancement, native rate
  auto output1 = model.process(std::string("First"));
  EXPECT_EQ(output1.size(), 24000u);

  // Second job: per-job outputSampleRate override via AnyInput
  TTSModel::AnyInput jobInput;
  jobInput.text = "Second";
  jobInput.config = {{"outputSampleRate", "16000"}};
  auto result = model.process(std::any(jobInput));
  auto output2 = std::any_cast<TTSModel::Output>(result);
  EXPECT_LT(output2.size(), 24000u)
      << "Per-job outputSampleRate=16000 should produce shorter output";
}
