#include <gtest/gtest.h>

#include "DspTestHelpers.hpp"
#include "src/model-interface/LavaSRDenoiser.hpp"
#include "src/model-interface/LavaSREnhancer.hpp"
#include "src/model-interface/TTSModel.hpp"
#include "src/model-interface/dsp/Resampler.hpp"

#include <filesystem>

using namespace qvac::ttslib;
using qvac::ttslib::test::generateSine;

namespace fs = std::filesystem;

namespace {

const std::string LAVASR_DIR = "models/lavasr";
const std::string CHATTERBOX_DIR = "models/chatterbox";

bool lavaSRModelsExist() {
  return fs::exists(LAVASR_DIR + "/enhancer_backbone.onnx") &&
         fs::exists(LAVASR_DIR + "/enhancer_backbone.onnx.data") &&
         fs::exists(LAVASR_DIR + "/enhancer_spec_head.onnx") &&
         fs::exists(LAVASR_DIR + "/enhancer_spec_head.onnx.data") &&
         fs::exists(LAVASR_DIR + "/denoiser_core_legacy_fixed63.onnx");
}

bool chatterboxModelsExist() {
  return fs::exists(CHATTERBOX_DIR + "/tokenizer.json") &&
         fs::exists(CHATTERBOX_DIR + "/speech_encoder.onnx") &&
         fs::exists(CHATTERBOX_DIR + "/embed_tokens.onnx") &&
         fs::exists(CHATTERBOX_DIR + "/conditional_decoder.onnx") &&
         fs::exists(CHATTERBOX_DIR + "/language_model.onnx");
}

} // namespace

TEST(LavaSRIntegrationTest, enhancerLoadsAndRunsWithRealModels) {
  if (!lavaSRModelsExist()) {
    GTEST_SKIP() << "LavaSR models not found in " << LAVASR_DIR;
  }

  lavasr::LavaSREnhancer enhancer(LAVASR_DIR + "/enhancer_backbone.onnx",
                                  LAVASR_DIR + "/enhancer_spec_head.onnx");
  enhancer.load();
  ASSERT_TRUE(enhancer.isLoaded());

  auto input48k = generateSine(440.0f, 48000, 48000, 0.3f);
  auto enhanced = enhancer.enhance(input48k, 4000.0f);

  EXPECT_EQ(enhanced.size(), input48k.size());
  bool allZero = true;
  for (float v : enhanced) {
    if (std::abs(v) > 1e-6f) {
      allZero = false;
      break;
    }
  }
  EXPECT_FALSE(allZero) << "Enhanced output should not be all zeros";
}

TEST(LavaSRIntegrationTest, denoiserLoadsAndRunsWithRealModels) {
  if (!lavaSRModelsExist()) {
    GTEST_SKIP() << "LavaSR models not found in " << LAVASR_DIR;
  }

  lavasr::LavaSRDenoiser denoiser(LAVASR_DIR +
                                  "/denoiser_core_legacy_fixed63.onnx");
  denoiser.load();
  ASSERT_TRUE(denoiser.isLoaded());

  auto input16k = generateSine(440.0f, 16000, 16000, 0.3f);
  auto denoised = denoiser.denoise(input16k);

  EXPECT_EQ(denoised.size(), input16k.size());
  bool allZero = true;
  for (float v : denoised) {
    if (std::abs(v) > 1e-6f) {
      allZero = false;
      break;
    }
  }
  EXPECT_FALSE(allZero) << "Denoised output should not be all zeros";
}

