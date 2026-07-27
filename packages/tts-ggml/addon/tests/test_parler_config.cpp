// Constructor-validation + description-resolution tests for ParlerModel.
// Same shape as test_supertonic_config.cpp: validateConfig is driven via
// the public constructor; resolveDescription is public static.
//
// Real-GGUF round-trip is gated behind QVAC_TEST_PARLER_GGUF.

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>

#include <gtest/gtest.h>

#include "inference-addon-cpp/Errors.hpp"
#include "model-interface/parler/ParlerConfig.hpp"
#include "model-interface/parler/ParlerModel.hpp"

using qvac::ttsggml::parler::ParlerConfig;
using qvac::ttsggml::parler::ParlerDescriptionFields;
using qvac::ttsggml::parler::ParlerModel;
using qvac_errors::StatusError;

namespace {

const char* kFallbackCaption =
    "The speaker speaks naturally. "
    "The recording is very high quality with no background noise.";

std::filesystem::path tempPath(const std::string& suffix) {
  auto dir =
      std::filesystem::temp_directory_path() / "qvac-tts-ggml-parler-tests";
  std::filesystem::create_directories(dir);
  return dir / suffix;
}

std::string envOrEmpty(const char* name) {
  if (const char* v = std::getenv(name))
    return v;
  return "";
}

ParlerConfig minimallyValidStubConfig() {
  ParlerConfig cfg;
  cfg.modelGgufPath = tempPath("parler-stub.gguf").string();
  std::ofstream(cfg.modelGgufPath, std::ios::binary) << "stub";
  return cfg;
}

} // namespace

TEST(ParlerValidate, EmptyModelPathRejected) {
  ParlerConfig cfg;
  EXPECT_THROW(ParlerModel{cfg}, StatusError);
}

TEST(ParlerValidate, NonexistentModelPathRejected) {
  ParlerConfig cfg;
  cfg.modelGgufPath = "/definitely/does/not/exist/parler.gguf";
  EXPECT_THROW(ParlerModel{cfg}, StatusError);
}

TEST(ParlerValidate, NegativeTemperatureRejected) {
  auto cfg = minimallyValidStubConfig();
  cfg.temperature = -0.1f;
  EXPECT_THROW(ParlerModel{cfg}, StatusError);
}

TEST(ParlerValidate, NegativeTopKRejected) {
  auto cfg = minimallyValidStubConfig();
  cfg.topK = -1;
  EXPECT_THROW(ParlerModel{cfg}, StatusError);
}

TEST(ParlerValidate, TopPOutOfRangeRejected) {
  auto cfg = minimallyValidStubConfig();
  cfg.topP = 0.0f;
  EXPECT_THROW(ParlerModel{cfg}, StatusError);
  cfg.topP = 1.5f;
  EXPECT_THROW(ParlerModel{cfg}, StatusError);
}

TEST(ParlerValidate, MaxFramesBand) {
  auto cfg = minimallyValidStubConfig();
  cfg.maxFrames = 5; // under the delay-pattern warmup — silence, reject
  EXPECT_THROW(ParlerModel{cfg}, StatusError);
  cfg.maxFrames = -1;
  EXPECT_THROW(ParlerModel{cfg}, StatusError);
  cfg.maxFrames = 0; // model default
  EXPECT_NO_THROW(ParlerModel{cfg});
  cfg.maxFrames = 10;
  EXPECT_NO_THROW(ParlerModel{cfg});
}

TEST(ParlerValidate, MinNewTokensBand) {
  auto cfg = minimallyValidStubConfig();
  cfg.minNewTokens = -2;
  EXPECT_THROW(ParlerModel{cfg}, StatusError);
  cfg.minNewTokens = -1; // model default
  EXPECT_NO_THROW(ParlerModel{cfg});
}

TEST(ParlerValidate, OutputSampleRateBand) {
  auto cfg = minimallyValidStubConfig();
  cfg.outputSampleRate = 4000;
  EXPECT_THROW(ParlerModel{cfg}, StatusError);
  cfg.outputSampleRate = 0; // native rate
  EXPECT_NO_THROW(ParlerModel{cfg});
  cfg.outputSampleRate = 16000;
  EXPECT_NO_THROW(ParlerModel{cfg});
}

