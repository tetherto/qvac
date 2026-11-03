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
#include "model-interface/parler/ParlerEngineOptions.hpp"
#include "model-interface/parler/ParlerModel.hpp"

namespace qvac::ttsggml::parler {
struct ParlerModelTestPeer {
  static std::shared_ptr<tts_cpp::parler::Engine>
  installEngine(ParlerModel& model) {
    // Identity-only handle; completion never dereferences it or loads weights.
    auto owner = std::make_shared<int>(0);
    auto engine = std::shared_ptr<tts_cpp::parler::Engine>(
        owner, reinterpret_cast<tts_cpp::parler::Engine*>(owner.get()));
    std::lock_guard lk(model.engineMu_);
    model.engine_ = engine;
    model.decoderSidecarLoaded_ = true;
    model.dacSidecarLoaded_ = true;
    model.decoderOnCoreml_ = false;
    model.dacOnCoreml_ = false;
    return engine;
  }
  static void complete(
      ParlerModel& model,
      const std::shared_ptr<tts_cpp::parler::Engine>& engine,
      const std::string& decoder, const std::string& dac, bool decoderLoaded,
      bool dacLoaded) {
    tts_cpp::parler::SynthesisResult result;
    result.decoder_backend = decoder;
    result.dac_backend = dac;
    model.completeSynthesis(
        engine, result, 0.5, 44100, 4410, 10, decoderLoaded, dacLoaded);
  }
  static void fail(
      ParlerModel& model,
      const std::shared_ptr<tts_cpp::parler::Engine>& engine,
      bool decoderLoaded, bool dacLoaded) {
    std::lock_guard lk(model.engineMu_);
    model.recordSynthesisFailureLocked(engine, decoderLoaded, dacLoaded);
  }
};
} // namespace qvac::ttsggml::parler

using qvac::ttsggml::parler::ParlerModelTestPeer;

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

TEST(ParlerCoreml, OmittedPolicyPreservesEngineDefaults) {
  ParlerConfig cfg;
  EXPECT_FALSE(cfg.coremlDecoder.has_value());
  EXPECT_TRUE(cfg.coremlComputeUnits.empty());
  EXPECT_FALSE(cfg.coremlStrict.has_value());
  const auto options =
      qvac::ttsggml::parler::detail::engineOptionsForTests(cfg);
  const tts_cpp::parler::EngineOptions defaults;
  EXPECT_EQ(options.coreml_decoder, defaults.coreml_decoder);
  EXPECT_EQ(options.coreml_compute_units, defaults.coreml_compute_units);
  EXPECT_EQ(options.coreml_strict, defaults.coreml_strict);
}

TEST(ParlerCoreml, ExplicitPolicyReachesEngineOptionsIncludingFalse) {
  ParlerConfig cfg;
  for (const char* units : {"all", "cpu_and_ane", "cpu_and_gpu", "cpu_only"}) {
    for (const bool enabled : {true, false}) {
      cfg.coremlDecoder = enabled;
      cfg.coremlStrict = enabled;
      cfg.coremlComputeUnits = units;
      const auto options =
          qvac::ttsggml::parler::detail::engineOptionsForTests(cfg);
      EXPECT_EQ(options.coreml_decoder, enabled);
      EXPECT_EQ(options.coreml_compute_units, units);
      ASSERT_TRUE(options.coreml_strict.has_value());
      EXPECT_EQ(*options.coreml_strict, enabled);
    }
  }
}

TEST(ParlerCoreml, InvalidComputeUnitsRejectedWithoutChangingConfig) {
  auto cfg = minimallyValidStubConfig();
  cfg.coremlStrict = true;
  cfg.coremlComputeUnits = "all";
  ParlerModel model(cfg);
  auto invalid = cfg;
  invalid.coremlStrict = false;
  invalid.coremlComputeUnits = "ane";
  EXPECT_THROW(model.setConfig(invalid), StatusError);
  EXPECT_EQ(model.config().coremlStrict, cfg.coremlStrict);
  EXPECT_EQ(model.config().coremlComputeUnits, "all");
  for (const char* units : {"ALL", "ANE", "cpu", "bogus"}) {
    invalid.coremlComputeUnits = units;
    EXPECT_THROW(ParlerModel::validateConfig(invalid), StatusError);
  }
}

namespace {
int64_t runtimeInt(const ParlerModel& model, const std::string& key) {
  for (const auto& [name, value] : model.runtimeStats()) {
    if (name == key)
      return std::get<int64_t>(value);
  }
  ADD_FAILURE() << "missing runtimeStats key: " << key;
  return -1;
}
} // namespace

TEST(ParlerCoremlStats, UnloadedAndUnloadClearBothStages) {
  ParlerModel model(minimallyValidStubConfig());
  for (const auto* key :
       {"decoderSidecarLoaded",
        "dacSidecarLoaded",
        "decoderOnCoreml",
        "dacOnCoreml"}) {
    EXPECT_EQ(runtimeInt(model, key), 0);
  }
  const auto engine = ParlerModelTestPeer::installEngine(model);
  ParlerModelTestPeer::complete(
      model, engine, "coreml-all", "coreml-cpu", true, true);
  model.unload();
  for (const auto* key :
       {"decoderSidecarLoaded",
        "dacSidecarLoaded",
        "decoderOnCoreml",
        "dacOnCoreml"}) {
    EXPECT_EQ(runtimeInt(model, key), 0);
  }
}

