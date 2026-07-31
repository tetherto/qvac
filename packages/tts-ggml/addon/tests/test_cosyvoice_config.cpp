// Constructor-validation + real-GGUF round-trip tests for CosyvoiceModel.
//
// Same shape as test_supertonic_config.cpp: validateConfig is private so we
// drive it indirectly via the public constructor and assert the throw path.
// The CosyVoice3 engine requires real weights (LM + flow + HiFT + voice +
// tokenizer), so load()/synthesize round-trips are gated behind
// QVAC_TEST_COSYVOICE_MODEL_DIR (a directory assembled by
// tts-cpp/scripts/assemble-cosyvoice3-model.py); without it, load() must throw.

#include <any>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include <gtest/gtest.h>

#include "inference-addon-cpp/Errors.hpp"
#include "model-interface/cosyvoice/CosyvoiceConfig.hpp"
#include "model-interface/cosyvoice/CosyvoiceModel.hpp"

using qvac::ttsggml::cosyvoice::CosyvoiceConfig;
using qvac::ttsggml::cosyvoice::CosyvoiceModel;
using qvac::ttsggml::cosyvoice::streamingRequested;
using qvac_errors::StatusError;

namespace {

std::string envOrEmpty(const char* name) {
  if (const char* v = std::getenv(name))
    return v;
  return "";
}

// A directory that exists but holds no CosyVoice3 weights: construction (which
// only validates the directory exists) succeeds, but load() must fail because
// the engine can't resolve the LM/flow/HiFT/voice/tokenizer components.
std::filesystem::path emptyModelDir() {
  auto dir =
      std::filesystem::temp_directory_path() / "qvac-tts-ggml-cosyvoice-tests";
  std::filesystem::create_directories(dir);
  return dir;
}

CosyvoiceConfig configWithExistingDir() {
  CosyvoiceConfig cfg;
  cfg.modelDir = emptyModelDir().string();
  return cfg;
}

} // namespace

TEST(CosyvoiceValidate, EmptyConfigRejected) {
  CosyvoiceConfig cfg;
  EXPECT_THROW(CosyvoiceModel{cfg}, StatusError);
}

TEST(CosyvoiceValidate, NonexistentModelDirRejected) {
  CosyvoiceConfig cfg;
  cfg.modelDir = "/definitely/does/not/exist/cosyvoice3";
  EXPECT_THROW(CosyvoiceModel{cfg}, StatusError);
}

TEST(CosyvoiceValidate, NonexistentReferenceAudioRejected) {
  auto cfg = configWithExistingDir();
  cfg.referenceAudio = "/definitely/does/not/exist/ref.wav";
  EXPECT_THROW(CosyvoiceModel{cfg}, StatusError);
}

TEST(CosyvoiceValidate, NegativeCfmStepsRejected) {
  auto cfg = configWithExistingDir();
  cfg.cfmSteps = -1;
  EXPECT_THROW(CosyvoiceModel{cfg}, StatusError);
}

TEST(CosyvoiceValidate, UseGpuNGpuLayersConflictRejected) {
  auto cfg = configWithExistingDir();
  cfg.useGpu = true;
  cfg.nGpuLayers = 0;
  EXPECT_THROW(CosyvoiceModel{cfg}, StatusError);
}

TEST(CosyvoiceValidate, NegativeStreamTokensRejected) {
  auto base = configWithExistingDir();

  auto chunk = base;
  chunk.streamChunkTokens = -1;
  EXPECT_THROW(CosyvoiceModel{chunk}, StatusError);

  auto first = base;
  first.streamFirstChunkTokens = -1;
  EXPECT_THROW(CosyvoiceModel{first}, StatusError);

  auto left = base;
  left.streamLeftContextTokens = -1;
  EXPECT_THROW(CosyvoiceModel{left}, StatusError);
}

TEST(CosyvoiceValidate, StreamingNonNativeOutputRateRejected) {
  auto cfg = configWithExistingDir();
  cfg.streamChunkTokens = 25;
  cfg.outputSampleRate = 16000; // non-native while streaming
  EXPECT_THROW(CosyvoiceModel{cfg}, StatusError);
}

// Ungated coverage of the wasStreaming decision (the double-emit fix):
// streaming requires BOTH streamChunkTokens>0 and a chunk sink. No weights
// needed.
TEST(CosyvoiceStreaming, StreamingRequestedContract) {
  CosyvoiceConfig cfgWithChunks;
  cfgWithChunks.streamChunkTokens = 25;
  EXPECT_TRUE(streamingRequested(cfgWithChunks, true));
  EXPECT_FALSE(streamingRequested(cfgWithChunks, false));

  CosyvoiceConfig cfgNoChunks;
  EXPECT_FALSE(streamingRequested(cfgNoChunks, true));

  CosyvoiceConfig cfgZeroChunks;
  cfgZeroChunks.streamChunkTokens = 0;
  EXPECT_FALSE(streamingRequested(cfgZeroChunks, true));
}