TEST(LavaSRIntegrationTest, fullPipelineChatterboxWithEnhance) {
  if (!lavaSRModelsExist() || !chatterboxModelsExist()) {
    GTEST_SKIP() << "Models not found";
  }

  std::unordered_map<std::string, std::string> config;
  config["language"] = "en";
  config["tokenizerPath"] = CHATTERBOX_DIR + "/tokenizer.json";
  config["speechEncoderPath"] = CHATTERBOX_DIR + "/speech_encoder.onnx";
  config["embedTokensPath"] = CHATTERBOX_DIR + "/embed_tokens.onnx";
  config["conditionalDecoderPath"] =
      CHATTERBOX_DIR + "/conditional_decoder.onnx";
  config["languageModelPath"] = CHATTERBOX_DIR + "/language_model.onnx";
  config["enhance"] = "true";
  config["enhancerBackbonePath"] = LAVASR_DIR + "/enhancer_backbone.onnx";
  config["enhancerSpecHeadPath"] = LAVASR_DIR + "/enhancer_spec_head.onnx";

  std::vector<float> refAudio(24000, 0.1f);

  addon_model::TTSModel model(config, refAudio);
  ASSERT_TRUE(model.isLoaded());

  auto output = model.process(std::string("Hi"));
  EXPECT_FALSE(output.empty()) << "Enhanced TTS output should not be empty";
  EXPECT_GT(output.size(), 24000u)
      << "Enhanced output (48kHz) should be longer than raw 24kHz output";
}

TEST(LavaSRIntegrationTest, fullPipelineDenoiseAndEnhance) {
  if (!lavaSRModelsExist() || !chatterboxModelsExist()) {
    GTEST_SKIP() << "Models not found";
  }

  std::unordered_map<std::string, std::string> config;
  config["language"] = "en";
  config["tokenizerPath"] = CHATTERBOX_DIR + "/tokenizer.json";
  config["speechEncoderPath"] = CHATTERBOX_DIR + "/speech_encoder.onnx";
  config["embedTokensPath"] = CHATTERBOX_DIR + "/embed_tokens.onnx";
  config["conditionalDecoderPath"] =
      CHATTERBOX_DIR + "/conditional_decoder.onnx";
  config["languageModelPath"] = CHATTERBOX_DIR + "/language_model.onnx";
  config["enhance"] = "true";
  config["denoise"] = "true";
  config["enhancerBackbonePath"] = LAVASR_DIR + "/enhancer_backbone.onnx";
  config["enhancerSpecHeadPath"] = LAVASR_DIR + "/enhancer_spec_head.onnx";
  config["denoiserPath"] = LAVASR_DIR + "/denoiser_core_legacy_fixed63.onnx";

  std::vector<float> refAudio(24000, 0.1f);

  addon_model::TTSModel model(config, refAudio);
  ASSERT_TRUE(model.isLoaded());

  auto output = model.process(std::string("Hi"));
  EXPECT_FALSE(output.empty())
      << "Denoised+enhanced TTS output should not be empty";
  EXPECT_GT(output.size(), 24000u)
      << "Denoised+enhanced output (48kHz) should be longer than raw 24kHz";
}

TEST(LavaSRIntegrationTest, enhanceWithOutputSampleRate) {
  if (!lavaSRModelsExist() || !chatterboxModelsExist()) {
    GTEST_SKIP() << "Models not found";
  }

  std::unordered_map<std::string, std::string> config;
  config["language"] = "en";
  config["tokenizerPath"] = CHATTERBOX_DIR + "/tokenizer.json";
  config["speechEncoderPath"] = CHATTERBOX_DIR + "/speech_encoder.onnx";
  config["embedTokensPath"] = CHATTERBOX_DIR + "/embed_tokens.onnx";
  config["conditionalDecoderPath"] =
      CHATTERBOX_DIR + "/conditional_decoder.onnx";
  config["languageModelPath"] = CHATTERBOX_DIR + "/language_model.onnx";
  config["enhance"] = "true";
  config["outputSampleRate"] = "22050";
  config["enhancerBackbonePath"] = LAVASR_DIR + "/enhancer_backbone.onnx";
  config["enhancerSpecHeadPath"] = LAVASR_DIR + "/enhancer_spec_head.onnx";

  std::vector<float> refAudio(24000, 0.1f);

  addon_model::TTSModel model(config, refAudio);
  ASSERT_TRUE(model.isLoaded());

  auto output = model.process(std::string("Hi"));
  EXPECT_FALSE(output.empty())
      << "Enhanced+resampled output should not be empty";
}
