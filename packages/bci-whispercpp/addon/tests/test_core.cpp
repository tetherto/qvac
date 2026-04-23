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
  // mel output is mel-major: data[bin * n_frames + frame]
  for (int m = 0; m < NeuralProcessor::K_WHISPER_N_MEL; ++m) {
    lastFrameSum += std::abs(result[m * NeuralProcessor::K_WHISPER_MEL_FRAMES + lastFrame]);
  }
  EXPECT_FLOAT_EQ(lastFrameSum, 0.0F);
}

TEST(BCIConfig, DefaultWhisperFullParamsAreValid) {
  BCIConfig config;
  config.whisperMainCfg["language"] = std::string("en");
  auto params = toWhisperFullParams(config);
  EXPECT_STREQ(params.language, "en");
}

TEST(BCIConfig, UnknownWhisperKeyIsRejected) {
  BCIConfig config;
  config.whisperMainCfg["not_a_real_key"] = true;
  EXPECT_THROW(toWhisperFullParams(config), std::exception);
}

TEST(BCIConfig, UnknownContextKeyIsRejected) {
  BCIConfig config;
  config.whisperContextCfg["nope"] = std::string("value");
  EXPECT_THROW(toWhisperContextParams(config), std::exception);
}

TEST(BCIConfig, NumericDoubleCoercedToInt) {
  BCIConfig config;
  config.whisperMainCfg["n_threads"] = 4.0;
  config.whisperMainCfg["duration_ms"] = 100.0;
  auto params = toWhisperFullParams(config);
  EXPECT_EQ(params.n_threads, 4);
  EXPECT_EQ(params.duration_ms, 100);
}

TEST(BCIConfig, NegativeNThreadsRejected) {
  BCIConfig config;
  config.whisperMainCfg["n_threads"] = -1.0;
  EXPECT_THROW(toWhisperFullParams(config), std::exception);
}

TEST(BCIConfig, NegativeDurationMsRejected) {
  BCIConfig config;
  config.whisperMainCfg["duration_ms"] = -5.0;
  EXPECT_THROW(toWhisperFullParams(config), std::exception);
}

TEST(BCIConfig, TemperatureOutOfRangeRejected) {
  BCIConfig config;
  config.whisperMainCfg["temperature"] = 3.5;
  EXPECT_THROW(toWhisperFullParams(config), std::exception);
}

TEST(BCIConfig, BeamSizeOutOfRangeRejected) {
  BCIConfig config;
  config.whisperMainCfg["beam_search_beam_size"] = 0.0;
  EXPECT_THROW(toWhisperFullParams(config), std::exception);
  BCIConfig big;
  big.whisperMainCfg["beam_search_beam_size"] = 100.0;
  EXPECT_THROW(toWhisperFullParams(big), std::exception);
}

TEST(BCIConfig, ContextGpuDeviceMustBeNonNegative) {
  BCIConfig config;
  config.whisperContextCfg["gpu_device"] = -1.0;
  EXPECT_THROW(toWhisperContextParams(config), std::exception);
}

TEST(BCIConfig, ContextBooleanHandlersWireThrough) {
  BCIConfig config;
  config.whisperContextCfg["use_gpu"] = true;
  config.whisperContextCfg["flash_attn"] = false;
  auto params = toWhisperContextParams(config);
  EXPECT_TRUE(params.use_gpu);
  EXPECT_FALSE(params.flash_attn);
}

TEST(NeuralProcessor, LoadInvalidEmbedderReturnsFalse) {
  NeuralProcessor processor;
  EXPECT_FALSE(processor.loadEmbedderWeights("/nonexistent/path/embedder.bin"));
  EXPECT_FALSE(processor.hasWeights());
}

TEST(NeuralProcessor, PassthroughModeSkipsPreprocessing) {
  NeuralProcessor processor;
  // Build a small "pre-computed mel" buffer and ensure passthrough
  // reshapes it into mel-major layout without throwing or zero-padding
  // the live frames.
  const uint32_t T = 32;
  const uint32_t C = 64;
  auto signal = createTestSignal(T, C);

  auto result = processor.processToMel(signal, /*dayIdx=*/-1);
  EXPECT_EQ(result.size(),
            static_cast<size_t>(NeuralProcessor::K_WHISPER_MEL_FRAMES) *
            NeuralProcessor::K_WHISPER_N_MEL);

  // First frame, first bin should match the test signal's (t=0, c=0) value
  // after the mel-major transpose: data[bin * n_frames + frame].
  const int nFrames = NeuralProcessor::K_WHISPER_MEL_FRAMES;
  const float* originalData = reinterpret_cast<const float*>(
      signal.data() + 2 * sizeof(uint32_t));
  EXPECT_FLOAT_EQ(result[0 * nFrames + 0], originalData[0 * C + 0]);
  EXPECT_FLOAT_EQ(result[1 * nFrames + 0], originalData[0 * C + 1]);
}
