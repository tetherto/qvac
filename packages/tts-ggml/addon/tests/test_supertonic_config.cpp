// Constructor-validation tests for SupertonicModel.  Same shape as
// test_chatterbox_config.cpp: validateConfig is private so we drive it
// indirectly via the public constructor and assert the throw path.
//
// Real-GGUF round-trip is gated behind QVAC_TEST_SUPERTONIC_GGUF.

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <random>
#include <stdexcept>
#include <string>
#include <system_error>

#include <gtest/gtest.h>

#include "inference-addon-cpp/Errors.hpp"
#include "model-interface/supertonic/SupertonicConfig.hpp"
#include "model-interface/supertonic/SupertonicEngineOptions.hpp"
#include "model-interface/supertonic/SupertonicModel.hpp"

using qvac::ttsggml::supertonic::SupertonicConfig;
using qvac::ttsggml::supertonic::SupertonicModel;
using qvac::ttsggml::supertonic::detail::applyVulkanPipelineCache;
using qvac::ttsggml::supertonic::detail::engineOptionsForTests;
using qvac::ttsggml::supertonic::detail::validateNoPerCallControls;
using qvac::ttsggml::supertonic::detail::VULKAN_PIPELINE_CACHE_DIR_ENV;
using qvac::ttsggml::supertonic::detail::VULKAN_PREWARM_TEXT;
using qvac_errors::StatusError;

namespace {

constexpr const char* TEST_DIR_PREFIX = "qvac-tts-ggml-supertonic-tests-";

class TestTempDir {
public:
  TestTempDir() : path_(createUniqueDir()) {}
  TestTempDir(const TestTempDir&) = delete;
  TestTempDir& operator=(const TestTempDir&) = delete;
  ~TestTempDir() {
    std::error_code ignored;
    std::filesystem::remove_all(path_, ignored);
  }
  const std::filesystem::path& path() const { return path_; }

private:
  static std::filesystem::path createUniqueDir() {
    std::random_device entropy;
    auto dir = std::filesystem::temp_directory_path() /
               (std::string(TEST_DIR_PREFIX) + std::to_string(entropy()));
    std::filesystem::create_directories(dir);
    return dir;
  }

  std::filesystem::path path_;
};

const std::filesystem::path& testTempDir() {
  static const TestTempDir dir;
  return dir.path();
}

std::filesystem::path tempPath(const std::string& suffix) {
  return testTempDir() / suffix;
}

void writeStubFile(const std::filesystem::path& p,
                   const std::string& contents = "stub") {
  std::ofstream(p, std::ios::binary) << contents;
}

std::string envOrEmpty(const char* name) {
  if (const char* v = std::getenv(name)) return v;
  return "";
}

SupertonicConfig minimallyValidStubConfig() {
  SupertonicConfig cfg;
  cfg.modelGgufPath = tempPath("supertonic-stub.gguf").string();
  writeStubFile(cfg.modelGgufPath);
  return cfg;
}

}

TEST(SupertonicValidate, EmptyModelPathRejected) {
  SupertonicConfig cfg;
  EXPECT_THROW(SupertonicModel{cfg}, StatusError);
}

TEST(SupertonicValidate, NonexistentModelPathRejected) {
  SupertonicConfig cfg;
  cfg.modelGgufPath = "/definitely/does/not/exist/supertonic.gguf";
  EXPECT_THROW(SupertonicModel{cfg}, StatusError);
}

TEST(SupertonicValidate, NegativeStepsRejected) {
  auto cfg = minimallyValidStubConfig();
  cfg.steps = -1;
  EXPECT_THROW(SupertonicModel{cfg}, StatusError);
}

TEST(SupertonicValidate, NegativeSpeedRejected) {
  auto cfg = minimallyValidStubConfig();
  cfg.speed = -0.5f;
  EXPECT_THROW(SupertonicModel{cfg}, StatusError);
}

TEST(SupertonicValidate, NonexistentNoiseNpyRejected) {
  auto cfg = minimallyValidStubConfig();
  cfg.noiseNpyPath = "/definitely/does/not/exist/noise.npy";
  EXPECT_THROW(SupertonicModel{cfg}, StatusError);
}

