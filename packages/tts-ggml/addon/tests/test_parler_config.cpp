// Constructor-validation + description-resolution tests for ParlerModel.
// Same shape as test_supertonic_config.cpp: validateConfig is driven via
// the public constructor; resolveDescription is public static.
//
// Real-GGUF round-trip is gated behind QVAC_TEST_PARLER_GGUF.

#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <random>
#include <stdexcept>
#include <string>
#include <system_error>
#include <variant>

#include <gtest/gtest.h>

#include "inference-addon-cpp/Errors.hpp"
#include "model-interface/BackendUtils.hpp"
#include "model-interface/parler/ParlerConfig.hpp"
#include "model-interface/parler/ParlerModel.hpp"

using qvac::ttsggml::kBackendDeviceNone;
using qvac::ttsggml::kBackendIdNone;
using qvac::ttsggml::parler::kParlerNativeSampleRate;
using qvac::ttsggml::parler::ParlerConfig;
using qvac::ttsggml::parler::ParlerDescriptionFields;
using qvac::ttsggml::parler::ParlerModel;
using qvac_errors::StatusError;

namespace {

constexpr const char* FALLBACK_CAPTION =
    "The speaker speaks naturally. "
    "The recording is very high quality with no background noise.";

constexpr const char* STUB_DIR_PREFIX = "qvac-tts-ggml-parler-tests-";
constexpr const char* STUB_CONTENTS = "stub";

// The directory name carries entropy because CI shares one /tmp across parallel
// self-hosted runners: a fixed name is created by whichever job runs first and
// is then unwritable by the rest, which silently drops every later stub write.
std::filesystem::path createStubDir() {
  std::random_device entropy;
  auto dir = std::filesystem::temp_directory_path() /
             (std::string(STUB_DIR_PREFIX) + std::to_string(entropy()));
  std::filesystem::create_directories(dir);
  return dir;
}

class StubDir {
public:
  StubDir() : path_(createStubDir()) {}
  ~StubDir() {
    std::error_code ignored;
    std::filesystem::remove_all(path_, ignored);
  }
  StubDir(const StubDir&) = delete;
  StubDir& operator=(const StubDir&) = delete;

