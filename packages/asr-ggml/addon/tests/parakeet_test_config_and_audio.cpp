#include <cstdint>
#include <vector>

#include <gtest/gtest.h>

#include "model-interface/ParakeetTypes.hpp"
#include "model-interface/parakeet/ParakeetConfig.hpp"
#include "model-interface/parakeet/ParakeetModel.hpp"

using namespace qvac::asrggml::parakeet;

namespace {

ParakeetConfig makeCpuTestConfig() {
  ParakeetConfig cfg;
  cfg.modelType = ModelType::TDT;
  cfg.maxThreads = 2;
  cfg.useGPU = false;
  cfg.sampleRate = 16000;
  cfg.channels = 1;
  return cfg;
}

} // namespace

TEST(ParakeetStreamingConfig, DefaultsUseNamedConstants) {
  ParakeetConfig c;
  EXPECT_EQ(c.streamingChunkMs, 0);
  EXPECT_EQ(c.streamingHistoryMs, ParakeetConfig::DEFAULT_STREAMING_HISTORY_MS);
  EXPECT_EQ(
      c.streamingSpkCacheLen, ParakeetConfig::DEFAULT_STREAMING_SPK_CACHE_LEN);
  EXPECT_EQ(c.streamingFifoLen, ParakeetConfig::DEFAULT_STREAMING_FIFO_LEN);
  EXPECT_EQ(
      c.streamingChunkLeftContextMs,
      ParakeetConfig::DEFAULT_STREAMING_CHUNK_LEFT_CONTEXT_MS);
  EXPECT_EQ(
      c.streamingChunkRightContextMs,
      ParakeetConfig::DEFAULT_STREAMING_CHUNK_RIGHT_CONTEXT_MS);
  EXPECT_EQ(
      c.streamingSpkCacheUpdatePeriod,
      ParakeetConfig::DEFAULT_STREAMING_SPK_CACHE_UPDATE_PERIOD);
}

TEST(ParakeetStreamingGetters, ResolveDefaultsByDetectedModelType) {
  ParakeetConfig c = makeCpuTestConfig();
  c.streamingChunkMs = 0;
  c.streamingHistoryMs = -1;
  ParakeetModel m(c);
  EXPECT_EQ(
      m.getStreamingChunkMs(), ParakeetConfig::DEFAULT_STREAMING_CHUNK_MS);
  EXPECT_EQ(
      m.getStreamingHistoryMs(), ParakeetConfig::DEFAULT_STREAMING_HISTORY_MS);

  c.modelType = ModelType::NEMOTRON;
  ParakeetModel nemotron(c);
  EXPECT_EQ(
      nemotron.getStreamingChunkMs(),
      ParakeetConfig::DEFAULT_NEMOTRON_STREAMING_CHUNK_MS);
}

TEST(ParakeetStreamingGetters, HonourPositiveOverrides) {
  ParakeetConfig c = makeCpuTestConfig();
  c.streamingChunkMs = 1234;
  c.streamingHistoryMs = 5678;
  ParakeetModel m(c);
  EXPECT_EQ(m.getStreamingChunkMs(), 1234);
  EXPECT_EQ(m.getStreamingHistoryMs(), 5678);
}

TEST(ParakeetStreamingGetters, PreserveNemotronOperatingPointOverrides) {
  for (const int chunkMs : {80, 160, 320, 560, 1120}) {
    EXPECT_EQ(
        ParakeetModel::resolveStreamingChunkMs(ModelType::NEMOTRON, chunkMs),
        chunkMs);
  }

  // Validation belongs to speech-cpp; do not silently coerce invalid values.
  EXPECT_EQ(
      ParakeetModel::resolveStreamingChunkMs(ModelType::NEMOTRON, 2000), 2000);
}

TEST(ParakeetPreprocessAudio, S16LeHandlesRangeExtremes) {
  std::vector<uint8_t> raw = {0x00, 0x00, 0x00, 0x80, 0xFF, 0x7F};
  auto out = ParakeetModel::preprocessAudioData(raw, "s16le");
  ASSERT_EQ(out.size(), 3U);
  EXPECT_NEAR(out[0], 0.0F, 1e-6F);
  EXPECT_NEAR(out[1], -1.0F, 1e-6F);
  EXPECT_NEAR(out[2], 32767.0F / 32768.0F, 1e-6F);
}