TEST(SupertonicValidate, UseGpuTrueAcceptedAtConstruction) {
  // GPU intent is now honored for Supertonic on GPU-capable hosts (Metal on
  // Apple, Vulkan/CUDA on desktop, and Android via tts-cpp's per-vendor
  // allowlist). Construction must NOT reject useGpu=true -- the GGUF parse
  // is deferred to load(), so a bare stub config validates cleanly.
  auto cfg = minimallyValidStubConfig();
  cfg.useGpu = true;
  EXPECT_NO_THROW(SupertonicModel{cfg});
}

TEST(SupertonicValidate, NGpuLayersGreaterThanZeroAccepted) {
  auto cfg = minimallyValidStubConfig();
  cfg.nGpuLayers = 99;
  EXPECT_NO_THROW(SupertonicModel{cfg});
}

TEST(SupertonicValidate, UseGpuNGpuLayersConflictStillRejected) {
  // The cross-field conflict check is preserved: useGPU=true paired with
  // nGpuLayers=0 (or useGPU=false with nGpuLayers!=0) is contradictory and
  // must still throw so callers can't silently get the opposite backend.
  auto cfg = minimallyValidStubConfig();
  cfg.useGpu = true;
  cfg.nGpuLayers = 0;
  EXPECT_THROW(SupertonicModel{cfg}, StatusError);
}

TEST(SupertonicValidate, NGpuLayersZeroAcceptedAndDeferredLoad) {
  auto cfg = minimallyValidStubConfig();
  cfg.nGpuLayers = 0;
  // Validation passes (CPU-only path); the stub file then fails GGUF
  // parsing on load() (not at construction — load is now deferred to
  // waitForLoadInitialization).  The eventual throw must NOT be the
  // GPU-rejection branch.
  std::unique_ptr<SupertonicModel> m;
  EXPECT_NO_THROW(m = std::make_unique<SupertonicModel>(cfg));
  ASSERT_NE(m, nullptr);
  EXPECT_FALSE(m->isLoaded());
  bool threw = false;
  try {
    m->load();
  } catch (const StatusError& e) {
    threw = true;
    const std::string what = e.what();
    EXPECT_EQ(what.find("GPU"), std::string::npos)
        << "nGpuLayers=0 should not trigger the GPU-rejection path; got: " << what;
  }
  EXPECT_TRUE(threw);
  EXPECT_FALSE(m->isLoaded());
}

TEST(SupertonicValidate, WaitForLoadInitializationDelegatesToLoad) {
  auto cfg = minimallyValidStubConfig();
  SupertonicModel m(cfg);
  EXPECT_FALSE(m.isLoaded());
  EXPECT_THROW(m.waitForLoadInitialization(), StatusError);
}

TEST(SupertonicValidate, ConfigDefaultsAreCpuFriendly) {
  SupertonicConfig cfg;
  EXPECT_EQ(cfg.language, "en");
  EXPECT_FALSE(cfg.useGpu.has_value());
  EXPECT_FALSE(cfg.nGpuLayers.has_value());
  EXPECT_FALSE(cfg.steps.has_value());
  EXPECT_FALSE(cfg.speed.has_value());
}

// ─────────────────────────────────────────────────────────────────────
//  Vulkan pipeline-cache opt-in mapping (config -> EngineOptions).
// ─────────────────────────────────────────────────────────────────────

TEST(SupertonicVulkanCache, GpuWithDirSetsEnvAndPrewarm) {
  tts_cpp::supertonic::EngineOptions opts;
  opts.n_gpu_layers = 99;
  SupertonicConfig cfg;
  cfg.vulkanCacheDir = "/data/vk";

  applyVulkanPipelineCache(opts, cfg);

  ASSERT_EQ(opts.vulkan_env_overrides.count(VULKAN_PIPELINE_CACHE_DIR_ENV), 1u);
  EXPECT_EQ(
      opts.vulkan_env_overrides.at(VULKAN_PIPELINE_CACHE_DIR_ENV), "/data/vk");
  EXPECT_EQ(opts.prewarm_text, VULKAN_PREWARM_TEXT);
}

TEST(SupertonicVulkanCache, CpuIgnoresCacheDir) {
  tts_cpp::supertonic::EngineOptions opts;
  opts.n_gpu_layers = 0;
  SupertonicConfig cfg;
  cfg.vulkanCacheDir = "/data/vk";

  applyVulkanPipelineCache(opts, cfg);

  EXPECT_TRUE(opts.vulkan_env_overrides.empty());
  EXPECT_TRUE(opts.prewarm_text.empty());
}

