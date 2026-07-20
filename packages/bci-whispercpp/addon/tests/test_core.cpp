#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <limits>
#include <string>
#include <variant>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/bci/BCIConfig.hpp"
#include "model-interface/bci/BCIModel.hpp"
#include "model-interface/bci/NeuralProcessor.hpp"

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

// Deterministic pseudo-random fill so the reorder-correctness tests are
// repeatable without pulling in <random> distributions.
void fillDeterministic(std::vector<float>& v, uint32_t seed) {
  uint32_t s = seed | 1U;
  for (auto& x : v) {
    s = s * 1664525U + 1013904223U;
    x = (static_cast<float>(s >> 8) / 8388608.0F) - 1.0F; // ~[-1, 1)
  }
}

// Serialise a minimal-but-valid bci-embedder.bin so tests can exercise
// loadEmbedderWeights + applyDayProjection with fully-known weights.
// Layout mirrors NeuralProcessor::loadEmbedderWeights exactly (1 day, 1
// month, conv blocks empty since the GGML model owns them at runtime).
std::string writeSyntheticEmbedder(
    uint32_t nf, uint32_t r, const std::vector<float>& dayA,
    const std::vector<float>& dayB, const std::vector<float>& dayBias,
    const std::vector<float>& monthW, const std::vector<float>& monthBias) {
  const auto path =
      (std::filesystem::temp_directory_path() / "bci_synth_embedder.bin")
          .string();
  std::ofstream f(path, std::ios::binary);
  auto u32 = [&](uint32_t v) {
    f.write(reinterpret_cast<const char*>(&v), sizeof(v));
  };
  auto floats = [&](const std::vector<float>& v) {
    u32(static_cast<uint32_t>(v.size()));
    if (!v.empty()) {
      f.write(
          reinterpret_cast<const char*>(v.data()),
          static_cast<std::streamsize>(v.size() * sizeof(float)));
    }
  };
  u32(0x42434945U); // magic 'EICB'
  u32(1U);          // version
  u32(nf);          // numFeatures
  u32(nf);          // embedDim (skipped by loader)
  u32(3U);          // kernelSize1 (skipped)
  u32(3U);          // kernelSize2 (skipped)
  u32(2U);          // stride2 (skipped)
  u32(1U);          // numDays
  u32(1U);          // numMonths
  u32(r);           // r
  floats({});       // conv1 weight (skipped)
  floats({});       // conv1 bias (skipped)
  floats({});       // conv2 weight (skipped)
  floats({});       // conv2 bias (skipped)
  const std::vector<int32_t> sessionToDay{0};
  u32(static_cast<uint32_t>(sessionToDay.size()));
  f.write(
      reinterpret_cast<const char*>(sessionToDay.data()),
      static_cast<std::streamsize>(sessionToDay.size() * sizeof(int32_t)));
  floats(dayA);
  floats(dayB);
  floats(dayBias);
  floats(monthW);
  floats(monthBias);
  return path;
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

// gaussianSmooth must stay numerically identical to an independent
// channel-outer naive reference, guarding the vectorized loop reorder.
TEST(NeuralProcessor, GaussianSmoothMatchesNaiveReference) {
  const uint32_t T = 40;
  const uint32_t C = 6;
  const float kernelStd = 2.0F;
  const int kernelSize = 25;

  std::vector<float> data(static_cast<size_t>(T) * C);
  fillDeterministic(data, 12345U);

  // Rebuild the exact kernel + trim that gaussianSmooth uses internally so the
  // reference differs from the implementation only in loop order.
  std::vector<float> kernel(kernelSize);
  const int center = kernelSize / 2;
  float ksum = 0.0F;
  for (int i = 0; i < kernelSize; ++i) {
    const float x = static_cast<float>(i - center);
    kernel[i] = std::exp(-0.5F * (x * x) / (kernelStd * kernelStd));
    ksum += kernel[i];
  }
  for (auto& k : kernel)
    k /= ksum;
  int start = 0;
  int end = kernelSize - 1;
  while (start < end && kernel[start] < 0.01F)
    ++start;
  while (end > start && kernel[end] < 0.01F)
    --end;
  const std::vector<float> trimK(
      kernel.begin() + start, kernel.begin() + end + 1);
  const int kn = static_cast<int>(trimK.size());
  const int halfK = kn / 2;

  std::vector<float> reference(data.size(), 0.0F);
  for (uint32_t c = 0; c < C; ++c) {
    for (uint32_t t = 0; t < T; ++t) {
      float s = 0.0F;
      for (int k = 0; k < kn; ++k) {
        const int srcT = static_cast<int>(t) + k - halfK;
        if (srcT < 0 || srcT >= static_cast<int>(T))
          continue;
        s += trimK[k] * data[static_cast<size_t>(srcT) * C + c];
      }
      reference[static_cast<size_t>(t) * C + c] = s;
    }
  }

  const auto actual =
      NeuralProcessor::gaussianSmooth(data, T, C, kernelStd, kernelSize);
  ASSERT_EQ(actual.size(), reference.size());
  for (size_t i = 0; i < reference.size(); ++i) {
    EXPECT_NEAR(actual[i], reference[i], 1e-5F) << "mismatch at index " << i;
  }
}

// applyDayProjection must equal a naive per-output dot product over the
// materialized (dayA·dayB + month) weight matrix, guarding the reorder.
TEST(NeuralProcessor, DayProjectionMatchesNaiveReference) {
  const uint32_t nf = 8;
  const uint32_t r = 3;
  // T exceeds the internal parallel threshold, so the threaded band split runs
  // against the single-threaded reference.
  const uint32_t T = 200;

  std::vector<float> dayA(static_cast<size_t>(nf) * r);
  std::vector<float> dayB(static_cast<size_t>(r) * nf);
  std::vector<float> dayBias(nf);
  std::vector<float> monthW(static_cast<size_t>(nf) * nf);
  std::vector<float> monthBias(nf);
  fillDeterministic(dayA, 1U);
  fillDeterministic(dayB, 2U);
  fillDeterministic(dayBias, 3U);
  fillDeterministic(monthW, 4U);
  fillDeterministic(monthBias, 5U);

  const auto path =
      writeSyntheticEmbedder(nf, r, dayA, dayB, dayBias, monthW, monthBias);
  NeuralProcessor processor;
  ASSERT_TRUE(processor.loadEmbedderWeights(path));
  ASSERT_EQ(processor.getNumDays(), 1U);

  std::vector<float> features(static_cast<size_t>(T) * nf);
  fillDeterministic(features, 6U);

  // Naive reference: dense W = dayA·dayB + monthW (day 0 → month 0), then
  // softsign(features @ W + bias) computed one output element at a time.
  std::vector<float> W(static_cast<size_t>(nf) * nf);
  std::vector<float> bias(nf);
  for (uint32_t i = 0; i < nf; ++i) {
    for (uint32_t j = 0; j < nf; ++j) {
      float s = 0.0F;
      for (uint32_t k = 0; k < r; ++k)
        s += dayA[i * r + k] * dayB[k * nf + j];
      W[i * nf + j] = s + monthW[i * nf + j];
    }
    bias[i] = dayBias[i] + monthBias[i];
  }
  std::vector<float> reference(static_cast<size_t>(T) * nf);
  for (uint32_t t = 0; t < T; ++t) {
    for (uint32_t k = 0; k < nf; ++k) {
      float s = bias[k];
      for (uint32_t d = 0; d < nf; ++d)
        s += features[t * nf + d] * W[d * nf + k];
      reference[t * nf + k] = s / (1.0F + std::abs(s));
    }
  }

  const auto actual = processor.applyDayProjection(
      features, T, /*numChannels=*/nf, /*dayIdx=*/0);
  ASSERT_EQ(actual.size(), reference.size());
  for (size_t i = 0; i < reference.size(); ++i) {
    EXPECT_NEAR(actual[i], reference[i], 1e-5F) << "mismatch at index " << i;
  }

  std::error_code ec;
  std::filesystem::remove(path, ec);
}

// Dynamic-backend-loading plumbing. These tests exercise the pieces that
// DON'T need a loaded whisper context, so they can run in the existing
// GoogleTest binary without model fixtures or network.

TEST(BCIConfig, BackendsDirDefaultsEmpty) {
  BCIConfig config;
  EXPECT_TRUE(config.backendsDir.empty());
}

TEST(BCIConfig, BackendsDirRoundTrip) {
  BCIConfig config;
  config.backendsDir = "/tmp/some/prebuilds/path";
  EXPECT_EQ(config.backendsDir, "/tmp/some/prebuilds/path");

  BCIConfig copy = config;
  EXPECT_EQ(copy.backendsDir, "/tmp/some/prebuilds/path");
}

namespace {

const std::variant<double, int64_t>* findStat(
    const qvac_lib_inference_addon_cpp::RuntimeStats& stats,
    const std::string& key) {
  for (const auto& [name, value] : stats) {
    if (name == key) {
      return &value;
    }
  }
  return nullptr;
}

int64_t statAsInt64(
    const qvac_lib_inference_addon_cpp::RuntimeStats& stats,
    const std::string& key) {
  const auto* v = findStat(stats, key);
  if (v == nullptr) {
    ADD_FAILURE() << "RuntimeStats missing key: " << key;
    return std::numeric_limits<int64_t>::min();
  }
  if (const auto* asInt = std::get_if<int64_t>(v)) {
    return *asInt;
  }
  ADD_FAILURE() << "RuntimeStats key '" << key << "' is not int64";
  return std::numeric_limits<int64_t>::min();
}

} // namespace

TEST(BCIModel, RuntimeStatsExposesBackendIdentityKeys) {
  BCIModel model{BCIConfig{}};
  auto stats = model.runtimeStats();
  for (const auto* key :
       {"backendDevice", "backendId", "gpuMemTotalMb", "gpuMemFreeMb"}) {
    EXPECT_NE(findStat(stats, key), nullptr)
        << "RuntimeStats is missing required backend-identity key: " << key;
  }
}

TEST(BCIModel, BackendIdentityDefaultsToCPU) {
  // Pre-load() defaults reported by runtimeStats() must match the
  // post-fallback "no GPU device available / use_gpu=false" reading
  // so downstream Device-Farm assertions don't get a misleading
  // GPU-device value before the model is even initialised.
  BCIModel model{BCIConfig{}};
  auto stats = model.runtimeStats();
  EXPECT_EQ(statAsInt64(stats, "backendDevice"), 0);
  EXPECT_EQ(statAsInt64(stats, "backendId"), 0);
  EXPECT_EQ(statAsInt64(stats, "gpuMemTotalMb"), -1);
  EXPECT_EQ(statAsInt64(stats, "gpuMemFreeMb"), -1);
}