TEST(ParlerValidate, StreamChunkTokensNonNegative) {
  auto cfg = minimallyValidStubConfig();
  cfg.streamChunkTokens = -1;
  EXPECT_THROW(ParlerModel{cfg}, StatusError);
  cfg.streamChunkTokens = 40; // native streaming enabled
  EXPECT_NO_THROW(ParlerModel{cfg});
  cfg.streamChunkTokens.reset();
  cfg.streamFirstChunkTokens = -1;
  EXPECT_THROW(ParlerModel{cfg}, StatusError);
}

TEST(ParlerValidate, StreamingRejectsNonNativeOutputSampleRate) {
  // Native streaming emits at 44100 Hz; a non-native output rate would need
  // seam-preserving per-chunk resampling the parler engine cannot do.
  auto cfg = minimallyValidStubConfig();
  cfg.streamChunkTokens = 40;
  cfg.outputSampleRate = 16000;
  EXPECT_THROW(ParlerModel{cfg}, StatusError);
  cfg.outputSampleRate = 44100; // native — allowed
  EXPECT_NO_THROW(ParlerModel{cfg});
  cfg.outputSampleRate = 0; // native default — allowed
  EXPECT_NO_THROW(ParlerModel{cfg});
  cfg.outputSampleRate.reset(); // unset — allowed
  EXPECT_NO_THROW(ParlerModel{cfg});
}

TEST(ParlerValidate, UseGpuTrueAcceptedAtConstruction) {
  // GPU intent is honored on GPU-capable hosts (Metal on Apple; other backends
  // fall back to CPU). Construction must NOT reject useGpu=true -- the GGUF
  // parse is deferred to load(), so a bare stub config validates cleanly.
  auto cfg = minimallyValidStubConfig();
  cfg.useGpu = true;
  EXPECT_NO_THROW(ParlerModel{cfg});
}

TEST(ParlerValidate, NGpuLayersGreaterThanZeroAccepted) {
  auto cfg = minimallyValidStubConfig();
  cfg.nGpuLayers = 99;
  EXPECT_NO_THROW(ParlerModel{cfg});
}

TEST(ParlerValidate, UseGpuNGpuLayersConflictRejected) {
  // Cross-field conflict: useGPU=true + nGpuLayers=0 (or useGPU=false +
  // nGpuLayers!=0) is contradictory and must throw so callers can't silently
  // get the opposite backend they asked for.
  auto cfg = minimallyValidStubConfig();
  cfg.useGpu = true;
  cfg.nGpuLayers = 0;
  EXPECT_THROW(ParlerModel{cfg}, StatusError);
  cfg.useGpu = false;
  cfg.nGpuLayers = 99;
  EXPECT_THROW(ParlerModel{cfg}, StatusError);
}

TEST(ParlerValidate, NGpuLayersZeroAcceptedAndDeferredLoad) {
  auto cfg = minimallyValidStubConfig();
  cfg.nGpuLayers = 0;
  // Validation passes (CPU path); the stub then fails GGUF parsing on load()
  // (not the conflict branch -- construction is deferred to load()).
  std::unique_ptr<ParlerModel> m;
  EXPECT_NO_THROW(m = std::make_unique<ParlerModel>(cfg));
  ASSERT_NE(m, nullptr);
  EXPECT_FALSE(m->isLoaded());
  EXPECT_THROW(m->load(), StatusError);
  EXPECT_FALSE(m->isLoaded());
}

TEST(ParlerValidate, DescriptionTemplateConflictRejected) {
  auto cfg = minimallyValidStubConfig();
  cfg.desc.description = "A calm female voice, close up.";
  cfg.desc.voice = "Rohit";
  EXPECT_THROW(ParlerModel{cfg}, StatusError);
}

TEST(ParlerValidate, DescriptionAloneAccepted) {
  auto cfg = minimallyValidStubConfig();
  cfg.desc.description = "A calm female voice, close up.";
  EXPECT_NO_THROW(ParlerModel{cfg});
}

TEST(ParlerValidate, TemplateFieldsAloneAccepted) {
  auto cfg = minimallyValidStubConfig();
  cfg.desc.voice = "Rohit";
  cfg.desc.emotion = "happy";
  cfg.desc.pace = "slow";
  EXPECT_NO_THROW(ParlerModel{cfg});
}

TEST(ParlerValidate, InvalidEmotionRejected) {
  auto cfg = minimallyValidStubConfig();
  cfg.desc.emotion = "angry"; // the valid value is "anger"
  EXPECT_THROW(ParlerModel{cfg}, StatusError);
}