TEST(SupertonicVulkanCache, GpuWithoutDirIsNoop) {
  tts_cpp::supertonic::EngineOptions opts;
  opts.n_gpu_layers = 99;
  SupertonicConfig cfg; // vulkanCacheDir left empty

  applyVulkanPipelineCache(opts, cfg);

  EXPECT_TRUE(opts.vulkan_env_overrides.empty());
  EXPECT_TRUE(opts.prewarm_text.empty());
}

TEST(SupertonicVulkanCache, DoesNotOverwriteCallerPrewarm) {
  tts_cpp::supertonic::EngineOptions opts;
  opts.n_gpu_layers = 99;
  opts.prewarm_text = "caller sentence";
  SupertonicConfig cfg;
  cfg.vulkanCacheDir = "/data/vk";

  applyVulkanPipelineCache(opts, cfg);

  EXPECT_EQ(
      opts.vulkan_env_overrides.at(VULKAN_PIPELINE_CACHE_DIR_ENV), "/data/vk");
  EXPECT_EQ(opts.prewarm_text, "caller sentence");
}

// ─────────────────────────────────────────────────────────────────────
//  SupertonicConfig -> tts_cpp EngineOptions mapping.
// ─────────────────────────────────────────────────────────────────────

TEST(SupertonicEngineOptions, UnsetKnobsKeepEngineDefaults) {
  const tts_cpp::supertonic::EngineOptions defaults;
  const auto opts = engineOptionsForTests(SupertonicConfig{});
  EXPECT_TRUE(opts.voice_json_path.empty());
  EXPECT_TRUE(opts.prewarm_text.empty());
  EXPECT_EQ(opts.vulkan_device, defaults.vulkan_device);
  EXPECT_EQ(opts.stream_chunk_tokens, defaults.stream_chunk_tokens);
  EXPECT_EQ(opts.stream_first_chunk_tokens, defaults.stream_first_chunk_tokens);
  EXPECT_EQ(
      opts.stream_chunk_tolerance_pct, defaults.stream_chunk_tolerance_pct);
  EXPECT_EQ(opts.stream_min_chunk_tokens, defaults.stream_min_chunk_tokens);
}

TEST(SupertonicEngineOptions, VoiceDeviceAndStreamingForwarded) {
  SupertonicConfig cfg;
  cfg.voiceJsonPath = "/voices/cloned.json";
  cfg.vulkanDevice = -1;
  cfg.streamChunkTokens = 50;
  cfg.streamFirstChunkTokens = 20;
  cfg.streamChunkTolerancePct = 10;
  cfg.streamMinChunkTokens = 25;
  const auto opts = engineOptionsForTests(cfg);
  EXPECT_EQ(opts.voice_json_path, "/voices/cloned.json");
  EXPECT_EQ(opts.vulkan_device, -1);
  EXPECT_EQ(opts.stream_chunk_tokens, 50);
  EXPECT_EQ(opts.stream_first_chunk_tokens, 20);
  EXPECT_EQ(opts.stream_chunk_tolerance_pct, 10);
  EXPECT_EQ(opts.stream_min_chunk_tokens, 25);
}

// A caller pre-warm text wins over the vulkanCacheDir default sentence.
TEST(SupertonicEngineOptions, PrewarmTextForwardedAndWinsOverCacheDefault) {
  SupertonicConfig cfg;
  cfg.prewarmText = "A representative production sentence.";
  EXPECT_EQ(engineOptionsForTests(cfg).prewarm_text, cfg.prewarmText);

  cfg.nGpuLayers = 99;
  cfg.vulkanCacheDir = "/data/vk";
  const auto opts = engineOptionsForTests(cfg);
  EXPECT_EQ(opts.prewarm_text, cfg.prewarmText);
  EXPECT_EQ(
      opts.vulkan_env_overrides.at(VULKAN_PIPELINE_CACHE_DIR_ENV), "/data/vk");
}

TEST(SupertonicValidate, NonexistentVoiceJsonRejected) {
  auto cfg = minimallyValidStubConfig();
  cfg.voiceJsonPath = tempPath("does-not-exist.json").string();
  EXPECT_THROW(SupertonicModel{cfg}, StatusError);
}

TEST(SupertonicValidate, VulkanDeviceBelowAutoRejected) {
  auto cfg = minimallyValidStubConfig();
  cfg.vulkanDevice = -2;
  EXPECT_THROW(SupertonicModel{cfg}, StatusError);
  cfg.vulkanDevice = -1;
  EXPECT_NO_THROW(SupertonicModel{cfg});
}

