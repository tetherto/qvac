#include "src/model-interface/PiperEngine.hpp"
#include <gtest/gtest.h>
#include <stdexcept>

namespace qvac::ttslib::piper::testing {

class PiperEngineTest : public ::testing::Test {
public:
  const std::filesystem::path basePath_ = std::filesystem::path("../../../../models/tts/");
  const std::filesystem::path modelPath_ = basePath_ / "en_US-amy-low.onnx";
  const std::filesystem::path eSpeakDataPath_ = basePath_ / "espeak-ng-data";
  const std::filesystem::path configJsonPath_ = basePath_ / "en_US-amy-low.onnx.json";

  TTSConfig validConfig_ {
    modelPath_.string(), configJsonPath_.string(), "en", eSpeakDataPath_.string(), false
  };

  TTSConfig emptyConfig_ {};

  TTSConfig invalidModelPathConfig_ {
    "invalid", configJsonPath_.string(), "en", eSpeakDataPath_.string(), false
  };

  TTSConfig invalidConfigJsonPathConfig_ {
    modelPath_.string(), "invalid", "en", eSpeakDataPath_.string(), false
  };

};

TEST_F(PiperEngineTest, negativeEmptyConfig) {
  EXPECT_THROW(PiperEngine engine(emptyConfig_), std::runtime_error);
}

TEST_F(PiperEngineTest, negativeInvalidModelPathConfig) {
  EXPECT_THROW(PiperEngine engine(invalidModelPathConfig_), std::runtime_error);
}

TEST_F(PiperEngineTest, negativeInvalidConfigJsonPathConfig) {
  EXPECT_THROW(PiperEngine engine(invalidConfigJsonPathConfig_), std::runtime_error);
}

TEST_F(PiperEngineTest, positiveConstruct) {
  EXPECT_NO_THROW(PiperEngine engine(validConfig_));
}

TEST_F(PiperEngineTest, positiveLoad) {
  PiperEngine engine(validConfig_);
  EXPECT_NO_THROW(engine.load(validConfig_));
}

TEST_F(PiperEngineTest, positiveUnload) {
  PiperEngine engine(validConfig_);
  EXPECT_NO_THROW(engine.unload());
}

TEST_F(PiperEngineTest, positiveSynthesize) {
  PiperEngine engine(validConfig_);
  const AudioResult result = engine.synthesize("Hello, world!");

  EXPECT_EQ(result.sampleRate, 16000);
  EXPECT_EQ(result.channels, 1);
  EXPECT_GT(result.pcm16.size(), 0);
  EXPECT_GT(result.durationMs, 0.0);
  EXPECT_GT(result.samples, 0);
}

} // namespace qvac::ttslib::piper::testing