TEST(ParlerCoremlStats, EachCallTracksIndependentStagesAndFallback) {
  ParlerModel model(minimallyValidStubConfig());
  const auto engine = ParlerModelTestPeer::installEngine(model);
  ParlerModelTestPeer::complete(
      model, engine, "coreml-all", "ggml", true, false);
  EXPECT_EQ(runtimeInt(model, "decoderOnCoreml"), 1);
  EXPECT_EQ(runtimeInt(model, "dacOnCoreml"), 0);
  EXPECT_EQ(runtimeInt(model, "decoderSidecarLoaded"), 1);
  EXPECT_EQ(runtimeInt(model, "dacSidecarLoaded"), 0);
  EXPECT_EQ(runtimeInt(model, "backendDevice"), 0);
  EXPECT_EQ(runtimeInt(model, "backendId"), 0); // host CPU is never tagged ANE

  ParlerModelTestPeer::complete(
      model, engine, "mixed", "coreml-ane", false, true);
  EXPECT_EQ(runtimeInt(model, "decoderOnCoreml"), 0);
  EXPECT_EQ(runtimeInt(model, "dacOnCoreml"), 1);
  EXPECT_EQ(runtimeInt(model, "decoderSidecarLoaded"), 0);
  EXPECT_EQ(runtimeInt(model, "dacSidecarLoaded"), 1);

  ParlerModelTestPeer::complete(model, engine, "ggml", "mixed", false, false);
  EXPECT_EQ(runtimeInt(model, "decoderOnCoreml"), 0);
  EXPECT_EQ(runtimeInt(model, "dacOnCoreml"), 0);
}

TEST(
    ParlerCoremlStats, OldCompletionCannotOverwriteReplacementOrUnloadedState) {
  ParlerModel model(minimallyValidStubConfig());
  const auto oldEngine = ParlerModelTestPeer::installEngine(model);
  model.unload();
  ParlerModelTestPeer::complete(
      model, oldEngine, "coreml-all", "coreml-all", true, true);
  EXPECT_EQ(runtimeInt(model, "decoderSidecarLoaded"), 0);
  EXPECT_EQ(runtimeInt(model, "dacSidecarLoaded"), 0);
  const auto replacement = ParlerModelTestPeer::installEngine(model);
  ParlerModelTestPeer::complete(model, oldEngine, "ggml", "ggml", false, false);
  EXPECT_EQ(runtimeInt(model, "decoderSidecarLoaded"), 1);
  EXPECT_EQ(runtimeInt(model, "dacSidecarLoaded"), 1);
  EXPECT_EQ(runtimeInt(model, "decoderOnCoreml"), 0);
  ParlerModelTestPeer::complete(
      model, replacement, "ggml", "coreml-all", false, true);
  EXPECT_EQ(runtimeInt(model, "decoderSidecarLoaded"), 0);
  EXPECT_EQ(runtimeInt(model, "dacSidecarLoaded"), 1);
  EXPECT_EQ(runtimeInt(model, "dacOnCoreml"), 1);
}

TEST(
    ParlerCoremlStats, FailureRefreshesAvailabilityAndClearsPreviousCallFlags) {
  ParlerModel model(minimallyValidStubConfig());
  const auto engine = ParlerModelTestPeer::installEngine(model);
  ParlerModelTestPeer::complete(
      model, engine, "coreml-all", "coreml-all", true, true);
  ParlerModelTestPeer::fail(model, engine, false, true);
  EXPECT_EQ(runtimeInt(model, "decoderSidecarLoaded"), 0);
  EXPECT_EQ(runtimeInt(model, "dacSidecarLoaded"), 1);
  EXPECT_EQ(runtimeInt(model, "decoderOnCoreml"), 0);
  EXPECT_EQ(runtimeInt(model, "dacOnCoreml"), 0);

  ParlerModelTestPeer::fail(model, engine, false, false);
  EXPECT_EQ(runtimeInt(model, "dacSidecarLoaded"), 0);
}

TEST(ParlerCoremlStats, OldFailureCannotOverwriteReplacementOrUnloadedState) {
  ParlerModel model(minimallyValidStubConfig());
  const auto oldEngine = ParlerModelTestPeer::installEngine(model);
  model.unload();
  ParlerModelTestPeer::fail(model, oldEngine, true, true);
  EXPECT_EQ(runtimeInt(model, "decoderSidecarLoaded"), 0);
  EXPECT_EQ(runtimeInt(model, "dacSidecarLoaded"), 0);

  const auto replacement = ParlerModelTestPeer::installEngine(model);
  ParlerModelTestPeer::complete(
      model, replacement, "coreml-all", "coreml-all", true, true);
  ParlerModelTestPeer::fail(model, oldEngine, false, false);
  EXPECT_EQ(runtimeInt(model, "decoderSidecarLoaded"), 1);
  EXPECT_EQ(runtimeInt(model, "dacSidecarLoaded"), 1);
  EXPECT_EQ(runtimeInt(model, "decoderOnCoreml"), 1);
  EXPECT_EQ(runtimeInt(model, "dacOnCoreml"), 1);
}