TEST(SupertonicValidate, NegativeStreamingValuesRejected) {
  for (auto field :
       {&SupertonicConfig::streamChunkTokens,
        &SupertonicConfig::streamFirstChunkTokens,
        &SupertonicConfig::streamChunkTolerancePct,
        &SupertonicConfig::streamMinChunkTokens}) {
    auto cfg = minimallyValidStubConfig();
    cfg.*field = -1;
    EXPECT_THROW(SupertonicModel{cfg}, StatusError);
  }
}

TEST(SupertonicValidate, StreamingWithLavasrRejected) {
  const auto stub = tempPath("lavasr-stub.gguf");
  writeStubFile(stub);

  auto enhanced = minimallyValidStubConfig();
  enhanced.streamChunkTokens = 50;
  enhanced.enhancerGgufPath = stub.string();
  EXPECT_THROW(SupertonicModel{enhanced}, StatusError);

  auto denoised = minimallyValidStubConfig();
  denoised.streamChunkTokens = 50;
  denoised.denoiserGgufPath = stub.string();
  EXPECT_THROW(SupertonicModel{denoised}, StatusError);

  // streamChunkTokens 0 means batch, so post-processing stays allowed.
  auto batch = minimallyValidStubConfig();
  batch.streamChunkTokens = 0;
  batch.enhancerGgufPath = stub.string();
  EXPECT_NO_THROW(SupertonicModel{batch});
}

// ─────────────────────────────────────────────────────────────────────
//  Per-call conditioning: supertonic takes it at construction only.
// ─────────────────────────────────────────────────────────────────────

TEST(SupertonicPerCallControls, EmptyControlsAccepted) {
  EXPECT_NO_THROW(validateNoPerCallControls("", ""));
}

TEST(SupertonicPerCallControls, PaceRejected) {
  EXPECT_THROW(validateNoPerCallControls("", "fast"), StatusError);
}

TEST(SupertonicPerCallControls, EmotionRejected) {
  EXPECT_THROW(validateNoPerCallControls("happy", ""), StatusError);
}

TEST(SupertonicPerCallControls, MessageNamesTheRejectedChannel) {
  try {
    validateNoPerCallControls("", "slow");
    FAIL() << "expected a per-call pace to be rejected";
  } catch (const StatusError& e) {
    EXPECT_NE(std::string(e.what()).find("pace"), std::string::npos);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Real-GGUF round-trip (env-var gated).
// ─────────────────────────────────────────────────────────────────────

TEST(SupertonicRealGguf, ConstructAndUnloadIfAvailable) {
  const auto path = envOrEmpty("QVAC_TEST_SUPERTONIC_GGUF");
  if (path.empty() || !std::filesystem::exists(path)) {
    GTEST_SKIP() << "Set QVAC_TEST_SUPERTONIC_GGUF to enable.";
  }

  SupertonicConfig cfg;
  cfg.modelGgufPath = path;
  cfg.useGpu = false;
  cfg.voice = "F1";

  SupertonicModel m(cfg);
  EXPECT_FALSE(m.isLoaded()) << "load is now deferred until activate()/load()";
  EXPECT_EQ(m.getName(), "SupertonicModel");
  EXPECT_NO_THROW(m.load());
  EXPECT_TRUE(m.isLoaded());
  EXPECT_GT(m.sampleRate(), 0);
  EXPECT_NO_THROW(m.unload());
  EXPECT_FALSE(m.isLoaded());
}

TEST(SupertonicRealGguf, ProcessRejectsWrongAnyInputType) {
  const auto path = envOrEmpty("QVAC_TEST_SUPERTONIC_GGUF");
  if (path.empty() || !std::filesystem::exists(path)) {
    GTEST_SKIP() << "Set QVAC_TEST_SUPERTONIC_GGUF to enable.";
  }

  SupertonicConfig cfg;
  cfg.modelGgufPath = path;
  cfg.useGpu = false;

  SupertonicModel m(cfg);
  m.load();  // load is deferred since the constructor refactor; trigger it here
  // Wrong AnyInput type is the only well-defined invariant SupertonicModel
  // checks at the boundary; empty-text behaviour is delegated to the
  // underlying tts_cpp::supertonic::Engine and intentionally left
  // untested here to avoid coupling to engine-internal policy.
  EXPECT_THROW(m.process(std::any{int64_t{42}}), StatusError);
}