TEST(CosyvoiceValidate, ConfigDefaultsAreCpuFriendly) {
  CosyvoiceConfig cfg;
  EXPECT_EQ(cfg.language, "en");
  EXPECT_FALSE(cfg.useGpu.has_value());
  EXPECT_FALSE(cfg.nGpuLayers.has_value());
  EXPECT_FALSE(cfg.cfmSteps.has_value());
  EXPECT_FALSE(cfg.streamChunkTokens.has_value());
}

TEST(CosyvoiceModelLifecycle, ConstructDefersLoad) {
  auto cfg = configWithExistingDir();
  CosyvoiceModel m(cfg);
  EXPECT_EQ(m.getName(), "CosyvoiceModel");
  EXPECT_FALSE(m.isLoaded()) << "load is deferred until activate()/load()";
}

TEST(CosyvoiceModelLifecycle, LoadWithoutWeightsThrows) {
  // A directory with no CosyVoice3 GGUFs: the engine can't resolve its
  // components, so the deferred load must raise (not silently succeed).
  auto cfg = configWithExistingDir();
  CosyvoiceModel m(cfg);
  EXPECT_THROW(m.load(), StatusError);
  EXPECT_FALSE(m.isLoaded());
}

TEST(CosyvoiceModelLifecycle, ProcessRejectsWrongAnyInputType) {
  // The input-type check happens before any engine work, so this needs no
  // weights: a non-AnyInput payload is rejected up front.
  auto cfg = configWithExistingDir();
  CosyvoiceModel m(cfg);
  EXPECT_THROW(m.process(std::any{int64_t{42}}), StatusError);
}

// ---- Real-GGUF round-trips (opt-in) -------------------------------------
// Set QVAC_TEST_COSYVOICE_MODEL_DIR to a directory holding
// cosyvoice3-{llm,flow,hift}*.gguf + voice.gguf + vocab.json + merges.txt.

TEST(CosyvoiceRealGguf, ConstructLoadSynthesizeUnload) {
  const auto dir = envOrEmpty("QVAC_TEST_COSYVOICE_MODEL_DIR");
  if (dir.empty())
    GTEST_SKIP() << "Set QVAC_TEST_COSYVOICE_MODEL_DIR to enable.";

  CosyvoiceConfig cfg;
  cfg.modelDir = dir;
  CosyvoiceModel m(cfg);
  EXPECT_FALSE(m.isLoaded());
  ASSERT_NO_THROW(m.load());
  EXPECT_TRUE(m.isLoaded());
  EXPECT_EQ(m.sampleRate(), 24000);

  CosyvoiceModel::AnyInput input;
  input.text = "Hello from a fully on device pipeline.";
  std::any out;
  ASSERT_NO_THROW(out = m.process(std::any(input)));
  const auto* pcm = std::any_cast<std::vector<int16_t>>(&out);
  ASSERT_NE(pcm, nullptr);
  EXPECT_GT(pcm->size(), 0u);

  EXPECT_NO_THROW(m.unload());
  EXPECT_FALSE(m.isLoaded());
}

TEST(CosyvoiceRealGguf, StreamingDeliversChunks) {
  const auto dir = envOrEmpty("QVAC_TEST_COSYVOICE_MODEL_DIR");
  if (dir.empty())
    GTEST_SKIP() << "Set QVAC_TEST_COSYVOICE_MODEL_DIR to enable.";

  CosyvoiceConfig cfg;
  cfg.modelDir = dir;
  cfg.streamChunkTokens = 25;      // ~1 s hops
  cfg.streamFirstChunkTokens = 10; // smaller first chunk
  CosyvoiceModel m(cfg);
  m.load();

  int chunks = 0;
  bool sawLast = false;
  size_t streamedSamples = 0;
  CosyvoiceModel::AnyInput input;
  input.text = "Streaming synthesis over several chunks.";
  input.chunkCallback = [&](std::vector<int16_t>&& pcm, int idx, bool isLast) {
    EXPECT_EQ(idx, chunks);
    streamedSamples += pcm.size();
    ++chunks;
    if (isLast)
      sawLast = true;
  };

  std::any out;
  ASSERT_NO_THROW(out = m.process(std::any(std::move(input))));
  EXPECT_GT(chunks, 1) << "expected multiple streaming chunks";
  EXPECT_TRUE(sawLast);
  EXPECT_GT(streamedSamples, 0u) << "chunks carried PCM";

  // Streaming publishes its audio via the chunk callback; process() must NOT
  // also return a full buffer (that would duplicate as a final outputArray
  // event). The returned std::any is empty.
  EXPECT_FALSE(out.has_value())
      << "streaming process() returns no batch buffer";
}
