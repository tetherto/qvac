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
#include <fstream>
#include <memory>
#include <stdexcept>
#include <string>
#include <system_error>
#include <vector>

#include <gtest/gtest.h>
#include <tts-cpp/cosyvoice/engine.h>

#include "inference-addon-cpp/Errors.hpp"
#include "model-interface/cosyvoice/CosyvoiceConfig.hpp"
#include "model-interface/cosyvoice/CosyvoiceModel.hpp"

using qvac::ttsggml::cosyvoice::CosyvoiceConfig;
using qvac::ttsggml::cosyvoice::CosyvoiceModel;
using qvac::ttsggml::cosyvoice::resampleBatchOutput;
using qvac::ttsggml::cosyvoice::resolveEmittedAudio;
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

// Placeholder LavaSR GGUFs are staged outside the model dir so the latter keeps
// matching the "holds no weights" contract above.
std::filesystem::path lavasrStageDir() {
  auto dir = std::filesystem::temp_directory_path() /
             "qvac-tts-ggml-cosyvoice-tests-lavasr";
  std::filesystem::create_directories(dir);
  return dir;
}

// validateConfig only checks for presence, so a weightless file is enough to
// exercise the accept path; an actual Enhancer::load happens later, in load().
class TempGguf {
public:
  explicit TempGguf(const char* name) : path_(lavasrStageDir() / name) {
    std::ofstream(path_) << "not-a-real-gguf";
  }
  ~TempGguf() {
    std::error_code ec;
    std::filesystem::remove(path_, ec);
  }
  TempGguf(const TempGguf&) = delete;
  TempGguf& operator=(const TempGguf&) = delete;

  std::string path() const { return path_.string(); }

private:
  std::filesystem::path path_;
};

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

// The LavaSR enhancer resamples inside its overlap-reprocess window, so it
// lifts the streaming native-rate restriction above.
TEST(CosyvoiceValidate, StreamingNonNativeOutputRateAcceptedWithEnhancer) {
  const TempGguf enhancer("lavasr-enhancer.gguf");
  auto cfg = configWithExistingDir();
  cfg.streamChunkTokens = 25;
  cfg.outputSampleRate = 16000;
  cfg.enhancerGgufPath = enhancer.path();
  EXPECT_NO_THROW(CosyvoiceModel{cfg});
}

TEST(CosyvoiceValidate, NonexistentEnhancerGgufRejected) {
  auto cfg = configWithExistingDir();
  cfg.enhancerGgufPath = "/definitely/does/not/exist/lavasr-enhancer.gguf";
  EXPECT_THROW(CosyvoiceModel{cfg}, StatusError);
}

TEST(CosyvoiceValidate, NonexistentDenoiserGgufRejected) {
  auto cfg = configWithExistingDir();
  cfg.denoiserGgufPath = "/definitely/does/not/exist/lavasr-denoiser.gguf";
  EXPECT_THROW(CosyvoiceModel{cfg}, StatusError);
}

TEST(CosyvoiceValidate, EnhancerAcceptedForBatchAndStreaming) {
  const TempGguf enhancer("lavasr-enhancer.gguf");
  auto base = configWithExistingDir();
  base.enhancerGgufPath = enhancer.path();

  EXPECT_NO_THROW(CosyvoiceModel{base});

  auto streaming = base;
  streaming.streamChunkTokens = 25;
  EXPECT_NO_THROW(CosyvoiceModel{streaming});
}

