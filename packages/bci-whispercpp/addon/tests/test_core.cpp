#include <cstdint>
#include <cstring>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/bci/NeuralProcessor.hpp"
#include "model-interface/bci/BCIConfig.hpp"

using namespace qvac_lib_inference_addon_bci;

namespace {

std::vector<uint8_t> createTestSignal(uint32_t numTimesteps, uint32_t numChannels) {
  const size_t headerSize = 2 * sizeof(uint32_t);
  const size_t dataSize = numTimesteps * numChannels * sizeof(float);
  std::vector<uint8_t> buffer(headerSize + dataSize);

  std::memcpy(buffer.data(), &numTimesteps, sizeof(uint32_t));
  std::memcpy(buffer.data() + sizeof(uint32_t), &numChannels, sizeof(uint32_t));

  auto* data = reinterpret_cast<float*>(buffer.data() + headerSize);
  for (uint32_t t = 0; t < numTimesteps; ++t) {
    for (uint32_t c = 0; c < numChannels; ++c) {
      data[t * numChannels + c] =
          static_cast<float>(t) / static_cast<float>(numTimesteps) *
          std::sin(static_cast<float>(c) * 0.1F);
    }
  }
  return buffer;
}

} // namespace

TEST(NeuralProcessor, ProcessToMelProducesCorrectShape) {
  NeuralProcessor processor;
  auto signal = createTestSignal(100, 512);
  auto result = processor.processToMel(signal);

  EXPECT_EQ(result.size(),
            static_cast<size_t>(NeuralProcessor::K_WHISPER_MEL_FRAMES) *
            NeuralProcessor::K_WHISPER_N_MEL);
}

TEST(NeuralProcessor, ProcessToMelRejectsSmallBuffer) {
  NeuralProcessor processor;
  std::vector<uint8_t> tooSmall = {1, 2, 3};
  EXPECT_THROW(processor.processToMel(tooSmall), std::exception);
}

TEST(NeuralProcessor, GaussianSmoothPreservesSize) {
  uint32_t T = 50, C = 8;
  std::vector<float> data(T * C, 1.0F);
  auto smoothed = NeuralProcessor::gaussianSmooth(data, T, C, 2.0F, 20);
  EXPECT_EQ(smoothed.size(), data.size());
}

TEST(NeuralProcessor, GaussianSmoothReducesNoise) {
  uint32_t T = 100, C = 4;
  std::vector<float> data(T * C);
  for (uint32_t t = 0; t < T; ++t)
    for (uint32_t c = 0; c < C; ++c)
      data[t * C + c] = (t % 2 == 0) ? 1.0F : -1.0F;

  auto smoothed = NeuralProcessor::gaussianSmooth(data, T, C, 2.0F, 20);

  float origVar = 0, smoothVar = 0;
  for (size_t i = 0; i < data.size(); ++i) {
    origVar += data[i] * data[i];
    smoothVar += smoothed[i] * smoothed[i];
  }
  EXPECT_LT(smoothVar, origVar);
}

TEST(NeuralProcessor, OutputValuesAreFinite) {
  NeuralProcessor processor;
  auto signal = createTestSignal(50, 512);
  auto result = processor.processToMel(signal);
  for (const auto& sample : result) {
    EXPECT_TRUE(std::isfinite(sample));
  }
}

TEST(NeuralProcessor, PaddedFramesAreZero) {
  NeuralProcessor processor;
  auto signal = createTestSignal(50, 512);
  auto result = processor.processToMel(signal);

  float lastFrameSum = 0;
  int lastFrame = NeuralProcessor::K_WHISPER_MEL_FRAMES - 1;
  for (int m = 0; m < NeuralProcessor::K_WHISPER_N_MEL; ++m) {
    lastFrameSum += std::abs(result[lastFrame * NeuralProcessor::K_WHISPER_N_MEL + m]);
  }
  EXPECT_FLOAT_EQ(lastFrameSum, 0.0F);
}

TEST(BCIConfig, DefaultWhisperFullParamsAreValid) {
  BCIConfig config;
  config.whisperMainCfg["language"] = std::string("en");
  auto params = toWhisperFullParams(config);
  EXPECT_STREQ(params.language, "en");
}