TEST(ParlerValidate, EmotionCaseInsensitive) {
  auto cfg = minimallyValidStubConfig();
  cfg.desc.emotion = "Happy";
  EXPECT_NO_THROW(ParlerModel{cfg});
  cfg.desc.emotion = "PROPER NOUN";
  EXPECT_NO_THROW(ParlerModel{cfg});
}

TEST(ParlerValidate, ConfigDefaultsAllUnset) {
  ParlerConfig cfg;
  EXPECT_FALSE(cfg.seed.has_value());
  EXPECT_FALSE(cfg.threads.has_value());
  EXPECT_FALSE(cfg.temperature.has_value());
  EXPECT_FALSE(cfg.topK.has_value());
  EXPECT_FALSE(cfg.topP.has_value());
  EXPECT_FALSE(cfg.maxFrames.has_value());
  EXPECT_FALSE(cfg.minNewTokens.has_value());
  EXPECT_FALSE(cfg.outputSampleRate.has_value());
  EXPECT_FALSE(cfg.normalizeNumbers.has_value());
  EXPECT_FALSE(cfg.nGpuLayers.has_value());
  EXPECT_FALSE(cfg.useGpu.has_value());
}

// ─────────────────────────────────────────────────────────────────────
//  Description resolution (config/per-call → engine description text).
// ─────────────────────────────────────────────────────────────────────

TEST(ParlerDescription, AllDefaultsRenderFallbackCaption) {
  ParlerDescriptionFields desc;
  EXPECT_EQ(ParlerModel::resolveDescription(desc), kFallbackCaption);
}

TEST(ParlerDescription, ExplicitDescriptionPassesThrough) {
  ParlerDescriptionFields desc;
  desc.description = "A calm female voice, close up.";
  EXPECT_EQ(ParlerModel::resolveDescription(desc), desc.description);
}

TEST(ParlerDescription, TemplateRendersEmotionAnchor) {
  ParlerDescriptionFields desc;
  desc.voice = "Rohit";
  desc.emotion = "happy";
  EXPECT_EQ(
      ParlerModel::resolveDescription(desc),
      "Rohit speaks with a happy tone. "
      "The recording is very high quality with no background noise. "
      "The intended style is happy.");
}

TEST(ParlerDescription, ConflictThrows) {
  ParlerDescriptionFields desc;
  desc.description = "A calm female voice.";
  desc.emotion = "happy";
  EXPECT_THROW(ParlerModel::resolveDescription(desc), StatusError);
}

// ─────────────────────────────────────────────────────────────────────
//  Deferred load + real-GGUF round-trip (env-var gated).
// ─────────────────────────────────────────────────────────────────────

TEST(ParlerValidate, StubConfigDefersLoadThenFailsParse) {
  auto cfg = minimallyValidStubConfig();
  std::unique_ptr<ParlerModel> m;
  EXPECT_NO_THROW(m = std::make_unique<ParlerModel>(cfg));
  ASSERT_NE(m, nullptr);
  EXPECT_FALSE(m->isLoaded());
  EXPECT_THROW(m->load(), StatusError);
  EXPECT_FALSE(m->isLoaded());
}

TEST(ParlerRealGguf, ConstructLoadUnloadIfAvailable) {
  const auto path = envOrEmpty("QVAC_TEST_PARLER_GGUF");
  if (path.empty() || !std::filesystem::exists(path)) {
    GTEST_SKIP() << "Set QVAC_TEST_PARLER_GGUF to enable.";
  }

  ParlerConfig cfg;
  cfg.modelGgufPath = path;
  cfg.desc.voice = "Laura";

  ParlerModel m(cfg);
  EXPECT_FALSE(m.isLoaded()) << "load is deferred until activate()/load()";
  EXPECT_EQ(m.getName(), "ParlerModel");
  EXPECT_NO_THROW(m.load());
  EXPECT_TRUE(m.isLoaded());
  EXPECT_EQ(m.sampleRate(), 44100);
  EXPECT_NO_THROW(m.unload());
  EXPECT_FALSE(m.isLoaded());
}

TEST(ParlerRealGguf, ProcessRejectsWrongAnyInputType) {
  const auto path = envOrEmpty("QVAC_TEST_PARLER_GGUF");
  if (path.empty() || !std::filesystem::exists(path)) {
    GTEST_SKIP() << "Set QVAC_TEST_PARLER_GGUF to enable.";
  }

  ParlerConfig cfg;
  cfg.modelGgufPath = path;

  ParlerModel m(cfg);
  m.load();
  EXPECT_THROW(m.process(std::any{int64_t{42}}), StatusError);
}