// The UL-UNAS denoiser is one-shot in tts-cpp, so it stays batch-only until a
// stateful streaming denoiser lands.
TEST(CosyvoiceValidate, DenoiserAcceptedForBatchButRejectedWhileStreaming) {
  const TempGguf denoiser("lavasr-denoiser.gguf");
  auto batch = configWithExistingDir();
  batch.denoiserGgufPath = denoiser.path();
  EXPECT_NO_THROW(CosyvoiceModel{batch});

  auto streaming = batch;
  streaming.streamChunkTokens = 25;
  EXPECT_THROW(CosyvoiceModel{streaming}, StatusError);
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

// Only the streaming+enhancer path diverges from the engine's SynthesisResult,
// and getting it wrong misreports stats without failing anything, so pin all
// four combinations.
TEST(CosyvoiceStreaming, EmittedAudioFollowsWhatTheCallerReceived) {
  constexpr std::size_t kStreamed = 96000;
  constexpr std::size_t kBatch = 48000;
  constexpr int kFinalRate = 16000;
  constexpr int kBatchRate = 24000;

  const auto batchPlain = resolveEmittedAudio(
      false, false, kFinalRate, kStreamed, kBatch, kBatchRate);
  EXPECT_EQ(batchPlain.samples, kBatch);
  EXPECT_EQ(batchPlain.sampleRate, kBatchRate);

  // Batch enhancement rewrites SynthesisResult in place, so the batch rate is
  // already the emitted one and the enhancer flag changes nothing.
  const auto batchEnhanced =
      resolveEmittedAudio(false, true, kFinalRate, kStreamed, kBatch, 48000);
  EXPECT_EQ(batchEnhanced.samples, kBatch);
  EXPECT_EQ(batchEnhanced.sampleRate, 48000);

  const auto streamPlain = resolveEmittedAudio(
      true, false, kFinalRate, kStreamed, kBatch, kBatchRate);
  EXPECT_EQ(streamPlain.samples, kStreamed);
  EXPECT_EQ(streamPlain.sampleRate, kBatchRate)
      << "unenhanced streaming emits at the engine's native rate";

  const auto streamEnhanced = resolveEmittedAudio(
      true, true, kFinalRate, kStreamed, kBatch, kBatchRate);
  EXPECT_EQ(streamEnhanced.samples, kStreamed);
  EXPECT_EQ(streamEnhanced.sampleRate, kFinalRate)
      << "the enhanced stream is emitted at the enhancer's final rate, not the "
         "native rate the SynthesisResult still reports";
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

// Ungated coverage of the batch output resampler (the tts-cpp engine ignores
// output_sample_rate, so the addon resamples the batch buffer itself). No
// weights needed — resampleBatchOutput is a free function over SynthesisResult.
TEST(CosyvoiceResample, ResamplesBatchOutputToRequestedRate) {
  tts_cpp::cosyvoice::SynthesisResult result;
  result.pcm.assign(2400, 0.0f); // 0.1 s at 24 kHz
  result.sample_rate = 24000;

  CosyvoiceConfig cfg;
  cfg.outputSampleRate = 16000;

  resampleBatchOutput(cfg, result);

  EXPECT_EQ(result.sample_rate, 16000);
  // 2400 * 16000 / 24000 == 1600 (allow small rounding slack).
  EXPECT_NEAR(static_cast<double>(result.pcm.size()), 1600.0, 2.0);
}

TEST(CosyvoiceResample, NoopWhenOutputRateMatchesOrUnset) {
  // Unset outputSampleRate: no-op.
  {
    tts_cpp::cosyvoice::SynthesisResult result;
    result.pcm.assign(2400, 0.0f);
    result.sample_rate = 24000;
    CosyvoiceConfig cfg; // outputSampleRate unset
    resampleBatchOutput(cfg, result);
    EXPECT_EQ(result.sample_rate, 24000);
    EXPECT_EQ(result.pcm.size(), 2400u);
  }
  // outputSampleRate == native rate: no-op.
  {
    tts_cpp::cosyvoice::SynthesisResult result;
    result.pcm.assign(2400, 0.0f);
    result.sample_rate = 24000;
    CosyvoiceConfig cfg;
    cfg.outputSampleRate = 24000;
    resampleBatchOutput(cfg, result);
    EXPECT_EQ(result.sample_rate, 24000);
    EXPECT_EQ(result.pcm.size(), 2400u);
  }
}

// Ungated coverage that setConfig re-validates (the reload path cannot bypass
// validateConfig). A valid modelDir lets the ctor succeed without loading
// weights; a subsequent invalid setConfig must throw and leave cfg_ untouched.
TEST(CosyvoiceSetConfig, RejectsInvalidConfigAndKeepsPrevious) {
  const auto dir = std::filesystem::temp_directory_path() /
                   "qvac-tts-ggml-cosyvoice-setcfg-test";
  std::filesystem::remove_all(dir);
  std::filesystem::create_directories(dir);

  CosyvoiceConfig good;
  good.modelDir = dir.string();
  CosyvoiceModel model(good);
  EXPECT_FALSE(model.config().streamChunkTokens.has_value());

  CosyvoiceConfig bad = good;
  bad.streamChunkTokens = -1; // invalid: must be >= 0
  EXPECT_THROW(model.setConfig(bad), StatusError);

  // The rejected setConfig must not have mutated cfg_.
  EXPECT_EQ(model.config().modelDir, dir.string());
  EXPECT_FALSE(model.config().streamChunkTokens.has_value());

  std::filesystem::remove_all(dir);
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

// The enhancer loads after the engine, so a failure there must not leave the
// model looking loaded: isLoaded() reads engine_ alone, and loadLocked()
// returns early when it is set, which would turn the retry into a no-op that
// silently synthesizes unenhanced audio.
TEST(CosyvoiceRealGguf, FailedEnhancerLoadLeavesModelUnloaded) {
  const auto dir = envOrEmpty("QVAC_TEST_COSYVOICE_MODEL_DIR");
  if (dir.empty())
    GTEST_SKIP() << "Set QVAC_TEST_COSYVOICE_MODEL_DIR to enable.";

  TempGguf invalidEnhancer("cosyvoice-invalid-enhancer.gguf");
  CosyvoiceConfig cfg;
  cfg.modelDir = dir;
  cfg.enhancerGgufPath = invalidEnhancer.path();
  CosyvoiceModel m(cfg);

  EXPECT_ANY_THROW(m.load());
  EXPECT_FALSE(m.isLoaded()) << "a half-loaded model must not report loaded";
  EXPECT_ANY_THROW(m.load()) << "the retry must fail rather than no-op";
  EXPECT_FALSE(m.isLoaded());
}