  const std::filesystem::path& path() const { return path_; }

private:
  std::filesystem::path path_;
};

const std::filesystem::path& stubDir() {
  static const StubDir dir;
  return dir.path();
}

std::filesystem::path tempPath(const std::string& suffix) {
  return stubDir() / suffix;
}

std::string envOrEmpty(const char* name) {
  if (const char* v = std::getenv(name))
    return v;
  return "";
}

std::string writeStub(const std::string& name) {
  const auto path = tempPath(name);
  std::ofstream out(path, std::ios::binary);
  out << STUB_CONTENTS;
  out.close();
  if (!out || !std::filesystem::exists(path)) {
    throw std::runtime_error(
        "test setup: could not write stub file " + path.string());
  }
  return path.string();
}

ParlerConfig minimallyValidStubConfig() {
  ParlerConfig cfg;
  cfg.modelGgufPath = writeStub("parler-stub.gguf");
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
  cfg.outputSampleRate = kParlerNativeSampleRate; // native — allowed
  EXPECT_NO_THROW(ParlerModel{cfg});
  cfg.outputSampleRate = 0; // native default — allowed
  EXPECT_NO_THROW(ParlerModel{cfg});
  cfg.outputSampleRate.reset(); // unset — allowed
  EXPECT_NO_THROW(ParlerModel{cfg});
}

// ─────────────────────────────────────────────────────────────────────
//  LavaSR enhancer / denoiser configuration.
// ─────────────────────────────────────────────────────────────────────

TEST(ParlerLavasr, MissingEnhancerGgufRejected) {
  auto cfg = minimallyValidStubConfig();
  cfg.enhancerGgufPath = "/definitely/does/not/exist/enhancer.gguf";
  EXPECT_THROW(ParlerModel{cfg}, StatusError);
}

TEST(ParlerLavasr, MissingDenoiserGgufRejected) {
  auto cfg = minimallyValidStubConfig();
  cfg.denoiserGgufPath = "/definitely/does/not/exist/denoiser.gguf";
  EXPECT_THROW(ParlerModel{cfg}, StatusError);
}

TEST(ParlerLavasr, ExistingEnhancerAndDenoiserAccepted) {
  // Validation only checks the paths exist; the GGUFs are parsed on load().
  auto cfg = minimallyValidStubConfig();
  cfg.enhancerGgufPath = writeStub("parler-enhancer-stub.gguf");
  cfg.denoiserGgufPath = writeStub("parler-denoiser-stub.gguf");
  EXPECT_NO_THROW(ParlerModel{cfg});
}

TEST(ParlerLavasr, DenoiserWithStreamingRejected) {
  // tts-cpp only exposes a one-shot denoise(), so streaming denoise would drop
  // the stage silently; reject the combination instead.
  auto cfg = minimallyValidStubConfig();
  cfg.denoiserGgufPath = writeStub("parler-denoiser-stub.gguf");
  cfg.streamChunkTokens = 40;
  EXPECT_THROW(ParlerModel{cfg}, StatusError);
  cfg.streamChunkTokens = 0; // batch — allowed
  EXPECT_NO_THROW(ParlerModel{cfg});
}

TEST(ParlerLavasr, EnhancerWithStreamingAccepted) {
  // StreamingEnhancer makes per-chunk enhancement seam-free, so unlike the
  // denoiser the enhancer composes with native chunk streaming.
  auto cfg = minimallyValidStubConfig();
  cfg.enhancerGgufPath = writeStub("parler-enhancer-stub.gguf");
  cfg.streamChunkTokens = 40;
  EXPECT_NO_THROW(ParlerModel{cfg});
}

TEST(ParlerLavasr, EnhancerLiftsStreamingOutputRateRestriction) {
  // Without the enhancer a non-native rate while streaming is rejected; with it
  // StreamingEnhancer resamples inside its overlap windows, so seams survive.
  auto cfg = minimallyValidStubConfig();
  cfg.streamChunkTokens = 40;
  cfg.outputSampleRate = 16000;
  EXPECT_THROW(ParlerModel{cfg}, StatusError);
  cfg.enhancerGgufPath = writeStub("parler-enhancer-stub.gguf");
  EXPECT_NO_THROW(ParlerModel{cfg});
}

TEST(ParlerLavasr, DefaultsDisableBothStages) {
  ParlerConfig cfg;
  EXPECT_TRUE(cfg.enhancerGgufPath.empty());
  EXPECT_TRUE(cfg.denoiserGgufPath.empty());
}

TEST(ParlerLavasr, StatsExposeEnhancerBackendSentinels) {
  // No enhancer loaded -> the kBackend*None sentinels (-1), so a host can tell
  // "no enhancer" apart from "enhancer ran on the CPU" (0).
  auto cfg = minimallyValidStubConfig();
  ParlerModel m(cfg);
  const auto stats = m.runtimeStats();
  const auto find = [&stats](const std::string& key) -> int64_t {
    for (const auto& entry : stats) {
      if (entry.first == key)
        return std::get<int64_t>(entry.second);
    }
    ADD_FAILURE() << "missing runtimeStats key: " << key;
    return 0;
  };
  EXPECT_EQ(find("enhancerBackendDevice"), kBackendDeviceNone);
  EXPECT_EQ(find("enhancerBackendId"), kBackendIdNone);
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
  EXPECT_EQ(ParlerModel::resolveDescription(desc), FALLBACK_CAPTION);
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

// A post-processing stage that fails to load must not leave the engine
// installed: isLoaded() would report success and load() would early-return, so
// the caller would synthesize without the enhancement it asked for.
TEST(ParlerRealGguf, FailedEnhancerLoadLeavesModelUnloaded) {
  const auto path = envOrEmpty("QVAC_TEST_PARLER_GGUF");
  if (path.empty() || !std::filesystem::exists(path)) {
    GTEST_SKIP() << "Set QVAC_TEST_PARLER_GGUF to enable.";
  }

  ParlerConfig cfg;
  cfg.modelGgufPath = path;
  cfg.desc.voice = "Laura";
  cfg.enhancerGgufPath = writeStub("parler-unparseable-enhancer.gguf");

  ParlerModel m(cfg);
  EXPECT_THROW(m.load(), StatusError);
  EXPECT_FALSE(m.isLoaded());
  EXPECT_THROW(m.load(), StatusError);
}

TEST(ParlerRealGguf, FailedDenoiserLoadLeavesModelUnloaded) {
  const auto path = envOrEmpty("QVAC_TEST_PARLER_GGUF");
  if (path.empty() || !std::filesystem::exists(path)) {
    GTEST_SKIP() << "Set QVAC_TEST_PARLER_GGUF to enable.";
  }

  ParlerConfig cfg;
  cfg.modelGgufPath = path;
  cfg.desc.voice = "Laura";
  cfg.denoiserGgufPath = writeStub("parler-unparseable-denoiser.gguf");

  ParlerModel m(cfg);
  EXPECT_THROW(m.load(), StatusError);
  EXPECT_FALSE(m.isLoaded());
  EXPECT_THROW(m.load(), StatusError);
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
